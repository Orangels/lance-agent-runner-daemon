import type {
  ArtifactRole,
  CollectionMode,
  ContextPolicy,
  PromptMode,
  RunKind,
  RunStatus,
} from '../core/run-types.js';

export interface WorkspaceRecord {
  id: string;
  profileId: string;
  clientId: string;
  originId: string;
  userId: string;
  projectId: string;
  workspaceKey: string;
  status: string;
  metadata: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationRecord {
  id: string;
  workspaceId: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunRecord {
  id: string;
  workspaceId: string;
  profileId: string;
  clientId: string;
  kind: RunKind;
  skillId: string | null;
  status: RunStatus;
  prompt: string;
  promptMode: PromptMode;
  currentPrompt: string | null;
  contextPolicy: ContextPolicy | null;
  collectionMode: CollectionMode;
  promptSnapshotHash: string | null;
  promptSnapshotCharCount: number | null;
  promptSnapshotByteCount: number | null;
  promptSnapshotPersisted: boolean;
  businessContextHash: string | null;
  artifactRuleIds: string[] | null;
  idempotencyKey: string | null;
  idempotencyFingerprint: string | null;
  lastRunEventId: string | null;
  queuedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  usage: unknown;
  metadata: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface RunMessageRecord {
  id: string;
  workspaceId: string;
  conversationId: string | null;
  runId: string;
  role: string;
  content: string;
  thinkingContent: string;
  events: unknown;
  attachments: unknown;
  producedFiles: unknown;
  runStatus: string | null;
  lastRunEventId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  position: number;
  conversationSeq: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  workspaceId: string;
  ruleId: string;
  role: ArtifactRole;
  relativePath: string;
  fileName: string;
  mimeType: string | null;
  size: number | null;
  mtime: number | null;
  sha256: string | null;
  metadata: unknown;
  createdAt: number;
}

export interface RunDetailRecord {
  run: RunRecord;
  messages: RunMessageRecord[];
}

export interface RunWithWorkspaceRecord {
  run: RunRecord;
  workspace: WorkspaceRecord;
}

export interface RunLogRecord {
  runId: string;
  stdoutLogPath: string | null;
  stderrLogPath: string | null;
  debugEventsLogPath: string | null;
  createdAt: number;
}

export interface ProfileSnapshotRecord {
  runId: string;
  profile: unknown;
  createdAt: number;
}

export interface RunPromptSnapshotRecord {
  runId: string;
  promptSnapshot: string | null;
  promptSnapshotHash: string | null;
  charCount: number | null;
  byteCount: number | null;
  persisted: boolean;
  createdAt: number;
}

export interface RunSkillSnapshotRecord {
  runId: string;
  skillId: string | null;
  skillName: string | null;
  skillDescription: string | null;
  skillBodyHash: string | null;
  skillBody: string | null;
  sideFilesManifest: unknown;
  persisted: boolean;
  createdAt: number;
}

export interface RunContextSnapshotRecord {
  runId: string;
  businessContext: unknown;
  businessContextHash: string | null;
  persisted: boolean;
  createdAt: number;
}

export interface RunFeedbackRecord {
  id: string;
  runId: string;
  clientId: string;
  category: string;
  message: string;
  metadata: unknown;
  createdAt: number;
}

export interface CreateRunQueuedWithMessagesAndSnapshotResult {
  run: RunRecord;
  conversation: ConversationRecord;
  messages: RunMessageRecord[];
  profileSnapshot: ProfileSnapshotRecord;
}

export interface UpsertWorkspaceInput {
  id: string;
  profileId: string;
  clientId: string;
  originId: string;
  userId: string;
  projectId: string;
  status?: string;
  metadata?: unknown;
  now: number;
}

export interface GetWorkspaceForClientInput {
  workspaceId: string;
  clientId: string;
  isAdmin?: boolean;
}

export interface GetOrCreateDefaultConversationInput {
  id: string;
  workspaceId: string;
  now: number;
}

export interface GetConversationForWorkspaceInput {
  conversationId: string;
  workspaceId: string;
}

export interface ListConversationMessagesForPromptInput {
  workspaceId: string;
  conversationId: string;
  excludeRunId?: string;
  limit: number;
}

export interface InsertRunQueuedInput {
  id: string;
  workspaceId: string;
  profileId: string;
  clientId: string;
  kind: RunKind;
  skillId?: string;
  prompt: string;
  promptMode?: PromptMode;
  currentPrompt?: string | null;
  contextPolicy?: ContextPolicy | null;
  collectionMode?: CollectionMode;
  promptSnapshotHash?: string | null;
  promptSnapshotCharCount?: number | null;
  promptSnapshotByteCount?: number | null;
  promptSnapshotPersisted?: boolean;
  businessContextHash?: string | null;
  artifactRuleIds?: string[];
  idempotencyKey?: string | null;
  idempotencyFingerprint?: string | null;
  metadata?: unknown;
  now: number;
}

export interface CreateRunQueuedWithMessagesAndSnapshotInput
  extends Omit<InsertRunQueuedInput, 'id'> {
  runId: string;
  conversationId?: string;
  defaultConversationId?: string;
  userMessageId: string;
  assistantMessageId: string;
  businessContext?: unknown;
  persistBusinessContext?: boolean;
  profileSnapshot: unknown;
}

export interface UpsertRunPromptSnapshotInput {
  runId: string;
  promptSnapshot: string | null;
  promptSnapshotHash: string;
  charCount: number;
  byteCount: number;
  persisted: boolean;
  now: number;
}

export interface UpdateRunPromptSnapshotFieldsInput {
  runId: string;
  promptSnapshotHash: string;
  charCount: number;
  byteCount: number;
  persisted: boolean;
  now: number;
}

export interface UpsertRunSkillSnapshotInput {
  runId: string;
  skillId: string | null;
  skillName: string | null;
  skillDescription: string | null;
  skillBodyHash: string | null;
  skillBody: string | null;
  sideFilesManifest: unknown;
  persisted: boolean;
  now: number;
}

export interface UpsertRunContextSnapshotInput {
  runId: string;
  businessContext: unknown;
  businessContextHash: string | null;
  persisted: boolean;
  now: number;
}

export interface InsertRunMessagesForRunCreateInput {
  userMessageId: string;
  assistantMessageId: string;
  workspaceId: string;
  conversationId: string;
  runId: string;
  prompt: string;
  now: number;
}

export interface InsertAssistantRunMessageInput {
  id: string;
  workspaceId: string;
  conversationId: string;
  runId: string;
  content?: string;
  thinkingContent?: string;
  events?: unknown;
  attachments?: unknown;
  producedFiles?: unknown;
  runStatus: RunStatus;
  lastRunEventId?: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
  position: number;
  now: number;
}

export interface UpdateAssistantMessagesTerminalForRunInput {
  runId: string;
  runStatus: RunStatus;
  endedAt: number;
  lastRunEventId?: string | null;
  now: number;
}

export interface UpdateRunStatusInput {
  runId: string;
  status: RunStatus;
  now: number;
}

export interface UpdateRunStartedInput {
  runId: string;
  startedAt: number;
  lastRunEventId?: string | null;
  now: number;
}

export interface UpdateRunTerminalInput {
  runId: string;
  status: RunStatus;
  finishedAt: number;
  exitCode?: number | null;
  signal?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  usage?: unknown;
  lastRunEventId?: string | null;
  now: number;
}

export interface UpdateAssistantMessageStartedInput {
  messageId: string;
  startedAt: number;
  lastRunEventId?: string | null;
  now: number;
}

export interface UpdateAssistantMessageTerminalInput {
  messageId: string;
  runStatus: RunStatus;
  content?: string;
  thinkingContent?: string;
  events?: unknown;
  attachments?: unknown;
  producedFiles?: unknown;
  endedAt: number;
  lastRunEventId?: string | null;
  now: number;
}

export interface UpdateRunMessageInput {
  messageId: string;
  content?: string;
  thinkingContent?: string;
  events?: unknown;
  attachments?: unknown;
  producedFiles?: unknown;
  runStatus?: string;
  lastRunEventId?: string | null;
  startedAt?: number;
  endedAt?: number;
  now: number;
}

export interface ReplaceArtifactsForRunInput {
  runId: string;
  workspaceId: string;
  artifacts: Array<{
    id: string;
    ruleId: string;
    role: ArtifactRole;
    relativePath: string;
    fileName: string;
    mimeType: string | null;
    size: number | null;
    mtime: number | null;
    sha256: string | null;
    metadata?: unknown;
  }>;
  now: number;
}

export interface ListArtifactsForRunInput {
  runId: string;
  clientId: string;
  isAdmin?: boolean;
}

export interface GetArtifactForRunForClientInput extends ListArtifactsForRunInput {
  artifactId: string;
}

export interface UpsertRunLogPathsInput {
  runId: string;
  stdoutLogPath: string | null;
  stderrLogPath: string | null;
  debugEventsLogPath: string | null;
  now: number;
}

export interface GetRunLogForRunForClientInput {
  runId: string;
  clientId: string;
  isAdmin?: boolean;
}

export interface ListRunLogsFinishedBeforeInput {
  finishedBefore: number;
  limit: number;
}

export interface InsertRunFeedbackInput {
  id: string;
  runId: string;
  clientId: string;
  category: string;
  message: string;
  metadata: unknown;
  now: number;
}

export interface ListRunFeedbackForClientInput {
  runId: string;
  clientId: string;
  isAdmin?: boolean;
}

export interface RunForClientInput {
  runId: string;
  clientId: string;
  isAdmin?: boolean;
}

export interface ListRunsForClientInput {
  clientId: string;
  isAdmin?: boolean;
  workspaceId?: string;
  status?: RunStatus;
  limit?: number;
}

export interface GetRunByIdempotencyKeyInput {
  clientId: string;
  profileId: string;
  workspaceId: string;
  idempotencyKey: string;
}

export interface RunnerPersistence {
  close(): Promise<void>;
  isUniqueConstraintError(error: unknown): boolean;
  transaction<T>(fn: (persistence: RunnerPersistence) => Promise<T>): Promise<T>;
  upsertWorkspace(input: UpsertWorkspaceInput): Promise<WorkspaceRecord>;
  getWorkspaceForClient(input: GetWorkspaceForClientInput): Promise<WorkspaceRecord | null>;
  getOrCreateDefaultConversation(input: GetOrCreateDefaultConversationInput): Promise<ConversationRecord>;
  getConversationForWorkspace(input: GetConversationForWorkspaceInput): Promise<ConversationRecord | null>;
  listConversationMessagesForPrompt(input: ListConversationMessagesForPromptInput): Promise<RunMessageRecord[]>;
  insertRunQueued(input: InsertRunQueuedInput): Promise<RunRecord>;
  createRunQueuedWithMessagesAndSnapshot(
    input: CreateRunQueuedWithMessagesAndSnapshotInput,
  ): Promise<CreateRunQueuedWithMessagesAndSnapshotResult>;
  getProfileSnapshotForRun(runId: string): Promise<ProfileSnapshotRecord | null>;
  upsertRunPromptSnapshot(input: UpsertRunPromptSnapshotInput): Promise<void>;
  updateRunPromptSnapshotFields(input: UpdateRunPromptSnapshotFieldsInput): Promise<RunRecord>;
  upsertRunSkillSnapshot(input: UpsertRunSkillSnapshotInput): Promise<void>;
  upsertRunContextSnapshot(input: UpsertRunContextSnapshotInput): Promise<void>;
  getRunPromptSnapshot(runId: string): Promise<RunPromptSnapshotRecord | null>;
  getRunSkillSnapshot(runId: string): Promise<RunSkillSnapshotRecord | null>;
  getRunContextSnapshot(runId: string): Promise<RunContextSnapshotRecord | null>;
  markInterruptedRunsOnStartup(now: number): Promise<number>;
  insertRunMessagesForRunCreate(input: InsertRunMessagesForRunCreateInput): Promise<RunMessageRecord[]>;
  insertAssistantRunMessage(input: InsertAssistantRunMessageInput): Promise<RunMessageRecord>;
  updateAssistantMessagesTerminalForRun(input: UpdateAssistantMessagesTerminalForRunInput): Promise<number>;
  updateRunStatus(input: UpdateRunStatusInput): Promise<RunRecord>;
  updateRunStarted(input: UpdateRunStartedInput): Promise<RunRecord>;
  updateRunTerminal(input: UpdateRunTerminalInput): Promise<RunRecord>;
  updateAssistantMessageStarted(input: UpdateAssistantMessageStartedInput): Promise<RunMessageRecord>;
  updateAssistantMessageTerminal(input: UpdateAssistantMessageTerminalInput): Promise<RunMessageRecord>;
  updateRunMessage(input: UpdateRunMessageInput): Promise<RunMessageRecord>;
  replaceArtifactsForRun(input: ReplaceArtifactsForRunInput): Promise<ArtifactRecord[]>;
  listArtifactsForRun(input: ListArtifactsForRunInput): Promise<ArtifactRecord[]>;
  getArtifactForRunForClient(input: GetArtifactForRunForClientInput): Promise<ArtifactRecord | null>;
  upsertRunLogPaths(input: UpsertRunLogPathsInput): Promise<RunLogRecord>;
  getRunLogForRunForClient(input: GetRunLogForRunForClientInput): Promise<RunLogRecord | null>;
  listRunLogsFinishedBefore(input: ListRunLogsFinishedBeforeInput): Promise<RunLogRecord[]>;
  deleteRunLogRows(runIds: readonly string[]): Promise<number>;
  insertRunFeedback(input: InsertRunFeedbackInput): Promise<RunFeedbackRecord>;
  listRunFeedbackForClient(input: ListRunFeedbackForClientInput): Promise<RunFeedbackRecord[] | null>;
  getRunDetail(input: RunForClientInput): Promise<RunDetailRecord | null>;
  getRunForClient(input: RunForClientInput): Promise<RunRecord | null>;
  getRunWithWorkspaceForClient(input: RunForClientInput): Promise<RunWithWorkspaceRecord | null>;
  listRunsForClient(input: ListRunsForClientInput): Promise<RunRecord[]>;
  getActiveRunForWorkspace(workspaceId: string): Promise<RunRecord | null>;
  getRunByIdempotencyKey(input: GetRunByIdempotencyKeyInput): Promise<RunRecord | null>;
}
