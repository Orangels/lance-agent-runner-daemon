import { createHash } from 'node:crypto';
import { requireCollectionModeAccess, requireProfileAccess } from '../config/auth.js';
import {
  getProfile,
  isModelAllowed,
  type ClientConfig,
  type DaemonConfig,
  type ProfileConfig,
} from '../config/profiles.js';
import type { RunnerDatabase } from '../db/connection.js';
import {
  createRunQueuedWithMessagesAndSnapshot,
  getConversationForWorkspace,
  getRunByIdempotencyKey,
  getRunDetail,
  getRunForClient,
  getWorkspaceForClient,
  isSqliteUniqueConstraintError,
  listConversationMessagesForPrompt,
  listRunsForClient,
  updateAssistantMessageTerminal,
  updateRunPromptSnapshotFields,
  updateRunStarted,
  updateRunTerminal,
  upsertRunPromptSnapshot,
  upsertRunSkillSnapshot,
  type RunDetailRecord,
  type RunRecord,
  type WorkspaceRecord,
} from '../db/repositories.js';
import { createArtifactService, type ArtifactService } from './artifact-service.js';
import { buildClaudeInvocation, type ClaudeInvocation } from './claude-adapter.js';
import {
  probeClaudeCapabilities,
  type ClaudeCapabilities,
} from './claude-capabilities.js';
import { startClaudeCliRun, type ClaudeCliRunHandle, type ClaudeCliRunResult } from './cli-runner.js';
import {
  buildConversationPromptContext,
  normalizeContextPolicy,
} from './conversation-context.js';
import { badRequest, daemonError, notFound } from './errors.js';
import { createId } from './ids.js';
import { createMessageAccumulator } from './message-accumulator.js';
import { composeRunPrompt } from './prompt-composer.js';
import { createSanitizedProfileSnapshot } from './profile-snapshot.js';
import {
  createTextSnapshot,
  shouldPersistFullSnapshot,
  stableJsonHash,
} from './snapshot-service.js';
import {
  countQueued,
  selectDispatchableCandidates,
  type QueueCandidate,
  type QueueLimits,
} from './run-queue.js';
import {
  createRunLogService,
  type RunLogHandle,
  type RunLogService,
} from './run-log-service.js';
import { formatRunEventId, shouldReplayEventAfter, type RunEvent } from './run-events.js';
import {
  isTerminalRunStatus,
  type ActivePromptMode,
  type CollectionMode,
  type ContextPolicy,
  type CreateRunRequest,
  type EventVisibility,
  type ListRunsQuery,
  type RunKind,
  type RunStatus,
} from './run-types.js';
import {
  assertSkillAllowedForProfile,
  resolveSkillForProfile,
  type SkillRecord,
} from './skill-registry.js';
import { stageSkillIntoWorkspace, type StagedSkill } from './skill-staging.js';
import { getWorkspaceCwd } from './workspace-service.js';

export interface BufferedRunEvent {
  id: string;
  event: RunEvent;
}

export interface CreateRunServiceInput {
  config: DaemonConfig;
  db: RunnerDatabase;
  runnerFactory?: RunServiceRunnerFactory;
  artifactService?: ArtifactService;
  runLogService?: RunLogService;
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
  createRun(input: { client: ClientConfig; request: CreateRunRequest }): CreateRunResult;
  listRuns(input: { client: ClientConfig; query?: ListRunsQuery }): RunRecord[];
  getRunStatus(input: { client: ClientConfig; runId: string }): RunRecord;
  getRunDetail(input: { client: ClientConfig; runId: string }): RunDetailRecord;
  getRequestedEventVisibility(runId: string): EventVisibility | undefined;
  replayRunEvents(input: { client: ClientConfig; runId: string; after?: string | null }): BufferedRunEvent[];
  subscribeRunEvents(
    input: { client: ClientConfig; runId: string; after?: string | null },
    listener: (record: BufferedRunEvent) => void,
  ): { replay: BufferedRunEvent[]; terminal: boolean; unsubscribe: () => void };
  cancelRun(input: { client: ClientConfig; runId: string }): { ok: true };
  shutdownActive(input?: { graceMs?: number }): Promise<{ interrupted: number }>;
}

