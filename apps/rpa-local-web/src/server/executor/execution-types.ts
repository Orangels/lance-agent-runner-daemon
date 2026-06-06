import type {
  RpaExecutionEvent,
  RpaExecutionEventType,
  RpaExecutionMode,
  RpaExecutionStatus,
} from '../../shared/rpa-api-types.js';

export type { RpaExecutionEvent, RpaExecutionEventType, RpaExecutionMode, RpaExecutionStatus };

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
