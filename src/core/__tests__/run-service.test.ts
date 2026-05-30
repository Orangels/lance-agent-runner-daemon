import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseDaemonConfig, type DaemonConfig } from '../../config/profiles.js';
import { openInMemoryDatabase } from '../../db/connection.js';
import { getProfileSnapshotForRun, getRunDetail, upsertWorkspace } from '../../db/repositories.js';
import { applySchema } from '../../db/schema.js';
import { DaemonError } from '../errors.js';
import { createRunService, type RunServiceRunnerFactory } from '../run-service.js';
import type { ClaudeCliRunResult } from '../cli-runner.js';

function makeConfig(root: string): DaemonConfig {
  return parseDaemonConfig(
    {
      server: {
        host: '127.0.0.1',
        port: 17890,
        dataDir: path.join(root, 'data'),
        globalConcurrency: 4,
        maxQueueSize: 100,
      },
      clients: [
        {
          id: 'lqbot',
          apiKey: 'secret',
          allowedProfileIds: ['report-docx'],
          canReadDebugEvents: false,
          canReadLogs: true,
        },
      ],
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
          allowedModels: ['sonnet', 'opus'],
          eventVisibility: 'normal',
          profileConcurrency: 1,
          runTimeoutMs: 1000,
          inactivityTimeoutMs: 1000,
          cancelGraceMs: 100,
          env: { ANTHROPIC_API_KEY: 'secret-key' },
        },
      ],
    },
    { env: {} },
  );
}

