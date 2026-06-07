import type {
  RpaChoiceQuestion,
  RpaQuestion,
  RpaQuestionAnswers,
  RpaQuestionBase,
  RpaQuestionForm,
  RpaQuestionOption,
  RpaQuestionType,
  RpaTextQuestion,
} from './question-form-types.js';

export const codegenSessionStatuses = [
  'starting',
  'recording',
  'completed',
  'hardening',
  'needs_input',
  'hardened',
  'failed',
  'cancelled',
] as const;

export type CodegenSessionStatus = (typeof codegenSessionStatuses)[number];

export type CodegenQuestionType = RpaQuestionType;
export type CodegenQuestionOption = RpaQuestionOption;
export type CodegenQuestionBase = RpaQuestionBase;
export type CodegenTextQuestion = RpaTextQuestion;
export type CodegenChoiceQuestion = RpaChoiceQuestion;
export type CodegenQuestion = RpaQuestion;
export type CodegenQuestionForm = RpaQuestionForm;
export type CodegenQuestionAnswers = RpaQuestionAnswers;

export interface StartCodegenSessionRequest {
  targetUrl: string;
  flowId: string;
  flowName?: string;
}

export interface CodegenSessionRecordingSummary {
  inputPath: 'input/flow.py';
}

export interface StartCodegenSessionResponse {
  sessionId: string;
  flowId: string;
  status: CodegenSessionStatus;
  targetUrl: string;
  recording: CodegenSessionRecordingSummary;
}

export interface StartCodegenHardeningRequest {
  requirement: string;
}

export interface StartCodegenHardeningResponse {
  sessionId: string;
  status: CodegenSessionStatus;
  daemonRunId?: string;
}

export interface CodegenArtifactSummary {
  artifactId: string;
  fileName: string;
  relativePath: string;
  size?: number | null;
}

export interface CodegenSessionStatusResponse {
  sessionId: string;
  flowId: string;
  status: CodegenSessionStatus;
  targetUrl: string;
  requirement?: string;
  daemonRunId?: string;
  workspaceId?: string;
  conversationId?: string;
  logs: string[];
  questionForm: CodegenQuestionForm | null;
  artifacts: CodegenArtifactSummary[];
  error: { code: string; message: string } | null;
}

export interface CancelCodegenSessionResponse {
  sessionId: string;
  status: CodegenSessionStatus;
}

export interface SubmitCodegenQuestionAnswersRequest {
  formId: string;
  answers: CodegenQuestionAnswers;
}

export interface SubmitCodegenQuestionAnswersResponse {
  sessionId: string;
  status: CodegenSessionStatus;
  daemonRunId?: string;
}
