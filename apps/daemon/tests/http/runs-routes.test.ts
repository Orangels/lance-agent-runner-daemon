import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDaemonConfig, type DaemonConfig } from '../../src/config/profiles.js';
import { createRunService, type RunServiceRunnerFactory } from '../../src/core/run-service.js';
import type { ClaudeCliRunResult } from '../../src/core/cli-runner.js';
import { createWorkspaceService } from '../../src/core/workspace-service.js';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { getRunDetail, upsertWorkspace } from '../../src/db/repositories.js';
import { applySchema } from '../../src/db/schema.js';
import { createSqliteRunnerPersistence } from '../../src/db/sqlite-persistence.js';
import { createApp } from '../../src/http/app.js';

const servers: Array<{ close: (callback: () => void) => void }> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(resolve);
        }),
    ),
  );
});

function makeConfig(root: string): DaemonConfig {
  return parseDaemonConfig(
    {
      server: {
        host: '127.0.0.1',
        port: 17890,
        dataDir: path.join(root, 'data'),
        globalConcurrency: 4,
        maxQueueSize: 100,
        persistence: {
          databaseUrl: 'postgres://user:pass@localhost:5432/lance_agent_daemon_test',
        },
      },
      clients: [
        { id: 'lqbot', apiKey: 'secret', allowedProfileIds: ['report-docx'], canReadDebugEvents: false },
        { id: 'other', apiKey: 'other-secret', allowedProfileIds: ['report-docx'], canReadDebugEvents: false },
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
          allowedModels: ['sonnet'],
          eventVisibility: 'normal',
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
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
  };
}

async function withApp(
  callback: (context: {
    baseUrl: string;
    config: DaemonConfig;
    db: ReturnType<typeof openInMemoryDatabase>;
    runners: Array<{
      input: Parameters<RunServiceRunnerFactory>[0];
      cancel: ReturnType<typeof vi.fn>;
      complete: (result: ClaudeCliRunResult) => void;
    }>;
    runNextTimer: () => { delayMs: number };
    startNextRun: () => Promise<void>;
    runAllTimers: () => void;
    workspaceId: string;
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-routes-test-'));
  const config = makeConfig(root);
  const db = openInMemoryDatabase();
  applySchema(db);
  const persistence = createSqliteRunnerPersistence(db);
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
  const runService = createRunService({
    config,
    persistence,
    runnerFactory,
    capabilityProbe: async () => ({}),
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
  const app = createApp({
    config,
    persistence,
    workspaceService: createWorkspaceService({ persistence }),
    runService,
  });
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  await callback({
    baseUrl: `http://127.0.0.1:${port}`,
    config,
    db,
    runners,
    runNextTimer: timerHarness.runNextTimer,
    startNextRun: async () => {
      timerHarness.runNextTimer();
      for (let index = 0; index < 5; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
    runAllTimers: () => {
      while (true) {
        try {
          timerHarness.runNextTimer();
        } catch {
          return;
        }
      }
    },
    workspaceId: workspace.id,
  });
}

describe('runs routes', () => {
  it('requires auth for run create', async () => {
    await withApp(async ({ baseUrl, workspaceId }) => {
      const response = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'report-docx', workspaceId, kind: 'revise', prompt: 'Run.' }),
      });

      expect(response.status).toBe(401);
    });
  });

  it('validates workspaceId-only run create body and rejects inline identity', async () => {
    await withApp(async ({ baseUrl, workspaceId }) => {
      const response = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: 'report-docx',
          workspaceId,
          kind: 'revise',
          prompt: 'Run.',
          originId: 'lqbot',
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expect.objectContaining({ code: 'BAD_REQUEST' }) });
    });
  });

  it('returns 202 queued for successful run create', async () => {
    await withApp(async ({ baseUrl, workspaceId }) => {
      const response = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'report-docx', workspaceId, kind: 'revise', prompt: 'Run.' }),
      });

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        runId: 'run_1',
        status: 'queued',
        conversationId: 'conv_1',
        userMessageId: 'msg_user',
        assistantMessageId: 'msg_assistant',
      });
    });
  });

  it('queues Phase 2 generate runs before execution', async () => {
    await withApp(async ({ baseUrl, workspaceId, runners }) => {
      const response = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: 'report-docx',
          workspaceId,
          kind: 'generate',
          skillId: 'report-writer',
          prompt: 'Generate.',
        }),
      });

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        runId: 'run_1',
        status: 'queued',
        conversationId: 'conv_1',
        userMessageId: 'msg_user',
        assistantMessageId: 'msg_assistant',
      });
      expect(runners).toHaveLength(0);
    });
  });

  it('replays POST /api/runs with the same idempotency key', async () => {
    await withApp(async ({ baseUrl, workspaceId }) => {
      const body = {
        profileId: 'report-docx',
        workspaceId,
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate.',
        artifactRuleIds: ['report-docx'],
        idempotencyKey: 'dispatch:1',
      };

      const first = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const firstPayload = await first.json() as Record<string, unknown>;
      const second = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(second.status).toBe(202);
      const secondPayload = await second.json() as Record<string, unknown>;
      expect(secondPayload.runId).toBe(firstPayload.runId);
      expect(secondPayload.conversationId).toBe(firstPayload.conversationId);
      expect(secondPayload.userMessageId).toBe(firstPayload.userMessageId);
      expect(secondPayload.assistantMessageId).toBe(firstPayload.assistantMessageId);
      expect(secondPayload.idempotentReplay).toBe(true);
      expect(['queued', 'running', 'succeeded', 'failed', 'canceled', 'interrupted']).toContain(
        secondPayload.status,
      );
    });
  });

  it('returns 409 when idempotency key is reused with different parameters', async () => {
    await withApp(async ({ baseUrl, workspaceId }) => {
      const baseBody = {
        profileId: 'report-docx',
        workspaceId,
        kind: 'generate',
        skillId: 'report-writer',
        artifactRuleIds: ['report-docx'],
        idempotencyKey: 'dispatch:1',
      };

      await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...baseBody, prompt: 'Generate.' }),
      });
      const conflict = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...baseBody, prompt: 'Generate differently.' }),
      });

      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({
        error: {
          code: 'IDEMPOTENCY_KEY_CONFLICT',
          message: 'idempotency key was already used with different run parameters',
        },
      });
    });
  });

  it('prevents another client from creating a run for this workspace', async () => {
    await withApp(async ({ baseUrl, workspaceId }) => {
      const response = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { Authorization: 'Bearer other-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'report-docx', workspaceId, kind: 'revise', prompt: 'Run.' }),
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: expect.objectContaining({ code: 'NOT_FOUND' }) });
    });
  });

  it('lists runs scoped to the authenticated client', async () => {
    await withApp(async ({ baseUrl, workspaceId }) => {
      await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: 'report-docx',
          workspaceId,
          kind: 'revise',
          prompt: 'Run.',
          artifactRuleIds: [],
        }),
      });

      const response = await fetch(`${baseUrl}/api/runs?status=queued&originId=lqbot`, {
        headers: { Authorization: 'Bearer secret' },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        runs: [expect.objectContaining({ id: 'run_1', workspaceId, status: 'queued' })],
      });
    });
  });

  it('returns durable run detail with filtered messages', async () => {
    await withApp(async ({ baseUrl, workspaceId, runners, startNextRun }) => {
      await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: 'report-docx',
          workspaceId,
          kind: 'revise',
          prompt: 'Run.',
          artifactRuleIds: [],
        }),
      });
      await startNextRun();
      runners[0]!.input.onEvent({ type: 'thinking_start' });
      runners[0]!.input.onEvent({ type: 'thinking_delta', delta: 'Thinking.' });
      runners[0]!.input.onEvent({ type: 'text_delta', delta: 'Done.' });
      runners[0]!.complete({ status: 'succeeded', exitCode: 0, signal: null, stdoutTail: '', stderrTail: '' });
      await Promise.resolve();

      const response = await fetch(`${baseUrl}/api/runs/run_1`, {
        headers: { Authorization: 'Bearer secret' },
      });

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, any>;
      expect(body.run).toEqual(expect.objectContaining({ id: 'run_1', status: 'succeeded' }));
      expect(body.messages[1]).toEqual(
        expect.objectContaining({
          role: 'assistant',
          content: 'Done.',
          thinkingContent: 'Thinking.',
          events: expect.arrayContaining([{ type: 'text_delta', delta: 'Done.' }]),
          runStatus: 'succeeded',
        }),
      );
    });
  });

  it('returns lightweight run status without durable messages', async () => {
    await withApp(async ({ baseUrl, workspaceId }) => {
      await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: 'report-docx',
          workspaceId,
          kind: 'revise',
          prompt: 'Run.',
          artifactRuleIds: [],
        }),
      });

      const response = await fetch(`${baseUrl}/api/runs/run_1/status`, {
        headers: { Authorization: 'Bearer secret' },
      });

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, any>;
      expect(body).toEqual({
        run: expect.objectContaining({
          id: 'run_1',
          workspaceId,
          profileId: 'report-docx',
          kind: 'revise',
          skillId: null,
          status: 'queued',
          errorCode: null,
          errorMessage: null,
        }),
        terminal: false,
      });
      expect(body).not.toHaveProperty('messages');
    });
  });

  it('does not expose aggregated thinking content to quiet run detail', async () => {
    await withApp(async ({ baseUrl, workspaceId, runners, startNextRun }) => {
      await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: 'report-docx',
          workspaceId,
          kind: 'revise',
          prompt: 'Run.',
          artifactRuleIds: [],
          eventVisibility: 'quiet',
        }),
      });
      await startNextRun();
      runners[0]!.input.onEvent({ type: 'thinking_start' });
      runners[0]!.input.onEvent({ type: 'thinking_delta', delta: 'Hidden.' });
      runners[0]!.input.onEvent({ type: 'text_delta', delta: 'Done.' });
      runners[0]!.complete({ status: 'succeeded', exitCode: 0, signal: null, stdoutTail: '', stderrTail: '' });
      await Promise.resolve();

      const response = await fetch(`${baseUrl}/api/runs/run_1`, {
        headers: { Authorization: 'Bearer secret' },
      });

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, any>;
      expect(body.messages[1]).toEqual(
        expect.objectContaining({
          content: 'Done.',
          thinkingContent: '',
          events: expect.arrayContaining([{ type: 'text_delta', delta: 'Done.' }]),
        }),
      );
      expect(JSON.stringify(body.messages[1].events)).not.toContain('thinking_delta');
    });
  });

  it('replays terminal SSE events until in-memory cleanup expires', async () => {
    await withApp(async ({ baseUrl, workspaceId, runners, startNextRun, runAllTimers, db }) => {
      await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: 'report-docx',
          workspaceId,
          kind: 'revise',
          prompt: 'Run.',
          artifactRuleIds: [],
        }),
      });
      await startNextRun();
      runners[0]!.input.onEvent({ type: 'text_delta', delta: 'Done.' });
      runners[0]!.complete({ status: 'succeeded', exitCode: 0, signal: null, stdoutTail: '', stderrTail: '' });
      await Promise.resolve();

      const response = await fetch(`${baseUrl}/api/runs/run_1/events?after=2`, {
        headers: { Authorization: 'Bearer secret' },
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('id: 3');
      expect(text).toContain('"delta":"Done."');
      expect(text).toContain('"status":"succeeded"');

      runAllTimers();
      const expired = await fetch(`${baseUrl}/api/runs/run_1/events`, {
        headers: { Authorization: 'Bearer secret' },
      });
      expect(expired.status).toBe(404);
      expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run.status).toBe('succeeded');
    });
  });

  it('cancels active runs', async () => {
    await withApp(async ({ baseUrl, workspaceId, runners, startNextRun }) => {
      await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'report-docx', workspaceId, kind: 'revise', prompt: 'Run.' }),
      });
      await startNextRun();

      const response = await fetch(`${baseUrl}/api/runs/run_1/cancel`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(runners[0]!.cancel).toHaveBeenCalledTimes(1);
    });
  });
});
