import { describe, expect, it } from 'vitest';
import { createMinimalRpaDsl, type RpaDslDocument } from '../../src/shared/dsl-schema.js';
import { deriveRuntimeParamFields, normalizeRuntimeParams } from '../../src/shared/runtime-params.js';

function dslWithParams(): RpaDslDocument {
  return {
    ...createMinimalRpaDsl(),
    params: {
      case_no: { type: 'string', label: 'Case No', required: true, mask: true },
      amount: { type: 'number', label: 'Amount', default: 10 },
      include_closed: { type: 'boolean', label: 'Include closed', default: false },
      report_date: { type: 'date', required: true },
      unit: {
        type: 'select',
        required: true,
        options: [
          { label: 'City', value: 'city' },
          { label: 'District', value: 'district' },
        ],
      },
      password: { type: 'secret', required: true },
    },
  };
}

describe('runtime params', () => {
  it('derives browser fields from DSL params', () => {
    expect(deriveRuntimeParamFields(dslWithParams().params)).toEqual([
      expect.objectContaining({ id: 'case_no', label: 'Case No', type: 'text', required: true, mask: true }),
      expect.objectContaining({ id: 'amount', type: 'number', defaultValue: 10 }),
      expect.objectContaining({ id: 'include_closed', type: 'checkbox', defaultValue: false }),
      expect.objectContaining({ id: 'report_date', type: 'date', required: true }),
      expect.objectContaining({
        id: 'unit',
        type: 'select',
        options: [
          { label: 'City', value: 'city' },
          { label: 'District', value: 'district' },
        ],
      }),
      expect.objectContaining({ id: 'password', type: 'password', mask: true }),
    ]);
  });

  it('normalizes valid form values and applies defaults', () => {
    const result = normalizeRuntimeParams(dslWithParams().params, {
      case_no: 'A123',
      report_date: '2026-06-06',
      unit: 'city',
      password: 'secret-value',
    });

    expect(result).toEqual({
      ok: true,
      value: {
        case_no: 'A123',
        amount: 10,
        include_closed: false,
        report_date: '2026-06-06',
        unit: 'city',
        password: 'secret-value',
      },
      errors: [],
    });
  });

  it('rejects missing required values, invalid numbers, and invalid select options', () => {
    const result = normalizeRuntimeParams(dslWithParams().params, {
      case_no: '',
      amount: 'not-a-number',
      report_date: '',
      unit: 'province',
      password: '',
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({ paramId: 'case_no', code: 'PARAM_REQUIRED' }),
      expect.objectContaining({ paramId: 'amount', code: 'PARAM_TYPE_INVALID' }),
      expect.objectContaining({ paramId: 'report_date', code: 'PARAM_REQUIRED' }),
      expect.objectContaining({ paramId: 'unit', code: 'PARAM_OPTION_INVALID' }),
      expect.objectContaining({ paramId: 'password', code: 'PARAM_REQUIRED' }),
    ]);
  });
});
