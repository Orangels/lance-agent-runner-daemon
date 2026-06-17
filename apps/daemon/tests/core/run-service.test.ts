import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseDaemonConfig, type DaemonConfig } from '../../src/config/profiles.js';
import type {
  CreateWebhookDeliveryForRunStatusInput,
  InsertRunWebhookInput,
  RunnerPersistence,
} from '../../src/db/types.js';
import { DaemonError } from '../../src/core/errors.js';
import type { DaemonLogger } from '../../src/core/daemon-logger.js';
import {
  buildClaudeRunInvocation,
  createRunService,
  type RunServiceRunnerFactory,
} from '../../src/core/run-service.js';
import type { RunLogService } from '../../src/core/run-log-service.js';
import { createTextSnapshot, stableJsonHash } from '../../src/core/snapshot-service.js';
import type { ClaudeCliRunResult } from '../../src/core/cli-runner.js';
import { getWorkspaceCwd } from '../../src/core/workspace-service.js';
import { createPostgresFilePersistenceHarness } from '../helpers/postgres-persistence-harness.js';
import { postgresTestHookTimeoutMs, requirePostgresTestUrl } from '../helpers/postgres.js';

const postgresDescribe = requirePostgresTestUrl() === null ? describe.skip : describe;
const tempDirs: string[] = [];
const activeServices: Array<ReturnType<typeof createRunService>> = [];
let harness: Awaited<ReturnType<typeof createPostgresFilePersistenceHarness>> | null = null;

beforeAll(async () => {
  harness = await createPostgresFilePersistenceHarness();
  expect(harness).not.toBeNull();
}, postgresTestHookTimeoutMs);

