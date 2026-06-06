export type DaemonRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';

export interface DaemonTextDeltaEvent {
  type: 'text_delta';
  delta: string;
}

export interface DaemonArtifactFinalizedEvent {
  type: 'artifact_finalized';
  artifact: {
    id: string;
    runId: string;
    ruleId: string;
    role: 'primary' | 'supporting' | 'debug';
    relativePath: string;
    fileName: string;
    mimeType: string | null;
    size: number | null;
    mtime: number | null;
    sha256: string | null;
  };
}

export interface DaemonEndEvent {
  type: 'end';
  status?: DaemonRunStatus;
}

export interface DaemonErrorEvent {
  type: 'error';
  message: string;
  code?: string;
  details?: unknown;
}

const daemonRunStatuses = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
] as const satisfies readonly DaemonRunStatus[];

const artifactRoles = ['primary', 'supporting', 'debug'] as const;

export function isDaemonTextDeltaEvent(event: unknown): event is DaemonTextDeltaEvent {
  return isRecord(event) && event.type === 'text_delta' && typeof event.delta === 'string';
}

export function isDaemonArtifactFinalizedEvent(event: unknown): event is DaemonArtifactFinalizedEvent {
  if (!isRecord(event) || event.type !== 'artifact_finalized' || !isRecord(event.artifact)) {
    return false;
  }

  const { artifact } = event;
  return (
    typeof artifact.id === 'string' &&
    typeof artifact.runId === 'string' &&
    typeof artifact.ruleId === 'string' &&
    isArtifactRole(artifact.role) &&
    typeof artifact.relativePath === 'string' &&
    typeof artifact.fileName === 'string' &&
    isNullableString(artifact.mimeType) &&
    isNullableNumber(artifact.size) &&
    isNullableNumber(artifact.mtime) &&
    isNullableString(artifact.sha256)
  );
}

export function isDaemonEndEvent(event: unknown): event is DaemonEndEvent {
  return (
    isRecord(event) &&
    event.type === 'end' &&
    (event.status === undefined || isDaemonRunStatus(event.status))
  );
}

export function isDaemonErrorEvent(event: unknown): event is DaemonErrorEvent {
  return (
    isRecord(event) &&
    event.type === 'error' &&
    typeof event.message === 'string' &&
    (event.code === undefined || typeof event.code === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDaemonRunStatus(value: unknown): value is DaemonRunStatus {
  return typeof value === 'string' && daemonRunStatuses.some((status) => status === value);
}

function isArtifactRole(value: unknown): value is DaemonArtifactFinalizedEvent['artifact']['role'] {
  return typeof value === 'string' && artifactRoles.some((role) => role === value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}
