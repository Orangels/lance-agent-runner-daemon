# RPA DSL And Artifact Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the RPA MVP `flow.dsl.json` v0.1 schema and required generation artifact contract so codegen hardening, natural-language generation, executor verification, import/export, and observability all share one validated representation.

**Architecture:** Keep RPA schema and validation in `apps/rpa-local-web`; `apps/daemon/src` must remain generic and must not parse DSL or Playwright semantics. The handwritten server-side validator is the runtime authority for MVP; the exported JSON Schema is a documentation/export contract and is tested for consistency with the validator using Ajv. This slice does not implement executor, codegen orchestration, natural-language workflow, or `.rpa.zip` import/export routes.

**Tech Stack:** TypeScript ESM, Vitest, Ajv for JSON Schema consistency tests, Node `crypto`/`fs`/`path`, existing `@lance-agent-runner/rpa-local-web` package, handwritten runtime validation helpers.

**Status:** Completed in commit `b39829d`.

**Verification evidence:**

- `pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run src/shared/dsl-schema.test.ts src/server/validators/dsl-validator.test.ts src/server/validators/artifact-validator.test.ts src/server/flow-store.test.ts`
- `pnpm --filter @lance-agent-runner/rpa-local-web test`
- `pnpm --filter @lance-agent-runner/rpa-local-web typecheck`
- `pnpm typecheck`
- `pnpm build`
- CC implementation review: no P0/P1; P2 suggestions deferred to later executor/import hardening slices.

---

## Scope Boundary

This slice implements:

- DSL version constant `rpa-dsl.v0.1`.
- TypeScript types for `flow.dsl.json`.
- Exportable JSON Schema object for `flow.dsl.json`.
- Server-side DSL validator with readable errors and warnings.
- Parameter form model derived from `params`.
- Required generation artifact contract for:
  - `flow.dsl.json`
  - `flow.hardened.py`
  - `config.example.json`
  - `parameterization-report.md`
  - `hardening-report.md`
- Artifact validation for daemon-downloaded generation outputs before verify/run.
- Provisional flow package manifest types and checksum helpers for later `.rpa.zip` work.
- Producer-facing skill reference sync so both RPA skills target the same `rpa-dsl.v0.1` contract.

This slice does not implement:

- Python/Playwright execution.
- Codegen child process orchestration.
- Natural-language generation workflow.
- `.rpa.zip` import/export HTTP routes.
- Trace, video, screenshot, or execution artifact collection.
- A standalone DSL compiler.
- Any RPA DSL parsing inside `apps/daemon/src`.

## File Map

Create:

- `apps/rpa-local-web/src/shared/dsl-schema.ts`
  - Owns DSL constants, TypeScript types, action/selector/wait/assert enums, and a minimal valid DSL fixture factory for tests.
- `apps/rpa-local-web/src/shared/dsl-json-schema.ts`
  - Exports a JSON Schema object for `flow.dsl.json`; this is used for documentation, future export packages, and external tooling.
- `apps/rpa-local-web/src/shared/artifacts.ts`
  - Owns required and allowed optional generation artifact names, artifact roles, provisional manifest types, package schema version, and safe artifact metadata types.
- `apps/rpa-local-web/src/server/validators/validation-types.ts`
  - Shared issue shape for validator errors/warnings.
- `apps/rpa-local-web/src/server/validators/dsl-validator.ts`
  - Validates DSL objects and derives parameter form fields.
- `apps/rpa-local-web/src/server/validators/artifact-validator.ts`
  - Validates daemon artifact metadata and local downloaded artifact paths before copying into RPA flow storage.
- `apps/rpa-local-web/src/server/flow-store.ts`
  - Minimal path-safe flow storage helpers and package manifest builder; no routes yet.
- Tests:
  - `apps/rpa-local-web/src/shared/dsl-schema.test.ts`
  - `apps/rpa-local-web/src/server/validators/dsl-validator.test.ts`
  - `apps/rpa-local-web/src/server/validators/artifact-validator.test.ts`
  - `apps/rpa-local-web/src/server/flow-store.test.ts`

Modify:

- `apps/rpa-local-web/package.json`
  - Add Ajv as a dev dependency for JSON Schema consistency tests.
- `pnpm-lock.yaml`
  - Records the Ajv dev dependency.
- `apps/daemon/skills/playwright-rpa-harden/references/dsl.md`
  - Align producer reference version/examples with `rpa-dsl.v0.1`.
- `apps/daemon/skills/rpa-script-generate/references/dsl.md`
  - Align producer reference version/examples with `rpa-dsl.v0.1`.
- `apps/daemon/skills/rpa-script-generate/templates/flow.dsl.json.tmpl`
  - Align the only current DSL-producing template with `rpa-dsl.v0.1` and the `navigate` representation.
- `docs/rpa-local-bs-mvp-design.md`
  - Replace stale DSL/package `"1.0"` examples with `rpa-dsl.v0.1` / `rpa-package.v0.1`, or mark the old snippets as superseded by this slice.
- `docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md`
  - Mark this slice complete only after implementation is done.

Do not modify:

- `apps/daemon/src/**`

---

## Contract Decisions

- DSL version string: `rpa-dsl.v0.1`.
- Provisional flow package manifest version string: `rpa-package.v0.1`. The import/export slice may extend this manifest, but it must preserve these core fields.
- Source modes: `codegen | nl | imported`.
- Parameter types: `string | number | date | boolean | select | secret`.
- Step actions: `navigate | click | input | select | submit | assert | wait | manual`.
- Target selector types: `role | label | placeholder | text | testid | id | css | xpath`.
- XPath is allowed by schema but validator emits a warning because it is a fallback selector.
- Required step fields: `id`, `name`, `action`, `write`, and `manual`.
- `target` is required for page-element actions: `click`, `input`, `select`, `submit`, `assert`.
- `target` is optional for `navigate`, `wait`, and `manual`.
- `wait` is optional at schema level but validator warns for actionable browser steps without explicit wait.
- `assert` is optional at schema level but validator warns for high-value actions without assertions.
- `navigate` steps use step-level `value` for URL references and do not use `target.by = "url"`.
- `write=true` without `idempotency_key` or `manual.riskLevel = high` is a validation warning in MVP, not a hard error. Producer skills should still emit `idempotency_key` whenever the business key is known.
- Step ids must be unique, stable, lowercase, and match `^[a-z][a-z0-9_]{0,63}$`; executor events, screenshots, highlights, and audit logs all map by step id.
- Selectable parameters must use `type: "select"` with `options`; `widget` is not part of DSL v0.1.
- Typed wait keys are `visible`, `enabled`, `url_changes`, `url_contains`, `network_idle`, `download`, `toast`, and `table_loaded`.
- Real secret values, cookie contents, and `storage_state` contents are never stored in DSL or manifest; only references are allowed.

