import { describe, expect, it } from 'vitest';
import { createMinimalRpaDsl } from '../../../src/shared/dsl-schema.js';
import { canonicalizeGeneratedRpaDsl } from '../../../src/server/validators/generated-dsl-normalizer.js';
import { validateRpaDsl } from '../../../src/server/validators/dsl-validator.js';

describe('generated DSL canonicalizer', () => {
  it('normalizes known safe assertion aliases before canonical validation', () => {
    const dsl = createMinimalRpaDsl() as any;
    dsl.steps[0].assert = [
      { type: 'min_count', target: { by: 'css', css: '[id="7d"] ul.t li' }, value: 5 },
      { type: 'text_includes', target: { by: 'css', css: 'body' }, text: '天气' },
      { type: 'url_includes', value: '/weather/' },
    ];

    const result = canonicalizeGeneratedRpaDsl(dsl);

    expect(result.warnings.map((issue) => issue.code)).toEqual([
      'ASSERT_TYPE_NORMALIZED',
      'ASSERT_TYPE_NORMALIZED',
      'ASSERT_TYPE_NORMALIZED',
    ]);
    expect((result.dsl as any).steps[0].assert).toEqual([
      { type: 'row_count_gt', target: { by: 'css', css: '[id="7d"] ul.t li' }, value: 4 },
      { type: 'text_contains', target: { by: 'css', css: 'body' }, text: '天气' },
      { type: 'url_contains', value: '/weather/' },
    ]);
    expect(validateRpaDsl(result.dsl).ok).toBe(true);
  });

  it('does not normalize min_count when the value is not a positive integer', () => {
    const dsl = createMinimalRpaDsl() as any;
    dsl.steps[0].assert = [
      { type: 'min_count', target: { by: 'css', css: '.row' }, value: 0 },
      { type: 'min_count', target: { by: 'css', css: '.row' }, value: -1 },
      { type: 'min_count', target: { by: 'css', css: '.row' }, value: 1.5 },
    ];

    const result = canonicalizeGeneratedRpaDsl(dsl);

    expect(result.warnings).toEqual([]);
    expect((result.dsl as any).steps[0].assert.map((assertion: any) => assertion.type)).toEqual([
      'min_count',
      'min_count',
      'min_count',
    ]);
    expect(validateRpaDsl(result.dsl).errors.map((issue) => issue.code)).toContain('UNSUPPORTED_ASSERT_TYPE');
  });

  it('keeps business-specific assertion types invalid instead of guessing a mapping', () => {
    const dsl = createMinimalRpaDsl() as any;
    dsl.steps[0].assert = [{ type: 'date_in_range', value: '${query_date}' }];

    const result = canonicalizeGeneratedRpaDsl(dsl);

    expect(result.warnings).toEqual([]);
    expect(validateRpaDsl(result.dsl).errors.map((issue) => issue.code)).toContain('UNSUPPORTED_ASSERT_TYPE');
  });
});
