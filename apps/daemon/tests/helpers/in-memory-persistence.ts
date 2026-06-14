import path from 'node:path';
import type {
  ArtifactRecord,
  ConversationRecord,
  CreateRunQueuedWithMessagesAndSnapshotInput,
  CreateRunQueuedWithMessagesAndSnapshotResult,
  GetArtifactForRunForClientInput,
  GetConversationForWorkspaceInput,
  GetOrCreateDefaultConversationInput,
  GetRunByIdempotencyKeyInput,
  GetRunLogForRunForClientInput,
  GetWorkspaceForClientInput,
  InsertAssistantRunMessageInput,
  InsertRunFeedbackInput,
  InsertRunMessagesForRunCreateInput,
  InsertRunQueuedInput,
  ListArtifactsForRunInput,
  ListConversationMessagesForPromptInput,
  ListRunFeedbackForClientInput,
  ListRunLogsFinishedBeforeInput,
  ListRunsForClientInput,
  ProfileSnapshotRecord,
  ReplaceArtifactsForRunInput,
  RunContextSnapshotRecord,
  RunDetailRecord,
  RunFeedbackRecord,
  RunLogRecord,
  RunnerPersistence,
  RunMessageRecord,
  RunPromptSnapshotRecord,
  RunRecord,
  RunSkillSnapshotRecord,
  RunWithWorkspaceRecord,
  UpsertRunContextSnapshotInput,
  UpsertRunLogPathsInput,
  UpsertRunPromptSnapshotInput,
  UpsertRunSkillSnapshotInput,
  UpsertWorkspaceInput,
  UpdateAssistantMessageStartedInput,
  UpdateAssistantMessageTerminalInput,
  UpdateAssistantMessagesTerminalForRunInput,
  UpdateRunMessageInput,
  UpdateRunPromptSnapshotFieldsInput,
  UpdateRunStartedInput,
  UpdateRunStatusInput,
  UpdateRunTerminalInput,
  WorkspaceRecord,
} from '../../src/db/types.js';

interface InMemoryState {
  workspaces: Map<string, WorkspaceRecord>;
  conversations: Map<string, ConversationRecord>;
  runs: Map<string, RunRecord>;
  messages: Map<string, RunMessageRecord>;
  profileSnapshots: Map<string, ProfileSnapshotRecord>;
  promptSnapshots: Map<string, RunPromptSnapshotRecord>;
  skillSnapshots: Map<string, RunSkillSnapshotRecord>;
  contextSnapshots: Map<string, RunContextSnapshotRecord>;
  artifacts: ArtifactRecord[];
  runLogs: Map<string, RunLogRecord>;
  feedback: RunFeedbackRecord[];
}

const terminalRunStatuses = new Set(['succeeded', 'failed', 'canceled', 'interrupted']);
const artifactRoleOrder = new Map([
  ['primary', 0],
  ['supporting', 1],
  ['debug', 2],
]);