export interface CreateRunResult {
  runId: string;
  status: RunStatus;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  idempotentReplay?: true;
}

export interface RunServiceRunnerInput {
  profile: ProfileConfig;
  workspace: WorkspaceRecord;
  workspaceCwd: string;
  run: RunRecord;
  prompt: string;
  model?: string;
  capabilities?: ClaudeCapabilities;
  extraAllowedDirs?: string[];
  logSink?: RunLogHandle;
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
  kind: RunKind;
  skillId: string | null;
  artifactRuleIds: string[];
  prompt: string;
  promptMode: ActivePromptMode;
  contextPolicy?: ContextPolicy;
  collectionMode: CollectionMode;
  businessContext?: Record<string, unknown>;
  model?: string;
  requestEventVisibility?: EventVisibility;
  events: BufferedRunEvent[];
  nextEventId: number;
  subscribers: Set<(record: BufferedRunEvent) => void>;
  runner: ClaudeCliRunHandle | null;
  accumulator: ReturnType<typeof createMessageAccumulator> | null;
  logHandle: RunLogHandle | null;
  assistantMessageId: string;
  conversationId: string;
  queueStatus: 'queued' | 'starting' | 'running' | 'finishing' | 'terminal';
  sequence: number;
  runTimeoutTimer: unknown;
  finishing: boolean;
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
  let nextSequence = 1;
  let dispatchTimer: unknown = null;
  let shuttingDown = false;
  const nextRunId = input.ids?.runId ?? (() => createId('run'));
  const nextConversationId = input.ids?.conversationId ?? (() => createId('conv'));
  const nextUserMessageId = input.ids?.userMessageId ?? (() => createId('msg'));
  const nextAssistantMessageId = input.ids?.assistantMessageId ?? (() => createId('msg'));
  const runnerFactory = input.runnerFactory ?? defaultRunnerFactory;
  const artifactService =
    input.artifactService ?? createArtifactService({ config: input.config, db: input.db, clock: now });
  const runLogService = input.runLogService ?? createRunLogService({ config: input.config, db: input.db });
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

  function scheduleDispatch(): void {
    if (shuttingDown) return;
    if (dispatchTimer !== null) return;

    dispatchTimer = timer.setTimeout(() => {
      dispatchTimer = null;
      dispatchQueuedRuns();
    }, 0);
  }

  function dispatchQueuedRuns(): void {
    const selected = selectDispatchableCandidates(queueCandidates(), queueLimits());
    for (const candidate of selected) {
      const state = states.get(candidate.runId);
      if (!state || state.queueStatus !== 'queued' || state.terminal) {
        continue;
      }
      state.queueStatus = 'starting';
      void startRun(state);
    }
  }

  function queueCandidates(): QueueCandidate[] {
    return Array.from(states.values()).map((state) => ({
      runId: state.runId,
      profileId: state.profile.id,
      workspaceId: state.workspace.id,
      status: state.queueStatus,
      sequence: state.sequence,
    }));
  }

  function queueLimits(): QueueLimits {
    return {
      globalConcurrency: input.config.server.globalConcurrency,
      profileConcurrencyById: new Map(
        input.config.profiles.map((profile) => [profile.id, profile.profileConcurrency]),
      ),
    };
  }

  function canStartNewRun(profile: ProfileConfig, workspace: WorkspaceRecord, sequence: number): boolean {
    const candidate: QueueCandidate = {
      runId: '__new__',
      profileId: profile.id,
      workspaceId: workspace.id,
      status: 'queued',
      sequence,
    };
    return selectDispatchableCandidates([...queueCandidates(), candidate], queueLimits()).some(
      (selected) => selected.runId === candidate.runId,
    );
  }