## Task 1: Shared DSL Types And JSON Schema

**Files:**

- Modify: `apps/rpa-local-web/package.json`
- Create: `apps/rpa-local-web/src/shared/dsl-schema.ts`
- Create: `apps/rpa-local-web/src/shared/dsl-json-schema.ts`
- Test: `apps/rpa-local-web/src/shared/dsl-schema.test.ts`

- [x] **Step 1: Add Ajv dev dependency for schema consistency tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web add -D ajv
```

Expected: `apps/rpa-local-web/package.json` and `pnpm-lock.yaml` include `ajv`.

- [x] **Step 2: Write shared DSL type tests**

Create `apps/rpa-local-web/src/shared/dsl-schema.test.ts`:

```ts
import Ajv from 'ajv/dist/2020.js';
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
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(rpaDslJsonSchema);

    expect(validate(createMinimalRpaDsl())).toBe(true);
    expect(validate({ ...createMinimalRpaDsl(), dsl_version: '1.0' })).toBe(false);
  });
});
```

- [x] **Step 3: Run the failing shared DSL tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web test -- src/shared/dsl-schema.test.ts
```

Expected: FAIL because `dsl-schema.ts` and `dsl-json-schema.ts` do not exist yet.

- [x] **Step 4: Add shared DSL constants and types**

Create `apps/rpa-local-web/src/shared/dsl-schema.ts`:

```ts
export const RPA_DSL_VERSION = 'rpa-dsl.v0.1' as const;

export const rpaDslParamTypeValues = ['string', 'number', 'date', 'boolean', 'select', 'secret'] as const;
export type RpaDslParamType = (typeof rpaDslParamTypeValues)[number];

export const rpaDslActionValues = [
  'navigate',
  'click',
  'input',
  'select',
  'submit',
  'assert',
  'wait',
  'manual',
] as const;
export type RpaDslAction = (typeof rpaDslActionValues)[number];

export const rpaDslTargetByValues = [
  'role',
  'label',
  'placeholder',
  'text',
  'testid',
  'id',
  'css',
  'xpath',
] as const;
export type RpaDslTargetBy = (typeof rpaDslTargetByValues)[number];

export const rpaDslAssertTypeValues = [
  'visible',
  'hidden',
  'text_contains',
  'url_contains',
  'download_exists',
  'row_count_gt',
] as const;
export type RpaDslAssertType = (typeof rpaDslAssertTypeValues)[number];

export interface RpaDslParamOption {
  label: string;
  value: string;
}

export interface RpaDslParamDefinition {
  type: RpaDslParamType;
  label?: string;
  description?: string;
  required?: boolean;
  mask?: boolean;
  default?: string | number | boolean;
  options?: RpaDslParamOption[];
}

export interface RpaDslMeta {
  title: string;
  source: 'codegen' | 'nl' | 'imported';
  created_at?: string;
  updated_at?: string;
}

export interface RpaDslContext {
  base_url?: string;
  storage_state?: string;
  default_timeout_ms?: number;
  [key: string]: unknown;
}

export interface RpaDslTarget {
  by: RpaDslTargetBy;
  frame?: string[];
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  testid?: string;
  id?: string;
  css?: string;
  xpath?: string;
  scope?: string;
  filter?: { has_text?: string };
}

export interface RpaDslWaitCondition {
  visible?: boolean;
  enabled?: boolean;
  url_changes?: boolean;
  url_contains?: string;
  network_idle?: boolean;
  download?: boolean;
  toast?: boolean;
  table_loaded?: boolean;
}

export interface RpaDslWait {
  before?: RpaDslWaitCondition;
  after?: RpaDslWaitCondition;
}

export interface RpaDslAssertion {
  type: RpaDslAssertType;
  target?: RpaDslTarget;
  text?: string;
  value?: string;
}

export interface RpaDslManual {
  type: 'captcha' | 'login' | 'ca_usbkey' | 'confirm' | 'other';
  instruction: string;
  riskLevel?: 'low' | 'medium' | 'high';
}

export interface RpaDslStep {
  id: string;
  name: string;
  action: RpaDslAction;
  target?: RpaDslTarget;
  value?: string | number | boolean;
  wait?: RpaDslWait;
  assert?: RpaDslAssertion[];
  write: boolean;
  idempotency_key?: string;
  manual: RpaDslManual | null;
}

export interface RpaDslDocument {
  dsl_version: typeof RPA_DSL_VERSION;
  flow_id: string;
  meta: RpaDslMeta;
  params: Record<string, RpaDslParamDefinition>;
  context: RpaDslContext;
  steps: RpaDslStep[];
}

export function isRpaAction(value: string): value is RpaDslAction {
  return (rpaDslActionValues as readonly string[]).includes(value);
}

export function createMinimalRpaDsl(): RpaDslDocument {
  return {
    dsl_version: RPA_DSL_VERSION,
    flow_id: 'case_query',
    meta: {
      title: '案件查询',
      source: 'codegen',
      created_at: '2026-06-06T00:00:00+08:00',
    },
    params: {
      case_no: {
        type: 'string',
        label: '案件编号',
        required: true,
        mask: true,
      },
    },
    context: {
      base_url: '${BASE_URL}',
      default_timeout_ms: 15000,
    },
    steps: [
      {
        id: 's1',
        name: '打开查询页',
        action: 'navigate',
        value: '${base_url}',
        wait: { after: { network_idle: true } },
        assert: [{ type: 'url_contains', value: '/query' }],
        write: false,
        manual: null,
      },
    ],
  };
}
```

- [x] **Step 5: Add JSON Schema export**

Create `apps/rpa-local-web/src/shared/dsl-json-schema.ts`:

