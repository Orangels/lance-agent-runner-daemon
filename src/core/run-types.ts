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

export const daemonErrorCodes = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'MODEL_NOT_ALLOWED',
  'PROFILE_NOT_ALLOWED',
  'SKILL_NOT_ALLOWED',
  'RUN_QUEUE_FULL',
  'RUN_NOT_CANCELABLE',
  'RUN_TIMEOUT',
  'RUN_INACTIVITY_TIMEOUT',
  'ARTIFACT_REQUIRED_MISSING',
  'RUN_INTERRUPTED_BY_DAEMON_RESTART',
  'CLAUDE_AUTH_FAILED',
  'CLAUDE_CLI_FAILED',
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

export const protectedWorkspaceDirectoryNames = ['.claude-runner-skills'] as const;

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

export interface CreateRunRequest {
  profileId: string;
  workspaceId: string;
  kind: RunKind;
  prompt: string;
  skillId?: string;
  model?: string;
  artifactRuleIds?: string[];
  eventVisibility?: EventVisibility;
  metadata?: Record<string, unknown>;
}

export interface ListRunsQuery {
  originId?: string;
  userId?: string;
  projectId?: string;
  workspaceKey?: string;
  workspacePrefix?: string;
  status?: RunStatus;
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