export function createInMemoryPersistence(): RunnerPersistence {
  let state = createEmptyState();

  const persistence: RunnerPersistence = {
    async close(): Promise<void> {},
    isUniqueConstraintError(): boolean {
      return false;
    },

    async transaction<T>(fn: (persistence: RunnerPersistence) => Promise<T>): Promise<T> {
      const snapshot = cloneState(state);
      try {
        return await fn(persistence);
      } catch (error) {
        state = snapshot;
        throw error;
      }
    },

    async upsertWorkspace(input: UpsertWorkspaceInput): Promise<WorkspaceRecord> {
      const workspaceKey = makeWorkspaceKey(input.originId, input.userId, input.projectId);
      const existing = [...state.workspaces.values()].find(
        (workspace) =>
          workspace.clientId === input.clientId &&
          workspace.profileId === input.profileId &&
          workspace.workspaceKey === workspaceKey,
      );

      if (existing) {
        const next: WorkspaceRecord = {
          ...existing,
          status: input.status ?? existing.status,
          metadata: input.metadata === undefined ? existing.metadata : clone(input.metadata),
          updatedAt: input.now,
        };
        state.workspaces.set(existing.id, next);
        return clone(next);
      }

      const workspace: WorkspaceRecord = {
        id: input.id,
        profileId: input.profileId,
        clientId: input.clientId,
        originId: input.originId,
        userId: input.userId,
        projectId: input.projectId,
        workspaceKey,
        status: input.status ?? 'active',
        metadata: clone(input.metadata ?? null),
        createdAt: input.now,
        updatedAt: input.now,
      };
      state.workspaces.set(workspace.id, workspace);
      return clone(workspace);
    },

    async getWorkspaceForClient(input: GetWorkspaceForClientInput): Promise<WorkspaceRecord | null> {
      const workspace = state.workspaces.get(input.workspaceId);
      if (!workspace || (!input.isAdmin && workspace.clientId !== input.clientId)) {
        return null;
      }
      return clone(workspace);
    },

    async getOrCreateDefaultConversation(
      input: GetOrCreateDefaultConversationInput,
    ): Promise<ConversationRecord> {
      const existing = [...state.conversations.values()]
        .filter((conversation) => conversation.workspaceId === input.workspaceId && conversation.title === 'Default')
        .sort(compareByCreatedAtThenId)[0];

      if (existing) {
        return clone(existing);
      }

      const conversation: ConversationRecord = {
        id: input.id,
        workspaceId: input.workspaceId,
        title: 'Default',
        createdAt: input.now,
        updatedAt: input.now,
      };
      state.conversations.set(conversation.id, conversation);
      return clone(conversation);
    },

    async getConversationForWorkspace(
      input: GetConversationForWorkspaceInput,
    ): Promise<ConversationRecord | null> {
      const conversation = state.conversations.get(input.conversationId);
      if (!conversation || conversation.workspaceId !== input.workspaceId) {
        return null;
      }
      return clone(conversation);
    },

    async listConversationMessagesForPrompt(
      input: ListConversationMessagesForPromptInput,
    ): Promise<RunMessageRecord[]> {
      if (input.limit <= 0) {
        return [];
      }

      return [...state.messages.values()]
        .filter(
          (message) =>
            message.workspaceId === input.workspaceId &&
            message.conversationId === input.conversationId &&
            message.content !== '' &&
            message.runId !== input.excludeRunId,
        )
        .sort(compareMessagesForPromptDesc)
        .slice(0, input.limit)
        .sort(compareMessagesForPromptAsc)
        .map(clone);
    },

    async insertRunQueued(input: InsertRunQueuedInput): Promise<RunRecord> {
      const run = makeQueuedRun(input.id, input);
      state.runs.set(run.id, run);
      return clone(run);
    },

    async createRunQueuedWithMessagesAndSnapshot(
      input: CreateRunQueuedWithMessagesAndSnapshotInput,
    ): Promise<CreateRunQueuedWithMessagesAndSnapshotResult> {
      return persistence.transaction(async () => {
        const conversation =
          input.conversationId && input.defaultConversationId
            ? await persistence.getConversationForWorkspace({
                conversationId: input.conversationId,
                workspaceId: input.workspaceId,
              })
            : await persistence.getOrCreateDefaultConversation({
                id: input.defaultConversationId ?? input.conversationId ?? 'conv_default',
                workspaceId: input.workspaceId,
                now: input.now,
              });

        if (!conversation) {
          throw new Error('Repository caller must validate conversation ownership before insert');
        }

        const run = await persistence.insertRunQueued({
          id: input.runId,
          workspaceId: input.workspaceId,
          profileId: input.profileId,
          clientId: input.clientId,
          kind: input.kind,
          skillId: input.skillId,
          prompt: input.prompt,
          promptMode: input.promptMode,
          currentPrompt: input.currentPrompt,
          contextPolicy: input.contextPolicy,
          collectionMode: input.collectionMode,
          promptSnapshotHash: input.promptSnapshotHash,
          promptSnapshotCharCount: input.promptSnapshotCharCount,
          promptSnapshotByteCount: input.promptSnapshotByteCount,
          promptSnapshotPersisted: input.promptSnapshotPersisted,
          businessContextHash: input.businessContextHash,
          artifactRuleIds: input.artifactRuleIds,
          idempotencyKey: input.idempotencyKey,
          idempotencyFingerprint: input.idempotencyFingerprint,
          metadata: input.metadata,
          now: input.now,
        });
        const messages = await persistence.insertRunMessagesForRunCreate({
          userMessageId: input.userMessageId,
          assistantMessageId: input.assistantMessageId,
          workspaceId: input.workspaceId,
          conversationId: conversation.id,
          runId: input.runId,
          prompt: input.currentPrompt ?? input.prompt,
          now: input.now,
        });
        const profileSnapshot = insertProfileSnapshot({
          runId: input.runId,
          profile: input.profileSnapshot,
          now: input.now,
        });

        if (input.businessContextHash) {
          await persistence.upsertRunContextSnapshot({
            runId: input.runId,
            businessContext: input.persistBusinessContext ? input.businessContext : null,
            businessContextHash: input.businessContextHash,
            persisted: Boolean(input.persistBusinessContext),
            now: input.now,
          });
        }

        return { run, conversation, messages, profileSnapshot };
      });
    },

    async getProfileSnapshotForRun(runId: string): Promise<ProfileSnapshotRecord | null> {
      return cloneOrNull(state.profileSnapshots.get(runId) ?? null);
    },

    async upsertRunPromptSnapshot(input: UpsertRunPromptSnapshotInput): Promise<void> {
      const snapshot: RunPromptSnapshotRecord = {
        runId: input.runId,
        promptSnapshot: input.promptSnapshot,
        promptSnapshotHash: input.promptSnapshotHash,
        charCount: input.charCount,
        byteCount: input.byteCount,
        persisted: input.persisted,
        createdAt: state.promptSnapshots.get(input.runId)?.createdAt ?? input.now,
      };
      state.promptSnapshots.set(input.runId, clone(snapshot));
    },

    async updateRunPromptSnapshotFields(
      input: UpdateRunPromptSnapshotFieldsInput,
    ): Promise<RunRecord> {
      const run = getRunById(input.runId);
      const next: RunRecord = {
        ...run,
        promptSnapshotHash: input.promptSnapshotHash,
        promptSnapshotCharCount: input.charCount,
        promptSnapshotByteCount: input.byteCount,
        promptSnapshotPersisted: input.persisted,
        updatedAt: input.now,
      };
      state.runs.set(run.id, next);
      return clone(next);
    },

    async upsertRunSkillSnapshot(input: UpsertRunSkillSnapshotInput): Promise<void> {
      const snapshot: RunSkillSnapshotRecord = {
        runId: input.runId,
        skillId: input.skillId,
        skillName: input.skillName,
        skillDescription: input.skillDescription,
        skillBodyHash: input.skillBodyHash,
        skillBody: input.skillBody,
        sideFilesManifest: clone(input.sideFilesManifest),
        persisted: input.persisted,
        createdAt: state.skillSnapshots.get(input.runId)?.createdAt ?? input.now,
      };
      state.skillSnapshots.set(input.runId, clone(snapshot));
    },

    async upsertRunContextSnapshot(input: UpsertRunContextSnapshotInput): Promise<void> {
      const snapshot: RunContextSnapshotRecord = {
        runId: input.runId,
        businessContext: input.persisted ? clone(input.businessContext) : null,
        businessContextHash: input.businessContextHash,
        persisted: input.persisted,
        createdAt: state.contextSnapshots.get(input.runId)?.createdAt ?? input.now,
      };
      state.contextSnapshots.set(input.runId, clone(snapshot));
    },

    async getRunPromptSnapshot(runId: string): Promise<RunPromptSnapshotRecord | null> {
      return cloneOrNull(state.promptSnapshots.get(runId) ?? null);
    },

    async getRunSkillSnapshot(runId: string): Promise<RunSkillSnapshotRecord | null> {
      return cloneOrNull(state.skillSnapshots.get(runId) ?? null);
    },

    async getRunContextSnapshot(runId: string): Promise<RunContextSnapshotRecord | null> {
      return cloneOrNull(state.contextSnapshots.get(runId) ?? null);
    },

    async markInterruptedRunsOnStartup(now: number): Promise<number> {
      let changed = 0;
      for (const run of state.runs.values()) {
        if (run.status !== 'queued' && run.status !== 'running') {
          continue;
        }
        state.runs.set(run.id, {
          ...run,
          status: 'interrupted',
          finishedAt: now,
          errorCode: 'RUN_INTERRUPTED_BY_DAEMON_RESTART',
          errorMessage: 'Run interrupted by daemon restart',
          updatedAt: now,
        });
        changed += 1;
      }
      return changed;
    },

    async insertRunMessagesForRunCreate(
      input: InsertRunMessagesForRunCreateInput,
    ): Promise<RunMessageRecord[]> {
      const userConversationSeq = nextConversationSeq(input.conversationId);
      const assistantConversationSeq =
        userConversationSeq === null ? null : userConversationSeq + 1;
      const records: RunMessageRecord[] = [
        {
          id: input.userMessageId,
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          runId: input.runId,
          role: 'user',
          content: input.prompt,
          thinkingContent: '',
          events: null,
          attachments: null,
          producedFiles: null,
          runStatus: null,
          lastRunEventId: null,
          startedAt: null,
          endedAt: null,
          position: 0,
          conversationSeq: userConversationSeq,
          createdAt: input.now,
          updatedAt: input.now,
        },
        {
          id: input.assistantMessageId,
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          runId: input.runId,
          role: 'assistant',
          content: '',
          thinkingContent: '',
          events: null,
          attachments: null,
          producedFiles: null,
          runStatus: 'queued',
          lastRunEventId: null,
          startedAt: null,
          endedAt: null,
          position: 1,
          conversationSeq: assistantConversationSeq,
          createdAt: input.now,
          updatedAt: input.now,
        },
      ];

      for (const record of records) {
        state.messages.set(record.id, record);
      }
      return getRunMessages(input.runId);
    },

    async insertAssistantRunMessage(
      input: InsertAssistantRunMessageInput,
    ): Promise<RunMessageRecord> {
      const message: RunMessageRecord = {
        id: input.id,
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        runId: input.runId,
        role: 'assistant',
        content: '',
        thinkingContent: '',
        events: null,
        attachments: null,
        producedFiles: null,
        runStatus: input.runStatus,
        lastRunEventId: null,
        startedAt: input.startedAt ?? null,
        endedAt: null,
        position: input.position,
        conversationSeq: nextConversationSeq(input.conversationId),
        createdAt: input.now,
        updatedAt: input.now,
      };
      state.messages.set(message.id, message);
      return clone(message);
    },

    async updateAssistantMessagesTerminalForRun(
      input: UpdateAssistantMessagesTerminalForRunInput,
    ): Promise<number> {
      let changed = 0;
      for (const message of state.messages.values()) {
        if (message.runId === input.runId && message.role === 'assistant') {
          state.messages.set(message.id, {
            ...message,
            runStatus: input.runStatus,
            endedAt: input.endedAt,
            updatedAt: input.now,
          });
          changed += 1;
        }
      }
      return changed;
    },

    async updateRunStatus(input: UpdateRunStatusInput): Promise<RunRecord> {
      const run = getRunById(input.runId);
      const next = { ...run, status: input.status, updatedAt: input.now };
      state.runs.set(next.id, next);
      return clone(next);
    },

    async updateRunStarted(input: UpdateRunStartedInput): Promise<RunRecord> {
      const run = getRunById(input.runId);
      const next: RunRecord = {
        ...run,
        status: 'running',
        startedAt: input.startedAt,
        updatedAt: input.now,
      };
      state.runs.set(next.id, next);
      return clone(next);
    },

    async updateRunTerminal(input: UpdateRunTerminalInput): Promise<RunRecord> {
      const run = getRunById(input.runId);
      const next: RunRecord = {
        ...run,
        status: input.status,
        finishedAt: input.finishedAt,
        exitCode: input.exitCode === undefined ? run.exitCode : input.exitCode,
        signal: input.signal === undefined ? run.signal : input.signal,
        errorCode: input.errorCode === undefined ? run.errorCode : input.errorCode,
        errorMessage: input.errorMessage === undefined ? run.errorMessage : input.errorMessage,
        usage: input.usage === undefined ? run.usage : clone(input.usage),
        lastRunEventId: input.lastRunEventId === undefined ? run.lastRunEventId : input.lastRunEventId,
        updatedAt: input.now,
      };
      state.runs.set(next.id, next);
      return clone(next);
    },

    async updateAssistantMessageStarted(
      input: UpdateAssistantMessageStartedInput,
    ): Promise<RunMessageRecord> {
      const message = getRunMessageById(input.messageId);
      const next: RunMessageRecord = {
        ...message,
        runStatus: 'running',
        startedAt: input.startedAt,
        updatedAt: input.now,
      };
      state.messages.set(next.id, next);
      return clone(next);
    },

    async updateAssistantMessageTerminal(
      input: UpdateAssistantMessageTerminalInput,
    ): Promise<RunMessageRecord> {
      const message = getRunMessageById(input.messageId);
      const next: RunMessageRecord = {
        ...message,
        runStatus: input.runStatus,
        lastRunEventId:
          input.lastRunEventId === undefined ? message.lastRunEventId : input.lastRunEventId,
        endedAt: input.endedAt,
        updatedAt: input.now,
      };
      state.messages.set(next.id, next);
      return clone(next);
    },

    async updateRunMessage(input: UpdateRunMessageInput): Promise<RunMessageRecord> {
      const message = getRunMessageById(input.messageId);
      const next: RunMessageRecord = {
        ...message,
        content: input.content ?? message.content,
        thinkingContent: input.thinkingContent ?? message.thinkingContent,
        events: input.events === undefined ? message.events : clone(input.events),
        attachments: input.attachments === undefined ? message.attachments : clone(input.attachments),
        producedFiles:
          input.producedFiles === undefined ? message.producedFiles : clone(input.producedFiles),
        runStatus: input.runStatus === undefined ? message.runStatus : input.runStatus,
        lastRunEventId:
          input.lastRunEventId === undefined ? message.lastRunEventId : input.lastRunEventId,
        updatedAt: input.now,
      };
      state.messages.set(next.id, next);
      return clone(next);
    },

    async replaceArtifactsForRun(input: ReplaceArtifactsForRunInput): Promise<ArtifactRecord[]> {
      state.artifacts = state.artifacts.filter((artifact) => artifact.runId !== input.runId);
      state.artifacts.push(
        ...input.artifacts.map((artifact) => ({
          id: artifact.id,
          runId: input.runId,
          workspaceId: input.workspaceId,
          ruleId: artifact.ruleId,
          role: artifact.role,
          relativePath: artifact.relativePath,
          fileName: artifact.fileName,
          mimeType: artifact.mimeType ?? null,
          size: artifact.size ?? null,
          mtime: artifact.mtime ?? null,
          sha256: artifact.sha256 ?? null,
          metadata: clone(artifact.metadata ?? null),
          createdAt: input.now,
        })),
      );
      return persistence.listArtifactsForRun({ runId: input.runId, clientId: '', isAdmin: true });
    },

    async listArtifactsForRun(input: ListArtifactsForRunInput): Promise<ArtifactRecord[]> {
      const run = await persistence.getRunForClient(input);
      if (!run) {
        return [];
      }

      return state.artifacts
        .filter((artifact) => artifact.runId === run.id)
        .sort(compareArtifacts)
        .map(clone);
    },

    async getArtifactForRunForClient(
      input: GetArtifactForRunForClientInput,
    ): Promise<ArtifactRecord | null> {
      const artifacts = await persistence.listArtifactsForRun(input);
      return cloneOrNull(artifacts.find((artifact) => artifact.id === input.artifactId) ?? null);
    },

    async upsertRunLogPaths(input: UpsertRunLogPathsInput): Promise<RunLogRecord> {
      assertRelativeLogPath(input.stdoutLogPath);
      assertRelativeLogPath(input.stderrLogPath);
      assertRelativeLogPath(input.debugEventsLogPath);

      const record: RunLogRecord = {
        runId: input.runId,
        stdoutLogPath: input.stdoutLogPath,
        stderrLogPath: input.stderrLogPath,
        debugEventsLogPath: input.debugEventsLogPath,
        createdAt: state.runLogs.get(input.runId)?.createdAt ?? input.now,
      };
      state.runLogs.set(input.runId, record);
      return clone(record);
    },

    async getRunLogForRunForClient(
      input: GetRunLogForRunForClientInput,
    ): Promise<RunLogRecord | null> {
      const run = await persistence.getRunForClient(input);
      if (!run) {
        return null;
      }
      return cloneOrNull(state.runLogs.get(input.runId) ?? null);
    },

    async listRunLogsFinishedBefore(input: ListRunLogsFinishedBeforeInput): Promise<RunLogRecord[]> {
      return [...state.runLogs.values()]
        .filter((log) => {
          const run = state.runs.get(log.runId);
          return (
            Boolean(run) &&
            run?.finishedAt !== null &&
            run?.finishedAt !== undefined &&
            run.finishedAt < input.finishedBefore &&
            terminalRunStatuses.has(run.status)
          );
        })
        .sort((left, right) => {
          const leftRun = getRunById(left.runId);
          const rightRun = getRunById(right.runId);
          return (
            (leftRun.finishedAt ?? 0) - (rightRun.finishedAt ?? 0) ||
            left.createdAt - right.createdAt ||
            left.runId.localeCompare(right.runId)
          );
        })
        .slice(0, input.limit)
        .map(clone);
    },

    async deleteRunLogRows(runIds: readonly string[]): Promise<number> {
      let deleted = 0;
      for (const runId of runIds) {
        if (state.runLogs.delete(runId)) {
          deleted += 1;
        }
      }
      return deleted;
    },

    async insertRunFeedback(input: InsertRunFeedbackInput): Promise<RunFeedbackRecord> {
      const record: RunFeedbackRecord = {
        id: input.id,
        runId: input.runId,
        clientId: input.clientId,
        category: input.category,
        message: input.message,
        metadata: clone(input.metadata ?? null),
        createdAt: input.now,
      };
      state.feedback.push(record);
      return clone(record);
    },

    async listRunFeedbackForClient(
      input: ListRunFeedbackForClientInput,
    ): Promise<RunFeedbackRecord[] | null> {
      const run = await persistence.getRunForClient(input);
      if (!run) {
        return null;
      }

      return state.feedback
        .filter((record) => record.runId === input.runId)
        .sort(compareByCreatedAtThenId)
        .map(clone);
    },

    async getRunDetail(input): Promise<RunDetailRecord | null> {
      const run = await persistence.getRunForClient(input);
      if (!run) {
        return null;
      }
      return {
        run,
        messages: getRunMessages(run.id),
      };
    },

    async getRunForClient(input): Promise<RunRecord | null> {
      const run = state.runs.get(input.runId);
      if (!run || (!input.isAdmin && run.clientId !== input.clientId)) {
        return null;
      }
      return clone(run);
    },

    async getRunWithWorkspaceForClient(input): Promise<RunWithWorkspaceRecord | null> {
      const run = await persistence.getRunForClient(input);
      if (!run) {
        return null;
      }
      return {
        run,
        workspace: getWorkspaceById(run.workspaceId),
      };
    },

    async listRunsForClient(input: ListRunsForClientInput): Promise<RunRecord[]> {
      return [...state.runs.values()]
        .filter((run) => input.isAdmin || run.clientId === input.clientId)
        .filter((run) => !input.workspaceId || run.workspaceId === input.workspaceId)
        .filter((run) => !input.status || run.status === input.status)
        .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
        .slice(0, input.limit ?? Number.POSITIVE_INFINITY)
        .map(clone);
    },

    async getActiveRunForWorkspace(workspaceId: string): Promise<RunRecord | null> {
      return cloneOrNull(
        [...state.runs.values()]
          .filter(
            (run) =>
              run.workspaceId === workspaceId && (run.status === 'queued' || run.status === 'running'),
          )
          .sort(compareByCreatedAtThenId)[0] ?? null,
      );
    },

    async getRunByIdempotencyKey(input: GetRunByIdempotencyKeyInput): Promise<RunRecord | null> {
      return cloneOrNull(
        [...state.runs.values()].find(
          (run) =>
            run.clientId === input.clientId &&
            run.profileId === input.profileId &&
            run.workspaceId === input.workspaceId &&
            run.idempotencyKey === input.idempotencyKey,
        ) ?? null,
      );
    },
  };

  function insertProfileSnapshot(input: {
    runId: string;
    profile: unknown;
    now: number;
  }): ProfileSnapshotRecord {
    const snapshot: ProfileSnapshotRecord = {
      runId: input.runId,
      profile: clone(input.profile),
      createdAt: input.now,
    };
    state.profileSnapshots.set(input.runId, snapshot);
    return clone(snapshot);
  }

  function getWorkspaceById(workspaceId: string): WorkspaceRecord {
    const workspace = state.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found after write: ${workspaceId}`);
    }
    return clone(workspace);
  }

  function getRunById(runId: string): RunRecord {
    const run = state.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found after write: ${runId}`);
    }
    return clone(run);
  }

  function getRunMessageById(messageId: string): RunMessageRecord {
    const message = state.messages.get(messageId);
    if (!message) {
      throw new Error(`Run message not found after write: ${messageId}`);
    }
    return clone(message);
  }

  function getRunMessages(runId: string): RunMessageRecord[] {
    return [...state.messages.values()]
      .filter((message) => message.runId === runId)
      .sort((left, right) => left.position - right.position || left.createdAt - right.createdAt)
      .map(clone);
  }

  function nextConversationSeq(conversationId: string | null): number | null {
    if (conversationId === null) {
      return null;
    }
    const maxSeq = [...state.messages.values()]
      .filter((message) => message.conversationId === conversationId)
      .reduce((max, message) => Math.max(max, message.conversationSeq ?? 0), 0);
    return maxSeq + 1;
  }

  return persistence;
}

