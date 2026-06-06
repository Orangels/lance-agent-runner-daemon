export type RpaQuestionType = 'text' | 'textarea' | 'radio' | 'checkbox' | 'select';

export interface RpaQuestionOption {
  label: string;
  value: string;
  description?: string;
}

export interface RpaQuestionBase {
  id: string;
  type: RpaQuestionType;
  label: string;
  required?: boolean;
  description?: string;
}

export interface RpaTextQuestion extends RpaQuestionBase {
  type: 'text' | 'textarea';
  placeholder?: string;
  defaultValue?: string;
}

export interface RpaChoiceQuestion extends RpaQuestionBase {
  type: 'radio' | 'checkbox' | 'select';
  options: RpaQuestionOption[];
  defaultValue?: string | string[];
  maxSelections?: number;
}

export type RpaQuestion = RpaTextQuestion | RpaChoiceQuestion;

export interface RpaQuestionForm {
  formId: string;
  version?: 'rpa-question-form.v0.1' | string;
  title?: string;
  description?: string;
  questions: RpaQuestion[];
}

export type RpaQuestionAnswers = Record<string, string | string[] | boolean | number | null>;
