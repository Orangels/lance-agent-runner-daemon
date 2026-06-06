import type { RpaQuestionAnswers, RpaQuestionForm } from './question-form-types.js';

export const naturalLanguageSessionStatuses = [
  'starting',
  'generating',
  'needs_input',
  'generated',
  'repairing',
  'failed',
  'cancelled',
] as const;

export type NaturalLanguageSessionStatus = (typeof naturalLanguageSessionStatuses)[number];

export interface StartNaturalLanguageSessionRequest {
  targetUrl: string;
  flowId: string;
  flowName?: string;
  requirement: string;
  businessConstraints?: string;
  safetyNotes?: string;
}

export interface NaturalLanguageArtifactSummary {
  artifactId: string;
  fileName: string;
  relativePath: string;
  size?: number | null;
}

export interface NaturalLanguageSessionStatusResponse {
  sessionId: string;
  flowId: string;
  flowName?: string;
  status: NaturalLanguageSessionStatus;
  targetUrl: string;
  requirement: string;
  daemonRunId?: string;
  workspaceId?: string;
  conversationId?: string;
  logs: string[];
  questionForm: RpaQuestionForm | null;
  artifacts: NaturalLanguageArtifactSummary[];
  error: { code: string; message: string } | null;
}

export interface StartNaturalLanguageSessionResponse {
  sessionId: string;
  flowId: string;
  status: NaturalLanguageSessionStatus;
  targetUrl: string;
}

export interface SubmitNaturalLanguageQuestionAnswersRequest {
  formId: string;
  answers: RpaQuestionAnswers;
}

export interface SubmitNaturalLanguageQuestionAnswersResponse {
  sessionId: string;
  status: NaturalLanguageSessionStatus;
  daemonRunId?: string;
}

export interface RepairNaturalLanguageSessionRequest {
  executionId: string;
  instruction?: string;
}