function createEmptyState(): InMemoryState {
  return {
    workspaces: new Map(),
    conversations: new Map(),
    runs: new Map(),
    messages: new Map(),
    profileSnapshots: new Map(),
    promptSnapshots: new Map(),
    skillSnapshots: new Map(),
    contextSnapshots: new Map(),
    artifacts: [],
    runLogs: new Map(),
    feedback: [],
  };
}

function cloneState(state: InMemoryState): InMemoryState {
  return {
    workspaces: cloneMap(state.workspaces),
    conversations: cloneMap(state.conversations),
    runs: cloneMap(state.runs),
    messages: cloneMap(state.messages),
    profileSnapshots: cloneMap(state.profileSnapshots),
    promptSnapshots: cloneMap(state.promptSnapshots),
    skillSnapshots: cloneMap(state.skillSnapshots),
    contextSnapshots: cloneMap(state.contextSnapshots),
    artifacts: state.artifacts.map(clone),
    runLogs: cloneMap(state.runLogs),
    feedback: state.feedback.map(clone),
  };
}

function cloneMap<K, V>(map: Map<K, V>): Map<K, V> {
  return new Map([...map.entries()].map(([key, value]) => [key, clone(value)]));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOrNull<T>(value: T | null): T | null {
  return value === null ? null : clone(value);
}

function makeWorkspaceKey(originId: string, userId: string, projectId: string): string {
  return `${originId}/${userId}/${projectId}`;
}

function makeQueuedRun(id: string, input: Omit<InsertRunQueuedInput, 'id'>): RunRecord {
  return {
    id,
    workspaceId: input.workspaceId,
    profileId: input.profileId,
    clientId: input.clientId,
    kind: input.kind,
    skillId: input.skillId ?? null,
    status: 'queued',
    prompt: input.prompt,
    promptMode: input.promptMode ?? 'legacy',
    currentPrompt: input.currentPrompt ?? input.prompt,
    contextPolicy: clone(input.contextPolicy ?? null),
    collectionMode: input.collectionMode ?? 'lite',
    promptSnapshotHash: input.promptSnapshotHash ?? null,
    promptSnapshotCharCount: input.promptSnapshotCharCount ?? null,
    promptSnapshotByteCount: input.promptSnapshotByteCount ?? null,
    promptSnapshotPersisted: input.promptSnapshotPersisted ?? false,
    businessContextHash: input.businessContextHash ?? null,
    artifactRuleIds: clone(input.artifactRuleIds ?? null),
    idempotencyKey: input.idempotencyKey ?? null,
    idempotencyFingerprint: input.idempotencyFingerprint ?? null,
    lastRunEventId: null,
    queuedAt: input.now,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    signal: null,
    errorCode: null,
    errorMessage: null,
    usage: null,
    metadata: clone(input.metadata ?? null),
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function assertRelativeLogPath(value: string | null): void {
  if (value !== null && path.isAbsolute(value)) {
    throw new Error('Run log paths must be relative to dataDir');
  }
}

function compareByCreatedAtThenId<T extends { createdAt: number; id: string }>(
  left: T,
  right: T,
): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function compareMessagesForPromptDesc(left: RunMessageRecord, right: RunMessageRecord): number {
  return (
    (right.conversationSeq ?? 0) - (left.conversationSeq ?? 0) ||
    right.createdAt - left.createdAt ||
    right.id.localeCompare(left.id)
  );
}

function compareMessagesForPromptAsc(left: RunMessageRecord, right: RunMessageRecord): number {
  return (
    (left.conversationSeq ?? 0) - (right.conversationSeq ?? 0) ||
    left.createdAt - right.createdAt ||
    left.id.localeCompare(right.id)
  );
}

function compareArtifacts(left: ArtifactRecord, right: ArtifactRecord): number {
  return (
    (artifactRoleOrder.get(left.role) ?? 3) - (artifactRoleOrder.get(right.role) ?? 3) ||
    left.relativePath.localeCompare(right.relativePath)
  );
}
