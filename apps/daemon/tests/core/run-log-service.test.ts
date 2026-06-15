import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openInMemoryDatabase, type RunnerDatabase } from '../../src/db/connection.js';
import {
  createRunQueuedWithMessagesAndSnapshot,
  getRunDetail,
  getRunLogForRunForClient,
  updateRunMessage,
  updateRunTerminal,
  upsertWorkspace,
} from '../../src/db/repositories.js';
import { applySchema } from '../../src/db/schema.js';
import { createSqliteRunnerPersistence } from '../../src/db/sqlite-persistence.js';
import {
  createRunLogService,
  type RunLogClient,
} from '../../src/core/run-log-service.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'runner-logs-'));
  tempDirs.push(dir);
  return dir;
}

function setup(input: { maxLogBytesPerRun?: number; logRetentionMs?: number } = {}) {
  const db = openInMemoryDatabase();
  applySchema(db);
  const persistence = createSqliteRunnerPersistence(db);
  const dataDir = makeDataDir();
  const service = createRunLogService({
    persistence,
    config: {
      server: {
        host: '127.0.0.1',
        port: 17890,
        dataDir,
        globalConcurrency: 4,
        maxQueueSize: 100,
        logRetentionMs: input.logRetentionMs ?? 60_000,
        maxLogBytesPerRun: input.maxLogBytesPerRun ?? 4 * 1024 * 1024,
        maxReviewBundleBytes: 16 * 1024 * 1024,
        maxUploadBytesPerFile: 50 * 1024 * 1024,
        uploadTempRetentionMs: 24 * 60 * 60 * 1000,
        persistence: {
          databaseUrl: 'postgres://user:pass@localhost:5432/lance_agent_daemon_test',
        },
      },
    },
  });
  const workspace = upsertWorkspace(db, {
    id: 'ws_1',
    clientId: 'lqbot',
    profileId: 'report-docx',
    originId: 'lqbot',
    userId: 'user_1',
    projectId: 'project_1',
    now: 1000,
  });
  createRunQueuedWithMessagesAndSnapshot(db, {
    runId: 'run_1',
    conversationId: 'conv_1',
    userMessageId: 'msg_user',
    assistantMessageId: 'msg_assistant',
    workspaceId: workspace.id,
    profileId: workspace.profileId,
    clientId: workspace.clientId,
    kind: 'revise',
    prompt: 'Run.',
    profileSnapshot: { profileId: workspace.profileId },
    now: 2000,
  });
  return { db, dataDir, service };
}

const logClient = (input: Partial<RunLogClient> = {}): RunLogClient => ({
  id: input.id ?? 'lqbot',
  isAdmin: input.isAdmin ?? false,
  canReadLogs: input.canReadLogs ?? true,
  canReadDebugEvents: input.canReadDebugEvents ?? false,
});