  async function startRun(state: RunState): Promise<void> {
    if (state.terminal) {
      return;
    }

    const startedAt = now();
    const run = updateRunStarted(input.db, { runId: state.runId, startedAt, now: startedAt });
    state.queueStatus = 'running';
    state.accumulator = createMessageAccumulator({
      db: input.db,
      messageId: state.assistantMessageId,
      workspaceId: state.workspace.id,
      conversationId: state.conversationId,
      runId: state.runId,
      initialPosition: 1,
      nextMessageId: nextAssistantMessageId,
      clock: { now },
      timer,
    });
    state.accumulator.startRun({ startedAt });
    state.logHandle = runLogService.openRunLogs({ runId: state.runId });
    scheduleRunTimeout(state);
    emitRunEvent(state, { type: 'status', label: 'running' });
    let prompt = state.prompt;
    let extraAllowedDirs: string[] = [];
    const persistFullSnapshots = shouldPersistFullSnapshot(state.collectionMode);
    let resolvedSkill: SkillRecord | null | undefined;
    let stagedSkill: StagedSkill | undefined;

    if (state.skillId) {
      resolvedSkill = await resolveRunSkill(state);
      if (state.terminal) {
        return;
      }
      if (!resolvedSkill) {
        return;
      }

      if (resolvedSkill.hasSideFiles) {
        try {
          stagedSkill = await stageSkillIntoWorkspace({
            workspaceCwd: getWorkspaceCwd(state.profile, state.workspace),
            skill: resolvedSkill,
          });
        } catch {
          await finishRun(
            state,
            {
              status: 'failed',
              exitCode: null,
              signal: null,
              errorCode: 'SKILL_STAGING_FAILED',
              errorMessage: 'Skill staging failed.',
              stdoutTail: '',
              stderrTail: '',
            },
            { finalizeArtifacts: false },
          );
          return;
        }
      }
      if (state.terminal) {
        return;
      }
      extraAllowedDirs = stagedSkill ? [stagedSkill.absoluteRoot] : [];
    }

    const conversationContext =
      state.promptMode === 'daemon-composed'
        ? buildConversationPromptContext(
            listConversationMessagesForPrompt(input.db, {
              workspaceId: state.workspace.id,
              conversationId: state.conversationId,
              excludeRunId: state.runId,
              limit: normalizeContextPolicy(state.contextPolicy).recentMessages,
            }).map((message) => ({ role: message.role, content: message.content })),
            state.contextPolicy,
          )
        : null;

    try {
      prompt = composeRunPrompt({
        kind: state.kind,
        promptMode: state.promptMode,
        currentPrompt: state.prompt,
        businessContext: state.businessContext,
        conversationMessages: conversationContext?.messages,
        contextWarnings: conversationContext?.warnings,
        skill: resolvedSkill ?? undefined,
        stagedSkill,
      });
    } catch {
      await finishRun(
        state,
        {
          status: 'failed',
          exitCode: null,
          signal: null,
          errorCode: 'PROMPT_COMPOSITION_FAILED',
          errorMessage: 'Prompt composition failed.',
          stdoutTail: '',
          stderrTail: '',
        },
        { finalizeArtifacts: false },
      );
      return;
    }

    const promptSnapshot = createTextSnapshot(prompt);
    upsertRunPromptSnapshot(input.db, {
      runId: state.runId,
      promptSnapshot: persistFullSnapshots ? prompt : null,
      promptSnapshotHash: promptSnapshot.hash,
      charCount: promptSnapshot.charCount,
      byteCount: promptSnapshot.byteCount,
      persisted: persistFullSnapshots,
      now: startedAt,
    });
    updateRunPromptSnapshotFields(input.db, {
      runId: state.runId,
      promptSnapshotHash: promptSnapshot.hash,
      charCount: promptSnapshot.charCount,
      byteCount: promptSnapshot.byteCount,
      persisted: persistFullSnapshots,
      now: startedAt,
    });

    if (resolvedSkill) {
      const skillBodySnapshot = createTextSnapshot(resolvedSkill.body);
      upsertRunSkillSnapshot(input.db, {
        runId: state.runId,
        skillId: resolvedSkill.id,
        skillName: resolvedSkill.name,
        skillDescription: resolvedSkill.description ?? null,
        skillBodyHash: skillBodySnapshot.hash,
        skillBody: persistFullSnapshots ? resolvedSkill.body : null,
        sideFilesManifest: stagedSkill?.sideFilesManifest ?? [],
        persisted: persistFullSnapshots,
        now: startedAt,
      });
    }

    const capabilities = await getCapabilities(state.profile);
    if (state.terminal) {
      return;
    }

    state.runner = runnerFactory({
      profile: state.profile,
      workspace: state.workspace,
      workspaceCwd: getWorkspaceCwd(state.profile, state.workspace),
      run,
      prompt,
      model: state.model,
      capabilities,
      extraAllowedDirs,
      logSink: state.logHandle ?? undefined,
      onEvent: (event) => emitRunEvent(state, event),
    });

    state.runner.completed.then(
      (result) => {
        void finishRun(state, result, { finalizeArtifacts: result.status !== 'canceled' });
      },
      () =>
        void finishRun(
          state,
          {
            status: 'failed',
            exitCode: 1,
            signal: null,
            errorCode: 'CLAUDE_CLI_FAILED',
            errorMessage: 'Claude CLI failed.',
            stdoutTail: '',
            stderrTail: '',
          },
          { finalizeArtifacts: false },
        ),
    );
  }