afterEach(async () => {
  try {
    await Promise.all(
      activeServices.splice(0).map(async (service) => {
        try {
          await service.shutdownActive({ graceMs: 0 });
        } catch {
          // Keep test cleanup best-effort so the original assertion failure remains visible.
        }
      }),
    );
    await flushAsync();
    await harness?.resetData();
  } finally {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

afterAll(async () => {
  await harness?.cleanup();
  harness = null;
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
      const task = timers
        .filter((candidate) => !candidate.cleared)
        .sort((left, right) => left.delayMs - right.delayMs)[0];
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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

type TestRunner = {
  input: Parameters<RunServiceRunnerFactory>[0];
  cancel: ReturnType<typeof vi.fn>;
  complete: (result: ClaudeCliRunResult) => void;
};

async function setup(
  options: {
    capabilities?: Parameters<RunServiceRunnerFactory>[0]['capabilities'];
    configure?: (config: DaemonConfig) => void;
    runLogService?: RunLogService;
    daemonLogger?: DaemonLogger;
    withWebhookSpy?: boolean;
  } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-service-test-'));
  tempDirs.push(root);
  const config = makeConfig(root);
  options.configure?.(config);
  expect(harness).not.toBeNull();
  const basePersistence = harness!.persistence;
  const webhookSpies = options.withWebhookSpy ? createWebhookSpyPersistence(basePersistence) : null;
  const persistence = webhookSpies?.persistence ?? basePersistence;
  const workspace = await persistence.upsertWorkspace({
    id: 'ws_1',
    clientId: 'lqbot',
    profileId: 'report-docx',
    originId: 'lqbot',
    userId: 'user_1',
    projectId: 'project_123',
    now: 1000,
  });
  const workspaceCwd = getWorkspaceCwd(config.profiles[0]!, workspace);
  mkdirSync(path.join(workspaceCwd, 'input'), { recursive: true });
  mkdirSync(path.join(workspaceCwd, 'output'), { recursive: true });
  mkdirSync(path.join(workspaceCwd, 'work'), { recursive: true });
  mkdirSync(path.join(workspaceCwd, '.claude-runner-skills'), { recursive: true });
  const timerHarness = createTimerHarness();
  let runId = 1;
  let conversationId = 1;
  let userMessageId = 1;
  let assistantMessageId = 1;
  const runners: TestRunner[] = [];
  const runnerFactory: RunServiceRunnerFactory = (input) => {
    const deferred = createDeferred<ClaudeCliRunResult>();
    const cancel = vi.fn();
    runners.push({ input, cancel, complete: deferred.resolve });
    return { completed: deferred.promise, cancel };
  };
  const service = createRunService({
    config,
    persistence,
    runnerFactory,
    runLogService: options.runLogService,
    daemonLogger: options.daemonLogger,
    capabilityProbe: async () => options.capabilities ?? {},
    timer: timerHarness.timer,
    clock: () => 5000,
    eventBufferTtlMs: 1000,
    ids: {
      runId: () => `run_${runId++}`,
      conversationId: () => `conv_${conversationId++}`,
      userMessageId: () => {
        const id = userMessageId++;
        return id === 1 ? 'msg_user' : `msg_user_${id}`;
      },
      assistantMessageId: () => {
        const id = assistantMessageId++;
        return id === 1 ? 'msg_assistant' : `msg_assistant_${id}`;
      },
    },
  });
  activeServices.push(service);

  return { root, config, persistence, workspace, workspaceCwd, service, runners, webhookSpies, ...timerHarness };
}
function createWebhookSpyPersistence(base: RunnerPersistence) {
  const insertRunWebhook = vi.fn(async (input: InsertRunWebhookInput) => ({
    id: input.id,
    runId: input.runId,
    clientId: input.clientId,
    url: input.url,
    secret: input.secret ?? null,
    statuses: input.statuses,
    metadata: input.metadata ?? null,
    createdAt: input.now,
    updatedAt: input.now,
  }));
  const createWebhookDeliveryForRunStatus = vi.fn(
    async (input: CreateWebhookDeliveryForRunStatusInput) => ({
      id: input.id,
      runId: input.runId,
      webhookId: input.webhookId,
      clientId: input.clientId,
      eventType: input.eventType,
      runStatus: input.runStatus,
      deliveryStatus: 'pending' as const,
      payload: input.payload,
      payloadSha256: input.payloadSha256,
      attemptCount: 0,
      nextAttemptAt: input.nextAttemptAt,
      lockedAt: null,
      lockedBy: null,
      lastAttemptAt: null,
      deliveredAt: null,
      responseStatus: null,
      responseBodyPreview: null,
      errorMessage: null,
      createdAt: input.now,
      updatedAt: input.now,
    }),
  );

  function wrap(persistence: RunnerPersistence): RunnerPersistence {
    return new Proxy(persistence, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return async <T,>(fn: (tx: RunnerPersistence) => Promise<T>) =>
            target.transaction((tx) => fn(wrap(tx)));
        }
        if (property === 'insertRunWebhook') return insertRunWebhook;
        if (property === 'createWebhookDeliveryForRunStatus') return createWebhookDeliveryForRunStatus;
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as RunnerPersistence;
  }

  return { persistence: wrap(base), insertRunWebhook, createWebhookDeliveryForRunStatus };
}

async function runScheduledStart(runNextTimer: () => unknown): Promise<void> {
  runNextTimer();
  await flushAsync();
}

async function waitForRunnerCount(runners: TestRunner[], count: number): Promise<void> {
  await vi.waitFor(() => expect(runners).toHaveLength(count));
}

async function advanceDispatchUntilRunnerCount(
  runners: TestRunner[],
  count: number,
  runNextTimer: () => unknown,
  pendingTimers: () => Array<{ delayMs: number; cleared: boolean }>,
): Promise<void> {
  for (let attempt = 0; attempt < 5 && runners.length < count; attempt += 1) {
    if (pendingTimers().some((timer) => !timer.cleared && timer.delayMs === 0)) {
      runNextTimer();
    }
    await flushAsync();
  }
  await waitForRunnerCount(runners, count);
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function writeSkill(root: string, options: { sideFiles?: boolean } = {}): string {
  const skillDir = path.join(root, 'skills', 'report-writer');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---
id: report-writer
name: Report Writer
description: Writes reports.
---
Use references/style.md to write the report.
`,
  );
  if (options.sideFiles) {
    mkdirSync(path.join(skillDir, 'references'), { recursive: true });
    writeFileSync(path.join(skillDir, 'references', 'style.md'), 'Keep it concise.');
  }
  return skillDir;
}

postgresDescribe('run service', () => {
  it('creates durable queued run data before starting the fake runner', async () => {
    const { config, persistence, workspace, service, runners, runNextTimer } = await setup();

    const result = await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Revise the report.',
      },
    });

    expect(result).toEqual({
      runId: 'run_1',
      status: 'queued',
      conversationId: 'conv_1',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
    });
    expect(runners).toHaveLength(0);
    expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.messages).toEqual([
      expect.objectContaining({ id: 'msg_user', role: 'user', content: 'Revise the report.' }),
      expect.objectContaining({ id: 'msg_assistant', role: 'assistant', runStatus: 'queued' }),
    ]);
    expect((await persistence.getProfileSnapshotForRun('run_1'))?.profile).toMatchObject({
      profileId: 'report-docx',
      selectedModel: 'sonnet',
      selectedArtifactRuleIds: ['report-docx'],
      envKeys: ['ANTHROPIC_API_KEY'],
    });

    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);
  });

  it('replays an existing run for the same idempotency key and fingerprint', async () => {
    const { config, workspace, service, runners, pendingTimers } = await setup();

    const first = await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate the report.',
        artifactRuleIds: ['report-docx'],
        idempotencyKey: 'dispatch:1',
      },
    });
    const second = await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate the report.',
        artifactRuleIds: ['report-docx'],
        idempotencyKey: 'dispatch:1',
      },
    });

    expect(second).toEqual({
      ...first,
      idempotentReplay: true,
    });
    expect(runners).toHaveLength(0);
    expect(pendingTimers()).toHaveLength(1);
  });

  it('stores a versioned idempotency fingerprint', async () => {
    const { config, persistence, workspace, service } = await setup();

    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate the report.',
        artifactRuleIds: ['report-docx'],
        idempotencyKey: 'dispatch:1',
      },
    });

    expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.idempotencyFingerprint).toBe(
      stableJsonHash({
        version: 1,
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        skillId: 'report-writer',
        promptMode: 'legacy',
        currentPromptHash: createTextSnapshot('Generate the report.').hash,
        conversationId: null,
        collectionMode: 'lite',
        contextPolicy: null,
        businessContextHash: null,
        model: 'sonnet',
        artifactRuleIds: ['report-docx'],
      }),
    );
  });

  it('stores run webhook config and creates a queued webhook delivery when requested', async () => {
    const { config, workspace, service, webhookSpies } = await setup({ withWebhookSpy: true });

    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate the report.',
        webhook: {
          url: 'http://192.168.88.20:8000/api/daemon/webhook',
          secret: 'webhook-secret',
          statuses: ['queued', 'running', 'succeeded'],
          metadata: { businessTaskId: 'task_001' },
        },
      },
    });

    expect(webhookSpies?.insertRunWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run_1',
        clientId: 'lqbot',
        url: 'http://192.168.88.20:8000/api/daemon/webhook',
        secret: 'webhook-secret',
        statuses: ['queued', 'running', 'succeeded'],
        metadata: { businessTaskId: 'task_001' },
      }),
    );
    expect(webhookSpies?.createWebhookDeliveryForRunStatus).toHaveBeenCalledTimes(1);
    expect(webhookSpies?.createWebhookDeliveryForRunStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run_1',
        clientId: 'lqbot',
        eventType: 'run.status_changed',
        runStatus: 'queued',
        payload: expect.objectContaining({
          eventType: 'run.status_changed',
          run: expect.objectContaining({ id: 'run_1', status: 'queued' }),
          metadata: { businessTaskId: 'task_001' },
        }),
      }),
    );
  });

  it('creates webhook deliveries for running and terminal status changes', async () => {
    const { config, workspace, service, runners, runNextTimer, webhookSpies } = await setup({
      withWebhookSpy: true,
    });

    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Revise.',
        artifactRuleIds: [],
        webhook: {
          url: 'http://192.168.88.20:8000/api/daemon/webhook',
          statuses: ['running', 'succeeded'],
        },
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);

    runners[0]!.complete({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
    });
    await flushAsync();

    await vi.waitFor(() => {
      const statuses = webhookSpies?.createWebhookDeliveryForRunStatus.mock.calls.map(
        ([delivery]) => delivery.runStatus,
      );
      expect(statuses).toEqual(['running', 'succeeded']);
    });
    expect(webhookSpies?.createWebhookDeliveryForRunStatus.mock.calls[0]?.[0].payload).toEqual(
      expect.objectContaining({
        run: expect.objectContaining({ id: 'run_1', status: 'running' }),
      }),
    );
    expect(webhookSpies?.createWebhookDeliveryForRunStatus.mock.calls[1]?.[0].payload).toEqual(
      expect.objectContaining({
        run: expect.objectContaining({ id: 'run_1', status: 'succeeded' }),
      }),
    );
  });

  it('rejects idempotency key reuse when webhook parameters differ', async () => {
    const { config, workspace, service } = await setup({ withWebhookSpy: true });

    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate the report.',
        idempotencyKey: 'dispatch:1',
        webhook: {
          url: 'http://192.168.88.20:8000/api/daemon/webhook',
          statuses: ['succeeded'],
        },
      },
    });

    await expect(
      service.createRun({
        client: config.clients[0]!,
        request: {
          profileId: 'report-docx',
          workspaceId: workspace.id,
          kind: 'generate',
          skillId: 'report-writer',
          prompt: 'Generate the report.',
          idempotencyKey: 'dispatch:1',
          webhook: {
            url: 'http://192.168.88.21:8000/api/daemon/webhook',
            statuses: ['succeeded'],
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      status: 409,
    });
  });

  it('replays an existing webhook run before applying current URL policy checks', async () => {
    const { config, workspace, service } = await setup({ withWebhookSpy: true });
    const request = {
      profileId: 'report-docx',
      workspaceId: workspace.id,
      kind: 'generate' as const,
      skillId: 'report-writer',
      prompt: 'Generate the report.',
      idempotencyKey: 'dispatch:webhook-policy',
      webhook: {
        url: 'http://192.168.88.20:8000/api/daemon/webhook',
        statuses: ['succeeded' as const],
      },
    };

    const first = await service.createRun({
      client: config.clients[0]!,
      request,
    });
    config.server.webhooks.allowPrivateNetworks = false;

    await expect(
      service.createRun({
        client: config.clients[0]!,
        request,
      }),
    ).resolves.toEqual({
      ...first,
      idempotentReplay: true,
    });
  });

  it('replays an existing idempotency key before queue capacity checks', async () => {
    const { config, workspace, service } = await setup({
      configure: (config) => {
        config.server.globalConcurrency = 1;
        config.server.maxQueueSize = 0;
      },
    });

    const first = await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate the report.',
        artifactRuleIds: ['report-docx'],
        idempotencyKey: 'dispatch:1',
      },
    });
    const replay = await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate the report.',
        artifactRuleIds: ['report-docx'],
        idempotencyKey: 'dispatch:1',
      },
    });

    expect(replay).toEqual({
      ...first,
      idempotentReplay: true,
    });
  });

  it('replays an interrupted run after daemon shutdown for the same idempotency key', async () => {
    const { config, workspace, service } = await setup();

    const request = {
      profileId: 'report-docx',
      workspaceId: workspace.id,
      kind: 'generate' as const,
      skillId: 'report-writer',
      prompt: 'Generate the report.',
      artifactRuleIds: ['report-docx'],
      idempotencyKey: 'dispatch:1',
    };
    const first = await service.createRun({
      client: config.clients[0]!,
      request,
    });

    await service.shutdownActive();
    const replay = await service.createRun({
      client: config.clients[0]!,
      request,
    });

    expect(replay.runId).toBe(first.runId);
    expect(replay.status).toBe('interrupted');
    expect(replay.idempotentReplay).toBe(true);
  });

  it('rejects reuse of an idempotency key with different run parameters', async () => {
    const { config, workspace, service } = await setup();

    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate the report.',
        artifactRuleIds: ['report-docx'],
        idempotencyKey: 'dispatch:1',
      },
    });

    await expect(
      service.createRun({
        client: config.clients[0]!,
        request: {
          profileId: 'report-docx',
          workspaceId: workspace.id,
          kind: 'generate',
          skillId: 'report-writer',
          prompt: 'Generate a different report.',
          artifactRuleIds: ['report-docx'],
          idempotencyKey: 'dispatch:1',
        },
      }),
    ).rejects.toThrow(expect.objectContaining({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      status: 409,
    }));
  });

  it('creates a new run when idempotency key changes', async () => {
    const { config, workspace, service } = await setup();

    const first = await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate the report.',
        artifactRuleIds: ['report-docx'],
        idempotencyKey: 'dispatch:1',
      },
    });
    const second = await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate the report.',
        artifactRuleIds: ['report-docx'],
        idempotencyKey: 'dispatch:2',
      },
    });

    expect(second.runId).not.toBe(first.runId);
    expect(second.idempotentReplay).toBeUndefined();
  });

  it('does not apply idempotency when no idempotency key is provided', async () => {
    const { config, workspace, service } = await setup();

    const first = await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Revise.',
      },
    });
    const second = await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Revise.',
      },
    });

    expect(second.runId).not.toBe(first.runId);
  });

  it('rejects explicit conversation ids owned by a different workspace before inserting a run', async () => {
    const { config, persistence, workspace, service } = await setup();
    const otherWorkspace = await persistence.upsertWorkspace({
      id: 'ws_2',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_2',
      projectId: 'project_123',
      now: 1000,
    });
    const otherRun = await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: otherWorkspace.id,
        kind: 'revise',
        prompt: 'Create the other conversation.',
        artifactRuleIds: [],
      },
    });

    await expect(
      service.createRun({
        client: config.clients[0]!,
        request: {
          profileId: 'report-docx',
          workspaceId: workspace.id,
          conversationId: otherRun.conversationId,
          kind: 'revise',
          prompt: 'Try to reuse a foreign conversation.',
          artifactRuleIds: [],
        },
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'BAD_REQUEST', status: 400 }));
    expect((await persistence.getRunDetail({ runId: 'run_2', clientId: 'lqbot' }))).toBeNull();
  });

  it('rejects collection modes above the profile cap before inserting a run', async () => {
    const { config, persistence, workspace, service } = await setup();

    await expect(
      service.createRun({
        client: config.clients[0]!,
        request: {
          profileId: 'report-docx',
          workspaceId: workspace.id,
          kind: 'revise',
          prompt: 'Run with diagnostic capture.',
          collectionMode: 'diagnostic',
          artifactRuleIds: [],
        },
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'COLLECTION_MODE_NOT_ALLOWED', status: 403 }));
    expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))).toBeNull();
  });

  it('rejects webhook requests when webhooks are disabled before inserting a run', async () => {
    const { config, persistence, workspace, service, webhookSpies } = await setup({ withWebhookSpy: true });
    config.server.webhooks.enabled = false;

    await expect(
      service.createRun({
        client: config.clients[0]!,
        request: {
          profileId: 'report-docx',
          workspaceId: workspace.id,
          kind: 'generate',
          skillId: 'report-writer',
          prompt: 'Generate a report.',
          artifactRuleIds: [],
          webhook: { url: 'http://192.168.88.20:8000/api/daemon/webhook' },
        },
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'BAD_REQUEST',
        details: { reason: 'webhooks_disabled' },
        status: 400,
      }),
    );
    expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))).toBeNull();
    expect(webhookSpies?.insertRunWebhook).not.toHaveBeenCalled();
    expect(webhookSpies?.createWebhookDeliveryForRunStatus).not.toHaveBeenCalled();
  });

  it('rejects disallowed webhook URLs before inserting a run', async () => {
    const { config, persistence, workspace, service, webhookSpies } = await setup({ withWebhookSpy: true });

    await expect(
      service.createRun({
        client: config.clients[0]!,
        request: {
          profileId: 'report-docx',
          workspaceId: workspace.id,
          kind: 'generate',
          skillId: 'report-writer',
          prompt: 'Generate a report.',
          artifactRuleIds: [],
          webhook: { url: 'http://127.0.0.1:8000/api/daemon/webhook' },
        },
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'WEBHOOK_URL_NOT_ALLOWED', status: 400 }));
    expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))).toBeNull();
    expect(webhookSpies?.insertRunWebhook).not.toHaveBeenCalled();
    expect(webhookSpies?.createWebhookDeliveryForRunStatus).not.toHaveBeenCalled();
  });

  it('rejects oversized webhook metadata before inserting a run', async () => {
    const { config, persistence, workspace, service, webhookSpies } = await setup({ withWebhookSpy: true });

    await expect(
      service.createRun({
        client: config.clients[0]!,
        request: {
          profileId: 'report-docx',
          workspaceId: workspace.id,
          kind: 'generate',
          skillId: 'report-writer',
          prompt: 'Generate a report.',
          artifactRuleIds: [],
          webhook: {
            url: 'http://192.168.88.20:8000/api/daemon/webhook',
            metadata: { payload: 'x'.repeat(20_000) },
          },
        },
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'BAD_REQUEST',
        details: expect.objectContaining({ reason: 'webhook_metadata_too_large' }),
        status: 400,
      }),
    );
    expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))).toBeNull();
    expect(webhookSpies?.insertRunWebhook).not.toHaveBeenCalled();
    expect(webhookSpies?.createWebhookDeliveryForRunStatus).not.toHaveBeenCalled();
  });

  it('stores business context snapshots at create time even if the queued run is canceled', async () => {
    const { config, persistence, workspace, service } = await setup({
      configure: (config) => {
        config.profiles[0]!.maxCollectionMode = 'diagnostic';
      },
    });

    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        promptMode: 'business-context',
        skillId: 'report-writer',
        currentPrompt: 'Generate from the supplied business package.',
        businessContext: { stage: 'initial', formAnswers: { unit: 'test-unit' } },
        collectionMode: 'diagnostic',
        artifactRuleIds: [],
      },
    });

    await expect(service.cancelRun({ client: config.clients[0]!, runId: 'run_1' })).resolves.toEqual({ ok: true });
    expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run).toMatchObject({
      status: 'canceled',
      promptMode: 'business-context',
      collectionMode: 'diagnostic',
      businessContextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect((await persistence.getRunContextSnapshot('run_1'))).toMatchObject({
      businessContextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      persisted: true,
      businessContext: expect.objectContaining({ stage: 'initial' }),
    });
    expect((await persistence.getRunPromptSnapshot('run_1'))).toBeNull();
  });

  it('does not grant allowed input roots to Claude --add-dir in Phase 1', async () => {
    const { config, workspace, root } = await setup();

    const invocation = buildClaudeRunInvocation({
      profile: config.profiles[0]!,
      workspace,
      workspaceCwd: path.join(root, 'sandboxes/lqbot/user_1/project_123'),
      run: {} as Parameters<RunServiceRunnerFactory>[0]['run'],
      prompt: 'Run.',
      capabilities: { addDir: true, partialMessages: true },
      onEvent: () => {},
    });

    expect(invocation.args).not.toContain('--add-dir');
    expect(invocation.args.join('\0')).not.toContain(path.join(root, 'uploads'));
    expect(invocation.args).toContain('--include-partial-messages');
  });

  it('rejects disallowed generate skill ids synchronously without inserting a run', async () => {
    const { config, persistence, workspace, service } = await setup();

    await expect(
      service.createRun({
        client: config.clients[0]!,
        request: {
          profileId: 'report-docx',
          workspaceId: workspace.id,
          kind: 'generate',
          skillId: 'not-allowed',
          prompt: 'Generate a report.',
        },
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'SKILL_NOT_ALLOWED', status: 400 }));
    expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))).toBeNull();
  });

  it('fails an allowlisted but unavailable generate skill as a durable run', async () => {
    const { config, persistence, workspace, service, runners, runNextTimer } = await setup();

    expect(
      await service.createRun({
        client: config.clients[0]!,
        request: {
          profileId: 'report-docx',
          workspaceId: workspace.id,
          kind: 'generate',
          skillId: 'report-writer',
          prompt: 'Generate a report.',
        },
      }),
    ).toEqual(expect.objectContaining({ runId: 'run_1', status: 'queued' }));

    await runScheduledStart(runNextTimer);

    expect(runners).toHaveLength(0);
    await vi.waitFor(async () => {
      expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run).toMatchObject({
        status: 'failed',
        errorCode: 'SKILL_UNAVAILABLE',
      });
    });
  });

  it('stages side-file skills for generate and grants only the staged skill dir', async () => {
    const { root, config, workspace, workspaceCwd, service, runners, runNextTimer } = await setup();
    writeSkill(root, { sideFiles: true });

    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate the report.',
        artifactRuleIds: [],
      },
    });

    await runScheduledStart(runNextTimer);

    const stagedDir = path.join(workspaceCwd, '.claude-runner-skills', 'report-writer');
    await waitForRunnerCount(runners, 1);
    expect(runners[0]!.input.prompt).toContain('Use references/style.md to write the report.');
    expect(runners[0]!.input.prompt).toContain('.claude-runner-skills/report-writer/');
    expect(runners[0]!.input.extraAllowedDirs).toEqual([stagedDir]);
    expect(runners[0]!.input.extraAllowedDirs?.join('\0')).not.toContain(path.join(root, 'uploads'));
    expect(runners[0]!.input.extraAllowedDirs?.join('\0')).not.toContain(path.join(root, 'skills'));
  });

  it('does not stage generate skills that have no side files', async () => {
    const { root, config, workspace, service, runners, runNextTimer } = await setup();
    writeSkill(root);

    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate the report.',
        artifactRuleIds: [],
      },
    });

    await runScheduledStart(runNextTimer);

    await waitForRunnerCount(runners, 1);
    expect(runners[0]!.input.prompt).toContain('Use references/style.md to write the report.');
    expect(runners[0]!.input.prompt).not.toContain('Skill root');
    expect(runners[0]!.input.extraAllowedDirs).toEqual([]);
  });

  it('injects skill instructions and persists diagnostic snapshots for business-context revise runs', async () => {
    const { root, config, persistence, workspace, service, runners, runNextTimer } = await setup({
      configure: (config) => {
        config.profiles[0]!.maxCollectionMode = 'diagnostic';
      },
    });
    writeSkill(root, { sideFiles: true });

    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        promptMode: 'business-context',
        skillId: 'report-writer',
        currentPrompt: 'Continue after the question-form answers.',
        businessContext: {
          previousRunId: 'run_previous',
          stage: 'question-form-answers',
          formAnswers: { unit: 'test-unit' },
        },
        collectionMode: 'diagnostic',
        artifactRuleIds: [],
      },
    });

    await runScheduledStart(runNextTimer);

    await waitForRunnerCount(runners, 1);
    expect(runners[0]!.input.prompt).toContain('## Business context');
    expect(runners[0]!.input.prompt).toContain('"previousRunId": "run_previous"');
    expect(runners[0]!.input.prompt).toContain('Use references/style.md to write the report.');
    expect(runners[0]!.input.prompt).toContain('Continue after the question-form answers.');
    expect((await persistence.getRunPromptSnapshot('run_1'))).toMatchObject({
      promptSnapshot: expect.stringContaining('## Business context'),
      persisted: true,
    });
    expect((await persistence.getRunSkillSnapshot('run_1'))).toMatchObject({
      skillId: 'report-writer',
      skillBody: expect.stringContaining('Use references/style.md'),
      sideFilesManifest: expect.arrayContaining([
        expect.objectContaining({ relativePath: 'references/style.md' }),
      ]),
      persisted: true,
    });
  });

  it('composes daemon-composed revise prompts from prior conversation messages in stable order', async () => {
    const { config, persistence, workspace, service, runners, runNextTimer } = await setup();

    const first = await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Summarize the first document.',
        artifactRuleIds: [],
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);
    runners[0]!.input.onEvent({ type: 'text_delta', delta: 'First summary.' });
    runners[0]!.complete({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
    });
    await flushAsync();
    await vi.waitFor(async () => {
      expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.status).toBe('succeeded');
    });

    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        conversationId: first.conversationId,
        kind: 'revise',
        promptMode: 'daemon-composed',
        currentPrompt: 'Continue from that summary.',
        contextPolicy: {
          recentMessages: 4,
          maxMessageChars: 1000,
          maxTotalChars: 4000,
        },
        artifactRuleIds: [],
      },
    });
    await runScheduledStart(runNextTimer);

    await waitForRunnerCount(runners, 2);
    expect(runners[1]!.input.prompt).toContain('## Conversation context');
    expect(runners[1]!.input.prompt).toContain('"role": "user"');
    expect(runners[1]!.input.prompt).toContain('Summarize the first document.');
    expect(runners[1]!.input.prompt).toContain('First summary.');
    expect(runners[1]!.input.prompt).toContain('## Current user request');
    expect(runners[1]!.input.prompt).toContain('Continue from that summary.');
    expect(runners[1]!.input.prompt).not.toContain('queued');
    expect((await persistence.getRunDetail({ runId: 'run_2', clientId: 'lqbot' }))?.messages[0]).toMatchObject({
      content: 'Continue from that summary.',
      conversationId: first.conversationId,
      conversationSeq: 3,
    });
  });

  it('fails generate runs durably when skill staging fails before spawn', async () => {
    const { root, config, persistence, workspace, workspaceCwd, service, runners, runNextTimer } = await setup();
    writeSkill(root, { sideFiles: true });
    rmSync(path.join(workspaceCwd, '.claude-runner-skills'), { recursive: true, force: true });
    writeFileSync(path.join(workspaceCwd, '.claude-runner-skills'), 'not a directory');

    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate the report.',
        artifactRuleIds: [],
      },
    });

    await runScheduledStart(runNextTimer);

    expect(runners).toHaveLength(0);
    await vi.waitFor(async () => {
      expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run).toMatchObject({
        status: 'failed',
        errorCode: 'SKILL_STAGING_FAILED',
      });
    });
  });

  it('queues a second run for the same workspace until the first terminalizes', async () => {
    const { config, persistence, workspace, service, runners, runNextTimer, pendingTimers } = await setup({
      configure: (config) => {
        config.server.globalConcurrency = 2;
        config.profiles[0]!.profileConcurrency = 2;
      },
    });
    await service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'One.', artifactRuleIds: [] },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);

    await service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'Two.', artifactRuleIds: [] },
    });
    await runScheduledStart(runNextTimer);

    await waitForRunnerCount(runners, 1);
    expect((await persistence.getRunDetail({ runId: 'run_2', clientId: 'lqbot' }))?.run.status).toBe('queued');

    runners[0]!.complete({ status: 'succeeded', exitCode: 0, signal: null, stdoutTail: '', stderrTail: '' });
    await flushAsync();

    await advanceDispatchUntilRunnerCount(runners, 2, runNextTimer, pendingTimers);
    await vi.waitFor(async () => {
      expect((await persistence.getRunDetail({ runId: 'run_2', clientId: 'lqbot' }))?.run.status).toBe('running');
    });
  });

  it('enforces global concurrency across different workspaces', async () => {
    const { config, persistence, workspace, service, runners, runNextTimer, pendingTimers } = await setup({
      configure: (config) => {
        config.server.globalConcurrency = 1;
        config.profiles[0]!.profileConcurrency = 2;
      },
    });
    const otherWorkspace = await persistence.upsertWorkspace({
      id: 'ws_2',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_2',
      projectId: 'project_123',
      now: 1000,
    });

    await service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'One.', artifactRuleIds: [] },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);
    await service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: otherWorkspace.id, kind: 'revise', prompt: 'Two.', artifactRuleIds: [] },
    });
    await runScheduledStart(runNextTimer);

    await waitForRunnerCount(runners, 1);
    expect((await persistence.getRunDetail({ runId: 'run_2', clientId: 'lqbot' }))?.run.status).toBe('queued');
  });

  it('does not let a workspace-blocked queued run block a later eligible workspace', async () => {
    const { config, persistence, workspace, service, runners, runNextTimer, pendingTimers } = await setup({
      configure: (config) => {
        config.server.globalConcurrency = 2;
        config.profiles[0]!.profileConcurrency = 2;
      },
    });
    const otherWorkspace = await persistence.upsertWorkspace({
      id: 'ws_2',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_2',
      projectId: 'project_123',
      now: 1000,
    });

    await service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'One.', artifactRuleIds: [] },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);
    await service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'Two.', artifactRuleIds: [] },
    });
    await service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: otherWorkspace.id, kind: 'revise', prompt: 'Three.', artifactRuleIds: [] },
    });
    runNextTimer();
    await flushAsync();

    await vi.waitFor(() => {
      expect(runners.map((runner) => runner.input.run.id)).toEqual(['run_1', 'run_3']);
    });
    expect((await persistence.getRunDetail({ runId: 'run_2', clientId: 'lqbot' }))?.run.status).toBe('queued');
  });

  it('allows different profiles to run concurrently when global capacity is available', async () => {
    const { config, persistence, workspace, service, runners, runNextTimer, pendingTimers } = await setup({
      configure: (config) => {
        config.server.globalConcurrency = 2;
        config.clients[0]!.allowedProfileIds.push('summary-docx');
        config.profiles.push({
          ...config.profiles[0]!,
          id: 'summary-docx',
          profileConcurrency: 1,
        });
      },
    });
    const secondProfileWorkspace = await persistence.upsertWorkspace({
      id: 'ws_2',
      clientId: 'lqbot',
      profileId: 'summary-docx',
      originId: 'lqbot',
      userId: 'user_2',
      projectId: 'project_123',
      now: 1000,
    });

    await service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'One.', artifactRuleIds: [] },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);
    await service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'summary-docx', workspaceId: secondProfileWorkspace.id, kind: 'revise', prompt: 'Two.', artifactRuleIds: [] },
    });
    await runScheduledStart(runNextTimer);

    await vi.waitFor(() => {
      expect(runners.map((runner) => runner.input.profile.id)).toEqual(['report-docx', 'summary-docx']);
    });
  });

  it('returns RUN_QUEUE_FULL before inserting when a waiting run would exceed maxQueueSize', async () => {
    const { config, persistence, workspace, service, runners, runNextTimer } = await setup({
      configure: (config) => {
        config.server.globalConcurrency = 1;
        config.server.maxQueueSize = 0;
      },
    });
    const otherWorkspace = await persistence.upsertWorkspace({
      id: 'ws_2',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_2',
      projectId: 'project_123',
      now: 1000,
    });

    await service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'One.', artifactRuleIds: [] },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);

    await expect(
      service.createRun({
        client: config.clients[0]!,
        request: { profileId: 'report-docx', workspaceId: otherWorkspace.id, kind: 'revise', prompt: 'Two.', artifactRuleIds: [] },
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'RUN_QUEUE_FULL', status: 429 }));
    expect((await persistence.getRunDetail({ runId: 'run_2', clientId: 'lqbot' }))).toBeNull();
  });

  it('counts earlier queued runs when checking maxQueueSize before dispatch has started', async () => {
    const { config, persistence, workspace, service } = await setup({
      configure: (config) => {
        config.server.globalConcurrency = 1;
        config.server.maxQueueSize = 0;
      },
    });
    const otherWorkspace = await persistence.upsertWorkspace({
      id: 'ws_2',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_2',
      projectId: 'project_123',
      now: 1000,
    });

    await service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'One.', artifactRuleIds: [] },
    });

    await expect(
      service.createRun({
        client: config.clients[0]!,
        request: { profileId: 'report-docx', workspaceId: otherWorkspace.id, kind: 'revise', prompt: 'Two.', artifactRuleIds: [] },
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'RUN_QUEUE_FULL', status: 429 }));
    expect((await persistence.getRunDetail({ runId: 'run_2', clientId: 'lqbot' }))).toBeNull();
  });

  it('cancels a queued run without spawning and dispatches the next eligible run', async () => {
    const { config, persistence, workspace, service, runners, runNextTimer, pendingTimers } = await setup({
      configure: (config) => {
        config.server.globalConcurrency = 1;
        config.server.maxQueueSize = 10;
        config.profiles[0]!.profileConcurrency = 2;
      },
    });
    const ws2 = await persistence.upsertWorkspace({
      id: 'ws_2',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_2',
      projectId: 'project_123',
      now: 1000,
    });
    const ws3 = await persistence.upsertWorkspace({
      id: 'ws_3',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_3',
      projectId: 'project_123',
      now: 1000,
    });

    await service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'One.', artifactRuleIds: [] },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);
    await service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: ws2.id, kind: 'revise', prompt: 'Two.', artifactRuleIds: [] },
    });
    await service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: ws3.id, kind: 'revise', prompt: 'Three.', artifactRuleIds: [] },
    });

    await expect(service.cancelRun({ client: config.clients[0]!, runId: 'run_2' })).resolves.toEqual({ ok: true });
    await vi.waitFor(async () => {
      expect((await persistence.getRunDetail({ runId: 'run_2', clientId: 'lqbot' }))?.run.status).toBe('canceled');
    });
    expect((await persistence.getRunDetail({ runId: 'run_2', clientId: 'lqbot' }))?.messages[1]).toMatchObject({
      runStatus: 'canceled',
      endedAt: 5000,
    });
    await waitForRunnerCount(runners, 1);

    runners[0]!.complete({ status: 'succeeded', exitCode: 0, signal: null, stdoutTail: '', stderrTail: '' });
    await flushAsync();

    await advanceDispatchUntilRunnerCount(runners, 2, runNextTimer, pendingTimers);
    expect(runners[1]!.input.run.id).toBe('run_3');
  });

  it('passes probed capabilities to the runner and replays numeric event ids', async () => {
    const { config, persistence, workspace, service, runners, runNextTimer } = await setup({
      capabilities: { partialMessages: true },
    });
    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Run.',
        artifactRuleIds: [],
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);

    expect(runners[0]!.input.capabilities).toEqual({ partialMessages: true });
    runners[0]!.input.onEvent({ type: 'text_delta', delta: 'hello' });

    await expect(service.replayRunEvents({ client: config.clients[0]!, runId: 'run_1', after: '2' })).resolves.toEqual([
      { id: '3', event: { type: 'text_delta', delta: 'hello' } },
    ]);
    expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.lastRunEventId).toBeNull();
  });

  it('flushes messages and marks run terminal when the runner completes', async () => {
    const { config, persistence, workspace, service, runners, runNextTimer } = await setup();
    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Run.',
        artifactRuleIds: [],
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);
    runners[0]!.input.onEvent({ type: 'text_delta', delta: 'Done.' });
    runners[0]!.complete({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
    });
    await flushAsync();

    await vi.waitFor(async () => {
      expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run).toMatchObject({
        status: 'succeeded',
        exitCode: 0,
        finishedAt: 5000,
        lastRunEventId: '4',
      });
    });
    const detail = (await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }));
    expect(detail?.messages[1]).toMatchObject({
      content: 'Done.',
      runStatus: 'succeeded',
      endedAt: 5000,
    });
    expect((await service.replayRunEvents({ client: config.clients[0]!, runId: 'run_1' })).at(-1)).toEqual({
      id: '4',
      event: { type: 'end', status: 'succeeded' },
    });
  });

  it('persists separate assistant messages for separate Claude assistant message starts', async () => {
    const { config, persistence, workspace, service, runners, runNextTimer } = await setup();
    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Run.',
        artifactRuleIds: [],
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);

    runners[0]!.input.onEvent({ type: 'assistant_message_start', messageId: 'claude_msg_1' });
    runners[0]!.input.onEvent({ type: 'text_delta', delta: 'First.' });
    runners[0]!.input.onEvent({ type: 'assistant_message_start', messageId: 'claude_msg_2' });
    runners[0]!.input.onEvent({ type: 'text_delta', delta: 'Second.' });
    runners[0]!.complete({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
    });
    await flushAsync();

    await vi.waitFor(async () => {
      expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.status).toBe('succeeded');
    });
    const detail = (await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }));
    expect(detail?.messages).toEqual([
      expect.objectContaining({ id: 'msg_user', role: 'user', position: 0, content: 'Run.' }),
      expect.objectContaining({ id: 'msg_assistant', role: 'assistant', position: 1, content: 'First.' }),
      expect.objectContaining({ id: 'msg_assistant_2', role: 'assistant', position: 2, content: 'Second.' }),
    ]);
    expect(detail?.messages.slice(1).map((message) => message.runStatus)).toEqual(['succeeded', 'succeeded']);
  });

  it('persists artifact events before terminal end on successful generate', async () => {
    const { root, config, persistence, workspace, workspaceCwd, service, runners, runNextTimer } = await setup();
    writeSkill(root);
    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate.',
        artifactRuleIds: ['report-docx'],
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);
    writeFileSync(path.join(workspaceCwd, 'output', 'report.docx'), 'docx');
    runners[0]!.complete({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
    });
    await flushAsync();

    await vi.waitFor(async () => {
      expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.status).toBe('succeeded');
    });
    const detail = (await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }));
    expect(detail?.run.status).toBe('succeeded');
    const eventTypes = (detail?.messages[1]?.events as Array<{ type: string }>).map((event) => event.type);
    expect(eventTypes).toEqual(expect.arrayContaining(['artifact_finalized', 'end']));
    expect(eventTypes.indexOf('artifact_finalized')).toBeLessThan(eventTypes.indexOf('end'));
  });

  it('persists run log close warning before terminal end without changing final status', async () => {
    const daemonLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(async () => {}),
    };
    const closeError = new Error('disk full');
    const runLogService = {
      dataDir: '',
      openRunLogs: vi.fn(async () => ({
        stdout: vi.fn(),
        stderr: vi.fn(),
        debugEvent: vi.fn(),
        close: vi.fn(async () => {
          throw closeError;
        }),
      })),
      getRunLogs: vi.fn(),
      getRunLogDownload: vi.fn(),
      pruneExpiredLogs: vi.fn(),
    } satisfies RunLogService;
    const { root, config, persistence, workspace, workspaceCwd, service, runners, runNextTimer } = await setup({
      daemonLogger,
      runLogService,
    });
    writeSkill(root);

    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        prompt: 'Write the report.',
        skillId: 'report-writer',
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);
    writeFileSync(path.join(workspaceCwd, 'output', 'report.docx'), 'docx');

    runners[0]!.complete({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
    });
    await flushAsync();

    await vi.waitFor(async () => {
      expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.status).toBe('succeeded');
    });
    const detail = (await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }));
    const events = detail?.messages[1]?.events as Array<{ type: string; code?: string }>;
    const eventTypes = events.map((event) => event.type);
    expect(detail?.run.status).toBe('succeeded');
    expect(eventTypes).toEqual(expect.arrayContaining(['artifact_finalized', 'warning', 'end']));
    expect(eventTypes.indexOf('artifact_finalized')).toBeLessThan(eventTypes.indexOf('warning'));
    expect(eventTypes.indexOf('warning')).toBeLessThan(eventTypes.indexOf('end'));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        code: 'RUN_LOG_WRITE_FAILED',
      }),
    );
    expect(daemonLogger.warn).toHaveBeenCalledWith('run_log_write_failed', {
      error: closeError,
      runId: 'run_1',
    });
  });

  it('persists a run log close timeout warning before terminal end without changing final status', async () => {
    const daemonLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(async () => {}),
    };
    const closeDeferred = createDeferred<void>();
    const close = vi.fn(() => closeDeferred.promise);
    const runLogService = {
      dataDir: '',
      openRunLogs: vi.fn(async () => ({
        stdout: vi.fn(),
        stderr: vi.fn(),
        debugEvent: vi.fn(),
        close,
      })),
      getRunLogs: vi.fn(),
      getRunLogDownload: vi.fn(),
      pruneExpiredLogs: vi.fn(),
    } satisfies RunLogService;
    const { root, config, persistence, workspace, workspaceCwd, service, runners, runNextTimer } = await setup({
      daemonLogger,
      runLogService,
      configure: (config) => {
        config.server.runLogCloseTimeoutMs = 25;
      },
    });
    writeSkill(root);

    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        prompt: 'Write the report.',
        skillId: 'report-writer',
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);
    writeFileSync(path.join(workspaceCwd, 'output', 'report.docx'), 'docx');

    runners[0]!.complete({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
    });
    await flushAsync();

    expect(close).toHaveBeenCalledTimes(1);
    expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.status).toBe('running');

    runNextTimer();
    await vi.waitFor(async () => {
      expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.status).toBe('succeeded');
    });

    const detail = await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' });
    const events = detail?.messages[1]?.events as Array<{ type: string; code?: string }>;
    const eventTypes = events.map((event) => event.type);
    expect(detail?.run.status).toBe('succeeded');
    expect(eventTypes).toEqual(expect.arrayContaining(['artifact_finalized', 'warning', 'end']));
    expect(eventTypes.indexOf('artifact_finalized')).toBeLessThan(eventTypes.indexOf('warning'));
    expect(eventTypes.indexOf('warning')).toBeLessThan(eventTypes.indexOf('end'));
    expect(events).toContainEqual(expect.objectContaining({ type: 'warning', code: 'RUN_LOG_WRITE_TIMEOUT' }));
    expect(daemonLogger.warn).toHaveBeenCalledWith('run_log_write_timeout', {
      runId: 'run_1',
      timeoutMs: 25,
    });
  });

  it('ignores a close rejection that arrives after the close timeout already finalized the run', async () => {
    const daemonLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(async () => {}),
    };
    const closeDeferred = createDeferred<void>();
    const close = vi.fn(() => closeDeferred.promise);
    const runLogService = {
      dataDir: '',
      openRunLogs: vi.fn(async () => ({
        stdout: vi.fn(),
        stderr: vi.fn(),
        debugEvent: vi.fn(),
        close,
      })),
      getRunLogs: vi.fn(),
      getRunLogDownload: vi.fn(),
      pruneExpiredLogs: vi.fn(),
    } satisfies RunLogService;
    const { config, persistence, workspace, service, runners, runNextTimer } = await setup({
      daemonLogger,
      runLogService,
      configure: (config) => {
        config.server.runLogCloseTimeoutMs = 25;
      },
    });

    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Run.',
        artifactRuleIds: [],
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);
    runners[0]!.complete({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
    });
    await flushAsync();
    runNextTimer();

    await vi.waitFor(async () => {
      expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.status).toBe('succeeded');
    });
    closeDeferred.reject(new Error('late close failure'));
    await flushAsync();

    const detail = await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' });
    const events = detail?.messages[1]?.events as Array<{ type: string; code?: string }>;
    expect(detail?.run.status).toBe('succeeded');
    expect(events.filter((event) => event.code === 'RUN_LOG_WRITE_TIMEOUT')).toHaveLength(1);
    expect(events).not.toContainEqual(expect.objectContaining({ code: 'RUN_LOG_WRITE_FAILED' }));
    expect(daemonLogger.warn).toHaveBeenCalledTimes(1);
    expect(daemonLogger.warn).toHaveBeenCalledWith('run_log_write_timeout', {
      runId: 'run_1',
      timeoutMs: 25,
    });
  });

  it('persists terminal end after successful run log close without a warning', async () => {
    const close = vi.fn(async () => {});
    const runLogService = {
      dataDir: '',
      openRunLogs: vi.fn(async () => ({
        stdout: vi.fn(),
        stderr: vi.fn(),
        debugEvent: vi.fn(),
        close,
      })),
      getRunLogs: vi.fn(),
      getRunLogDownload: vi.fn(),
      pruneExpiredLogs: vi.fn(),
    } satisfies RunLogService;
    const { config, persistence, workspace, service, runners, runNextTimer } = await setup({ runLogService });

    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Run.',
        artifactRuleIds: [],
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);
    runners[0]!.complete({ status: 'succeeded', exitCode: 0, signal: null, stdoutTail: '', stderrTail: '' });

    await vi.waitFor(async () => {
      expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.status).toBe('succeeded');
    });

    const events = (await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.messages[1]
      ?.events as Array<{ type: string }>;
    expect(close).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toContain('end');
    expect(events.map((event) => event.type)).not.toContain('warning');
  });

  it('ignores runner events emitted after terminal end is persisted', async () => {
    const { config, persistence, workspace, service, runners, runNextTimer } = await setup();
    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Run.',
        artifactRuleIds: [],
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);
    runners[0]!.complete({ status: 'succeeded', exitCode: 0, signal: null, stdoutTail: '', stderrTail: '' });

    await vi.waitFor(async () => {
      expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.status).toBe('succeeded');
    });
    runners[0]!.input.onEvent({ type: 'stderr', text: 'late output after terminal' });
    await flushAsync();

    const events = (await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.messages[1]
      ?.events as Array<{ type: string; text?: string }>;
    expect(events.at(-1)).toMatchObject({ type: 'end' });
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'stderr', text: 'late output after terminal' }));
    await expect(service.replayRunEvents({ client: config.clients[0]!, runId: 'run_1' })).resolves.toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({
          event: { type: 'stderr', text: 'late output after terminal' },
        }),
      ]),
    );
  });

  it('rewrites successful runs to failed when required artifacts are missing', async () => {
    const { root, config, persistence, workspace, service, runners, runNextTimer } = await setup();
    writeSkill(root);
    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate.',
        artifactRuleIds: ['report-docx'],
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);
    runners[0]!.input.onEvent({ type: 'text_delta', delta: 'Draft before artifact check.' });
    runners[0]!.complete({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
    });
    await flushAsync();

    await vi.waitFor(async () => {
      expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run).toMatchObject({
        status: 'failed',
        errorCode: 'ARTIFACT_REQUIRED_MISSING',
      });
    });
    const detail = (await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }));
    expect(detail?.messages[1]).toMatchObject({
      content: 'Draft before artifact check.',
      runStatus: 'failed',
    });
    const eventTypes = (detail?.messages[1]?.events as Array<{ type: string }>).map((event) => event.type);
    expect(eventTypes.slice(-2)).toEqual(['error', 'end']);
  });

  it('fails terminally with ARTIFACT_SCAN_FAILED when artifact finalization throws', async () => {
    const { root, config, persistence, workspace, workspaceCwd, service, runners, runNextTimer } = await setup();
    writeSkill(root);
    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate.',
        artifactRuleIds: ['report-docx'],
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);
    rmSync(workspaceCwd, { recursive: true, force: true });
    runners[0]!.complete({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
    });
    await flushAsync();

    await vi.waitFor(async () => {
      expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run).toMatchObject({
        status: 'failed',
        errorCode: 'ARTIFACT_SCAN_FAILED',
      });
    });
  });

  it('drops in-memory event streams after TTL while durable detail remains', async () => {
    const { config, persistence, workspace, service, runners, runNextTimer } = await setup();
    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Run.',
        artifactRuleIds: [],
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);
    runners[0]!.complete({ status: 'succeeded', exitCode: 0, signal: null, stdoutTail: '', stderrTail: '' });
    await flushAsync();
    await vi.waitFor(async () => {
      expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.status).toBe('succeeded');
    });

    runNextTimer();
    runNextTimer();

    await expect(service.replayRunEvents({ client: config.clients[0]!, runId: 'run_1' })).rejects.toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
    expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.status).toBe('succeeded');
  });

  it('cancels a running run through the runner handle', async () => {
    const { config, persistence, workspace, service, runners, runNextTimer } = await setup();
    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Run.',
        artifactRuleIds: [],
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);

    await expect(service.cancelRun({ client: config.clients[0]!, runId: 'run_1' })).resolves.toEqual({ ok: true });
    expect(runners[0]!.cancel).toHaveBeenCalledTimes(1);
    runners[0]!.complete({
      status: 'canceled',
      exitCode: null,
      signal: 'SIGTERM',
      stdoutTail: '',
      stderrTail: '',
    });
    await flushAsync();

    expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.status).toBe('canceled');
  });

  it('keeps canceled status when run log close times out', async () => {
    const closeDeferred = createDeferred<void>();
    const runLogService = {
      dataDir: '',
      openRunLogs: vi.fn(async () => ({
        stdout: vi.fn(),
        stderr: vi.fn(),
        debugEvent: vi.fn(),
        close: vi.fn(() => closeDeferred.promise),
      })),
      getRunLogs: vi.fn(),
      getRunLogDownload: vi.fn(),
      pruneExpiredLogs: vi.fn(),
    } satisfies RunLogService;
    const { config, persistence, workspace, service, runners, runNextTimer } = await setup({
      runLogService,
      configure: (config) => {
        config.server.runLogCloseTimeoutMs = 25;
      },
    });
    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Run.',
        artifactRuleIds: [],
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);

    await service.cancelRun({ client: config.clients[0]!, runId: 'run_1' });
    runners[0]!.complete({
      status: 'canceled',
      exitCode: null,
      signal: 'SIGTERM',
      stdoutTail: '',
      stderrTail: '',
    });
    await flushAsync();
    runNextTimer();

    await vi.waitFor(async () => {
      expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.status).toBe('canceled');
    });
    const detail = await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' });
    const events = detail?.messages[1]?.events as Array<{ type: string; code?: string; status?: string }>;
    expect(detail?.run.status).toBe('canceled');
    expect(detail?.messages[1]?.runStatus).toBe('canceled');
    expect(events).toContainEqual(expect.objectContaining({ type: 'warning', code: 'RUN_LOG_WRITE_TIMEOUT' }));
    expect(events.at(-1)).toMatchObject({ type: 'end', status: 'canceled' });
  });

  it('clears the run timeout when canceling a running run', async () => {
    const { config, workspace, service, runners, runNextTimer, pendingTimers } = await setup({
      configure: (config) => {
        config.profiles[0]!.runTimeoutMs = 50;
      },
    });
    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Run.',
        artifactRuleIds: [],
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);

    expect(pendingTimers().some((timer) => timer.delayMs === 50)).toBe(true);
    await expect(service.cancelRun({ client: config.clients[0]!, runId: 'run_1' })).resolves.toEqual({ ok: true });

    expect(runners[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(pendingTimers().some((timer) => timer.delayMs === 50)).toBe(false);
  });

  it('fails a running run with RUN_TIMEOUT and cancels the runner', async () => {
    const { config, persistence, workspace, service, runners, runNextTimer, pendingTimers } = await setup({
      configure: (config) => {
        config.profiles[0]!.runTimeoutMs = 50;
      },
    });
    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Run.',
        artifactRuleIds: [],
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);

    expect(pendingTimers().some((timer) => timer.delayMs === 50)).toBe(true);
    runNextTimer();
    await flushAsync();

    expect(runners[0]!.cancel).toHaveBeenCalledTimes(1);
    expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run).toMatchObject({
      status: 'failed',
      errorCode: 'RUN_TIMEOUT',
    });
    await expect(service.replayRunEvents({ client: config.clients[0]!, runId: 'run_1' })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: { type: 'error', code: 'RUN_TIMEOUT', message: 'Run exceeded total timeout.' },
        }),
      ]),
    );
  });

  it('keeps RUN_TIMEOUT failure details when run log close times out', async () => {
    const closeDeferred = createDeferred<void>();
    const runLogService = {
      dataDir: '',
      openRunLogs: vi.fn(async () => ({
        stdout: vi.fn(),
        stderr: vi.fn(),
        debugEvent: vi.fn(),
        close: vi.fn(() => closeDeferred.promise),
      })),
      getRunLogs: vi.fn(),
      getRunLogDownload: vi.fn(),
      pruneExpiredLogs: vi.fn(),
    } satisfies RunLogService;
    const { config, persistence, workspace, service, runners, runNextTimer } = await setup({
      runLogService,
      configure: (config) => {
        config.profiles[0]!.runTimeoutMs = 50;
        config.server.runLogCloseTimeoutMs = 25;
      },
    });
    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Run.',
        artifactRuleIds: [],
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);

    runNextTimer();
    await flushAsync();
    runNextTimer();

    await vi.waitFor(async () => {
      expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.status).toBe('failed');
    });
    const detail = await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' });
    const events = detail?.messages[1]?.events as Array<{ type: string; code?: string; status?: string }>;
    expect(detail?.run).toMatchObject({ status: 'failed', errorCode: 'RUN_TIMEOUT' });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'RUN_TIMEOUT' }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'warning', code: 'RUN_LOG_WRITE_TIMEOUT' }));
    expect(events.at(-1)).toMatchObject({ type: 'end', status: 'failed' });
  });

  it('shutdownActive interrupts queued runs without spawning them', async () => {
    const { config, persistence, workspace, service, runners } = await setup();
    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Run.',
        artifactRuleIds: [],
      },
    });

    await expect(service.shutdownActive()).resolves.toEqual({ interrupted: 1 });

    expect(runners).toHaveLength(0);
    expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run).toMatchObject({
      status: 'interrupted',
      errorCode: 'RUN_INTERRUPTED_BY_DAEMON_RESTART',
    });
    expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.messages[1]).toMatchObject({
      runStatus: 'interrupted',
      endedAt: 5000,
    });
  });

  it('shutdownActive waits up to graceMs for running runner completion before returning', async () => {
    const { config, persistence, workspace, service, runners, runNextTimer, pendingTimers } = await setup();
    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Run.',
        artifactRuleIds: [],
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);

    let settled = false;
    const shutdown = service.shutdownActive({ graceMs: 100 }).then((result) => {
      settled = true;
      return result;
    });
    await flushAsync();

    expect(runners[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    runners[0]!.complete({
      status: 'canceled',
      exitCode: null,
      signal: 'SIGTERM',
      stdoutTail: '',
      stderrTail: '',
    });

    await expect(shutdown).resolves.toEqual({ interrupted: 1 });
    expect(pendingTimers().some((timer) => timer.delayMs === 100)).toBe(false);
    expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run).toMatchObject({
      status: 'interrupted',
      errorCode: 'RUN_INTERRUPTED_BY_DAEMON_RESTART',
    });
  });

  it('shutdownActive cancels all running runs before waiting for graceMs', async () => {
    const { config, persistence, workspace, service, runners, runNextTimer, pendingTimers } = await setup({
      configure: (config) => {
        config.profiles[0]!.profileConcurrency = 2;
      },
    });
    const secondWorkspace = await persistence.upsertWorkspace({
      id: 'ws_2',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_2',
      projectId: 'project_456',
      now: 1000,
    });
    const secondWorkspaceCwd = getWorkspaceCwd(config.profiles[0]!, secondWorkspace);
    mkdirSync(path.join(secondWorkspaceCwd, 'input'), { recursive: true });
    mkdirSync(path.join(secondWorkspaceCwd, 'output'), { recursive: true });
    mkdirSync(path.join(secondWorkspaceCwd, 'work'), { recursive: true });
    mkdirSync(path.join(secondWorkspaceCwd, '.claude-runner-skills'), { recursive: true });

    for (const workspaceId of [workspace.id, secondWorkspace.id]) {
      await service.createRun({
        client: config.clients[0]!,
        request: {
          profileId: 'report-docx',
          workspaceId,
          kind: 'revise',
          prompt: 'Run.',
          artifactRuleIds: [],
        },
      });
    }
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 2);

    const shutdown = service.shutdownActive({ graceMs: 100 });
    await vi.waitFor(() => {
      expect(runners.map((runner) => runner.cancel.mock.calls.length)).toEqual([1, 1]);
    });

    for (const runner of runners) {
      runner.complete({
        status: 'canceled',
        exitCode: null,
        signal: 'SIGTERM',
        stdoutTail: '',
        stderrTail: '',
      });
    }
    await flushAsync();
    if (pendingTimers().some((timer) => timer.delayMs === 100)) {
      runNextTimer();
    }

    await expect(shutdown).resolves.toEqual({ interrupted: 2 });
  });

  it('shutdownActive cancels running runs and clears run timeout timers', async () => {
    const { config, persistence, workspace, service, runners, runNextTimer, pendingTimers } = await setup({
      configure: (config) => {
        config.profiles[0]!.runTimeoutMs = 50;
      },
    });
    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Run.',
        artifactRuleIds: [],
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);
    expect(pendingTimers().some((timer) => timer.delayMs === 50)).toBe(true);

    await expect(service.shutdownActive({ graceMs: 0 })).resolves.toEqual({ interrupted: 1 });

    expect(runners[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(pendingTimers().some((timer) => timer.delayMs === 50)).toBe(false);
    expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run).toMatchObject({
      status: 'interrupted',
      errorCode: 'RUN_INTERRUPTED_BY_DAEMON_RESTART',
      errorMessage: 'Run interrupted by daemon shutdown',
    });
  });

  it('keeps interrupted shutdown details when run log close times out', async () => {
    const closeDeferred = createDeferred<void>();
    const runLogService = {
      dataDir: '',
      openRunLogs: vi.fn(async () => ({
        stdout: vi.fn(),
        stderr: vi.fn(),
        debugEvent: vi.fn(),
        close: vi.fn(() => closeDeferred.promise),
      })),
      getRunLogs: vi.fn(),
      getRunLogDownload: vi.fn(),
      pruneExpiredLogs: vi.fn(),
    } satisfies RunLogService;
    const { config, persistence, workspace, service, runners, runNextTimer } = await setup({
      runLogService,
      configure: (config) => {
        config.server.runLogCloseTimeoutMs = 25;
      },
    });
    await service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Run.',
        artifactRuleIds: [],
      },
    });
    await runScheduledStart(runNextTimer);
    await waitForRunnerCount(runners, 1);

    const shutdown = service.shutdownActive({ graceMs: 0 });
    await flushAsync();
    runNextTimer();

    await expect(shutdown).resolves.toEqual({ interrupted: 1 });
    const detail = await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' });
    const events = detail?.messages[1]?.events as Array<{ type: string; code?: string; status?: string }>;
    expect(detail?.run).toMatchObject({
      status: 'interrupted',
      errorCode: 'RUN_INTERRUPTED_BY_DAEMON_RESTART',
    });
    expect(events).toContainEqual(expect.objectContaining({ type: 'warning', code: 'RUN_LOG_WRITE_TIMEOUT' }));
    expect(events.at(-1)).toMatchObject({ type: 'end', status: 'interrupted' });
  });
});
