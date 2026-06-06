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
const questionFormBlockPattern =
  /(?:^|\r?\n)[ \t]*<question-form\b([^>]*)>[ \t]*(?:\r?\n)?([\s\S]*?)(?:\r?\n)?[ \t]*<\/question-form>[ \t]*(?=\r?\n|$)/;

export class QuestionFormParseError extends Error {
  readonly code = 'QUESTION_FORM_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'QuestionFormParseError';
  }
}

export function parseQuestionFormFromTranscript(transcript: string): RpaQuestionForm | null {
  const match = questionFormBlockPattern.exec(transcript);
  if (!match) return null;

  const attrs = match[1] ?? '';
  const parsed = parsePayload(match[2] ?? '');
  if (!isRecord(parsed) || !Array.isArray(parsed.questions)) {
    throw new QuestionFormParseError('Question form payload is invalid: questions array is required.');
  }

  return {
    formId: readAttr(attrs, 'id') ?? 'rpa-question-form',
    version: readString(parsed.version) ?? readAttr(attrs, 'version'),
    title: readString(parsed.title) ?? readAttr(attrs, 'title'),
    description: readString(parsed.description),
    questions: parsed.questions.map(parseQuestion),
  };
}

function parsePayload(body: string): unknown {
  try {
    return JSON.parse(stripOptionalJsonFence(body).trim()) as unknown;
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
  const type = typeof value.type === 'string' ? normalizeQuestionType(value.type) : null;
  if (type === null) {
    throw new QuestionFormParseError(`Unsupported question type: ${String(value.type)}.`);
  }
  if (typeof value.label !== 'string' || value.label.length === 0) {
    throw new QuestionFormParseError('Question label is required.');
  }

  const base = {
    id: value.id,
    type,
    label: value.label,
    required: readBoolean(value.required),
    description: readString(value.description),
  };

  if (isChoiceQuestionType(type)) {
    if (!Array.isArray(value.options)) {
      throw new QuestionFormParseError('Choice question options are required.');
    }
    return {
      ...base,
      type,
      options: value.options.map(parseOption),
      defaultValue: readStringOrStringArray(value.defaultValue) ?? readStringOrStringArray(value.default),
      maxSelections: type === 'checkbox' ? readPositiveInteger(value.maxSelections) : undefined,
    } satisfies RpaChoiceQuestion;
  }

  if (!isTextQuestionType(type)) {
    throw new QuestionFormParseError(`Unsupported question type: ${String(value.type)}.`);
  }

  return {
    ...base,
    type,
    placeholder: readString(value.placeholder),
    defaultValue: readString(value.defaultValue) ?? readString(value.default),
  } satisfies RpaTextQuestion;
}

function parseOption(value: unknown): RpaQuestionOption {
  if (typeof value === 'string') {
    const label = value.trim();
    if (label.length === 0) {
      throw new QuestionFormParseError('Choice question string options must not be empty.');
    }
    return { label, value: label };
  }
  if (!isRecord(value) || typeof value.label !== 'string') {
    throw new QuestionFormParseError('Choice question options must include a string label.');
  }
  const label = value.label.trim();
  const optionValue = typeof value.value === 'string' && value.value.trim().length > 0 ? value.value.trim() : label;
  if (label.length === 0) {
    throw new QuestionFormParseError('Choice question options must include a non-empty label.');
  }
  return {
    label,
    value: optionValue,
    description: readString(value.description),
  };
}

function isQuestionType(value: string): value is RpaQuestionType {
  return allowedQuestionTypes.has(value as RpaQuestionType);
}

function normalizeQuestionType(value: string): RpaQuestionType | null {
  const normalized = value.toLowerCase().trim();
  if (isQuestionType(normalized)) return normalized;
  if (normalized === 'single_choice' || normalized === 'single' || normalized === 'choice') return 'radio';
  if (normalized === 'multiple_choice' || normalized === 'multi' || normalized === 'multiple') return 'checkbox';
  if (normalized === 'dropdown') return 'select';
  if (normalized === 'string') return 'text';
  if (normalized === 'long' || normalized === 'paragraph') return 'textarea';
  return null;
}

function isChoiceQuestionType(value: RpaQuestionType): value is RpaChoiceQuestion['type'] {
  return choiceQuestionTypes.has(value as RpaChoiceQuestion['type']);
}

function isTextQuestionType(value: RpaQuestionType): value is RpaTextQuestion['type'] {
  return value === 'text' || value === 'textarea';
}

function readAttr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]+)"|'([^']+)')`));
  return match?.[1] ?? match?.[2];
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

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripOptionalJsonFence(body: string): string {
  const trimmed = body.trim();
  const match = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  return match?.[1] ?? trimmed;
}
