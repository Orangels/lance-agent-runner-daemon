export interface RpaHealthResponse {
  ok: true;
  app: 'rpa-local-web';
}

export interface RpaConfigResponse {
  defaultProfileId: string;
  daemonConfigured: boolean;
}

export interface RpaDaemonHealthResponse {
  ok: boolean;
  daemonReachable: boolean;
  status?: number;
  error?: string;
}

export type RpaExecutionMode = 'verify' | 'run';
export type RpaExecutionStatus = 'queued' | 'running' | 'canceling' | 'succeeded' | 'failed' | 'canceled' | 'timed_out';

export interface StartRpaExecutionRequest {
  flowId: string;
  daemonRunId?: string;
  mode: RpaExecutionMode;
  dryRun?: boolean;
  headless?: boolean;
  timeoutMs?: number;
  params?: Record<string, string | number | boolean | null>;
}

export interface StartRpaExecutionResponse {
  executionId: string;
  flowId: string;
  daemonRunId?: string;
  status: RpaExecutionStatus;
}

export interface RpaExecutionStatusResponse {
  executionId: string;
  flowId: string;
  daemonRunId?: string;
  status: RpaExecutionStatus;
  mode: RpaExecutionMode;
  dryRun: boolean;
  headless: boolean;
  startedAt?: string;
  finishedAt?: string;
  failedStepId?: string;
  error?: { code: string; message: string };
}

export interface RpaExecutionLogResponse {
  executionId: string;
  stdout: string;
  stderr: string;
}

export interface RpaExecutionArtifactSummary {
  artifactId: string;
  role: 'screenshot' | 'download' | 'trace' | 'video' | 'log' | 'other';
  fileName: string;
  relativePath: string;
  size: number;
  sha256: string;
}

export interface RpaExecutionArtifactsResponse {
  executionId: string;
  artifacts: RpaExecutionArtifactSummary[];
}
