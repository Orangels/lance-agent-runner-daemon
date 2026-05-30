import { requireProfileAccess } from '../config/auth.js';
import {
  getProfile,
  isModelAllowed,
  type ClientConfig,
  type DaemonConfig,
  type ProfileConfig,
} from '../config/profiles.js';
import type { RunnerDatabase } from '../db/connection.js';
import {
  WorkspaceRunActiveRepositoryError,
  createRunQueuedWithMessagesAndSnapshot,
  getRunDetail,
  getRunForClient,
  getWorkspaceForClient,
  listRunsForClient,
  updateRunStarted,
  updateRunTerminal,
  type RunDetailRecord,
  type RunRecord,
  type RunMessageRecord,
  type WorkspaceRecord,
} from '../db/repositories.js';
import { buildClaudeInvocation, type ClaudeInvocation } from './claude-adapter.js';
import {
  probeClaudeCapabilities,
  type ClaudeCapabilities,
} from './claude-capabilities.js';
import { startClaudeCliRun, type ClaudeCliRunHandle, type ClaudeCliRunResult } from './cli-runner.js';
import { badRequest, daemonError, notFound } from './errors.js';
import { createId } from './ids.js';
import { createMessageAccumulator } from './message-accumulator.js';
import { createSanitizedProfileSnapshot } from './profile-snapshot.js';
import { formatRunEventId, shouldReplayEventAfter, type RunEvent } from './run-events.js';
import {
  isTerminalRunStatus,
  type CreateRunRequest,
  type EventVisibility,
  type ListRunsQuery,
  type RunStatus,
} from './run-types.js';
import { getWorkspaceCwd } from './workspace-service.js';

export interface BufferedRunEvent {
  id: string;
  event: RunEvent;
}

export interface CreateRunServiceInput {
  config: DaemonConfig;
  db: RunnerDatabase;
  runnerFactory?: RunServiceRunnerFactory;
  capabilityProbe?: (profile: ProfileConfig) => Promise<ClaudeCapabilities>;
  clock?: () => number;
  timer?: RunServiceTimer;
  eventBufferTtlMs?: number;
  maxBufferedEvents?: number;
  ids?: {
    runId?: () => string;
    conversationId?: () => string;
    userMessageId?: () => string;
    assistantMessageId?: () => string;
  };
}

export interface RunService {
  createRun(input: { client: ClientConfig; request: CreateRunRequest }): { runId: string; status: 'queued' };
  listRuns(input: { client: ClientConfig; query?: ListRunsQuery }): RunRecord[];
  getRunDetail(input: { client: ClientConfig; runId: string }): RunDetailRecord;
  getRequestedEventVisibility(runId: string): EventVisibility | undefined;
  replayRunEvents(input: { client: ClientConfig; runId: string; after?: string | null }): BufferedRunEvent[];
  subscribeRunEvents(
    input: { client: ClientConfig; runId: string; after?: string | null },
    listener: (record: BufferedRunEvent) => void,
  ): { replay: BufferedRunEvent[]; terminal: boolean; unsubscribe: () => void };
  cancelRun(input: { client: ClientConfig; runId: string }): { ok: true };
}

export interface RunServiceRunnerInput {
  profile: ProfileConfig;
  workspace: WorkspaceRecord;
  workspaceCwd: string;
  run: RunRecord;
  prompt: string;
  model?: string;
  capabilities?: ClaudeCapabilities;
  onEvent: (event: RunEvent) => void;
}

export type RunServiceRunnerFactory = (input: RunServiceRunnerInput) => ClaudeCliRunHandle;

export interface RunServiceTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timerId: unknown): void;
}

interface RunState {
  runId: string;
  profile: ProfileConfig;
  workspace: WorkspaceRecord;
  prompt: string;
  model?: string;
  requestEventVisibility?: EventVisibility;
  events: BufferedRunEvent[];
  nextEventId: number;
  subscribers: Set<(record: BufferedRunEvent) => void>;
  runner: ClaudeCliRunHandle | null;
  accumulator: ReturnType<typeof createMessageAccumulator> | null;
  assistantMessageId: string;
  terminal: boolean;
  cleanupTimer: unknown;
}

const defaultTimer: RunServiceTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timerId) => clearTimeout(timerId as ReturnType<typeof setTimeout>),
};

