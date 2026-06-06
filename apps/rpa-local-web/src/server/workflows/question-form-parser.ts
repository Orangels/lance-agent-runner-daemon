import type {
  RpaChoiceQuestion,
  RpaQuestion,
  RpaQuestionForm,
  RpaQuestionOption,
  RpaQuestionType,
  RpaTextQuestion,
} from '../../shared/question-form-types.js';

const allowedQuestionTypes = new Set<RpaQuestionType>(['text', 'textarea', 'radio', 'checkbox', 'select']);
const choiceQuestionTypes = new Set<RpaChoiceQuestion['type']>(['radio', 'checkbox', 'select']);

export class QuestionFormParseError extends Error {
  readonly code = 'QUESTION_FORM_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'QuestionFormParseError';
  }
}

export function parseQuestionFormFromTranscript(transcript: string): RpaQuestionForm | null {
  const match = transcript.match(/<question-form\b([^>]*)>([\s\S]*?)<\/question-form>/);
  if (!match) return null;

  const attrs = match[1] ?? '';
  const parsed = parsePayload(match[2] ?? '');
  if (!isRecord(parsed) || !Array.isArray(parsed.questions)) {
    throw new QuestionFormParseError('Question form payload is invalid: questions array is required.');
  }

  return {
    formId: readAttr(attrs, 'id') ?? 'rpa-question-form',
    version: readString(parsed.version) ?? readAttr(attrs, 'version'),
    title: readString(parsed.title),
    description: readString(parsed.description),
    questions: parsed.questions.map(parseQuestion),
  };
}

function parsePayload(body: string): unknown {
  try {
    return JSON.parse(body.trim()) as unknown;
  } catch {
    throw new QuestionFormParseError('Question form payload is invalid JSON.');
  }
}

function parseQuestion(value: unknown): RpaQuestion {
  if (!isRecord(value)) {
    throw new QuestionFormParseError('Question must be an object.');
  }
  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw new QuestionFormParseError('Question id is required.');
  }
  if (typeof value.type !== 'string' || !isQuestionType(value.type)) {
    throw new QuestionFormParseError(`Unsupported question type: ${String(value.type)}.`);
  }
  if (typeof value.label !== 'string' || value.label.length === 0) {
    throw new QuestionFormParseError('Question label is required.');
  }

  const base = {
    id: value.id,
    type: value.type,
    label: value.label,
    required: readBoolean(value.required),
    description: readString(value.description),
  };

  if (isChoiceQuestionType(value.type)) {
    if (!Array.isArray(value.options)) {
      throw new QuestionFormParseError('Choice question options are required.');
    }
    return {
      ...base,
      type: value.type,
      options: value.options.map(parseOption),
      defaultValue: readStringOrStringArray(value.defaultValue),
    } satisfies RpaChoiceQuestion;
  }

  if (!isTextQuestionType(value.type)) {
    throw new QuestionFormParseError(`Unsupported question type: ${String(value.type)}.`);
  }

  return {
    ...base,
    type: value.type,
    placeholder: readString(value.placeholder),
    defaultValue: readString(value.defaultValue),
  } satisfies RpaTextQuestion;
}

function parseOption(value: unknown): RpaQuestionOption {
  if (!isRecord(value) || typeof value.label !== 'string' || typeof value.value !== 'string') {
    throw new QuestionFormParseError('Choice question options must include string label and value.');
  }
  return { label: value.label, value: value.value };
}

function isQuestionType(value: string): value is RpaQuestionType {
  return allowedQuestionTypes.has(value as RpaQuestionType);
}

function isChoiceQuestionType(value: RpaQuestionType): value is RpaChoiceQuestion['type'] {
  return choiceQuestionTypes.has(value as RpaChoiceQuestion['type']);
}

function isTextQuestionType(value: RpaQuestionType): value is RpaTextQuestion['type'] {
  return value === 'text' || value === 'textarea';
}

function readAttr(attrs: string, name: string): string | undefined {
  return attrs.match(new RegExp(`${name}="([^"]+)"`))?.[1];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readStringOrStringArray(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
