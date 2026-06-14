import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseDaemonConfig, type DaemonConfig } from '../../src/config/profiles.js';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import {
  getProfileSnapshotForRun,
  getRunContextSnapshot,
  getRunDetail,
  getRunPromptSnapshot,
  getRunSkillSnapshot,
  upsertWorkspace,
} from '../../src/db/repositories.js';
import { applySchema } from '../../src/db/schema.js';
import { DaemonError } from '../../src/core/errors.js';
import {
  buildClaudeRunInvocation,
  createRunService,
  type RunServiceRunnerFactory,
} from '../../src/core/run-service.js';
import type { ClaudeCliRunResult } from '../../src/core/cli-runner.js';
import { getWorkspaceCwd } from '../../src/core/workspace-service.js';

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
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function setup(
  options: {
    capabilities?: Parameters<RunServiceRunnerFactory>[0]['capabilities'];
    configure?: (config: DaemonConfig) => void;
  } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-service-test-'));
  const config = makeConfig(root);
  options.configure?.(config);
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

  return { root, config, db, workspace, workspaceCwd, service, runners, ...timerHarness };
}

async function runScheduledStart(runNextTimer: () => unknown): Promise<void> {
  runNextTimer();
  await flushAsync();
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
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

describe('run service', () => {
  it('creates durable queued run data before starting the fake runner', async () => {
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

    expect(result).toEqual({
      runId: 'run_1',
      status: 'queued',
      conversationId: 'conv_1',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
    });
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

    await runScheduledStart(runNextTimer);
    expect(runners).toHaveLength(1);
  });

  it('replays an existing run for the same idempotency key and fingerprint', () => {
    const { config, workspace, service, runners, pendingTimers } = setup();

    const first = service.createRun({
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
    const second = service.createRun({
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

  it('replays an existing idempotency key before queue capacity checks', () => {
    const { config, workspace, service } = setup({
      configure: (config) => {
        config.server.globalConcurrency = 1;
        config.server.maxQueueSize = 0;
      },
    });

    const first = service.createRun({
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
    const replay = service.createRun({
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
    const { config, workspace, service } = setup();

    const request = {
      profileId: 'report-docx',
      workspaceId: workspace.id,
      kind: 'generate' as const,
      skillId: 'report-writer',
      prompt: 'Generate the report.',
      artifactRuleIds: ['report-docx'],
      idempotencyKey: 'dispatch:1',
    };
    const first = service.createRun({
      client: config.clients[0]!,
      request,
    });

    await service.shutdownActive();
    const replay = service.createRun({
      client: config.clients[0]!,
      request,
    });

    expect(replay.runId).toBe(first.runId);
    expect(replay.status).toBe('interrupted');
    expect(replay.idempotentReplay).toBe(true);
  });

  it('rejects reuse of an idempotency key with different run parameters', () => {
    const { config, workspace, service } = setup();

    service.createRun({
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

    expect(() =>
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
    ).toThrow(expect.objectContaining({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      status: 409,
    }));
  });

  it('creates a new run when idempotency key changes', () => {
    const { config, workspace, service } = setup();

    const first = service.createRun({
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
    const second = service.createRun({
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

  it('does not apply idempotency when no idempotency key is provided', () => {
    const { config, workspace, service } = setup();

    const first = service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Revise.',
      },
    });
    const second = service.createRun({
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

  it('rejects explicit conversation ids owned by a different workspace before inserting a run', () => {
    const { config, db, workspace, service } = setup();
    const otherWorkspace = upsertWorkspace(db, {
      id: 'ws_2',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_2',
      projectId: 'project_123',
      now: 1000,
    });
    const otherRun = service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: otherWorkspace.id,
        kind: 'revise',
        prompt: 'Create the other conversation.',
        artifactRuleIds: [],
      },
    });

    expect(() =>
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
    ).toThrow(expect.objectContaining({ code: 'BAD_REQUEST', status: 400 }));
    expect(getRunDetail(db, { runId: 'run_2', clientId: 'lqbot' })).toBeNull();
  });

  it('rejects collection modes above the profile cap before inserting a run', () => {
    const { config, db, workspace, service } = setup();

    expect(() =>
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
    ).toThrow(expect.objectContaining({ code: 'COLLECTION_MODE_NOT_ALLOWED', status: 403 }));
    expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })).toBeNull();
  });

  it('stores business context snapshots at create time even if the queued run is canceled', () => {
    const { config, db, workspace, service } = setup({
      configure: (config) => {
        config.profiles[0]!.maxCollectionMode = 'diagnostic';
      },
    });

    service.createRun({
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

    expect(service.cancelRun({ client: config.clients[0]!, runId: 'run_1' })).toEqual({ ok: true });
    expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run).toMatchObject({
      status: 'canceled',
      promptMode: 'business-context',
      collectionMode: 'diagnostic',
      businessContextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(getRunContextSnapshot(db, 'run_1')).toMatchObject({
      businessContextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      persisted: true,
      businessContext: expect.objectContaining({ stage: 'initial' }),
    });
    expect(getRunPromptSnapshot(db, 'run_1')).toBeNull();
  });

  it('does not grant allowed input roots to Claude --add-dir in Phase 1', () => {
    const { config, workspace, root } = setup();

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

  it('rejects disallowed generate skill ids synchronously without inserting a run', () => {
    const { config, db, workspace, service } = setup();

    expect(() =>
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
    ).toThrow(expect.objectContaining({ code: 'SKILL_NOT_ALLOWED', status: 400 }));
    expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })).toBeNull();
  });

  it('fails an allowlisted but unavailable generate skill as a durable run', async () => {
    const { config, db, workspace, service, runners, runNextTimer } = setup();

    expect(
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
    ).toEqual(expect.objectContaining({ runId: 'run_1', status: 'queued' }));

    await runScheduledStart(runNextTimer);

    expect(runners).toHaveLength(0);
    await vi.waitFor(() => {
      expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run).toMatchObject({
        status: 'failed',
        errorCode: 'SKILL_UNAVAILABLE',
      });
    });
  });

  it('stages side-file skills for generate and grants only the staged skill dir', async () => {
    const { root, config, workspace, workspaceCwd, service, runners, runNextTimer } = setup();
    writeSkill(root, { sideFiles: true });

    service.createRun({
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
    await vi.waitFor(() => expect(runners).toHaveLength(1));
    expect(runners[0]!.input.prompt).toContain('Use references/style.md to write the report.');
    expect(runners[0]!.input.prompt).toContain('.claude-runner-skills/report-writer/');
    expect(runners[0]!.input.extraAllowedDirs).toEqual([stagedDir]);
    expect(runners[0]!.input.extraAllowedDirs?.join('\0')).not.toContain(path.join(root, 'uploads'));
    expect(runners[0]!.input.extraAllowedDirs?.join('\0')).not.toContain(path.join(root, 'skills'));
  });

  it('does not stage generate skills that have no side files', async () => {
    const { root, config, workspace, service, runners, runNextTimer } = setup();
    writeSkill(root);

    service.createRun({
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

    await vi.waitFor(() => expect(runners).toHaveLength(1));
    expect(runners[0]!.input.prompt).toContain('Use references/style.md to write the report.');
    expect(runners[0]!.input.prompt).not.toContain('Skill root');
    expect(runners[0]!.input.extraAllowedDirs).toEqual([]);
  });

  it('injects skill instructions and persists diagnostic snapshots for business-context revise runs', async () => {
    const { root, config, db, workspace, service, runners, runNextTimer } = setup({
      configure: (config) => {
        config.profiles[0]!.maxCollectionMode = 'diagnostic';
      },
    });
    writeSkill(root, { sideFiles: true });

    service.createRun({
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

    await vi.waitFor(() => expect(runners).toHaveLength(1));
    expect(runners[0]!.input.prompt).toContain('## Business context');
    expect(runners[0]!.input.prompt).toContain('"previousRunId": "run_previous"');
    expect(runners[0]!.input.prompt).toContain('Use references/style.md to write the report.');
    expect(runners[0]!.input.prompt).toContain('Continue after the question-form answers.');
    expect(getRunPromptSnapshot(db, 'run_1')).toMatchObject({
      promptSnapshot: expect.stringContaining('## Business context'),
      persisted: true,
    });
    expect(getRunSkillSnapshot(db, 'run_1')).toMatchObject({
      skillId: 'report-writer',
      skillBody: expect.stringContaining('Use references/style.md'),
      sideFilesManifest: expect.arrayContaining([
        expect.objectContaining({ relativePath: 'references/style.md' }),
      ]),
      persisted: true,
    });
  });

  it('composes daemon-composed revise prompts from prior conversation messages in stable order', async () => {
    const { config, db, workspace, service, runners, runNextTimer } = setup();

    const first = service.createRun({
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
    runners[0]!.input.onEvent({ type: 'text_delta', delta: 'First summary.' });
    runners[0]!.complete({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
    });
    await flushAsync();

    service.createRun({
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

    expect(runners).toHaveLength(2);
    expect(runners[1]!.input.prompt).toContain('## Conversation context');
    expect(runners[1]!.input.prompt).toContain('"role": "user"');
    expect(runners[1]!.input.prompt).toContain('Summarize the first document.');
    expect(runners[1]!.input.prompt).toContain('First summary.');
    expect(runners[1]!.input.prompt).toContain('## Current user request');
    expect(runners[1]!.input.prompt).toContain('Continue from that summary.');
    expect(runners[1]!.input.prompt).not.toContain('queued');
    expect(getRunDetail(db, { runId: 'run_2', clientId: 'lqbot' })?.messages[0]).toMatchObject({
      content: 'Continue from that summary.',
      conversationId: first.conversationId,
      conversationSeq: 3,
    });
  });

  it('fails generate runs durably when skill staging fails before spawn', async () => {
    const { root, config, db, workspace, workspaceCwd, service, runners, runNextTimer } = setup();
    writeSkill(root, { sideFiles: true });
    rmSync(path.join(workspaceCwd, '.claude-runner-skills'), { recursive: true, force: true });
    writeFileSync(path.join(workspaceCwd, '.claude-runner-skills'), 'not a directory');

    service.createRun({
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
    await vi.waitFor(() => {
      expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run).toMatchObject({
        status: 'failed',
        errorCode: 'SKILL_STAGING_FAILED',
      });
    });
  });

  it('queues a second run for the same workspace until the first terminalizes', async () => {
    const { config, db, workspace, service, runners, runNextTimer } = setup({
      configure: (config) => {
        config.server.globalConcurrency = 2;
        config.profiles[0]!.profileConcurrency = 2;
      },
    });
    service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'One.', artifactRuleIds: [] },
    });
    await runScheduledStart(runNextTimer);

    service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'Two.', artifactRuleIds: [] },
    });
    await runScheduledStart(runNextTimer);

    expect(runners).toHaveLength(1);
    expect(getRunDetail(db, { runId: 'run_2', clientId: 'lqbot' })?.run.status).toBe('queued');

    runners[0]!.complete({ status: 'succeeded', exitCode: 0, signal: null, stdoutTail: '', stderrTail: '' });
    await flushAsync();
    runNextTimer();
    await flushAsync();

    expect(runners).toHaveLength(2);
    expect(getRunDetail(db, { runId: 'run_2', clientId: 'lqbot' })?.run.status).toBe('running');
  });

  it('enforces global concurrency across different workspaces', async () => {
    const { config, db, workspace, service, runners, runNextTimer } = setup({
      configure: (config) => {
        config.server.globalConcurrency = 1;
        config.profiles[0]!.profileConcurrency = 2;
      },
    });
    const otherWorkspace = upsertWorkspace(db, {
      id: 'ws_2',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_2',
      projectId: 'project_123',
      now: 1000,
    });

    service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'One.', artifactRuleIds: [] },
    });
    await runScheduledStart(runNextTimer);
    service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: otherWorkspace.id, kind: 'revise', prompt: 'Two.', artifactRuleIds: [] },
    });
    await runScheduledStart(runNextTimer);

    expect(runners).toHaveLength(1);
    expect(getRunDetail(db, { runId: 'run_2', clientId: 'lqbot' })?.run.status).toBe('queued');
  });

  it('does not let a workspace-blocked queued run block a later eligible workspace', async () => {
    const { config, db, workspace, service, runners, runNextTimer } = setup({
      configure: (config) => {
        config.server.globalConcurrency = 2;
        config.profiles[0]!.profileConcurrency = 2;
      },
    });
    const otherWorkspace = upsertWorkspace(db, {
      id: 'ws_2',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_2',
      projectId: 'project_123',
      now: 1000,
    });

    service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'One.', artifactRuleIds: [] },
    });
    await runScheduledStart(runNextTimer);
    service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'Two.', artifactRuleIds: [] },
    });
    service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: otherWorkspace.id, kind: 'revise', prompt: 'Three.', artifactRuleIds: [] },
    });
    runNextTimer();
    await flushAsync();

    expect(runners.map((runner) => runner.input.run.id)).toEqual(['run_1', 'run_3']);
    expect(getRunDetail(db, { runId: 'run_2', clientId: 'lqbot' })?.run.status).toBe('queued');
  });

  it('allows different profiles to run concurrently when global capacity is available', async () => {
    const { config, db, workspace, service, runners, runNextTimer } = setup({
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
    const secondProfileWorkspace = upsertWorkspace(db, {
      id: 'ws_2',
      clientId: 'lqbot',
      profileId: 'summary-docx',
      originId: 'lqbot',
      userId: 'user_2',
      projectId: 'project_123',
      now: 1000,
    });

    service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'One.', artifactRuleIds: [] },
    });
    await runScheduledStart(runNextTimer);
    service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'summary-docx', workspaceId: secondProfileWorkspace.id, kind: 'revise', prompt: 'Two.', artifactRuleIds: [] },
    });
    await runScheduledStart(runNextTimer);

    expect(runners.map((runner) => runner.input.profile.id)).toEqual(['report-docx', 'summary-docx']);
  });

  it('returns RUN_QUEUE_FULL before inserting when a waiting run would exceed maxQueueSize', async () => {
    const { config, db, workspace, service, runNextTimer } = setup({
      configure: (config) => {
        config.server.globalConcurrency = 1;
        config.server.maxQueueSize = 0;
      },
    });
    const otherWorkspace = upsertWorkspace(db, {
      id: 'ws_2',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_2',
      projectId: 'project_123',
      now: 1000,
    });

    service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'One.', artifactRuleIds: [] },
    });
    await runScheduledStart(runNextTimer);

    expect(() =>
      service.createRun({
        client: config.clients[0]!,
        request: { profileId: 'report-docx', workspaceId: otherWorkspace.id, kind: 'revise', prompt: 'Two.', artifactRuleIds: [] },
      }),
    ).toThrow(expect.objectContaining({ code: 'RUN_QUEUE_FULL', status: 429 }));
    expect(getRunDetail(db, { runId: 'run_2', clientId: 'lqbot' })).toBeNull();
  });

  it('counts earlier queued runs when checking maxQueueSize before dispatch has started', () => {
    const { config, db, workspace, service } = setup({
      configure: (config) => {
        config.server.globalConcurrency = 1;
        config.server.maxQueueSize = 0;
      },
    });
    const otherWorkspace = upsertWorkspace(db, {
      id: 'ws_2',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_2',
      projectId: 'project_123',
      now: 1000,
    });

    service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'One.', artifactRuleIds: [] },
    });

    expect(() =>
      service.createRun({
        client: config.clients[0]!,
        request: { profileId: 'report-docx', workspaceId: otherWorkspace.id, kind: 'revise', prompt: 'Two.', artifactRuleIds: [] },
      }),
    ).toThrow(expect.objectContaining({ code: 'RUN_QUEUE_FULL', status: 429 }));
    expect(getRunDetail(db, { runId: 'run_2', clientId: 'lqbot' })).toBeNull();
  });

  it('cancels a queued run without spawning and dispatches the next eligible run', async () => {
    const { config, db, workspace, service, runners, runNextTimer } = setup({
      configure: (config) => {
        config.server.globalConcurrency = 1;
        config.server.maxQueueSize = 10;
        config.profiles[0]!.profileConcurrency = 2;
      },
    });
    const ws2 = upsertWorkspace(db, {
      id: 'ws_2',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_2',
      projectId: 'project_123',
      now: 1000,
    });
    const ws3 = upsertWorkspace(db, {
      id: 'ws_3',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_3',
      projectId: 'project_123',
      now: 1000,
    });

    service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: workspace.id, kind: 'revise', prompt: 'One.', artifactRuleIds: [] },
    });
    await runScheduledStart(runNextTimer);
    service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: ws2.id, kind: 'revise', prompt: 'Two.', artifactRuleIds: [] },
    });
    service.createRun({
      client: config.clients[0]!,
      request: { profileId: 'report-docx', workspaceId: ws3.id, kind: 'revise', prompt: 'Three.', artifactRuleIds: [] },
    });

    expect(service.cancelRun({ client: config.clients[0]!, runId: 'run_2' })).toEqual({ ok: true });
    expect(getRunDetail(db, { runId: 'run_2', clientId: 'lqbot' })?.run.status).toBe('canceled');
    expect(getRunDetail(db, { runId: 'run_2', clientId: 'lqbot' })?.messages[1]).toMatchObject({
      runStatus: 'canceled',
      endedAt: 5000,
    });
    expect(runners).toHaveLength(1);

    runners[0]!.complete({ status: 'succeeded', exitCode: 0, signal: null, stdoutTail: '', stderrTail: '' });
    await flushAsync();
    runNextTimer();
    await flushAsync();

    expect(runners).toHaveLength(2);
    expect(runners[1]!.input.run.id).toBe('run_3');
  });

  it('passes probed capabilities to the runner and replays numeric event ids', async () => {
    const { config, db, workspace, service, runners, runNextTimer } = setup({
      capabilities: { partialMessages: true },
    });
    service.createRun({
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

    expect(runners[0]!.input.capabilities).toEqual({ partialMessages: true });
    runners[0]!.input.onEvent({ type: 'text_delta', delta: 'hello' });

    expect(service.replayRunEvents({ client: config.clients[0]!, runId: 'run_1', after: '2' })).toEqual([
      { id: '3', event: { type: 'text_delta', delta: 'hello' } },
    ]);
    expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run.lastRunEventId).toBeNull();
  });

  it('flushes messages and marks run terminal when the runner completes', async () => {
    const { config, db, workspace, service, runners, runNextTimer } = setup();
    service.createRun({
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
    runners[0]!.input.onEvent({ type: 'text_delta', delta: 'Done.' });
    runners[0]!.complete({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
    });
    await flushAsync();

    await vi.waitFor(() => {
      expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run).toMatchObject({
        status: 'succeeded',
        exitCode: 0,
        finishedAt: 5000,
        lastRunEventId: '4',
      });
    });
    const detail = getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' });
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

  it('persists separate assistant messages for separate Claude assistant message starts', async () => {
    const { config, db, workspace, service, runners, runNextTimer } = setup();
    service.createRun({
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

    await vi.waitFor(() => {
      expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run.status).toBe('succeeded');
    });
    const detail = getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' });
    expect(detail?.messages).toEqual([
      expect.objectContaining({ id: 'msg_user', role: 'user', position: 0, content: 'Run.' }),
      expect.objectContaining({ id: 'msg_assistant', role: 'assistant', position: 1, content: 'First.' }),
      expect.objectContaining({ id: 'msg_assistant_2', role: 'assistant', position: 2, content: 'Second.' }),
    ]);
    expect(detail?.messages.slice(1).map((message) => message.runStatus)).toEqual(['succeeded', 'succeeded']);
  });

  it('persists artifact events before terminal end on successful generate', async () => {
    const { root, config, db, workspace, workspaceCwd, service, runners, runNextTimer } = setup();
    writeSkill(root);
    service.createRun({
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
    await vi.waitFor(() => expect(runners).toHaveLength(1));
    writeFileSync(path.join(workspaceCwd, 'output', 'report.docx'), 'docx');
    runners[0]!.complete({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
    });
    await flushAsync();

    await vi.waitFor(() => {
      expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run.status).toBe('succeeded');
    });
    const detail = getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' });
    expect(detail?.run.status).toBe('succeeded');
    const eventTypes = (detail?.messages[1]?.events as Array<{ type: string }>).map((event) => event.type);
    expect(eventTypes).toEqual(expect.arrayContaining(['artifact_finalized', 'end']));
    expect(eventTypes.indexOf('artifact_finalized')).toBeLessThan(eventTypes.indexOf('end'));
  });

  it('rewrites successful runs to failed when required artifacts are missing', async () => {
    const { root, config, db, workspace, service, runners, runNextTimer } = setup();
    writeSkill(root);
    service.createRun({
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
    await vi.waitFor(() => expect(runners).toHaveLength(1));
    runners[0]!.input.onEvent({ type: 'text_delta', delta: 'Draft before artifact check.' });
    runners[0]!.complete({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
    });
    await flushAsync();

    await vi.waitFor(() => {
      expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run).toMatchObject({
        status: 'failed',
        errorCode: 'ARTIFACT_REQUIRED_MISSING',
      });
    });
    const detail = getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' });
    expect(detail?.messages[1]).toMatchObject({
      content: 'Draft before artifact check.',
      runStatus: 'failed',
    });
    const eventTypes = (detail?.messages[1]?.events as Array<{ type: string }>).map((event) => event.type);
    expect(eventTypes.slice(-2)).toEqual(['error', 'end']);
  });

  it('fails terminally with ARTIFACT_SCAN_FAILED when artifact finalization throws', async () => {
    const { root, config, db, workspace, workspaceCwd, service, runners, runNextTimer } = setup();
    writeSkill(root);
    service.createRun({
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
    await vi.waitFor(() => expect(runners).toHaveLength(1));
    rmSync(workspaceCwd, { recursive: true, force: true });
    runners[0]!.complete({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
    });
    await flushAsync();

    await vi.waitFor(() => {
      expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run).toMatchObject({
        status: 'failed',
        errorCode: 'ARTIFACT_SCAN_FAILED',
      });
    });
  });

  it('drops in-memory event streams after TTL while durable detail remains', async () => {
    const { config, db, workspace, service, runners, runNextTimer } = setup();
    service.createRun({
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
    runners[0]!.complete({ status: 'succeeded', exitCode: 0, signal: null, stdoutTail: '', stderrTail: '' });
    await flushAsync();
    await vi.waitFor(() => {
      expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run.status).toBe('succeeded');
    });

    runNextTimer();
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
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'revise',
        prompt: 'Run.',
        artifactRuleIds: [],
      },
    });
    await runScheduledStart(runNextTimer);

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

  it('clears the run timeout when canceling a running run', async () => {
    const { config, workspace, service, runners, runNextTimer, pendingTimers } = setup({
      configure: (config) => {
        config.profiles[0]!.runTimeoutMs = 50;
      },
    });
    service.createRun({
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

    expect(pendingTimers().some((timer) => timer.delayMs === 50)).toBe(true);
    expect(service.cancelRun({ client: config.clients[0]!, runId: 'run_1' })).toEqual({ ok: true });

    expect(runners[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(pendingTimers().some((timer) => timer.delayMs === 50)).toBe(false);
  });

  it('fails a running run with RUN_TIMEOUT and cancels the runner', async () => {
    const { config, db, workspace, service, runners, runNextTimer, pendingTimers } = setup({
      configure: (config) => {
        config.profiles[0]!.runTimeoutMs = 50;
      },
    });
    service.createRun({
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

    expect(pendingTimers().some((timer) => timer.delayMs === 50)).toBe(true);
    runNextTimer();
    await flushAsync();

    expect(runners[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run).toMatchObject({
      status: 'failed',
      errorCode: 'RUN_TIMEOUT',
    });
    expect(service.replayRunEvents({ client: config.clients[0]!, runId: 'run_1' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: { type: 'error', code: 'RUN_TIMEOUT', message: 'Run exceeded total timeout.' },
        }),
      ]),
    );
  });

  it('shutdownActive interrupts queued runs without spawning them', async () => {
    const { config, db, workspace, service, runners } = setup();
    service.createRun({
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
    expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run).toMatchObject({
      status: 'interrupted',
      errorCode: 'RUN_INTERRUPTED_BY_DAEMON_RESTART',
    });
    expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.messages[1]).toMatchObject({
      runStatus: 'interrupted',
      endedAt: 5000,
    });
  });

  it('shutdownActive waits up to graceMs for running runner completion before returning', async () => {
    const { config, db, workspace, service, runners, runNextTimer, pendingTimers } = setup();
    service.createRun({
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
    expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run).toMatchObject({
      status: 'interrupted',
      errorCode: 'RUN_INTERRUPTED_BY_DAEMON_RESTART',
    });
  });

  it('shutdownActive cancels all running runs before waiting for graceMs', async () => {
    const { config, db, workspace, service, runners, runNextTimer, pendingTimers } = setup({
      configure: (config) => {
        config.profiles[0]!.profileConcurrency = 2;
      },
    });
    const secondWorkspace = upsertWorkspace(db, {
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
      service.createRun({
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
    expect(runners).toHaveLength(2);

    const shutdown = service.shutdownActive({ graceMs: 100 });
    await flushAsync();
    const cancelCountsBeforeGrace = runners.map((runner) => runner.cancel.mock.calls.length);

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
    expect(cancelCountsBeforeGrace).toEqual([1, 1]);
  });

  it('shutdownActive cancels running runs and clears run timeout timers', async () => {
    const { config, db, workspace, service, runners, runNextTimer, pendingTimers } = setup({
      configure: (config) => {
        config.profiles[0]!.runTimeoutMs = 50;
      },
    });
    service.createRun({
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
    expect(pendingTimers().some((timer) => timer.delayMs === 50)).toBe(true);

    await expect(service.shutdownActive({ graceMs: 0 })).resolves.toEqual({ interrupted: 1 });

    expect(runners[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(pendingTimers().some((timer) => timer.delayMs === 50)).toBe(false);
    expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run).toMatchObject({
      status: 'interrupted',
      errorCode: 'RUN_INTERRUPTED_BY_DAEMON_RESTART',
      errorMessage: 'Run interrupted by daemon shutdown',
    });
  });
});
