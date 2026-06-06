import { useState } from 'react';
import type {
  RpaQuestion,
  RpaQuestionAnswers,
  RpaQuestionForm as RpaQuestionFormModel,
} from '../shared/question-form-types.js';

export interface QuestionFormProps {
  form: RpaQuestionFormModel;
  busy?: boolean;
  onSubmit: (answers: RpaQuestionAnswers) => void | Promise<void>;
}

export function QuestionForm({ form, busy = false, onSubmit }: QuestionFormProps) {
  const [answers, setAnswers] = useState<RpaQuestionAnswers>(() => initialAnswers(form.questions));

  const updateAnswer = (question: RpaQuestion, value: string | string[]): void => {
    setAnswers((current) => ({ ...current, [question.id]: value }));
  };

  return (
    <form
      className="question-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(answers);
      }}
    >
      <div className="question-form__heading">
        <h3>{form.title ?? '确认参数'}</h3>
      </div>
      {form.questions.map((question) => (
        <QuestionField key={question.id} question={question} value={answers[question.id]} onChange={updateAnswer} />
      ))}
      <button type="submit" className="command-button" disabled={busy}>
        Submit answers
      </button>
    </form>
  );
}

function QuestionField({
  question,
  value,
  onChange,
}: {
  question: RpaQuestion;
  value: RpaQuestionAnswers[string];
  onChange: (question: RpaQuestion, value: string | string[]) => void;
}) {
  const label = (
    <span>
      {question.label}
      {question.required ? ' *' : ''}
    </span>
  );

  if (question.type === 'textarea') {
    return (
      <label className="field">
        {label}
        <textarea
          value={typeof value === 'string' ? value : ''}
          placeholder={question.placeholder}
          rows={3}
          onChange={(event) => onChange(question, event.target.value)}
        />
      </label>
    );
  }

  if (question.type === 'text') {
    return (
      <label className="field">
        {label}
        <input
          value={typeof value === 'string' ? value : ''}
          placeholder={question.placeholder}
          onChange={(event) => onChange(question, event.target.value)}
        />
      </label>
    );
  }

  if (question.type === 'select') {
    return (
      <label className="field">
        {label}
        <select value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(question, event.target.value)}>
          <option value="" />
          {question.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (question.type === 'radio') {
    return (
      <fieldset className="choice-field">
        <legend>{label}</legend>
        {question.options.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name={question.id}
              value={option.value}
              checked={value === option.value}
              onChange={(event) => {
                if (event.target.checked) onChange(question, option.value);
              }}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>
    );
  }

  if (question.type === 'checkbox') {
    return (
      <fieldset className="choice-field">
        <legend>{label}</legend>
        {question.options.map((option) => {
          const selected = Array.isArray(value) ? value : [];
          const maxReached =
            typeof question.maxSelections === 'number' &&
            selected.length >= question.maxSelections &&
            !selected.includes(option.value);
          return (
            <label key={option.value}>
              <input
                type="checkbox"
                value={option.value}
                disabled={maxReached}
                checked={selected.includes(option.value)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...selected, option.value]
                    : selected.filter((item) => item !== option.value);
                  onChange(question, next);
                }}
              />
              <span>{option.label}</span>
            </label>
          );
        })}
      </fieldset>
    );
  }

  return null;
}

function initialAnswers(questions: RpaQuestion[]): RpaQuestionAnswers {
  return Object.fromEntries(
    questions.map((question) => [
      question.id,
      question.defaultValue ?? (question.type === 'checkbox' ? [] : ''),
    ]),
  );
}