describe('run log service', () => {
  it('creates log files and a relative run_logs row', async () => {
    const { db, dataDir, service } = setup();

    const logs = await service.openRunLogs({ runId: 'run_1' });
    logs.stdout('hello stdout\n');
    logs.stderr('hello stderr\n');
    logs.debugEvent({ type: 'stderr', text: 'debug line' });
    await logs.close();

    const row = getRunLogForRunForClient(db, { runId: 'run_1', clientId: 'lqbot' });
    expect(row).toEqual({
      runId: 'run_1',
      stdoutLogPath: 'logs/runs/run_1/stdout.log',
      stderrLogPath: 'logs/runs/run_1/stderr.log',
      debugEventsLogPath: 'logs/runs/run_1/debug-events.ndjson',
      createdAt: expect.any(Number),
    });
    expect(readFileSync(path.join(dataDir, row!.stdoutLogPath!), 'utf8')).toBe('hello stdout\n');
    expect(readFileSync(path.join(dataDir, row!.stderrLogPath!), 'utf8')).toBe('hello stderr\n');
    expect(readFileSync(path.join(dataDir, row!.debugEventsLogPath!), 'utf8')).toContain('debug line');
  });

  it('sanitizes secrets and absolute paths before writing', async () => {
    const { dataDir, service } = setup();

    const logs = await service.openRunLogs({ runId: 'run_1' });
    logs.stdout('authorization: Bearer secret /home/orangels/private.txt output/report.docx');
    logs.stderr('CLAUDE_CONFIG_DIR=/tmp/claude token=my-token');
    await logs.close();

    const stdout = readFileSync(path.join(dataDir, 'logs/runs/run_1/stdout.log'), 'utf8');
    const stderr = readFileSync(path.join(dataDir, 'logs/runs/run_1/stderr.log'), 'utf8');
    expect(stdout).not.toContain('secret');
    expect(stdout).not.toContain('/home/orangels');
    expect(stdout).toContain('output/report.docx');
    expect(stderr).not.toContain('CLAUDE_CONFIG_DIR');
    expect(stderr).not.toContain('my-token');
  });

  it('caps log size and appends one truncation marker', async () => {
    const { dataDir, service } = setup({ maxLogBytesPerRun: 12 });

    const logs = await service.openRunLogs({ runId: 'run_1' });
    logs.stdout('1234567890');
    logs.stdout('abcdef');
    logs.stdout('ignored');
    await logs.close();

    const stdout = readFileSync(path.join(dataDir, 'logs/runs/run_1/stdout.log'), 'utf8');
    expect(stdout).toContain('1234567890ab');
    expect(stdout).toContain('[truncated: max log bytes reached]');
    expect(stdout.match(/\[truncated: max log bytes reached\]/g)).toHaveLength(1);
    expect(stdout).not.toContain('ignored');
  });

  it('returns public tails only for clients allowed to read logs', async () => {
    const { service } = setup();
    const logs = await service.openRunLogs({ runId: 'run_1' });
    logs.stdout('safe tail');
    await logs.close();

    await expect(
      service.getRunLogs({ runId: 'run_1', client: logClient({ canReadLogs: false }) }),
    ).rejects.toThrow(expect.objectContaining({ code: 'FORBIDDEN', status: 403 }));
    await expect(service.getRunLogs({ runId: 'run_1', client: logClient() })).resolves.toEqual({
      runId: 'run_1',
      logs: {
        stdout: { available: true, size: 9, tail: 'safe tail' },
        stderr: { available: true, size: 0, tail: '' },
        debugEvents: { available: true, size: 0, tail: '' },
      },
    });
  });

  it('returns not found for another client unless admin', async () => {
    const { service } = setup();
    await (await service.openRunLogs({ runId: 'run_1' })).close();

    await expect(service.getRunLogs({ runId: 'run_1', client: logClient({ id: 'other' }) })).rejects.toThrow(
      expect.objectContaining({ code: 'NOT_FOUND', status: 404 }),
    );
    expect((await service.getRunLogs({ runId: 'run_1', client: logClient({ id: 'admin', isAdmin: true }) })).runId).toBe(
      'run_1',
    );
  });

  it('marks missing log files unavailable instead of throwing', async () => {
    const { service } = setup();
    const logs = await service.openRunLogs({ runId: 'run_1' });
    logs.stdout('gone');
    await logs.close();
    rmSync(path.join(service.dataDir, 'logs/runs/run_1/stdout.log'));

    expect((await service.getRunLogs({ runId: 'run_1', client: logClient() })).logs.stdout).toEqual({
      available: false,
      size: 0,
      tail: '',
    });
  });

  it('returns complete stdout and stderr download handles for authorized clients', async () => {
    const { dataDir, service } = setup();
    const logs = await service.openRunLogs({ runId: 'run_1' });
    logs.stdout('full stdout');
    logs.stderr('full stderr');
    await logs.close();

    await expect(service.getRunLogDownload({ runId: 'run_1', kind: 'stdout', client: logClient() })).resolves.toEqual({
      filePath: path.join(dataDir, 'logs/runs/run_1/stdout.log'),
      fileName: 'stdout.log',
      mimeType: 'text/plain; charset=utf-8',
      size: 'full stdout'.length,
    });
    expect((await service.getRunLogDownload({ runId: 'run_1', kind: 'stderr', client: logClient() })).fileName).toBe(
      'stderr.log',
    );
  });

  it('requires debug-event permission for complete debug event downloads', async () => {
    const { service } = setup();
    const logs = await service.openRunLogs({ runId: 'run_1' });
    logs.debugEvent({ type: 'stderr', text: 'debug line' });
    await logs.close();

    await expect(
      service.getRunLogDownload({ runId: 'run_1', kind: 'debug-events', client: logClient() }),
    ).rejects.toThrow(expect.objectContaining({ code: 'FORBIDDEN', status: 403 }));
    expect(
      (await service.getRunLogDownload({
        runId: 'run_1',
        kind: 'debug-events',
        client: logClient({ canReadDebugEvents: true }),
      })).fileName,
    ).toBe('debug-events.ndjson');
  });

  it('returns not found when a complete log file is missing or belongs to another client', async () => {
    const { service } = setup();
    const logs = await service.openRunLogs({ runId: 'run_1' });
    logs.stdout('gone');
    await logs.close();
    rmSync(path.join(service.dataDir, 'logs/runs/run_1/stdout.log'));

    await expect(
      service.getRunLogDownload({ runId: 'run_1', kind: 'stdout', client: logClient() }),
    ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND', status: 404 }));
    await expect(
      service.getRunLogDownload({ runId: 'run_1', kind: 'stderr', client: logClient({ id: 'other' }) }),
    ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND', status: 404 }));
  });

  it('prunes expired log files without deleting durable run data', async () => {
    const { db, dataDir, service } = setup({ logRetentionMs: 1000 });
    const logs = await service.openRunLogs({ runId: 'run_1' });
    logs.stdout('old');
    await logs.close();
    updateRunTerminal(db, {
      runId: 'run_1',
      status: 'succeeded',
      finishedAt: 5000,
      now: 5000,
    });
    updateRunMessage(db, {
      messageId: 'msg_assistant',
      runStatus: 'succeeded',
      endedAt: 5000,
      now: 5000,
    });

    const logDir = path.join(dataDir, 'logs/runs/run_1');
    writeFileSync(path.join(logDir, 'extra.txt'), 'also removed');
    await expect(service.pruneExpiredLogs({ now: 7001 })).resolves.toEqual({ pruned: 1 });

    expect(getRunLogForRunForClient(db, { runId: 'run_1', clientId: 'lqbot' })).toBeNull();
    expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run.status).toBe('succeeded');
    expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.messages).toHaveLength(2);
  });
});