```ts
import {
  RPA_DSL_VERSION,
  rpaDslActionValues,
  rpaDslAssertTypeValues,
  rpaDslParamTypeValues,
  rpaDslTargetByValues,
} from './dsl-schema.js';

export const rpaDslJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://lance-agent-runner.local/schemas/rpa-dsl.v0.1.json',
  title: 'RPA DSL v0.1',
  type: 'object',
  additionalProperties: false,
  required: ['dsl_version', 'flow_id', 'meta', 'params', 'context', 'steps'],
  properties: {
    dsl_version: { const: RPA_DSL_VERSION },
    flow_id: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,63}$' },
    meta: {
      type: 'object',
      required: ['title', 'source'],
      additionalProperties: true,
      properties: {
        title: { type: 'string', minLength: 1 },
        source: { enum: ['codegen', 'nl', 'imported'] },
        created_at: { type: 'string' },
        updated_at: { type: 'string' },
      },
    },
    params: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['type'],
        additionalProperties: true,
        properties: {
          type: { enum: [...rpaDslParamTypeValues] },
          label: { type: 'string' },
          description: { type: 'string' },
          required: { type: 'boolean' },
          mask: { type: 'boolean' },
          default: { type: ['string', 'number', 'boolean'] },
          options: {
            type: 'array',
            items: {
              type: 'object',
              required: ['label', 'value'],
              additionalProperties: false,
              properties: {
                label: { type: 'string' },
                value: { type: 'string' },
              },
            },
          },
        },
      },
    },
    context: { type: 'object', additionalProperties: true },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'name', 'action', 'write', 'manual'],
        additionalProperties: true,
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
          name: { type: 'string', minLength: 1 },
          action: { enum: [...rpaDslActionValues] },
          target: {
            type: 'object',
            required: ['by'],
            additionalProperties: true,
            properties: {
              by: { enum: [...rpaDslTargetByValues] },
              frame: { type: 'array', items: { type: 'string' } },
              role: { type: 'string' },
              name: { type: 'string' },
              label: { type: 'string' },
              placeholder: { type: 'string' },
              text: { type: 'string' },
              testid: { type: 'string' },
              id: { type: 'string' },
              css: { type: 'string' },
              xpath: { type: 'string' },
              scope: { type: 'string' },
            },
          },
          value: { type: ['string', 'number', 'boolean'] },
          wait: { type: 'object', additionalProperties: true },
          assert: {
            type: 'array',
            items: {
              type: 'object',
              required: ['type'],
              additionalProperties: true,
              properties: {
                type: { enum: [...rpaDslAssertTypeValues] },
              },
            },
          },
          write: { type: 'boolean' },
          idempotency_key: { type: 'string' },
          manual: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                required: ['type', 'instruction'],
                additionalProperties: true,
                properties: {
                  type: { enum: ['captcha', 'login', 'ca_usbkey', 'confirm', 'other'] },
                  instruction: { type: 'string' },
                  riskLevel: { enum: ['low', 'medium', 'high'] },
                },
              },
            ],
          },
        },
      },
    },
  },
} as const;
```

- [x] **Step 6: Run shared DSL tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web test -- src/shared/dsl-schema.test.ts
```

Expected: PASS.

## Task 2: DSL Validator And Diagnostics Issues

**Files:**

- Create: `apps/rpa-local-web/src/server/validators/validation-types.ts`
- Create: `apps/rpa-local-web/src/server/validators/dsl-validator.ts`
- Test: `apps/rpa-local-web/src/server/validators/dsl-validator.test.ts`

- [x] **Step 1: Write failing validator tests**

Create `apps/rpa-local-web/src/server/validators/dsl-validator.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMinimalRpaDsl } from '../../shared/dsl-schema.js';
import { deriveParameterFormModel, validateRpaDsl } from './dsl-validator.js';

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
```

- [x] **Step 2: Run failing validator tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web test -- src/server/validators/dsl-validator.test.ts
```

Expected: FAIL because validator modules do not exist yet.

- [x] **Step 3: Add shared validation issue types**

Create `apps/rpa-local-web/src/server/validators/validation-types.ts`:

```ts
export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export function errorIssue(code: string, path: string, message: string): ValidationIssue {
  return { severity: 'error', code, path, message };
}

export function warningIssue(code: string, path: string, message: string): ValidationIssue {
  return { severity: 'warning', code, path, message };
}
```

- [x] **Step 4: Implement DSL validator and form derivation**

Create `apps/rpa-local-web/src/server/validators/dsl-validator.ts`:

