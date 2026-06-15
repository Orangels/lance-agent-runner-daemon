export type RunKind = 'generate' | 'revise';

export type PromptMode = 'legacy' | 'business-context' | 'daemon-composed';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';

export type EventVisibility = 'quiet' | 'normal' | 'debug';

export type CollectionMode = 'lite' | 'diagnostic' | 'review';

export type ArtifactRole = 'primary' | 'supporting' | 'debug';

export type DaemonErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'MODEL_NOT_ALLOWED'
  | 'PROFILE_NOT_ALLOWED'
  | 'SKILL_NOT_ALLOWED'
  | 'COLLECTION_MODE_NOT_ALLOWED'
  | 'SKILL_UNAVAILABLE'
  | 'SKILL_STAGING_FAILED'
  | 'PROMPT_COMPOSITION_FAILED'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'RUN_QUEUE_FULL'
  | 'WORKSPACE_RUN_ACTIVE'
  | 'RUN_NOT_CANCELABLE'
  | 'RUN_TIMEOUT'
  | 'RUN_INACTIVITY_TIMEOUT'
  | 'ARTIFACT_REQUIRED_MISSING'
  | 'ARTIFACT_SCAN_FAILED'
  | 'RUN_INTERRUPTED_BY_DAEMON_RESTART'
  | 'CLAUDE_AUTH_FAILED'
  | 'CLAUDE_CLI_FAILED'
  | 'WEBHOOK_URL_NOT_ALLOWED'
  | 'INTERNAL_ERROR'
  | 'PATH_NOT_ALLOWED'
  | 'INVALID_PATH_SEGMENT';

export interface ErrorResponse {
  error: {
    code: DaemonErrorCode;
    message: string;
    details?: unknown;
  };
}

export interface HealthResponse {
  ok: true;
}

export interface ArtifactRule {
  id: string;
  role: ArtifactRole;
  pattern: string;
  required?: boolean;
  mimeType?: string;
}

export interface PublicProfile {
  id: string;
  allowedSkillIds: string[];
  artifactRules: ArtifactRule[];
  defaultArtifactRuleIds: string[];
  defaultModel: string | null;
  allowedModels: string[];
  eventVisibility: EventVisibility;
  maxCollectionMode: CollectionMode;
  permissionMode: string;
  profileConcurrency: number;
  runTimeoutMs: number | null;
  inactivityTimeoutMs: number | null;
  cancelGraceMs: number;
}

export interface ProfilesResponse {
  profiles: PublicProfile[];
}

export interface WorkspaceIdentity {
  originId: string;
  userId: string;
  projectId: string;
}

export interface CreateWorkspaceRequest {
  profileId: string;
  workspace: WorkspaceIdentity;
  metadata?: Record<string, unknown>;
}

export interface PublicWorkspace {
  workspaceId: string;
  workspaceKey: string;
}

export interface UploadedWorkspaceFile {
  targetPath: string;
  size: number;
  originalName: string;
  mimeType: string | null;
}

export interface UploadWorkspaceFileResponse extends PublicWorkspace {
  file: UploadedWorkspaceFile;
}

export interface ContextPolicy {
  recentMessages?: number;
  maxMessageChars?: number;
  maxTotalChars?: number;
  includeRunWarnings?: boolean;
}

export interface CreateRunWebhookRequest {
  url: string;
  secret?: string;
  statuses?: RunStatus[];
  metadata?: Record<string, unknown>;
}

export interface CreateRunRequest {
  profileId: string;
  workspaceId: string;
  kind: RunKind;
  prompt?: string;
  currentPrompt?: string;
  conversationId?: string;
  promptMode?: PromptMode;
  collectionMode?: CollectionMode;
  businessContext?: Record<string, unknown>;
  contextPolicy?: ContextPolicy;
  skillId?: string;
  model?: string;
  artifactRuleIds?: string[];
  eventVisibility?: EventVisibility;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  webhook?: CreateRunWebhookRequest;
}

export interface PublicRun {
  id: string;
  workspaceId: string;
  profileId: string;
  kind: RunKind;
  skillId: string | null;
  status: RunStatus;
  lastRunEventId: string | null;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
  exitCode?: number | null;
  signal?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  usage?: unknown;
  metadata?: unknown;
}

export interface CreateRunResponse {
  runId: string;
  status: RunStatus;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  idempotentReplay?: true;
}

export interface CancelRunResponse {
  ok: true;
}

export interface PublicRunMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinkingContent: string;
  events: unknown[] | null;
  runStatus: RunStatus | null;
  lastRunEventId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface RunDetailResponse {
  run: PublicRun;
  messages: PublicRunMessage[];
}

export interface PublicRunStatus {
  id: string;
  workspaceId: string;
  profileId: string;
  kind: RunKind;
  skillId: string | null;
  status: RunStatus;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface RunStatusResponse {
  run: PublicRunStatus;
  terminal: boolean;
}

export interface PublicArtifact {
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
}

export interface ArtifactsResponse {
  artifacts: PublicArtifact[];
}
