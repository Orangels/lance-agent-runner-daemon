import { describe, expect, it } from 'vitest';
import { parseQuestionFormFromTranscript } from '../../../src/server/workflows/question-form-parser.js';

describe('question-form parser', () => {
  it('parses rpa-question-form blocks from daemon text transcript', () => {
    const form = parseQuestionFormFromTranscript(`before
<question-form id="rpa-parameterization" version="rpa-question-form.v0.1">
{"version":"rpa-question-form.v0.1","title":"确认参数","questions":[{"id":"date","type":"text","label":"日期"}]}
</question-form>
after`);

    expect(form).toMatchObject({
      formId: 'rpa-parameterization',
      version: 'rpa-question-form.v0.1',
      title: '确认参数',
      questions: [{ id: 'date', type: 'text', label: '日期' }],
    });
  });

  it('returns null when no question-form block is present', () => {
    expect(parseQuestionFormFromTranscript('plain daemon transcript')).toBeNull();
  });

  it('accepts every MVP-supported question type used by RPA skills', () => {
    const form = parseQuestionFormFromTranscript(`<question-form id="all" version="rpa-question-form.v0.1">
{"version":"rpa-question-form.v0.1","questions":[
  {"id":"text","type":"text","label":"Text"},
  {"id":"textarea","type":"textarea","label":"Textarea"},
  {"id":"radio","type":"radio","label":"Radio","options":[{"label":"A","value":"a"}]},
  {"id":"checkbox","type":"checkbox","label":"Checkbox","options":[{"label":"A","value":"a"}]},
  {"id":"select","type":"select","label":"Select","options":[{"label":"A","value":"a"}]}
]}
</question-form>`);

    expect(form?.questions.map((question) => question.type)).toEqual([
      'text',
      'textarea',
      'radio',
      'checkbox',
      'select',
    ]);
  });

  it('rejects malformed JSON with QUESTION_FORM_INVALID', () => {
    expectQuestionFormInvalid(() =>
      parseQuestionFormFromTranscript(`<question-form id="bad" version="rpa-question-form.v0.1">
{"version":"rpa-question-form.v0.1","questions":[}
</question-form>`),
    );
  });

  it('rejects forms without questions with QUESTION_FORM_INVALID', () => {
    expectQuestionFormInvalid(() =>
      parseQuestionFormFromTranscript(`<question-form id="bad" version="rpa-question-form.v0.1">
{"version":"rpa-question-form.v0.1","title":"Bad"}
</question-form>`),
    );
  });

  it('rejects unsupported question types instead of rendering arbitrary controls', () => {
    expectQuestionFormInvalid(
      () =>
        parseQuestionFormFromTranscript(`<question-form id="bad" version="rpa-question-form.v0.1">
{"version":"rpa-question-form.v0.1","questions":[{"id":"x","type":"direction-cards","label":"x"}]}
</question-form>`),
      /unsupported question type/i,
    );
  });

  it('rejects choice questions without options with QUESTION_FORM_INVALID', () => {
    expectQuestionFormInvalid(
      () =>
        parseQuestionFormFromTranscript(`<question-form id="bad" version="rpa-question-form.v0.1">
{"version":"rpa-question-form.v0.1","questions":[{"id":"x","type":"select","label":"x"}]}
</question-form>`),
      /options/i,
    );
  });
});

function expectQuestionFormInvalid(action: () => unknown, message?: RegExp): void {
  try {
    action();
    throw new Error('Expected question-form parse to fail.');
  } catch (error) {
    expect(error).toMatchObject({ code: 'QUESTION_FORM_INVALID' });
    if (message) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(message);
    }
  }
}