```ts
import {
  RPA_DSL_VERSION,
  type RpaDslDocument,
  type RpaDslParamDefinition,
  type RpaDslStep,
  rpaDslActionValues,
  rpaDslAssertTypeValues,
  rpaDslParamTypeValues,
  rpaDslTargetByValues,
} from '../../shared/dsl-schema.js';
import {
  type ValidationIssue,
  type ValidationResult,
  errorIssue,
  warningIssue,
} from './validation-types.js';

export interface ParameterFormField {
  id: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'checkbox' | 'select' | 'password';
  required: boolean;
  mask: boolean;
  options?: { label: string; value: string }[];
  defaultValue?: string | number | boolean;
}

const actionsRequiringTarget = new Set(['click', 'input', 'select', 'submit', 'assert']);
const actionsNeedingWaitWarning = new Set(['navigate', 'click', 'input', 'select', 'submit']);
const actionsNeedingAssertWarning = new Set(['submit', 'assert']);

export function validateRpaDsl(input: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [errorIssue('DSL_NOT_OBJECT', '', 'DSL must be a JSON object.')],
      warnings,
    };
  }

  if (input.dsl_version !== RPA_DSL_VERSION) {
    errors.push(errorIssue('UNSUPPORTED_DSL_VERSION', 'dsl_version', `Expected ${RPA_DSL_VERSION}.`));
  }
  if (!isFlowId(input.flow_id)) {
    errors.push(errorIssue('INVALID_FLOW_ID', 'flow_id', 'flow_id must use lowercase letters, numbers, and underscores.'));
  }
  if (!isRecord(input.meta)) {
    errors.push(errorIssue('META_REQUIRED', 'meta', 'meta must be an object.'));
  }
  if (!isRecord(input.params)) {
    errors.push(errorIssue('PARAMS_REQUIRED', 'params', 'params must be an object.'));
  } else {
    validateParams(input.params, errors);
  }
  if (!isRecord(input.context)) {
    errors.push(errorIssue('CONTEXT_REQUIRED', 'context', 'context must be an object.'));
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    errors.push(errorIssue('STEPS_REQUIRED', 'steps', 'steps must be a non-empty array.'));
  } else {
    const seenStepIds = new Set<string>();
    input.steps.forEach((step, index) => validateStep(step, index, seenStepIds, errors, warnings));
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function deriveParameterFormModel(dsl: RpaDslDocument): ParameterFormField[] {
  return Object.entries(dsl.params).map(([id, param]) => ({
    id,
    label: param.label ?? id,
    type: mapParamTypeToFormType(param),
    required: param.required === true,
    mask: param.mask === true || param.type === 'secret',
    options: param.options,
    defaultValue: param.default,
  }));
}

function validateParams(params: Record<string, unknown>, errors: ValidationIssue[]) {
  for (const [key, value] of Object.entries(params)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) {
      errors.push(errorIssue('INVALID_PARAM_ID', `params.${key}`, 'Parameter ids must use lowercase letters, numbers, and underscores.'));
      continue;
    }
    if (!isRecord(value)) {
      errors.push(errorIssue('INVALID_PARAM', `params.${key}`, 'Parameter definition must be an object.'));
      continue;
    }
    if (!includesString(rpaDslParamTypeValues, value.type)) {
      errors.push(errorIssue('UNSUPPORTED_PARAM_TYPE', `params.${key}.type`, 'Unsupported parameter type.'));
    }
    if (value.type === 'select' && !Array.isArray(value.options)) {
      errors.push(errorIssue('SELECT_REQUIRES_OPTIONS', `params.${key}.options`, 'Select parameters require options.'));
    }
  }
}

function validateStep(
  value: unknown,
  index: number,
  seenStepIds: Set<string>,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
) {
  const path = `steps[${index}]`;
  if (!isRecord(value)) {
    errors.push(errorIssue('INVALID_STEP', path, 'Step must be an object.'));
    return;
  }

  const step = value as Partial<RpaDslStep>;
  if (typeof step.id !== 'string' || step.id.length === 0) {
    errors.push(errorIssue('STEP_ID_REQUIRED', `${path}.id`, 'Step id is required.'));
  } else {
    if (seenStepIds.has(step.id)) {
      errors.push(errorIssue('DUPLICATE_STEP_ID', `${path}.id`, `Duplicate step id: ${step.id}.`));
    } else {
      seenStepIds.add(step.id);
    }
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(step.id)) {
      errors.push(errorIssue('INVALID_STEP_ID', `${path}.id`, 'Step id must be lowercase, stable, and match ^[a-z][a-z0-9_]{0,63}$.'));
    }
  }
  if (typeof step.name !== 'string' || step.name.length === 0) {
    errors.push(errorIssue('STEP_NAME_REQUIRED', `${path}.name`, 'Step name is required.'));
  }
  if (!includesString(rpaDslActionValues, step.action)) {
    errors.push(errorIssue('UNSUPPORTED_ACTION', `${path}.action`, 'Unsupported step action.'));
    return;
  }
  if (typeof step.write !== 'boolean') {
    errors.push(errorIssue('STEP_WRITE_REQUIRED', `${path}.write`, 'Step write flag is required.'));
  }
  if (!('manual' in step)) {
    errors.push(errorIssue('STEP_MANUAL_REQUIRED', `${path}.manual`, 'Step manual field is required, use null when not needed.'));
  }

  if (actionsRequiringTarget.has(step.action) && !isRecord(step.target)) {
    errors.push(errorIssue('STEP_TARGET_REQUIRED', `${path}.target`, 'This action requires a target.'));
  }
  if (isRecord(step.target)) {
    validateTarget(step.target, `${path}.target`, errors, warnings);
  }
  if (Array.isArray(step.assert)) {
    step.assert.forEach((assertion, assertionIndex) => {
      if (!isRecord(assertion) || !includesString(rpaDslAssertTypeValues, assertion.type)) {
        errors.push(
          errorIssue(
            'UNSUPPORTED_ASSERT_TYPE',
            `${path}.assert[${assertionIndex}].type`,
            'Unsupported assertion type.',
          ),
        );
      }
    });
  }
  if (step.manual !== null && step.manual !== undefined) {
    validateManual(step.manual, `${path}.manual`, errors);
  }

  if (actionsNeedingWaitWarning.has(step.action) && step.wait === undefined) {
    warnings.push(warningIssue('MISSING_WAIT', `${path}.wait`, 'Actionable step should define explicit wait conditions.'));
  }
  if (actionsNeedingAssertWarning.has(step.action) && (!Array.isArray(step.assert) || step.assert.length === 0)) {
    warnings.push(warningIssue('MISSING_ASSERT', `${path}.assert`, 'Critical step should define a result assertion.'));
  }
  if (step.write === true && !step.idempotency_key && !hasHighRiskManual(step.manual)) {
    warnings.push(
      warningIssue(
        'WRITE_MISSING_IDEMPOTENCY_OR_MANUAL_CONFIRMATION',
        `${path}.write`,
        'Write steps should provide idempotency_key or high-risk manual confirmation.',
      ),
    );
  }
}

function validateManual(value: unknown, path: string, errors: ValidationIssue[]) {
  if (!isRecord(value)) {
    errors.push(errorIssue('INVALID_MANUAL', path, 'Manual field must be null or an object.'));
    return;
  }
  if (!['captcha', 'login', 'ca_usbkey', 'confirm', 'other'].includes(String(value.type))) {
    errors.push(errorIssue('UNSUPPORTED_MANUAL_TYPE', `${path}.type`, 'Unsupported manual intervention type.'));
  }
  if (typeof value.instruction !== 'string' || value.instruction.trim().length === 0) {
    errors.push(errorIssue('MANUAL_INSTRUCTION_REQUIRED', `${path}.instruction`, 'Manual intervention requires an instruction.'));
  }
}

function validateTarget(
  target: Record<string, unknown>,
  path: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
) {
  if (!includesString(rpaDslTargetByValues, target.by)) {
    errors.push(errorIssue('UNSUPPORTED_TARGET_BY', `${path}.by`, 'Unsupported target selector type.'));
    return;
  }
  if (target.by === 'xpath') {
    warnings.push(warningIssue('XPATH_FALLBACK', `${path}.by`, 'XPath is a fallback selector and should be hardened later.'));
  }
}

function mapParamTypeToFormType(param: RpaDslParamDefinition): ParameterFormField['type'] {
  if (param.type === 'number') return 'number';
  if (param.type === 'date') return 'date';
  if (param.type === 'boolean') return 'checkbox';
  if (param.type === 'select') return 'select';
  if (param.type === 'secret') return 'password';
  return 'text';
}

function hasHighRiskManual(value: unknown): boolean {
  return isRecord(value) && value.riskLevel === 'high';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function includesString(values: readonly string[], value: unknown): value is string {
  return typeof value === 'string' && values.includes(value);
}

function isFlowId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(value);
}
```

- [x] **Step 5: Run DSL validator tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web test -- src/server/validators/dsl-validator.test.ts
```

Expected: PASS.

## Task 3: Generation Artifact Contract

**Files:**

- Create: `apps/rpa-local-web/src/shared/artifacts.ts`
- Create: `apps/rpa-local-web/src/server/validators/artifact-validator.ts`
- Test: `apps/rpa-local-web/src/server/validators/artifact-validator.test.ts`

- [x] **Step 1: Write failing artifact validator tests**

Create `apps/rpa-local-web/src/server/validators/artifact-validator.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { optionalGenerationArtifactNames, requiredGenerationArtifactNames } from '../../shared/artifacts.js';
import { validateGenerationArtifacts } from './artifact-validator.js';

