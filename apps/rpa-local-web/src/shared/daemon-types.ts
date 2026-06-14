export type RunKind = 'generate' | 'revise';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';
export type PromptMode = 'legacy' | 'business-context' | 'daemon-composed';
export type CollectionMode = 'lite' | 'diagnostic' | 'review';
export type EventVisibility = 'quiet' | 'normal' | 'debug';

export interface HealthResponse {
  ok: true;
}

export interface CreateWorkspaceRequest {
  profileId: string;
  workspace: {
    originId: string;
    userId: string;
    projectId: string;
  };
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

export interface ArtifactSummary {
  id: string;
  runId: string;
  workspaceId: string;
  ruleId: string;
  role: 'primary' | 'supporting' | 'debug';
  relativePath: string;
  fileName: string;
  mimeType: string | null;
  size: number | null;
  mtime: number | null;
  sha256: string | null;
}

export interface ArtifactsResponse {
  artifacts: ArtifactSummary[];
}

export interface CreateRunFeedbackRequest {
  category: string;
  message: string;
  metadata?: unknown;
}

export interface RunFeedbackRecord {
  id?: string;
  runId?: string;
  clientId?: string;
  category: string;
  message: string;
  metadata?: unknown;
  createdAt?: number;
}

export interface CreateRunFeedbackResponse {
  feedback: RunFeedbackRecord;
}

export interface RunFeedbackResponse {
  feedback: RunFeedbackRecord[];
}

export interface DaemonRunEventRecord {
  id: string;
  event: unknown;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
