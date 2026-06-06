import type { RpaExecutionMode, RpaExecutionStatus } from '../../shared/rpa-api-types.js';

export type { RpaExecutionMode, RpaExecutionStatus };

export type RpaExecutionEventType =
  | 'run.started'
  | 'step.started'
  | 'step.screenshot'
  | 'step.completed'
  | 'step.failed'
  | 'artifact.created'
  | 'run.completed'
  | 'log';

export type RpaExecutionParamValue = string | number | boolean | null;
export type RpaExecutionParamSummaryValue = RpaExecutionParamValue | '[masked]';

export interface RpaExecutionRecord {
  executionId: string;
  flowId: string;
  daemonRunId?: string;
  mode: RpaExecutionMode;
  dryRun: boolean;
  headless: boolean;
  status: RpaExecutionStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  timeoutMs: number;
  failedStepId?: string;
  paramsSummary: Record<string, RpaExecutionParamSummaryValue>;
  error?: { code: string; message: string };
}

export interface CreateExecutionInput {
  flowId: string;
  daemonRunId?: string;
  mode: RpaExecutionMode;
  dryRun: boolean;
  headless: boolean;
  timeoutMs: number;
  params: Record<string, RpaExecutionParamValue>;
  maskedParamIds: string[];
}

export interface FinishExecutionInput {
  status: Extract<RpaExecutionStatus, 'succeeded' | 'failed' | 'canceled' | 'timed_out'>;
  failedStepId?: string;
  error?: { code: string; message: string };
  exitCode?: number | null;
}

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
