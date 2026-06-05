import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  RPA_DSL_VERSION,
  createMinimalRpaDsl,
  isRpaAction,
  rpaDslActionValues,
  rpaDslParamTypeValues,
  rpaDslTargetByValues,
} from './dsl-schema.js';
import { rpaDslJsonSchema } from './dsl-json-schema.js';

describe('RPA DSL shared schema contract', () => {
  it('defines the v0.1 version and enum values used by skills and validators', () => {
    expect(RPA_DSL_VERSION).toBe('rpa-dsl.v0.1');
    expect(rpaDslParamTypeValues).toEqual(['string', 'number', 'date', 'boolean', 'select', 'secret']);
    expect(rpaDslActionValues).toEqual([
      'navigate',
      'click',
      'input',
      'select',
      'submit',
      'assert',
      'wait',
      'manual',
    ]);
    expect(rpaDslTargetByValues).toEqual([
      'role',
      'label',
      'placeholder',
      'text',
      'testid',
      'id',
      'css',
      'xpath',
    ]);
    expect(isRpaAction('click')).toBe(true);
    expect(isRpaAction('hover')).toBe(false);
  });

  it('creates a minimal valid DSL fixture for downstream tests', () => {
    const dsl = createMinimalRpaDsl();

    expect(dsl.dsl_version).toBe('rpa-dsl.v0.1');
    expect(dsl.flow_id).toBe('case_query');
    expect(dsl.params.case_no.mask).toBe(true);
    expect(dsl.steps[0]?.id).toBe('s1');
  });

  it('exports a JSON Schema object with the same version constant', () => {
    expect(rpaDslJsonSchema.$id).toBe('https://lance-agent-runner.local/schemas/rpa-dsl.v0.1.json');
    expect(rpaDslJsonSchema.properties.dsl_version.const).toBe(RPA_DSL_VERSION);
    expect(rpaDslJsonSchema.required).toEqual([
      'dsl_version',
      'flow_id',
      'meta',
      'params',
      'context',
      'steps',
    ]);
  });

  it('keeps JSON Schema consistent with the minimal DSL fixture', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(rpaDslJsonSchema);

    expect(validate(createMinimalRpaDsl())).toBe(true);
    expect(validate({ ...createMinimalRpaDsl(), dsl_version: '1.0' })).toBe(false);
  });
});