  async function resolveRunSkill(state: RunState) {
    if (!state.skillId) {
      await finishRun(
        state,
        {
          status: 'failed',
          exitCode: null,
          signal: null,
          errorCode: 'SKILL_UNAVAILABLE',
          errorMessage: 'Skill is unavailable.',
          stdoutTail: '',
          stderrTail: '',
        },
        { finalizeArtifacts: false },
      );
      return null;
    }

    try {
      return await resolveSkillForProfile(state.profile, state.skillId);
    } catch {
      await finishRun(
        state,
        {
          status: 'failed',
          exitCode: null,
          signal: null,
          errorCode: 'SKILL_UNAVAILABLE',
          errorMessage: 'Skill is unavailable.',
          stdoutTail: '',
          stderrTail: '',
        },
        { finalizeArtifacts: false },
      );
      return null;
    }
  }

  async function finishRun(
    state: RunState,
    result: ClaudeCliRunResult,
    options: { finalizeArtifacts?: boolean } = {},
  ): Promise<void> {
    if (state.terminal || state.finishing) {
      return;
    }
    state.finishing = true;
    state.queueStatus = 'finishing';
    clearRunTimeout(state);

    let finalStatus = result.status;
    let finalErrorCode = result.errorCode ?? null;
    let finalErrorMessage = result.errorMessage ?? null;

    if (options.finalizeArtifacts !== false) {
      try {
        const finalized = await artifactService.finalizeRunArtifacts({
          profile: state.profile,
          workspace: state.workspace,
          runId: state.runId,
          artifactRuleIds: state.artifactRuleIds,
        });

        for (const artifact of finalized.artifacts) {
          emitRunEvent(state, {
            type: 'artifact_finalized',
            artifact: {
              id: artifact.id,
              runId: artifact.runId,
              ruleId: artifact.ruleId,
              role: artifact.role,
              relativePath: artifact.relativePath,
              fileName: artifact.fileName,
              mimeType: artifact.mimeType,
              size: artifact.size,
              mtime: artifact.mtime,
              sha256: artifact.sha256,
            },
          });
        }

        if (result.status === 'succeeded' && finalized.missingRequiredRuleIds.length > 0) {
          finalStatus = 'failed';
          finalErrorCode = 'ARTIFACT_REQUIRED_MISSING';
          finalErrorMessage = 'Required artifact was not produced.';
          emitRunEvent(state, {
            type: 'error',
            code: finalErrorCode,
            message: finalErrorMessage,
            details: { missingRuleIds: finalized.missingRequiredRuleIds },
          });
        }
      } catch {
        finalStatus = 'failed';
        finalErrorCode = 'ARTIFACT_SCAN_FAILED';
        finalErrorMessage = 'Artifact scan failed.';
        emitRunEvent(state, {
          type: 'error',
          code: finalErrorCode,
          message: finalErrorMessage,
        });
      }
    }

    emitRunEvent(state, { type: 'end', status: finalStatus });
    const finishedAt = now();
    if (state.accumulator) {
      state.accumulator.flushTerminal({
        runStatus: finalStatus,
        endedAt: finishedAt,
      });
    } else {
      updateAssistantMessageTerminal(input.db, {
        messageId: state.assistantMessageId,
        runStatus: finalStatus,
        lastRunEventId: state.events.at(-1)?.id ?? null,
        endedAt: finishedAt,
        now: finishedAt,
      });
    }

    updateRunTerminal(input.db, {
      runId: state.runId,
      status: finalStatus,
      finishedAt,
      exitCode: result.exitCode,
      signal: result.signal,
      errorCode: finalErrorCode,
      errorMessage: finalErrorMessage,
      usage: state.accumulator?.getUsage() ?? null,
      lastRunEventId: state.events.at(-1)?.id ?? null,
      now: finishedAt,
    });

    state.logHandle?.close();
    state.logHandle = null;
    state.terminal = true;
    state.queueStatus = 'terminal';
    state.finishing = false;

    if (eventBufferTtlMs >= 0 && !shuttingDown) {
      state.cleanupTimer = timer.setTimeout(() => {
        state.accumulator?.dispose();
        states.delete(state.runId);
      }, eventBufferTtlMs);
    }
    scheduleDispatch();
  }

