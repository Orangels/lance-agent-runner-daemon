import { describe, expect, it } from 'vitest';
import { createMinimalRpaDsl } from '../../../src/shared/dsl-schema.js';
import { deriveParameterFormModel, validateRpaDsl } from '../../../src/server/validators/dsl-validator.js';

describe('RPA DSL validator', () => {
  it('accepts a minimal valid DSL document', () => {
    const result = validateRpaDsl(createMinimalRpaDsl());

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects missing required top-level and step fields', () => {
    const dsl = createMinimalRpaDsl() as unknown as Record<string, unknown>;
    delete dsl.flow_id;
    dsl.steps = [{ id: 's1', action: 'click', write: false, manual: null }];

    const result = validateRpaDsl(dsl);

    expect(result.ok).toBe(false);
    expect(result.errors.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['flow_id', 'steps[0].name', 'steps[0].target']),
    );
  });

  it('rejects invalid step ids, unsupported assert types, and invalid manual blocks', () => {
    const dsl = createMinimalRpaDsl();
    dsl.steps = [
      {
        id: 'step one',
        name: '点击查询',
        action: 'click',
        target: { by: 'role', role: 'button', name: '查询' },
        assert: [{ type: 'not_a_real_assert' as never }],
        write: false,
        manual: { type: 'captcha', instruction: '' },
      },
    ];

    const result = validateRpaDsl(dsl);

    expect(result.ok).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'INVALID_STEP_ID',
        'UNSUPPORTED_ASSERT_TYPE',
        'MANUAL_INSTRUCTION_REQUIRED',
      ]),
    );
  });

  it('rejects duplicate stable step ids', () => {
    const dsl = createMinimalRpaDsl();
    dsl.steps = [
      {
        id: 'open_query',
        name: '打开查询',
        action: 'click',
        target: { by: 'role', role: 'button', name: '查询' },
        write: false,
        manual: null,
      },
      {
        id: 'open_query',
        name: '再次打开查询',
        action: 'click',
        target: { by: 'role', role: 'button', name: '查询' },
        write: false,
        manual: null,
      },
    ];

    const result = validateRpaDsl(dsl);

    expect(result.ok).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toContain('DUPLICATE_STEP_ID');
  });

  it('rejects unsupported selector types and warns for xpath fallback', () => {
    const unsupported = createMinimalRpaDsl();
    unsupported.steps[0] = {
      id: 's1',
      name: '点击查询',
      action: 'click',
      target: { by: 'data-cy' as never },
      write: false,
      manual: null,
    };

    expect(validateRpaDsl(unsupported).errors.map((issue) => issue.code)).toContain(
      'UNSUPPORTED_TARGET_BY',
    );

    const xpath = createMinimalRpaDsl();
    xpath.steps[0] = {
      id: 's1',
      name: '点击查询',
      action: 'click',
      target: { by: 'xpath', xpath: '//button[1]' },
      write: false,
      manual: null,
    };

    expect(validateRpaDsl(xpath).warnings.map((issue) => issue.code)).toContain('XPATH_FALLBACK');
  });

  it('warns for actionable steps without wait or assert coverage', () => {
    const dsl = createMinimalRpaDsl();
    dsl.steps[0] = {
      id: 's1',
      name: '提交查询',
      action: 'submit',
      target: { by: 'role', role: 'button', name: '查询' },
      write: false,
      manual: null,
    };

    const result = validateRpaDsl(dsl);

    expect(result.ok).toBe(true);
    expect(result.warnings.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['MISSING_WAIT', 'MISSING_ASSERT']),
    );
  });

  it('warns when write steps do not expose idempotency or high-risk manual confirmation', () => {
    const dsl = createMinimalRpaDsl();
    dsl.steps[0] = {
      id: 's1',
      name: '保存数据',
      action: 'submit',
      target: { by: 'role', role: 'button', name: '保存' },
      write: true,
      manual: null,
    };

    const result = validateRpaDsl(dsl);

    expect(result.ok).toBe(true);
    expect(result.warnings.map((issue) => issue.code)).toContain(
      'WRITE_MISSING_IDEMPOTENCY_OR_MANUAL_CONFIRMATION',
    );
  });

  it('derives masked parameter form fields from params', () => {
    const dsl = createMinimalRpaDsl();
    dsl.params.org = {
      type: 'select',
      label: '单位',
      required: true,
      options: [
        { label: '一队', value: 'team_1' },
        { label: '二队', value: 'team_2' },
      ],
    };

    expect(deriveParameterFormModel(dsl)).toEqual([
      {
        id: 'case_no',
        label: '案件编号',
        type: 'text',
        required: true,
        mask: true,
        options: undefined,
        defaultValue: undefined,
      },
      {
        id: 'org',
        label: '单位',
        type: 'select',
        required: true,
        mask: false,
        options: [
          { label: '一队', value: 'team_1' },
          { label: '二队', value: 'team_2' },
        ],
        defaultValue: undefined,
      },
    ]);
  });
});
