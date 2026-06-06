import type { RpaDslDocument } from './dsl-schema.js';

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

export const rpaExecutionEventTypes = [
  'run.started',
  'step.started',
  'step.screenshot',
  'step.completed',
  'step.failed',
  'artifact.created',
  'run.completed',
  'log',
] as const;

export type RpaExecutionEventType = (typeof rpaExecutionEventTypes)[number];

export interface RpaExecutionEvent {
  type: RpaExecutionEventType;
  executionId: string;
  timestamp: string;
  stepId?: string;
  stream?: 'stdout' | 'stderr';
  message?: string;
  artifactId?: string;
  role?: 'screenshot' | 'download' | 'trace' | 'video' | 'log' | 'other';
  relativePath?: string;
  status?: RpaExecutionStatus;
  exitCode?: number | null;
  sequence?: number;
}

export interface RpaValidationIssueSummary {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
}

export interface RpaFlowDetailResponse {
  flowId: string;
  title: string;
  source: RpaDslDocument['meta']['source'];
  dsl: RpaDslDocument;
  warnings: RpaValidationIssueSummary[];
}

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

export const rpaFeedbackCategories = [
  'dsl',
  'selector',
  'wait',
  'assert',
  'parameterization',
  'write-risk',
  'manual-step',
  'executor',
] as const;

export type RpaFeedbackCategory = (typeof rpaFeedbackCategories)[number];

export const rpaFeedbackSeverities = ['minor', 'major', 'critical'] as const;

export type RpaFeedbackSeverity = (typeof rpaFeedbackSeverities)[number];

export interface CreateRpaFeedbackRequest {
  daemonRunId: string;
  flowId?: string;
  executionId?: string;
  stepId?: string;
  category: RpaFeedbackCategory;
  severity: RpaFeedbackSeverity;
  message: string;
  artifactPath?: string;
  screenshotPath?: string;
}

export interface CreateRpaFeedbackResponse {
  feedback: unknown;
}

export function isRpaFeedbackCategory(value: string): value is RpaFeedbackCategory {
  return rpaFeedbackCategories.includes(value as RpaFeedbackCategory);
}

export function isRpaFeedbackSeverity(value: string): value is RpaFeedbackSeverity {
  return rpaFeedbackSeverities.includes(value as RpaFeedbackSeverity);
}