  function scheduleRunTimeout(state: RunState): void {
    if (state.profile.runTimeoutMs <= 0) return;
    state.runTimeoutTimer = timer.setTimeout(() => {
      state.runTimeoutTimer = null;
      void timeoutRun(state);
    }, state.profile.runTimeoutMs);
  }

  async function timeoutRun(state: RunState): Promise<void> {
    if (state.terminal) return;

    emitRunEvent(state, {
      type: 'error',
      code: 'RUN_TIMEOUT',
      message: 'Run exceeded total timeout.',
    });
    state.runner?.cancel();
    await finishRun(
      state,
      {
        status: 'failed',
        exitCode: null,
        signal: null,
        errorCode: 'RUN_TIMEOUT',
        errorMessage: 'Run exceeded total timeout.',
        stdoutTail: '',
        stderrTail: '',
      },
      { finalizeArtifacts: false },
    );
  }

  function clearRunTimeout(state: RunState): void {
    if (state.runTimeoutTimer !== null) {
      timer.clearTimeout(state.runTimeoutTimer);
      state.runTimeoutTimer = null;
    }
  }

  function waitForRunnerCompletion(runner: ClaudeCliRunHandle, graceMs: number): Promise<void> {
    const waitMs = Math.max(0, graceMs);
    if (waitMs <= 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let timeoutId: unknown = null;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) {
          timer.clearTimeout(timeoutId);
          timeoutId = null;
        }
        resolve();
      };