export function createRunService(input: CreateRunServiceInput): RunService {
  const now = input.clock ?? Date.now;
  const timer = input.timer ?? defaultTimer;
  const eventBufferTtlMs = input.eventBufferTtlMs ?? 5 * 60_000;
  const maxBufferedEvents = input.maxBufferedEvents ?? 1_000;
  const states = new Map<string, RunState>();
  const capabilitiesByBin = new Map<string, Promise<ClaudeCapabilities>>();
  const nextRunId = input.ids?.runId ?? (() => createId('run'));
  const nextConversationId = input.ids?.conversationId ?? (() => createId('conv'));
  const nextUserMessageId = input.ids?.userMessageId ?? (() => createId('msg'));
  const nextAssistantMessageId = input.ids?.assistantMessageId ?? (() => createId('msg'));
  const runnerFactory = input.runnerFactory ?? defaultRunnerFactory;
  const capabilityProbe =
    input.capabilityProbe ??
    ((profile: ProfileConfig) => probeClaudeCapabilities({ claudeBin: profile.claudeBin }));

  function getCapabilities(profile: ProfileConfig): Promise<ClaudeCapabilities> {
    const cached = capabilitiesByBin.get(profile.claudeBin);
    if (cached) {
      return cached;
    }

    const loaded = capabilityProbe(profile).catch(() => ({}));
    capabilitiesByBin.set(profile.claudeBin, loaded);
    return loaded;
  }

  function emitRunEvent(state: RunState, event: RunEvent): BufferedRunEvent {
    const record = { id: formatRunEventId(state.nextEventId++), event };
    state.events.push(record);
    if (state.events.length > maxBufferedEvents) {
      state.events.splice(0, state.events.length - maxBufferedEvents);
    }

    state.accumulator?.consume(event, record.id);

    for (const subscriber of Array.from(state.subscribers)) {
      subscriber(record);
    }

    return record;
  }

  function scheduleStart(state: RunState): void {
    timer.setTimeout(() => startRun(state), 0);
  }

  async function startRun(state: RunState): Promise<void> {
    if (state.terminal) {
      return;
    }

    const startedAt = now();
    const run = updateRunStarted(input.db, { runId: state.runId, startedAt, now: startedAt });
    state.accumulator = createMessageAccumulator({
      db: input.db,
      messageId: state.assistantMessageId,
      clock: { now },
      timer,
    });
    state.accumulator.startRun({ startedAt });
    emitRunEvent(state, { type: 'status', label: 'running' });
    const capabilities = await getCapabilities(state.profile);
    if (state.terminal) {
      return;
    }

    state.runner = runnerFactory({
      profile: state.profile,
      workspace: state.workspace,
      workspaceCwd: getWorkspaceCwd(state.profile, state.workspace),
      run,
      prompt: state.prompt,
      model: state.model,
      capabilities,
      onEvent: (event) => emitRunEvent(state, event),
    });

    state.runner.completed.then(
      (result) => finishRun(state, result),
      () =>
        finishRun(state, {
          status: 'failed',
          exitCode: 1,
          signal: null,
          errorCode: 'CLAUDE_CLI_FAILED',
          errorMessage: 'Claude CLI failed.',
          stdoutTail: '',
          stderrTail: '',
        }),
    );
  }

  function finishRun(state: RunState, result: ClaudeCliRunResult): void {
    if (state.terminal) {
      return;
    }
    state.terminal = true;

    emitRunEvent(state, { type: 'end', status: result.status });
    const finishedAt = now();
    state.accumulator?.flushTerminal({
      runStatus: result.status,
      endedAt: finishedAt,
    });

    updateRunTerminal(input.db, {
      runId: state.runId,
      status: result.status,
      finishedAt,
      exitCode: result.exitCode,
      signal: result.signal,
      errorCode: result.errorCode ?? null,
      errorMessage: result.errorMessage ?? null,
      usage: state.accumulator?.getUsage() ?? null,
      lastRunEventId: state.events.at(-1)?.id ?? null,
      now: finishedAt,
    });

    if (eventBufferTtlMs >= 0) {
      state.cleanupTimer = timer.setTimeout(() => {
        state.accumulator?.dispose();
        states.delete(state.runId);
      }, eventBufferTtlMs);
    }
  }

  function assertRunReadable(client: ClientConfig, runId: string): RunRecord {
    const run = getRunForClient(input.db, { runId, clientId: client.id, isAdmin: client.isAdmin });
    if (!run) {
      throw notFound('Run not found');
    }
    requireProfileAccess(client, run.profileId);
    return run;
  }

  return {
    createRun({ client, request }) {
      requireProfileAccess(client, request.profileId);
      const profile = getProfile(input.config, request.profileId);
      if (request.kind === 'generate') {
        throw badRequest('kind=generate requires Phase 2 skill support');
      }

      const selectedModel = request.model ?? profile.defaultModel;
      if (!isModelAllowed(profile, selectedModel)) {
        throw daemonError('MODEL_NOT_ALLOWED', `Model is not allowed for profile ${profile.id}`, 400, {
          model: selectedModel,
          profileId: profile.id,
        });
      }

      const workspace = getWorkspaceForClient(input.db, {
        workspaceId: request.workspaceId,
        clientId: client.id,
        isAdmin: client.isAdmin,
      });
      if (!workspace) {
        throw notFound('Workspace not found');
      }
      if (workspace.profileId !== profile.id) {
        throw badRequest('Workspace profile does not match requested profile');
      }

      const runId = nextRunId();
      const assistantMessageId = nextAssistantMessageId();
      const selectedArtifactRuleIds = request.artifactRuleIds ?? profile.defaultArtifactRuleIds;

      let created: {
        run: RunRecord;
        messages: RunMessageRecord[];
      };
      try {
        created = createRunQueuedWithMessagesAndSnapshot(input.db, {
          runId,
          conversationId: nextConversationId(),
          userMessageId: nextUserMessageId(),
          assistantMessageId,
          workspaceId: workspace.id,
          profileId: profile.id,
          clientId: client.id,
          kind: request.kind,
          skillId: request.skillId,
          prompt: request.prompt,
          artifactRuleIds: selectedArtifactRuleIds,
          metadata: request.metadata,
          profileSnapshot: createSanitizedProfileSnapshot(profile, {
            selectedModel,
            selectedArtifactRuleIds,
          }),
          now: now(),
        });
      } catch (error) {
        if (error instanceof WorkspaceRunActiveRepositoryError) {
          throw daemonError('WORKSPACE_RUN_ACTIVE', 'Workspace already has an active run', 409, {
            reason: 'WORKSPACE_RUN_ACTIVE',
          });
        }
        throw error;
      }

      const state: RunState = {
        runId,
        profile,
        workspace,
        prompt: request.prompt,
        model: request.model,
        requestEventVisibility: request.eventVisibility,
        events: [],
        nextEventId: 1,
        subscribers: new Set(),
        runner: null,
        accumulator: null,
        assistantMessageId,
        terminal: false,
        cleanupTimer: null,
      };
      states.set(runId, state);
      emitRunEvent(state, { type: 'status', label: 'queued' });
      scheduleStart(state);

      return { runId: created.run.id, status: 'queued' };
    },

    listRuns({ client, query = {} }) {
      return listRunsForClient(input.db, {
        clientId: client.id,
        isAdmin: client.isAdmin,
        ...query,
      });
    },

    getRunDetail({ client, runId }) {
      requireProfileAccess(client, assertRunReadable(client, runId).profileId);
      const detail = getRunDetail(input.db, {
        runId,
        clientId: client.id,
        isAdmin: client.isAdmin,
      });
      if (!detail) {
        throw notFound('Run not found');
      }
      return detail;
    },

    getRequestedEventVisibility(runId) {
      return states.get(runId)?.requestEventVisibility;
    },

    replayRunEvents({ client, runId, after = null }) {
      assertRunReadable(client, runId);
      const state = states.get(runId);
      if (!state) {
        throw notFound('Run event stream not found');
      }
      return state.events.filter((record) => shouldReplayEventAfter(record.id, after));
    },

    subscribeRunEvents({ client, runId, after = null }, listener) {
      const replay = this.replayRunEvents({ client, runId, after });
      const state = states.get(runId);
      if (!state) {
        throw notFound('Run event stream not found');
      }
      if (state.terminal) {
        return { replay, terminal: true, unsubscribe: () => {} };
      }
      state.subscribers.add(listener);
      return {
        replay,
        terminal: false,
        unsubscribe: () => {
          state.subscribers.delete(listener);
        },
      };
    },

    cancelRun({ client, runId }) {
      const run = assertRunReadable(client, runId);
      if (isTerminalRunStatus(run.status)) {
        throw daemonError('RUN_NOT_CANCELABLE', 'Run is not cancelable', 409);
      }

      const state = states.get(runId);
      if (!state) {
        throw daemonError('RUN_NOT_CANCELABLE', 'Run is not cancelable', 409);
      }

      if (!state.runner) {
        finishRun(state, {
          status: 'canceled',
          exitCode: null,
          signal: null,
          stdoutTail: '',
          stderrTail: '',
        });
        return { ok: true };
      }

      state.runner.cancel();
      return { ok: true };
    },
  };
}

function defaultRunnerFactory(input: RunServiceRunnerInput): ClaudeCliRunHandle {
  const invocation = buildClaudeRunInvocation(input);

  return startClaudeCliRun({
    invocation,
    inactivityTimeoutMs: input.profile.inactivityTimeoutMs,
    cancelGraceMs: input.profile.cancelGraceMs,
    onEvent: input.onEvent,
  });
}

export function buildClaudeRunInvocation(input: RunServiceRunnerInput): ClaudeInvocation {
  return buildClaudeInvocation({
    profile: input.profile,
    prompt: input.prompt,
    workspaceCwd: input.workspaceCwd,
    requestModel: input.model,
    capabilities: input.capabilities,
  });
}