describe('RPA generation artifact validator', () => {
  const completeArtifacts = requiredGenerationArtifactNames.map((relativePath) => ({
    artifactId: `art_${relativePath}`,
    relativePath: `output/${relativePath}`,
    fileName: relativePath,
    mimeType: relativePath.endsWith('.json')
      ? 'application/json'
      : relativePath.endsWith('.py')
        ? 'text/x-python'
        : 'text/markdown',
    size: 128,
    sha256: 'a'.repeat(64),
  }));

  it('accepts the five required generation artifacts', () => {
    const result = validateGenerationArtifacts(completeArtifacts);

    expect(result.ok).toBe(true);
    expect(result.artifacts.map((artifact) => artifact.fileName)).toEqual(requiredGenerationArtifactNames);
  });

  it('rejects missing required artifacts with readable errors', () => {
    const result = validateGenerationArtifacts(completeArtifacts.slice(0, 3));

    expect(result.ok).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toContain('REQUIRED_ARTIFACT_MISSING');
    expect(result.errors.map((issue) => issue.message).join('\\n')).toContain('parameterization-report.md');
  });

  it('rejects path traversal and unexpected artifact names', () => {
    const result = validateGenerationArtifacts([
      ...completeArtifacts,
      {
        artifactId: 'bad',
        relativePath: '../secrets/storage_state.json',
        fileName: 'storage_state.json',
        mimeType: 'application/json',
        size: 10,
        sha256: 'b'.repeat(64),
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['ARTIFACT_PATH_UNSAFE', 'UNEXPECTED_ARTIFACT']),
    );
  });

  it('rejects Windows-style path separators in artifact paths', () => {
    const result = validateGenerationArtifacts([
      ...completeArtifacts.map((artifact) =>
        artifact.fileName === 'flow.dsl.json'
          ? { ...artifact, relativePath: 'output\\flow.dsl.json' }
          : artifact,
      ),
    ]);

    expect(result.ok).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toContain('ARTIFACT_PATH_UNSAFE');
  });

  it('allows optional flow.py without blocking required artifact validation', () => {
    const result = validateGenerationArtifacts([
      ...completeArtifacts,
      {
        artifactId: 'art_flow_py',
        relativePath: 'output/flow.py',
        fileName: optionalGenerationArtifactNames[0],
        mimeType: 'text/x-python',
        size: 32,
        sha256: 'c'.repeat(64),
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.artifacts.map((artifact) => artifact.fileName)).toEqual([
      ...requiredGenerationArtifactNames,
      ...optionalGenerationArtifactNames,
    ]);
  });

  it('warns when sha256 is missing but still identifies artifact completeness', () => {
    const artifacts = completeArtifacts.map((artifact) =>
      artifact.fileName === 'flow.dsl.json' ? { ...artifact, sha256: undefined } : artifact,
    );

    const result = validateGenerationArtifacts(artifacts);

    expect(result.ok).toBe(true);
    expect(result.warnings.map((issue) => issue.code)).toContain('ARTIFACT_HASH_MISSING');
  });
});
```

- [x] **Step 2: Run failing artifact tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web test -- src/server/validators/artifact-validator.test.ts
```

Expected: FAIL because `artifacts.ts` and `artifact-validator.ts` do not exist yet.

- [x] **Step 3: Add shared artifact contract types**

Create `apps/rpa-local-web/src/shared/artifacts.ts`:

```ts
import { RPA_DSL_VERSION } from './dsl-schema.js';

export const RPA_PACKAGE_SCHEMA_VERSION = 'rpa-package.v0.1' as const;

export const requiredGenerationArtifactNames = [
  'flow.dsl.json',
  'flow.hardened.py',
  'config.example.json',
  'parameterization-report.md',
  'hardening-report.md',
] as const;

export type RequiredGenerationArtifactName = (typeof requiredGenerationArtifactNames)[number];

export const optionalGenerationArtifactNames = ['flow.py'] as const;
export type OptionalGenerationArtifactName = (typeof optionalGenerationArtifactNames)[number];

export const allowedGenerationArtifactNames = [
  ...requiredGenerationArtifactNames,
  ...optionalGenerationArtifactNames,
] as const;

export type AllowedGenerationArtifactName = (typeof allowedGenerationArtifactNames)[number];

export type GenerationArtifactRole =
  | 'dsl'
  | 'script'
  | 'configTemplate'
  | 'parameterizationReport'
  | 'hardeningReport';

export interface RpaGenerationArtifact {
  artifactId: string;
  relativePath: string;
  fileName: string;
  mimeType?: string;
  size: number;
  sha256?: string;
}

export interface RpaPackageManifest {
  schemaVersion: typeof RPA_PACKAGE_SCHEMA_VERSION;
  flowId: string;
  name: string;
  description?: string;
  createdAt: string;
  generator: {
    mode: 'codegen' | 'nl' | 'imported';
    skillId?: 'playwright-rpa-harden' | 'rpa-script-generate';
    daemonRunId?: string;
  };
  dsl: {
    version: typeof RPA_DSL_VERSION;
    path: 'flow.dsl.json';
  };
  artifacts: Record<GenerationArtifactRole, RequiredGenerationArtifactName>;
  params: {
    schemaPath: 'flow.dsl.json#/params';
    requiresUserInput: boolean;
    maskedParamIds: string[];
  };
  requirements: {
    runtime: 'python-playwright';
    executorMinVersion: '0.1.0';
    browser: 'playwright-chromium' | 'system-chrome';
    browserChannel: string | null;
    manualIntervention: string[];
  };
  checksums: Record<RequiredGenerationArtifactName, `sha256:${string}`>;
}

export const requiredArtifactRoleByName: Record<RequiredGenerationArtifactName, GenerationArtifactRole> = {
  'flow.dsl.json': 'dsl',
  'flow.hardened.py': 'script',
  'config.example.json': 'configTemplate',
  'parameterization-report.md': 'parameterizationReport',
  'hardening-report.md': 'hardeningReport',
};
```

- [x] **Step 4: Implement artifact validator**

Create `apps/rpa-local-web/src/server/validators/artifact-validator.ts`:

```ts
import {
  type RpaGenerationArtifact,
  allowedGenerationArtifactNames,
  optionalGenerationArtifactNames,
  requiredGenerationArtifactNames,
} from '../../shared/artifacts.js';
import {
  type ValidationIssue,
  errorIssue,
  warningIssue,
} from './validation-types.js';

export interface GenerationArtifactValidationResult {
  ok: boolean;
  artifacts: RpaGenerationArtifact[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

const allowedNameSet = new Set<string>(allowedGenerationArtifactNames);

export function validateGenerationArtifacts(
  artifacts: RpaGenerationArtifact[],
): GenerationArtifactValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const byFileName = new Map<string, RpaGenerationArtifact>();

  for (const artifact of artifacts) {
    const path = `artifacts.${artifact.fileName}`;
    if (!isSafeOutputArtifactPath(artifact.relativePath)) {
      errors.push(errorIssue('ARTIFACT_PATH_UNSAFE', path, 'Artifact path must stay under output/ and cannot contain traversal.'));
    }
    if (!allowedNameSet.has(artifact.fileName)) {
      errors.push(errorIssue('UNEXPECTED_ARTIFACT', path, `Unexpected generation artifact: ${artifact.fileName}.`));
    }
    if (artifact.size <= 0) {
      errors.push(errorIssue('ARTIFACT_EMPTY', path, `Artifact ${artifact.fileName} is empty.`));
    }
    if (artifact.sha256 === undefined) {
      warnings.push(warningIssue('ARTIFACT_HASH_MISSING', path, `Artifact ${artifact.fileName} has no sha256 hash.`));
    } else if (!/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
      errors.push(errorIssue('ARTIFACT_HASH_INVALID', path, `Artifact ${artifact.fileName} has an invalid sha256 hash.`));
    }
    byFileName.set(artifact.fileName, artifact);
  }

  for (const requiredName of requiredGenerationArtifactNames) {
    if (!byFileName.has(requiredName)) {
      errors.push(
        errorIssue(
          'REQUIRED_ARTIFACT_MISSING',
          `artifacts.${requiredName}`,
          `Required generation artifact is missing: ${requiredName}.`,
        ),
      );
    }
  }

  return {
    ok: errors.length === 0,
    artifacts: [...requiredGenerationArtifactNames, ...optionalGenerationArtifactNames].flatMap((name) => {
      const artifact = byFileName.get(name);
      return artifact ? [artifact] : [];
    }),
    errors,
    warnings,
  };
}

function isSafeOutputArtifactPath(relativePath: string): boolean {
  return (
    relativePath.startsWith('output/') &&
    !relativePath.includes('..') &&
    !relativePath.startsWith('/') &&
    !relativePath.includes('\\')
  );
}
```

- [x] **Step 5: Run artifact validator tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web test -- src/server/validators/artifact-validator.test.ts
```

Expected: PASS.

## Task 4: Flow Store Helpers And Manifest Builder

**Files:**

- Create: `apps/rpa-local-web/src/server/flow-store.ts`
- Test: `apps/rpa-local-web/src/server/flow-store.test.ts`

- [x] **Step 1: Write failing flow-store tests**

Create `apps/rpa-local-web/src/server/flow-store.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMinimalRpaDsl } from '../shared/dsl-schema.js';
import { requiredGenerationArtifactNames } from '../shared/artifacts.js';
import {
  buildRpaPackageManifest,
  resolveFlowArtifactPath,
  safeFlowId,
  writeJsonFile,
} from './flow-store.js';

describe('RPA flow store helpers', () => {
  it('validates flow ids and confines artifact paths to the flow directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rpa-flow-store-'));

    expect(safeFlowId('case_query')).toBe('case_query');
    expect(() => safeFlowId('../case')).toThrow(/Invalid flow id/);

    const resolved = resolveFlowArtifactPath(root, 'case_query', 'flow.dsl.json');
    expect(resolved.startsWith(path.join(root, 'case_query'))).toBe(true);
    expect(resolveFlowArtifactPath(root, 'case_query', 'flow.py')).toContain('flow.py');
    expect(() => resolveFlowArtifactPath(root, 'case_query', '../secret.json')).toThrow(/Unsafe artifact path/);
    expect(() => resolveFlowArtifactPath(root, 'case_query', 'notes.md')).toThrow(/Unsupported flow artifact/);
  });

  it('writes JSON files with stable formatting', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rpa-flow-json-'));
    const filePath = path.join(root, 'flow.dsl.json');

    await writeJsonFile(filePath, createMinimalRpaDsl());

    expect(await readFile(filePath, 'utf8')).toContain('"dsl_version": "rpa-dsl.v0.1"');
  });

  it('builds a manifest with required artifact checksums and masked params', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rpa-flow-manifest-'));
    for (const name of requiredGenerationArtifactNames) {
      await writeFile(path.join(root, name), `${name}\\n`);
    }

    const manifest = await buildRpaPackageManifest({
      flowDir: root,
      dsl: createMinimalRpaDsl(),
      generator: {
        mode: 'codegen',
        skillId: 'playwright-rpa-harden',
        daemonRunId: 'run_1',
      },
    });

    expect(manifest.schemaVersion).toBe('rpa-package.v0.1');
    expect(manifest.dsl.version).toBe('rpa-dsl.v0.1');
    expect(manifest.params.maskedParamIds).toEqual(['case_no']);
    expect(Object.keys(manifest.checksums)).toEqual([...requiredGenerationArtifactNames]);
    expect(manifest.checksums['flow.dsl.json']).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
```

- [x] **Step 2: Run failing flow-store tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web test -- src/server/flow-store.test.ts
```

Expected: FAIL because `flow-store.ts` does not exist yet.

- [x] **Step 3: Implement flow-store helpers**

Create `apps/rpa-local-web/src/server/flow-store.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  RPA_PACKAGE_SCHEMA_VERSION,
  type RpaPackageManifest,
  allowedGenerationArtifactNames,
  requiredArtifactRoleByName,
  requiredGenerationArtifactNames,
} from '../shared/artifacts.js';
import { RPA_DSL_VERSION, type RpaDslDocument } from '../shared/dsl-schema.js';

export function safeFlowId(flowId: string): string {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(flowId)) {
    throw new Error(`Invalid flow id: ${flowId}`);
  }
  return flowId;
}

export function resolveFlowArtifactPath(rootDir: string, flowId: string, artifactName: string): string {
  const safeId = safeFlowId(flowId);
  const flowDir = path.resolve(rootDir, safeId);
  const resolved = path.resolve(flowDir, artifactName);
  if (!resolved.startsWith(`${flowDir}${path.sep}`)) {
    throw new Error(`Unsafe artifact path: ${artifactName}`);
  }
  if (!allowedGenerationArtifactNames.includes(artifactName as never)) {
    throw new Error(`Unsupported flow artifact: ${artifactName}`);
  }
  return resolved;
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export interface BuildRpaPackageManifestInput {
  flowDir: string;
  dsl: RpaDslDocument;
  generator: RpaPackageManifest['generator'];
}

export async function buildRpaPackageManifest(
  input: BuildRpaPackageManifestInput,
): Promise<RpaPackageManifest> {
  const checksums = {} as RpaPackageManifest['checksums'];
  for (const name of requiredGenerationArtifactNames) {
    checksums[name] = `sha256:${await sha256File(path.join(input.flowDir, name))}`;
  }

  return {
    schemaVersion: RPA_PACKAGE_SCHEMA_VERSION,
    flowId: input.dsl.flow_id,
    name: input.dsl.meta.title,
    createdAt: new Date().toISOString(),
    generator: input.generator,
    dsl: {
      version: RPA_DSL_VERSION,
      path: 'flow.dsl.json',
    },
    artifacts: {
      [requiredArtifactRoleByName['flow.dsl.json']]: 'flow.dsl.json',
      [requiredArtifactRoleByName['flow.hardened.py']]: 'flow.hardened.py',
      [requiredArtifactRoleByName['config.example.json']]: 'config.example.json',
      [requiredArtifactRoleByName['parameterization-report.md']]: 'parameterization-report.md',
      [requiredArtifactRoleByName['hardening-report.md']]: 'hardening-report.md',
    },
    params: {
      schemaPath: 'flow.dsl.json#/params',
      requiresUserInput: Object.values(input.dsl.params).some((param) => param.required === true),
      maskedParamIds: Object.entries(input.dsl.params)
        .filter(([, param]) => param.mask === true || param.type === 'secret')
        .map(([id]) => id),
    },
    requirements: {
      runtime: 'python-playwright',
      executorMinVersion: '0.1.0',
      browser: 'playwright-chromium',
      browserChannel: null,
      manualIntervention: input.dsl.steps
        .filter((step) => step.manual !== null)
        .map((step) => step.manual?.type ?? 'other'),
    },
    checksums,
  };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return hash.digest('hex');
}
```

- [x] **Step 4: Run flow-store tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web test -- src/server/flow-store.test.ts
```

Expected: PASS.

## Task 5: Producer Contract Sync

**Files:**

- Modify: `apps/daemon/skills/playwright-rpa-harden/references/dsl.md`
- Modify: `apps/daemon/skills/rpa-script-generate/references/dsl.md`
- Modify: `apps/daemon/skills/rpa-script-generate/templates/flow.dsl.json.tmpl`

- [x] **Step 1: Update producer-facing DSL references**

Change both references so they state:

```md
- `dsl_version`: current MVP contract is `"rpa-dsl.v0.1"`.
```

In JSON examples, replace:

```json
"dsl_version": "1.0"
```

with:

```json
"dsl_version": "rpa-dsl.v0.1"
```

In both reference files, add this rule under step/target guidance:

```md
- `navigate` uses step-level `value` for the URL or URL parameter reference, for example `"value": "${BASE_URL}"`. Do not emit `target.by = "url"`.
- Step `id` must be stable, unique, lowercase, and match `^[a-z][a-z0-9_]{0,63}$`. Semantic ids such as `open_query_page` are allowed.
- Every step must include `write` and `manual`; use `"manual": null` when no manual intervention is needed.
- For `write: true`, emit `idempotency_key` whenever a stable business key is known. If no idempotency key is available, document the risk in `hardening-report.md`.
- Selectable runtime parameters must use `"type": "select"` with `options`; do not emit a separate `widget` field in DSL v0.1.
- Wait keys supported by DSL v0.1 are `visible`, `enabled`, `url_changes`, `url_contains`, `network_idle`, `download`, `toast`, and `table_loaded`.
```

- [x] **Step 2: Update the natural-language DSL template**

Modify `apps/daemon/skills/rpa-script-generate/templates/flow.dsl.json.tmpl`:

```json
{
  "dsl_version": "rpa-dsl.v0.1",
  "flow_id": "{{flow_id}}",
  "meta": {
    "title": "{{title}}",
    "source": "nl",
    "created_at": "{{created_at}}"
  },
  "params": {
    "{{param_name}}": {
      "type": "string",
      "label": "{{param_label}}",
      "required": true,
      "mask": false
    }
  },
  "context": {
    "base_url": "${BASE_URL}",
    "storage_state": "secrets/storage_state.json",
    "default_timeout_ms": 15000
  },
  "steps": [
    {
      "id": "s1",
      "name": "打开系统入口",
      "action": "navigate",
      "value": "${BASE_URL}",
      "wait": {
        "after": { "network_idle": true }
      },
      "assert": [
        {
          "type": "visible",
          "target": { "by": "role", "role": "main" }
        }
      ],
      "write": false,
      "manual": null
    }
  ]
}
```

- [x] **Step 3: Verify no old DSL version or URL target remains in RPA producer references/templates**

Run:

```bash
rg -n '"1.0"|"by": "url"' apps/daemon/skills/playwright-rpa-harden/references/dsl.md apps/daemon/skills/rpa-script-generate/references/dsl.md apps/daemon/skills/rpa-script-generate/templates/flow.dsl.json.tmpl
```

Expected: no matches.

- [x] **Step 4: Sync stale design-document DSL/package examples**

Update `docs/rpa-local-bs-mvp-design.md` so DSL examples use:

```json
"dsl_version": "rpa-dsl.v0.1"
```

and flow package manifest examples use:

```json
"schemaVersion": "rpa-package.v0.1"
```

with:

```json
"version": "rpa-dsl.v0.1"
```

Also update the execution-parameter examples in `docs/rpa-local-bs-mvp-design.md`:

- Remove `widget` from `flow.dsl.json.params` examples.
- Express selectable parameters as `"type": "select"` with `options`.
- Change prose such as `label/type/widget/default` to `label/type/default/options`.
- Existing date parameters that already use `"type": "date"` only need `widget` removed; selectable parameters such as `org_code` must change from `"type": "string"` plus `widget: "select"` to `"type": "select"` plus `options`.

Run:

```bash
rg -n '"1.0"|widget' docs/rpa-local-bs-mvp-design.md
```

Expected: no stale DSL/package version examples and no DSL `widget` examples remain in `docs/rpa-local-bs-mvp-design.md`.

Do not scan or edit `docs/rpa-skill-observability-design.md` in this step. Its `schemaVersion: "1.0"` example belongs to the RPA observability extension manifest, not the DSL or `.rpa.zip` package contract frozen in this slice.

## Task 6: Slice Verification And Boundary Review

**Files:**

- Modify: `docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md` only after implementation is complete.

- [x] **Step 1: Run focused RPA local web tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web test
```

Expected: all RPA local web tests PASS.

- [x] **Step 2: Run typecheck and build**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web typecheck
pnpm --filter @lance-agent-runner/rpa-local-web build
```

Expected: both PASS.

- [x] **Step 3: Run root verification**

Run:

```bash
pnpm typecheck
pnpm build
```

Expected: both PASS.

- [x] **Step 4: Check daemon boundary**

Run:

```bash
git diff --stat
rg -n "RPA_DSL_VERSION|validateRpaDsl|rpa-dsl|flow\\.dsl|flow\\.hardened" apps/daemon/src
```

Expected:

- Diff contains `apps/rpa-local-web`, RPA skill references, and plan docs only.
- `apps/daemon/src` search has no matches from this slice.

- [x] **Step 5: Update MVP plan progress after implementation**

After implementation and verification, update `docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md` by recording the actual commit hash printed by `git rev-parse --short HEAD` and marking the slice tasks complete.

- [x] **Step 6: Commit**

Run:

```bash
git add apps/rpa-local-web package.json pnpm-lock.yaml apps/daemon/skills/playwright-rpa-harden/references/dsl.md apps/daemon/skills/rpa-script-generate/references/dsl.md apps/daemon/skills/rpa-script-generate/templates/flow.dsl.json.tmpl docs/rpa-local-bs-mvp-design.md docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md docs/superpowers/plans/2026-06-06-rpa-dsl-artifact-contract.md
git commit -m "Add RPA DSL artifact contract"
```

Expected: commit succeeds with no co-author trailer.

## Acceptance Checklist

- [x] `flow.dsl.json` version is consistently `rpa-dsl.v0.1`.
- [x] DSL TypeScript types exist and are exported from `apps/rpa-local-web/src/shared/dsl-schema.ts`.
- [x] JSON Schema object exists, uses the same enum/version constants, accepts `createMinimalRpaDsl()` through Ajv, and rejects legacy `"1.0"`.
- [x] DSL validator rejects malformed documents and produces UI-readable issues.
- [x] DSL validator rejects duplicate step ids, invalid step ids, invalid manual blocks, and unsupported assertion types.
- [x] DSL validator warns for weak but schema-allowed cases such as missing waits/assertions, XPath fallback, and write steps without idempotency/manual confirmation.
- [x] Parameter form model is derived from `params` and preserves `mask`.
- [x] Selectable parameters use `type: "select"` with `options`; `widget` is not part of DSL v0.1.
- [x] Wait keys are aligned between types and producer references, including `toast` and `table_loaded`.
- [x] Required generation artifact names are centralized.
- [x] Artifact validator accepts optional `flow.py` and rejects missing required files, traversal paths, backslash paths, unexpected names, empty artifacts, and invalid hashes.
- [x] Flow-store helpers confine artifact paths to RPA flow storage.
- [x] Manifest builder records schema versions, artifact checksums, generator metadata, masked param ids, and manual intervention summary.
- [x] RPA skill DSL references and templates target the same `rpa-dsl.v0.1` contract and do not emit `target.by = "url"`.
- [x] Stale design-document DSL/package `"1.0"` examples are updated or explicitly marked superseded.
- [x] No code under `apps/daemon/src` understands or imports RPA DSL.

## CC Review Prompt After Plan

Use this prompt before implementation:

```text
Review only. Do not edit files.

Repo: /home/orangels/ls_dev/lance-agent-runner-daemon

Task background:
We are planning the next RPA MVP slice: RPA DSL And Artifact Contract. The daemon must remain a generic Claude Code runner and must not parse RPA DSL or Playwright. RPA product schema/validators belong in apps/rpa-local-web. The two RPA producer skills must output the same required artifacts and target the same DSL contract.

Plan to review:
- docs/superpowers/plans/2026-06-06-rpa-dsl-artifact-contract.md

Already completed prerequisites:
- Slice 1a daemon business-context/snapshot guard.
- Slice 1b daemon-composed continuation.
- apps/rpa-local-web skeleton.

This planned slice should freeze:
- flow.dsl.json contract as rpa-dsl.v0.1
- required generation artifacts:
  - flow.dsl.json
  - flow.hardened.py
  - config.example.json
  - parameterization-report.md
  - hardening-report.md
- optional generation artifact:
  - flow.py
- DSL validator and parameter form derivation
- generation artifact validator
- minimal package manifest/checksum helpers
- producer-facing skill reference/template version sync

First review fixes already applied in the plan:
- Flow-store path traversal and unsupported artifact tests are separated.
- Producer sync includes the natural-language DSL template and removes target.by = "url".
- Optional flow.py is allowed by artifact validation.
- write=true without idempotency/manual confirmation is a warning, not a hard error.
- Handwritten validator is runtime authority; JSON Schema is tested with Ajv for consistency.
- Duplicate step ids, invalid step ids, invalid manual blocks, unsupported assertion types, and Windows-style artifact paths are covered.
- Second review fixes applied:
  - Step id rule is relaxed to stable lowercase ids matching `^[a-z][a-z0-9_]{0,63}$`.
  - Duplicate-id tests use duplicate valid ids, separate from invalid-id tests.
  - Ajv imports from `ajv/dist/2020.js` to match draft 2020-12.
  - `type: "select"` with `options` is the DSL v0.1 way to express selectable params; `widget` is excluded.
  - Wait keys include `toast` and `table_loaded`.
  - Stale design-doc DSL/package version examples are included in the sync scope.

Please review:
1. Whether the slice scope is correct and small enough.
2. Whether DSL v0.1 fields are sufficient for upcoming executor, codegen hardening, natural-language generation, import/export, and observability slices.
3. Whether any planned validator rules are too strict or too loose for MVP.
4. Whether choosing dsl_version = "rpa-dsl.v0.1" creates a conflict with existing skill references/templates that previously said "1.0", and whether the planned sync is enough.
5. Whether artifact validation covers the right security boundaries without exposing daemon workspace paths.
6. Whether the plan accidentally puts RPA semantics into apps/daemon/src.
7. Whether the plan misses any P0/P1 tests needed before implementation.

Expected output:
- Overall verdict.
- P0/P1 issues first with file/section references.
- Required plan changes before coding.
- P2 suggestions that can wait.
- Final recommendation on whether to start implementing this slice.
```
