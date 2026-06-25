export const runKinds = ['generate', 'revise'] as const;
export type RunKind = (typeof runKinds)[number];

export const runStatuses = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
] as const;
export type RunStatus = (typeof runStatuses)[number];

const terminalRunStatuses = new Set<RunStatus>(['succeeded', 'failed', 'canceled', 'interrupted']);

export function isTerminalRunStatus(status: RunStatus): boolean {
  return terminalRunStatuses.has(status);
}

export const eventVisibilityLevels = ['quiet', 'normal', 'debug'] as const;
export type EventVisibility = (typeof eventVisibilityLevels)[number];

export const promptModes = ['legacy', 'business-context', 'daemon-composed'] as const;
export type PromptMode = (typeof promptModes)[number];

export const collectionModes = ['lite', 'diagnostic', 'review'] as const;
export type CollectionMode = (typeof collectionModes)[number];

export const artifactRoles = ['primary', 'supporting', 'debug'] as const;
export type ArtifactRole = (typeof artifactRoles)[number];

export const daemonErrorCodes = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'MODEL_NOT_ALLOWED',
  'PROFILE_NOT_ALLOWED',
  'SKILL_NOT_ALLOWED',
  'SKILL_UNAVAILABLE',
  'SKILL_STAGING_FAILED',
  'PROMPT_COMPOSITION_FAILED',
  'IDEMPOTENCY_KEY_CONFLICT',
  'RUN_QUEUE_FULL',
  'WORKSPACE_RUN_ACTIVE',
  'RUN_NOT_CANCELABLE',
  'RUN_TIMEOUT',
  'RUN_INACTIVITY_TIMEOUT',
  'ARTIFACT_REQUIRED_MISSING',
  'ARTIFACT_SCAN_FAILED',
  'RUN_INTERRUPTED_BY_DAEMON_RESTART',
  'CLAUDE_AUTH_FAILED',
  'CLAUDE_CLI_FAILED',
  'COLLECTION_MODE_NOT_ALLOWED',
  'WEBHOOK_URL_NOT_ALLOWED',
  'REVIEW_BUNDLE_TOO_LARGE',
  'INTERNAL_ERROR',
  'PATH_NOT_ALLOWED',
  'INVALID_PATH_SEGMENT',
] as const;
export type DaemonErrorCode = (typeof daemonErrorCodes)[number];

export const workspaceDirectoryNames = [
  'input',
  'output',
  'work',
  '.claude-runner-skills',
] as const;
export type WorkspaceDirectoryName = (typeof workspaceDirectoryNames)[number];

export const runMessageFlushPolicy = {
  throttleMs: 500,
  createUserAndAssistantDraftOnRunCreate: true,
  forceFlushBeforeTerminalTransition: true,
  preserveLastSuccessfulPartialWriteAfterCrash: true,
} as const;

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

export interface PrepareWorkspaceFileRequest {
  sourcePath: string;
  targetPath: string;
}

export interface PrepareWorkspaceRequest {
  files: PrepareWorkspaceFileRequest[];
}

export interface UploadedWorkspaceFile {
  targetPath: string;
  size: number;
  originalName: string;
  mimeType: string | null;
}

export interface UploadWorkspaceFileResponse {
  workspaceId: string;
  workspaceKey: string;
  file: UploadedWorkspaceFile;
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

export interface CreateRunWebhookRequest {
  url: string;
  secret?: string;
  statuses?: RunStatus[];
  metadata?: Record<string, unknown>;
}

export interface ContextPolicy {
  recentMessages?: number;
  maxMessageChars?: number;
  maxTotalChars?: number;
  includeRunWarnings?: boolean;
}

export interface ListRunsQuery {
  originId?: string;
  userId?: string;
  projectId?: string;
  workspaceKey?: string;
  workspacePrefix?: string;
  status?: RunStatus;
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

export interface EventReplayQuery {
  after?: string;
}

export interface ErrorResponse {
  error: {
    code: DaemonErrorCode;
    message: string;
    details?: unknown;
  };
}