function createTimerHarness() {
  let nextId = 1;
  const timers: Array<{ id: number; delayMs: number; callback: () => void; cleared: boolean }> = [];

  return {
    timer: {
      setTimeout: (callback: () => void, delayMs: number) => {
        const task = { id: nextId++, delayMs, callback, cleared: false };
        timers.push(task);
        return task.id;
      },
      clearTimeout: (id: number) => {
        const task = timers.find((candidate) => candidate.id === id);
        if (task) task.cleared = true;
      },
    },
    runNextTimer: () => {
      const task = timers.find((candidate) => !candidate.cleared);
      if (!task) throw new Error('No pending timer');
      task.cleared = true;
      task.callback();
      return task;
    },
    pendingTimers: () => timers.filter((task) => !task.cleared),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-service-test-'));
  const config = makeConfig(root);
  const db = openInMemoryDatabase();
  applySchema(db);
  const workspace = upsertWorkspace(db, {
    id: 'ws_1',
    clientId: 'lqbot',
    profileId: 'report-docx',
    originId: 'lqbot',
    userId: 'user_1',
    projectId: 'project_123',
    now: 1000,
  });
  const timerHarness = createTimerHarness();
  const runners: Array<{
    input: Parameters<RunServiceRunnerFactory>[0];
    cancel: ReturnType<typeof vi.fn>;
    complete: (result: ClaudeCliRunResult) => void;
  }> = [];
  const runnerFactory: RunServiceRunnerFactory = (input) => {
    const deferred = createDeferred<ClaudeCliRunResult>();
    const cancel = vi.fn();
    runners.push({ input, cancel, complete: deferred.resolve });
    return { completed: deferred.promise, cancel };
  };
  const service = createRunService({
    config,
    db,
    runnerFactory,
    timer: timerHarness.timer,
    clock: () => 5000,
    eventBufferTtlMs: 1000,
    ids: {
      runId: () => `run_${runners.length + 1}`,
      conversationId: () => 'conv_1',
      userMessageId: () => 'msg_user',
      assistantMessageId: () => 'msg_assistant',
    },
  });

  return { root, config, db, workspace, service, runners, ...timerHarness };
}

describe('run service', () => {
  it('creates durable queued run data before starting the fake runner', () => {
    const { config, db, workspace, service, runners, runNextTimer } = setup();

    const result = service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Revise the report.',
      },
    });

    expect(result).toEqual({ runId: 'run_1', status: 'queued' });
    expect(runners).toHaveLength(0);
    expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.messages).toEqual([
      expect.objectContaining({ id: 'msg_user', role: 'user', content: 'Revise the report.' }),
      expect.objectContaining({ id: 'msg_assistant', role: 'assistant', runStatus: 'queued' }),
    ]);
    expect(getProfileSnapshotForRun(db, 'run_1')?.profile).toMatchObject({
      profileId: 'report-docx',
      selectedModel: 'sonnet',
      selectedArtifactRuleIds: ['report-docx'],
      envKeys: ['ANTHROPIC_API_KEY'],
    });

    runNextTimer();
    expect(runners).toHaveLength(1);
  });

  it('rejects kind=generate during Phase 1', () => {
    const { config, workspace, service } = setup();

    expect(() =>
      service.createRun({
        client: config.clients[0]!,
        request: {
          profileId: 'report-docx',
          workspaceId: workspace.id,
          kind: 'generate',
          skillId: 'report-writer',
          prompt: 'Generate a report.',
        },
      }),
    ).toThrow(DaemonError);
  });

  it('rejects a second active run for the same workspace', () => {
    const { config, workspace, service } = setup();
    service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'One.' },
    });

    expect(() =>
      service.createRun({
        client: config.clients[0]!,
        request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'Two.' },
      }),
    ).toThrow(expect.objectContaining({ code: 'WORKSPACE_RUN_ACTIVE', status: 409 }));
  });

  it('assigns numeric event ids, persists last id, and replays only newer events', () => {
    const { config, db, workspace, service, runners, runNextTimer } = setup();
    service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'Run.' },
    });
    runNextTimer();

    runners[0]!.input.onEvent({ type: 'text_delta', delta: 'hello' });

    expect(service.replayRunEvents({ client: config.clients[0]!, runId: 'run_1', after: '2' })).toEqual([
      { id: '3', event: { type: 'text_delta', delta: 'hello' } },
    ]);
    expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run.lastRunEventId).toBe('3');
  });

  it('flushes messages and marks run terminal when the runner completes', async () => {
    const { config, db, workspace, service, runners, runNextTimer } = setup();
    service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'Run.' },
    });
    runNextTimer();
    runners[0]!.input.onEvent({ type: 'text_delta', delta: 'Done.' });
    runners[0]!.complete({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
    });
    await Promise.resolve();

    const detail = getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' });
    expect(detail?.run).toMatchObject({ status: 'succeeded', exitCode: 0, finishedAt: 5000 });
    expect(detail?.messages[1]).toMatchObject({
      content: 'Done.',
      runStatus: 'succeeded',
      endedAt: 5000,
    });
    expect(service.replayRunEvents({ client: config.clients[0]!, runId: 'run_1' }).at(-1)).toEqual({
      id: '4',
      event: { type: 'end', status: 'succeeded' },
    });
  });

  it('drops in-memory event streams after TTL while durable detail remains', async () => {
    const { config, db, workspace, service, runners, runNextTimer } = setup();
    service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'Run.' },
    });
    runNextTimer();
    runners[0]!.complete({ status: 'succeeded', exitCode: 0, signal: null, stdoutTail: '', stderrTail: '' });
    await Promise.resolve();

    runNextTimer();

    expect(() => service.replayRunEvents({ client: config.clients[0]!, runId: 'run_1' })).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
    expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run.status).toBe('succeeded');
  });

  it('cancels a running run through the runner handle', async () => {
    const { config, db, workspace, service, runners, runNextTimer } = setup();
    service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'Run.' },
    });
    runNextTimer();

    expect(service.cancelRun({ client: config.clients[0]!, runId: 'run_1' })).toEqual({ ok: true });
    expect(runners[0]!.cancel).toHaveBeenCalledTimes(1);
    runners[0]!.complete({
      status: 'canceled',
      exitCode: null,
      signal: 'SIGTERM',
      stdoutTail: '',
      stderrTail: '',
    });
    await Promise.resolve();

    expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run.status).toBe('canceled');
  });
});