      timeoutId = timer.setTimeout(settle, waitMs);
      runner.completed.then(settle, settle);
    });
  }

  function assertRunReadable(client: ClientConfig, runId: string): RunRecord {
    const run = getRunForClient(input.db, { runId, clientId: client.id, isAdmin: client.isAdmin });
    if (!run) {
      throw notFound('Run not found');
    }
    requireProfileAccess(client, run.profileId);
    return run;
  }

  function replayIdempotentRun(replayInput: {
    client: ClientConfig;
    existing: RunRecord;
    expectedFingerprint: string | null;
    requestConversationId?: string;
  }): CreateRunResult {
    if (
      !replayInput.expectedFingerprint ||
      replayInput.existing.idempotencyFingerprint !== replayInput.expectedFingerprint
    ) {
      throw daemonError(
        'IDEMPOTENCY_KEY_CONFLICT',
        'idempotency key was already used with different run parameters',
        409,
      );
    }
    const detail = getRunDetail(input.db, {
      runId: replayInput.existing.id,
      clientId: replayInput.client.id,
      isAdmin: replayInput.client.isAdmin,
    });
    if (!detail) {
      throw notFound('Run not found');
    }
    return {
      runId: replayInput.existing.id,
      status: replayInput.existing.status,
      conversationId: detail.messages[0]?.conversationId ?? replayInput.requestConversationId ?? '',
      userMessageId: detail.messages.find((message) => message.role === 'user')?.id ?? '',
      assistantMessageId: detail.messages.find((message) => message.role === 'assistant')?.id ?? '',
      idempotentReplay: true,
    };
  }

  return {
    createRun({ client, request }) {
      requireProfileAccess(client, request.profileId);
      const profile = getProfile(input.config, request.profileId);

      const promptMode = request.promptMode ?? 'legacy';
      const activePromptMode = promptMode as ActivePromptMode;
      assertPromptModeRequestShape(request, activePromptMode);
      const collectionMode = request.collectionMode ?? 'lite';
      requireCollectionModeAccess({ client, profile, collectionMode });

      if (request.skillId) {
        assertSkillAllowedForProfile(profile, request.skillId);
      } else if (
        request.kind === 'generate' ||
        activePromptMode === 'business-context'
      ) {
        assertSkillAllowedForProfile(profile, request.skillId ?? '');
      }
      const currentPrompt =
        activePromptMode === 'legacy' ? request.prompt : request.currentPrompt;
      if (!currentPrompt) {
        throw badRequest(`${activePromptMode} promptMode requires a prompt`);
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
      if (
        request.conversationId &&
        !getConversationForWorkspace(input.db, {
          conversationId: request.conversationId,
          workspaceId: workspace.id,
        })
      ) {
        throw badRequest('Conversation does not belong to requested workspace');
      }

      const selectedArtifactRules = artifactService.resolveSelectedArtifactRules({
        profile,
        artifactRuleIds: request.artifactRuleIds,
      });
      const selectedArtifactRuleIds = selectedArtifactRules.map((rule) => rule.id);
      const businessContextHash =
        request.businessContext === undefined ? null : stableJsonHash(request.businessContext);
      const persistBusinessContext =
        request.businessContext !== undefined && shouldPersistFullSnapshot(collectionMode);
      const idempotencyFingerprint = request.idempotencyKey
        ? buildRunIdempotencyFingerprint({
            profileId: profile.id,
            workspaceId: workspace.id,
            kind: request.kind,
            skillId: request.skillId ?? null,
            promptMode: activePromptMode,
            currentPrompt,
            conversationId: request.conversationId ?? null,
            collectionMode,
            contextPolicy: request.contextPolicy,
            businessContextHash,
            model: selectedModel,
            artifactRuleIds: selectedArtifactRuleIds,
          })
        : null;

      if (request.idempotencyKey) {
        const existing = getRunByIdempotencyKey(input.db, {
          clientId: client.id,
          profileId: profile.id,
          workspaceId: workspace.id,
          idempotencyKey: request.idempotencyKey,
        });
        if (existing) {
          return replayIdempotentRun({
            client,
            existing,
            expectedFingerprint: idempotencyFingerprint,
            requestConversationId: request.conversationId,
          });
        }
      }

      const runId = nextRunId();
      const sequence = nextSequence++;
      const assistantMessageId = nextAssistantMessageId();

      if (
        !canStartNewRun(profile, workspace, sequence) &&
        countQueued(queueCandidates()) >= input.config.server.maxQueueSize
      ) {
        throw daemonError('RUN_QUEUE_FULL', 'Run queue is full', 429);
      }

      let created: ReturnType<typeof createRunQueuedWithMessagesAndSnapshot>;
      try {
        created = createRunQueuedWithMessagesAndSnapshot(input.db, {
          runId,
          conversationId: request.conversationId,
          defaultConversationId: nextConversationId(),
          userMessageId: nextUserMessageId(),
          assistantMessageId,
          workspaceId: workspace.id,
          profileId: profile.id,
          clientId: client.id,
          kind: request.kind,
          skillId: request.skillId,
          prompt: currentPrompt,
          promptMode: activePromptMode,
          currentPrompt,
          contextPolicy: request.contextPolicy,
          collectionMode,
          businessContext: request.businessContext,
          businessContextHash,
          persistBusinessContext,
          artifactRuleIds: selectedArtifactRuleIds,
          idempotencyKey: request.idempotencyKey,
          idempotencyFingerprint,
          metadata: request.metadata,
          profileSnapshot: createSanitizedProfileSnapshot(profile, {
            selectedModel,
            selectedArtifactRuleIds,
          }),
          now: now(),
        });
      } catch (error) {
        if (request.idempotencyKey && isSqliteUniqueConstraintError(error)) {
          const existing = getRunByIdempotencyKey(input.db, {
            clientId: client.id,
            profileId: profile.id,
            workspaceId: workspace.id,
            idempotencyKey: request.idempotencyKey,
          });
          if (existing) {
            return replayIdempotentRun({
              client,
              existing,
              expectedFingerprint: idempotencyFingerprint,
              requestConversationId: request.conversationId,
            });
          }
        }
        throw error;
      }

      const state: RunState = {
        runId,
        profile,
        workspace,
        kind: request.kind,
        skillId: request.skillId ?? null,
        artifactRuleIds: selectedArtifactRuleIds,
        prompt: currentPrompt,
        promptMode: activePromptMode,
        contextPolicy: request.contextPolicy,
        collectionMode,
        businessContext: request.businessContext,
        model: request.model,
        requestEventVisibility: request.eventVisibility,
        events: [],
        nextEventId: 1,
        subscribers: new Set(),
        runner: null,
        accumulator: null,
        logHandle: null,
        assistantMessageId,
        conversationId: created.conversation.id,
        queueStatus: 'queued',
        sequence,
        runTimeoutTimer: null,
        finishing: false,
        terminal: false,
        cleanupTimer: null,
      };
      states.set(runId, state);
      emitRunEvent(state, { type: 'status', label: 'queued' });
      scheduleDispatch();

      return {
        runId: created.run.id,
        status: 'queued',
        conversationId: created.conversation.id,
        userMessageId: created.messages.find((message) => message.role === 'user')!.id,
        assistantMessageId: assistantMessageId,
      };
    },

    listRuns({ client, query = {} }) {
      return listRunsForClient(input.db, {
        clientId: client.id,
        isAdmin: client.isAdmin,
        ...query,
      });
    },

    getRunStatus({ client, runId }) {
      return assertRunReadable(client, runId);
    },

    getRunDetail({ client, runId }) {
      assertRunReadable(client, runId);
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
      if (state.finishing) {
        throw daemonError('RUN_NOT_CANCELABLE', 'Run is not cancelable', 409);
      }

      if (!state.runner) {
        void finishRun(
          state,
          {
            status: 'canceled',
            exitCode: null,
            signal: null,
            stdoutTail: '',
            stderrTail: '',
          },
          { finalizeArtifacts: false },
        );
        scheduleDispatch();
        return { ok: true };
      }

      clearRunTimeout(state);
      state.runner.cancel();
      return { ok: true };
    },

    async shutdownActive({ graceMs = 0 } = {}) {
      shuttingDown = true;
      if (dispatchTimer !== null) {
        timer.clearTimeout(dispatchTimer);
        dispatchTimer = null;
      }

      let interrupted = 0;
      const waits: Array<Promise<void>> = [];
      for (const state of Array.from(states.values())) {
        if (state.terminal) {
          continue;
        }
        interrupted += 1;
        const runner = state.runner;
        runner?.cancel();
        await finishRun(
          state,
          {
            status: 'interrupted',
            exitCode: null,
            signal: null,
            errorCode: 'RUN_INTERRUPTED_BY_DAEMON_RESTART',
            errorMessage: 'Run interrupted by daemon shutdown',
            stdoutTail: '',
            stderrTail: '',
          },
          { finalizeArtifacts: false },
        );
        if (runner) {
          waits.push(waitForRunnerCompletion(runner, graceMs));
        }
      }
      await Promise.all(waits);

      return { interrupted };
    },
  };
}

