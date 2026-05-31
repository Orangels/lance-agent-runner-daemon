import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseDaemonConfig } from '../config/profiles.js';
import { openRunnerDatabase } from '../db/connection.js';
import { getRunDetail, insertRunQueued, upsertWorkspace } from '../db/repositories.js';
import { applySchema } from '../db/schema.js';
import { createServerContext, installShutdownHandlers } from '../index.js';

function makeConfig(root: string, input: { uploadTempRetentionMs?: number } = {}) {
  return parseDaemonConfig(
    {
      server: {
        host: '127.0.0.1',
        port: 17890,
        dataDir: path.join(root, 'data'),
        globalConcurrency: 4,
        maxQueueSize: 100,
        uploadTempRetentionMs: input.uploadTempRetentionMs,
      },
      clients: [{ id: 'lqbot', apiKey: 'secret', allowedProfileIds: ['report-docx'] }],
      profiles: [
        {
          id: 'report-docx',
          sandboxRoot: path.join(root, 'sandboxes'),
          claudeConfigDir: path.join(root, 'profiles/report-docx/claude'),
          claudeBin: 'claude',
          skillRoots: [path.join(root, 'skills')],
          allowedInputRoots: [path.join(root, 'uploads')],
          allowedSkillIds: ['report-writer'],
          artifactRules: [
            { id: 'report-docx', pattern: 'output/**/*.docx', role: 'primary', required: true },
          ],
          defaultArtifactRuleIds: ['report-docx'],
          permissionMode: 'bypassPermissions',
          defaultModel: 'sonnet',
          allowedModels: ['sonnet'],
          eventVisibility: 'quiet',
          profileConcurrency: 1,
          runTimeoutMs: 1000,
          inactivityTimeoutMs: 1000,
          cancelGraceMs: 100,
          env: {},
        },
      ],
    },
    { env: {} },
  );
}

describe('server startup context', () => {
  it('applies schema and marks old queued runs interrupted', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'runner-index-test-'));
    const config = makeConfig(root);
    const setupDb = openRunnerDatabase(config.server.dataDir);
    applySchema(setupDb);
    const workspace = upsertWorkspace(setupDb, {
      id: 'ws_1',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_1',
      projectId: 'project_123',
      now: 1000,
    });
    insertRunQueued(setupDb, {
      id: 'run_1',
      workspaceId: workspace.id,
      clientId: 'lqbot',
      profileId: 'report-docx',
      kind: 'revise',
      prompt: 'Queued run',
      now: 1000,
    });
    setupDb.close();

    const context = createServerContext(config, { clock: () => 2000 });

    expect(context.runService).toBeDefined();
    expect(context.artifactService).toBeDefined();
    expect(context.uploadTempService.getTempRoot()).toBe(path.join(config.server.dataDir, 'uploads', 'tmp'));
    expect(context.interruptedRuns).toBe(1);
    expect(getRunDetail(context.db, { runId: 'run_1', clientId: 'lqbot' })?.run).toMatchObject({
      status: 'interrupted',
      errorCode: 'RUN_INTERRUPTED_BY_DAEMON_RESTART',
      finishedAt: 2000,
    });
    context.db.close();
  });

  it('prunes stale upload temp directories on startup while preserving fresh ones', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'runner-index-test-'));
    const config = makeConfig(root, { uploadTempRetentionMs: 1000 });
    const tempRoot = path.join(config.server.dataDir, 'uploads', 'tmp');
    const staleUploadDir = path.join(tempRoot, 'upload_stale');
    const freshUploadDir = path.join(tempRoot, 'upload_fresh');
    mkdirSync(staleUploadDir, { recursive: true });
    mkdirSync(freshUploadDir, { recursive: true });
    writeFileSync(path.join(staleUploadDir, 'file'), 'stale');
    writeFileSync(path.join(freshUploadDir, 'file'), 'fresh');
    utimesSync(staleUploadDir, new Date(8000), new Date(8000));
    utimesSync(freshUploadDir, new Date(9500), new Date(9500));

    const context = createServerContext(config, { clock: () => 10_000 });

    expect(existsSync(staleUploadDir)).toBe(false);
    expect(existsSync(freshUploadDir)).toBe(true);
    expect(readdirSync(tempRoot)).toEqual(['upload_fresh']);
    context.db.close();
  });

  it('can import the index module without starting the server', async () => {
    const module = await import('../index.js');

    expect(module.main).toBeTypeOf('function');
    expect(module.startServer).toBeTypeOf('function');
  });
});

describe('server shutdown handlers', () => {
  it('registers signal handlers that close HTTP, shutdown runs, and close the database', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'runner-index-test-'));
    const config = makeConfig(root);
    const listeners = new Map<string, () => Promise<void>>();
    const signalTarget = {
      exitCode: undefined as number | undefined,
      once: vi.fn((signal: string, listener: () => Promise<void>) => {
        listeners.set(signal, listener);
        return signalTarget;
      }),
      off: vi.fn(),
    };
    const server = {
      close: vi.fn((callback: () => void) => {
        callback();
        return server;
      }),
    };
    const runService = {
      shutdownActive: vi.fn(async () => ({ interrupted: 2 })),
    };
    const db = { close: vi.fn() };
    const context = {
      config,
      db,
      runService,
    };

    installShutdownHandlers(context as unknown as Parameters<typeof installShutdownHandlers>[0], server as never, signalTarget);
    await listeners.get('SIGTERM')?.();

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(runService.shutdownActive).toHaveBeenCalledWith({ graceMs: 100 });
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(signalTarget.exitCode).toBe(0);
  });
});
