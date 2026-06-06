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

export type CodegenQuestionType = 'text' | 'textarea' | 'radio' | 'checkbox' | 'select';

export interface CodegenQuestionOption {
  label: string;
  value: string;
}

export interface CodegenQuestionBase {
  id: string;
  type: CodegenQuestionType;
  label: string;
  required?: boolean;
  description?: string;
}

export interface CodegenTextQuestion extends CodegenQuestionBase {
  type: 'text' | 'textarea';
  placeholder?: string;
  defaultValue?: string;
}

export interface CodegenChoiceQuestion extends CodegenQuestionBase {
  type: 'radio' | 'checkbox' | 'select';
  options: CodegenQuestionOption[];
  defaultValue?: string | string[];
}

export type CodegenQuestion = CodegenTextQuestion | CodegenChoiceQuestion;

export interface CodegenQuestionForm {
  formId: string;
  version?: string;
  title?: string;
  description?: string;
  questions: CodegenQuestion[];
}

export type CodegenQuestionAnswers = Record<string, string | string[] | boolean | number | null>;

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