function buildRunIdempotencyFingerprint(input: {
  profileId: string;
  workspaceId: string;
  kind: RunKind;
  skillId: string | null;
  promptMode: ActivePromptMode;
  currentPrompt: string;
  conversationId: string | null;
  collectionMode: CollectionMode;
  contextPolicy: ContextPolicy | undefined;
  businessContextHash: string | null;
  model: string | null;
  artifactRuleIds: string[];
}): string {
  return stableJsonHash({
    version: 1,
    profileId: input.profileId,
    workspaceId: input.workspaceId,
    kind: input.kind,
    skillId: input.skillId,
    promptMode: input.promptMode,
    currentPromptHash: hashSensitiveText(input.currentPrompt),
    conversationId: input.conversationId,
    collectionMode: input.collectionMode,
    contextPolicy: input.contextPolicy ?? null,
    businessContextHash: input.businessContextHash,
    model: input.model,
    artifactRuleIds: input.artifactRuleIds,
  });
}

function hashSensitiveText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertPromptModeRequestShape(
  request: CreateRunRequest,
  promptMode: ActivePromptMode,
): void {
  if (promptMode === 'legacy') {
    if (!request.prompt) {
      throw badRequest('legacy promptMode requires prompt');
    }
    if (request.currentPrompt) {
      throw badRequest('legacy promptMode forbids currentPrompt');
    }
    if (request.businessContext !== undefined) {
      throw badRequest('legacy promptMode forbids businessContext');
    }
    if (request.contextPolicy !== undefined) {
      throw badRequest('legacy promptMode forbids contextPolicy');
    }
    if (request.kind === 'generate' && !request.skillId) {
      throw badRequest('legacy generate requires skillId');
    }
    if (request.kind === 'revise' && request.skillId) {
      throw badRequest('legacy revise forbids skillId');
    }
    return;
  }

  if (promptMode === 'business-context') {
    if (request.prompt) {
      throw badRequest('business-context forbids prompt');
    }
    if (!request.currentPrompt) {
      throw badRequest('business-context requires currentPrompt');
    }
    if (!request.skillId) {
      throw badRequest('business-context requires skillId');
    }
    if (request.contextPolicy !== undefined) {
      throw badRequest('business-context forbids contextPolicy');
    }
    return;
  }

  if (request.prompt) {
    throw badRequest('daemon-composed forbids prompt');
  }
  if (!request.currentPrompt) {
    throw badRequest('daemon-composed requires currentPrompt');
  }
  if (request.businessContext !== undefined) {
    throw badRequest('daemon-composed forbids businessContext');
  }
  if (request.kind === 'generate' && !request.skillId) {
    throw badRequest('daemon-composed generate requires skillId');
  }
}

function defaultRunnerFactory(input: RunServiceRunnerInput): ClaudeCliRunHandle {
  const invocation = buildClaudeRunInvocation(input);

  return startClaudeCliRun({
    invocation,
    inactivityTimeoutMs: input.profile.inactivityTimeoutMs,
    cancelGraceMs: input.profile.cancelGraceMs,
    logSink: input.logSink,
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
    extraAllowedDirs: input.extraAllowedDirs,
  });
}
