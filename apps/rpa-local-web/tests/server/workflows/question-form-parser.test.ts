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

  it('ignores inline mentions of question-form tags before the real block', () => {
    const form = parseQuestionFormFromTranscript(`I will ask with \`<question-form>\`.

Need to confirm the workflow details.

<question-form id="rpa-confirmation" version="rpa-question-form.v0.1">
{"version":"rpa-question-form.v0.1","questions":[{"id":"city","type":"text","label":"城市"}]}
</question-form>`);

    expect(form).toMatchObject({
      formId: 'rpa-confirmation',
      questions: [{ id: 'city', type: 'text', label: '城市' }],
    });
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

  it('normalizes common Claude question-form variants from fenced JSON', () => {
    const form = parseQuestionFormFromTranscript(`<question-form id="rpa-parameterization" version="rpa-question-form.v0.1">
\`\`\`json
{
  "version": "rpa-question-form.v0.1",
  "title": "确认参数",
  "questions": [
    {
      "id": "city_param_shape",
      "type": "single_choice",
      "label": "城市输入参数如何设计？",
      "options": [
        { "value": "single_city_name", "label": "合并为单一参数 city_name" }
      ]
    },
    {
      "id": "default_city",
      "type": "string",
      "label": "city_name 的默认值 / 示例值",
      "default": "北京"
    }
  ]
}
\`\`\`
</question-form>`);

    expect(form).toMatchObject({
      formId: 'rpa-parameterization',
      title: '确认参数',
      questions: [
        {
          id: 'city_param_shape',
          type: 'radio',
          options: [{ value: 'single_city_name', label: '合并为单一参数 city_name' }],
        },
        {
          id: 'default_city',
          type: 'text',
          defaultValue: '北京',
        },
      ],
    });
  });

  it('accepts lanceDesign-style type aliases, string options, and single-quoted attrs', () => {
    const form = parseQuestionFormFromTranscript(`<question-form id='rpa-parameterization' title='参数确认' version='rpa-question-form.v0.1'>
{
  "version": "rpa-question-form.v0.1",
  "questions": [
    { "id": "mode", "type": "single", "label": "执行模式", "options": ["只验证", "直接运行"] },
    { "id": "fields", "type": "multi", "label": "返回字段", "maxSelections": 2, "options": ["日期", "天气", "温度"] },
    { "id": "city", "type": "dropdown", "label": "城市", "options": [
      { "label": "北京", "value": "101010100", "description": "默认城市" }
    ] },
    { "id": "note", "type": "paragraph", "label": "补充说明" }
  ]
}
</question-form>`);

    expect(form).toMatchObject({
      formId: 'rpa-parameterization',
      version: 'rpa-question-form.v0.1',
      title: '参数确认',
      questions: [
        {
          id: 'mode',
          type: 'radio',
          options: [
            { label: '只验证', value: '只验证' },
            { label: '直接运行', value: '直接运行' },
          ],
        },
        {
          id: 'fields',
          type: 'checkbox',
          maxSelections: 2,
          options: [
            { label: '日期', value: '日期' },
            { label: '天气', value: '天气' },
            { label: '温度', value: '温度' },
          ],
        },
        {
          id: 'city',
          type: 'select',
          options: [{ label: '北京', value: '101010100', description: '默认城市' }],
        },
        {
          id: 'note',
          type: 'textarea',
        },
      ],
    });
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
