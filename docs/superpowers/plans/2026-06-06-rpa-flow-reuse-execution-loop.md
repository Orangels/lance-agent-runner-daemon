# RPA Flow Reuse And Execution Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `流程复用与执行闭环` slice: DSL-driven runtime parameter forms, per-execution param validation, `.rpa.zip` export/import, imported-flow provenance, and verify-before-run enforcement.

**Architecture:** Keep every RPA semantic in `apps/rpa-local-web`; `apps/daemon` remains untouched. RPA Web reads generated flow artifacts from its local flow storage, packages only allowlisted flow files into `.rpa.zip`, imports packages back into local flow storage with local provenance metadata, and validates runtime params before the executor spawns Python. The browser renders params from `flow.dsl.json.params`; daily execution does not call Claude Code to rediscover variables.

**Tech Stack:** TypeScript ESM, Express, React/Vite, Vitest, existing RPA Web file storage under `.rpa-local`, existing uncompressed ZIP helper generalized for package export/import.

---

## Scope

This plan implements the current slice only:

- Runtime params form rendered from `flow.dsl.json.params`.
- Required/type/options validation before executor spawn.
- Per-execution `run.params.json` stays the execution input file and remains masked in summaries.
- `.rpa.zip` export with `manifest.json` plus the five required generation artifacts.
- `.rpa.zip` import with manifest, checksum, DSL, and artifact validation.
- Imported package provenance shown in RPA Web.
- Imported flows cannot start production `run` until a successful local `verify` has been recorded.

Out of scope for this slice:

- No daemon route, schema, skill, prompt, or review bundle changes.
- No SaaS, Browserless, multi-user server execution, or object storage.
- No new trace/video generation. If scripts already produce trace/video artifacts, existing executor artifact collection may expose them; `.rpa.zip` export excludes them by default.
- No flow rename or overwrite UX. MVP import rejects an existing `flowId`.

## Current Code Facts

- `apps/rpa-local-web/src/server/executor/execution-store.ts` already writes `run.params.json` during `createExecution`.
- `apps/rpa-local-web/src/server/flow-store.ts` already has `buildRpaPackageManifest`, `resolveFlowsRoot`, `resolveFlowArtifactPath`, and `safeFlowId`.
- `apps/rpa-local-web/src/server/validators/dsl-validator.ts` already has `deriveParameterFormModel`, but it is server-only; this slice moves runtime-param derivation/validation to shared code.
- `apps/rpa-local-web/src/components/ExecutionControlBar.tsx` currently uses free-form Params JSON; this slice replaces it with typed controls.
- `apps/rpa-local-web/src/server/observability/review-zip.ts` already creates and reads uncompressed ZIPs. This slice moves that helper to a neutral server utility so observability and `.rpa.zip` packages can share it.

## API Contract

Add these RPA Web endpoints:

```text
GET  /api/rpa/flows/:flowId/package/download
POST /api/rpa/flows/import-package
```

`GET /api/rpa/flows/:flowId` response gains:

```ts
runtimeParams: {
  fields: RpaRuntimeParamField[];
  requiresUserInput: boolean;
  maskedParamIds: string[];
};
provenance: {
  source: 'generated' | 'imported';
  requiresVerifyBeforeRun: boolean;
  importedAt?: string;
  originalFlowId?: string;
  packageCreatedAt?: string;
  packageSha256?: string;
  verifiedAt?: string;
  verifiedExecutionId?: string;
};
```

Import request:

```http
POST /api/rpa/flows/import-package
Content-Type: application/zip
X-RPA-Package-File-Name: case-query.rpa.zip

<zip bytes>
```

Import response:

```ts
interface ImportRpaPackageResponse {
  flowId: string;
  title: string;
  source: 'imported';
  requiresVerifyBeforeRun: true;
  importedAt: string;
  packageSha256: string;
  ignoredEntries: string[];
}
```

Export response:

```http
200 OK
Content-Type: application/zip
Content-Disposition: attachment; filename="case_query.rpa.zip"
```

## File Structure

Create:

- `apps/rpa-local-web/src/shared/runtime-params.ts`  
  Shared runtime-param field derivation, coercion, and validation.
- `apps/rpa-local-web/src/server/zip/uncompressed-zip.ts`  
  Neutral ZIP helper moved from observability.
- `apps/rpa-local-web/src/server/packages/manifest-schema.ts`  
  Runtime validation for `manifest.json` inside `.rpa.zip`.
- `apps/rpa-local-web/src/server/packages/rpa-package.ts`  
  Export/import package service.
- `apps/rpa-local-web/src/server/routes/packages.ts`  
  Express routes for package download/import.
- `apps/rpa-local-web/src/components/RuntimeParamsForm.tsx`  
  Typed runtime parameter controls.
- `apps/rpa-local-web/src/components/FlowAssetsWorkspace.tsx`  
  Flow asset UI for load/import/export/verify/run.
- Tests:
  - `apps/rpa-local-web/tests/shared/runtime-params.test.ts`
  - `apps/rpa-local-web/tests/server/packages/manifest-schema.test.ts`
  - `apps/rpa-local-web/tests/server/packages/rpa-package.test.ts`
  - `apps/rpa-local-web/tests/server/routes/packages.test.ts`
  - `apps/rpa-local-web/tests/components/RuntimeParamsForm.test.tsx`
  - `apps/rpa-local-web/tests/components/FlowAssetsWorkspace.test.tsx`

Modify:

- `apps/rpa-local-web/src/shared/rpa-api-types.ts`
- `apps/rpa-local-web/src/shared/artifacts.ts`
- `apps/rpa-local-web/src/server/flow-store.ts`
- `apps/rpa-local-web/src/server/validators/dsl-validator.ts`
- `apps/rpa-local-web/src/server/workflows/generation-artifact-service.ts`
- `apps/rpa-local-web/src/server/workflows/codegen-hardening-workflow.ts`
- `apps/rpa-local-web/src/server/workflows/natural-language-generation-workflow.ts`
- `apps/rpa-local-web/src/server/executor/python-playwright-executor.ts`
- `apps/rpa-local-web/src/server/routes/flows.ts`
- `apps/rpa-local-web/src/server/server.ts`
- `apps/rpa-local-web/src/api/rpa-api-client.ts`
- `apps/rpa-local-web/src/components/ExecutionControlBar.tsx`
- `apps/rpa-local-web/src/components/RuntimeVerificationWorkspace.tsx`
- `apps/rpa-local-web/src/components/AppShell.tsx`
- `apps/rpa-local-web/src/styles.css`
- Existing tests touched by changed contracts.

---

## Task 1: Shared Runtime Params Contract

**Files:**
- Create: `apps/rpa-local-web/src/shared/runtime-params.ts`
- Modify: `apps/rpa-local-web/src/server/validators/dsl-validator.ts`
- Modify: `apps/rpa-local-web/src/shared/rpa-api-types.ts`
- Test: `apps/rpa-local-web/tests/shared/runtime-params.test.ts`
- Test: `apps/rpa-local-web/tests/server/validators/dsl-validator.test.ts`

- [ ] **Step 1: Write failing runtime-param tests**

Create `apps/rpa-local-web/tests/shared/runtime-params.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMinimalRpaDsl, type RpaDslDocument } from '../../src/shared/dsl-schema.js';
import {
  deriveRuntimeParamFields,
  normalizeRuntimeParams,
} from '../../src/shared/runtime-params.js';

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
      expect.objectContaining({ id: 'unit', type: 'select', options: [{ label: 'City', value: 'city' }, { label: 'District', value: 'district' }] }),
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
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/shared/runtime-params.test.ts
```

Expected: FAIL because `runtime-params.ts` does not exist.

- [ ] **Step 3: Implement shared runtime-param helpers**

Create `apps/rpa-local-web/src/shared/runtime-params.ts`:

```ts
import type { RpaDslParamDefinition } from './dsl-schema.js';

export type RuntimeParamValue = string | number | boolean | null;

export interface RpaRuntimeParamField {
  id: string;
  label: string;
  description?: string;
  type: 'text' | 'number' | 'date' | 'checkbox' | 'select' | 'password';
  required: boolean;
  mask: boolean;
  options?: { label: string; value: string }[];
  defaultValue?: string | number | boolean;
}

export interface RuntimeParamValidationError {
  paramId: string;
  code: 'PARAM_REQUIRED' | 'PARAM_TYPE_INVALID' | 'PARAM_OPTION_INVALID' | 'PARAM_UNSUPPORTED';
  message: string;
}

export type RuntimeParamValidationResult =
  | { ok: true; value: Record<string, RuntimeParamValue>; errors: [] }
  | { ok: false; value: Record<string, RuntimeParamValue>; errors: RuntimeParamValidationError[] };

export function deriveRuntimeParamFields(
  params: Record<string, RpaDslParamDefinition>,
): RpaRuntimeParamField[] {
  return Object.entries(params).map(([id, param]) => ({
    id,
    label: param.label ?? id,
    description: param.description,
    type: mapParamTypeToFieldType(param),
    required: param.required === true,
    mask: param.mask === true || param.type === 'secret',
    options: param.options,
    defaultValue: param.default,
  }));
}

export function normalizeRuntimeParams(
  definitions: Record<string, RpaDslParamDefinition>,
  input: Record<string, RuntimeParamValue | undefined>,
): RuntimeParamValidationResult {
  const value: Record<string, RuntimeParamValue> = {};
  const errors: RuntimeParamValidationError[] = [];

  for (const [paramId, definition] of Object.entries(definitions)) {
    const raw = input[paramId] ?? definition.default;
    const normalized = normalizeOneParam(paramId, definition, raw);
    if (normalized.ok) {
      if (normalized.value !== undefined) value[paramId] = normalized.value;
    } else {
      errors.push(normalized.error);
    }
  }

  if (errors.length > 0) return { ok: false, value, errors };
  return { ok: true, value, errors: [] };
}

function normalizeOneParam(
  paramId: string,
  definition: RpaDslParamDefinition,
  raw: RuntimeParamValue | undefined,
):
  | { ok: true; value: RuntimeParamValue | undefined }
  | { ok: false; error: RuntimeParamValidationError } {
  if (raw === undefined || raw === null || raw === '') {
    if (definition.required === true) {
      return {
        ok: false,
        error: {
          paramId,
          code: 'PARAM_REQUIRED',
          message: `${definition.label ?? paramId} is required.`,
        },
      };
    }
    return { ok: true, value: raw === null ? null : undefined };
  }

  if (definition.type === 'string' || definition.type === 'secret' || definition.type === 'date') {
    if (typeof raw !== 'string') return invalidType(paramId, definition);
    return { ok: true, value: raw };
  }

  if (definition.type === 'number') {
    if (typeof raw === 'number' && Number.isFinite(raw)) return { ok: true, value: raw };
    if (typeof raw === 'string' && raw.trim().length > 0 && Number.isFinite(Number(raw))) {
      return { ok: true, value: Number(raw) };
    }
    return invalidType(paramId, definition);
  }

  if (definition.type === 'boolean') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    if (raw === 'true') return { ok: true, value: true };
    if (raw === 'false') return { ok: true, value: false };
    return invalidType(paramId, definition);
  }

  if (definition.type === 'select') {
    if (typeof raw !== 'string') return invalidType(paramId, definition);
    const allowed = new Set((definition.options ?? []).map((option) => option.value));
    if (!allowed.has(raw)) {
      return {
        ok: false,
        error: {
          paramId,
          code: 'PARAM_OPTION_INVALID',
          message: `${definition.label ?? paramId} must be one of the configured options.`,
        },
      };
    }
    return { ok: true, value: raw };
  }

  return {
    ok: false,
    error: {
      paramId,
      code: 'PARAM_UNSUPPORTED',
      message: `${definition.label ?? paramId} uses an unsupported parameter type.`,
    },
  };
}

function invalidType(paramId: string, definition: RpaDslParamDefinition) {
  return {
    ok: false as const,
    error: {
      paramId,
      code: 'PARAM_TYPE_INVALID' as const,
      message: `${definition.label ?? paramId} must be a ${definition.type} value.`,
    },
  };
}

function mapParamTypeToFieldType(param: RpaDslParamDefinition): RpaRuntimeParamField['type'] {
  if (param.type === 'number') return 'number';
  if (param.type === 'date') return 'date';
  if (param.type === 'boolean') return 'checkbox';
  if (param.type === 'select') return 'select';
  if (param.type === 'secret') return 'password';
  return 'text';
}
```

- [ ] **Step 4: Re-export shared param model through API types**

Modify `apps/rpa-local-web/src/shared/rpa-api-types.ts`:

```ts
import type { RpaDslDocument } from './dsl-schema.js';
import type { RpaRuntimeParamField } from './runtime-params.js';

export type { RuntimeParamValue, RpaRuntimeParamField } from './runtime-params.js';
```

Extend `RpaFlowDetailResponse`:

```ts
export interface RpaFlowRuntimeParamsResponse {
  fields: RpaRuntimeParamField[];
  requiresUserInput: boolean;
  maskedParamIds: string[];
}

export interface RpaFlowProvenanceResponse {
  source: 'generated' | 'imported';
  requiresVerifyBeforeRun: boolean;
  importedAt?: string;
  originalFlowId?: string;
  packageCreatedAt?: string;
  packageSha256?: string;
  verifiedAt?: string;
  verifiedExecutionId?: string;
}

export interface RpaFlowDetailResponse {
  flowId: string;
  title: string;
  source: RpaDslDocument['meta']['source'];
  dsl: RpaDslDocument;
  warnings: RpaValidationIssueSummary[];
  runtimeParams: RpaFlowRuntimeParamsResponse;
  provenance: RpaFlowProvenanceResponse;
}
```

- [ ] **Step 5: Keep server validator deriving from shared helper**

Modify `apps/rpa-local-web/src/server/validators/dsl-validator.ts`:

```ts
import {
  deriveRuntimeParamFields,
  type RpaRuntimeParamField,
} from '../../shared/runtime-params.js';

export type ParameterFormField = RpaRuntimeParamField;

export function deriveParameterFormModel(dsl: RpaDslDocument): ParameterFormField[] {
  return deriveRuntimeParamFields(dsl.params);
}
```

Remove the old local `mapParamTypeToFormType` helper from this file.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/shared/runtime-params.test.ts tests/server/validators/dsl-validator.test.ts
```

Expected: PASS.

---

## Task 2: Flow Local Metadata And Package Manifest Schema

**Files:**
- Modify: `apps/rpa-local-web/src/shared/artifacts.ts`
- Modify: `apps/rpa-local-web/src/server/flow-store.ts`
- Modify: `apps/rpa-local-web/src/server/workflows/generation-artifact-service.ts`
- Modify: `apps/rpa-local-web/src/server/workflows/codegen-hardening-workflow.ts`
- Modify: `apps/rpa-local-web/src/server/workflows/natural-language-generation-workflow.ts`
- Create: `apps/rpa-local-web/src/server/packages/manifest-schema.ts`
- Test: `apps/rpa-local-web/tests/server/flow-store.test.ts`
- Test: `apps/rpa-local-web/tests/server/packages/manifest-schema.test.ts`
- Existing workflow tests for codegen/NL.

- [ ] **Step 1: Add failing flow metadata and manifest parser tests**

Extend `apps/rpa-local-web/tests/server/flow-store.test.ts` with:

```ts
import {
  FLOW_LOCAL_METADATA_FILE,
  readFlowLocalMetadata,
  writeFlowLocalMetadata,
} from '../../src/server/flow-store.js';

it('writes and reads browser-safe local flow metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpa-flow-local-metadata-'));
  const flowDir = path.join(root, 'case_query');

  await writeFlowLocalMetadata(flowDir, {
    schemaVersion: 'rpa-flow-local.v0.1',
    flowId: 'case_query',
    source: 'imported',
    createdAt: '2026-06-06T00:00:00.000Z',
    requiresVerifyBeforeRun: true,
    imported: {
      originalFlowId: 'case_query',
      packageCreatedAt: '2026-06-05T00:00:00.000Z',
      packageSha256: 'sha256:abc',
      packageFileName: 'case_query.rpa.zip',
    },
  });

  expect(await readFlowLocalMetadata(flowDir, 'case_query')).toMatchObject({
    flowId: 'case_query',
    source: 'imported',
    requiresVerifyBeforeRun: true,
    imported: { packageFileName: 'case_query.rpa.zip' },
  });
  expect(await readFile(path.join(flowDir, FLOW_LOCAL_METADATA_FILE), 'utf8')).toContain('rpa-flow-local.v0.1');
});

it('returns generated fallback metadata for old generated flows', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpa-flow-local-metadata-fallback-'));
  const flowDir = path.join(root, 'case_query');

  await mkdir(flowDir, { recursive: true });

  expect(await readFlowLocalMetadata(flowDir, 'case_query')).toMatchObject({
    schemaVersion: 'rpa-flow-local.v0.1',
    flowId: 'case_query',
    source: 'generated',
    requiresVerifyBeforeRun: false,
  });
});
```

Create `apps/rpa-local-web/tests/server/packages/manifest-schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMinimalRpaDsl } from '../../../src/shared/dsl-schema.js';
import {
  parseRpaPackageManifest,
} from '../../../src/server/packages/manifest-schema.js';
import { buildRpaPackageManifest } from '../../../src/server/flow-store.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { requiredGenerationArtifactNames } from '../../../src/shared/artifacts.js';

async function validManifest() {
  const flowDir = await mkdtemp(path.join(os.tmpdir(), 'rpa-manifest-schema-'));
  for (const name of requiredGenerationArtifactNames) {
    await writeFile(path.join(flowDir, name), `${name}\n`);
  }
  return buildRpaPackageManifest({
    flowDir,
    dsl: createMinimalRpaDsl(),
    generator: { mode: 'codegen', skillId: 'playwright-rpa-harden', daemonRunId: 'run_1' },
  });
}

describe('RPA package manifest schema', () => {
  it('accepts the MVP manifest shape', async () => {
    await expect(parseRpaPackageManifest(await validManifest())).resolves.toMatchObject({
      schemaVersion: 'rpa-package.v0.1',
      flowId: 'case_query',
      artifacts: { dsl: 'flow.dsl.json', script: 'flow.hardened.py' },
    });
  });

  it('rejects unsupported schema versions and unsafe artifact names', async () => {
    const manifest = await validManifest();
    await expect(parseRpaPackageManifest({ ...manifest, schemaVersion: 'bad' })).rejects.toThrow(/PACKAGE_SCHEMA_UNSUPPORTED/);
    await expect(parseRpaPackageManifest({
      ...manifest,
      artifacts: { ...manifest.artifacts, script: '../flow.hardened.py' },
    })).rejects.toThrow(/PACKAGE_MANIFEST_INVALID/);
  });
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/flow-store.test.ts tests/server/packages/manifest-schema.test.ts
```

Expected: FAIL because metadata helpers and manifest parser do not exist.

- [ ] **Step 3: Add flow local metadata types**

Modify `apps/rpa-local-web/src/shared/artifacts.ts`:

```ts
export const RPA_FLOW_LOCAL_METADATA_SCHEMA_VERSION = 'rpa-flow-local.v0.1' as const;

export interface RpaFlowLocalMetadata {
  schemaVersion: typeof RPA_FLOW_LOCAL_METADATA_SCHEMA_VERSION;
  flowId: string;
  source: 'generated' | 'imported';
  createdAt: string;
  generator?: RpaPackageManifest['generator'];
  requiresVerifyBeforeRun: boolean;
  imported?: {
    originalFlowId: string;
    packageCreatedAt?: string;
    packageSha256: `sha256:${string}`;
    packageFileName?: string;
  };
  verified?: {
    executionId: string;
    verifiedAt: string;
  };
}
```

- [ ] **Step 4: Add metadata helpers to flow store**

Modify `apps/rpa-local-web/src/server/flow-store.ts`:

```ts
import {
  RPA_FLOW_LOCAL_METADATA_SCHEMA_VERSION,
  type RpaFlowLocalMetadata,
} from '../shared/artifacts.js';

export const FLOW_LOCAL_METADATA_FILE = 'flow.local.json' as const;

export function resolveFlowDir(storageRoot: string, flowId: string): string {
  const flowsRoot = resolveFlowsRoot(storageRoot);
  const safeId = safeFlowId(flowId);
  const resolved = path.resolve(flowsRoot, safeId);
  if (!resolved.startsWith(`${flowsRoot}${path.sep}`)) {
    throw new Error(`Unsafe flow path: ${flowId}`);
  }
  return resolved;
}

export async function readFlowLocalMetadata(
  flowDir: string,
  flowId: string,
): Promise<RpaFlowLocalMetadata> {
  try {
    const parsed = JSON.parse(await readFile(path.join(flowDir, FLOW_LOCAL_METADATA_FILE), 'utf8')) as RpaFlowLocalMetadata;
    if (parsed.schemaVersion !== RPA_FLOW_LOCAL_METADATA_SCHEMA_VERSION || parsed.flowId !== flowId) {
      throw new Error('Invalid flow local metadata.');
    }
    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {
        schemaVersion: RPA_FLOW_LOCAL_METADATA_SCHEMA_VERSION,
        flowId,
        source: 'generated',
        createdAt: new Date(0).toISOString(),
        requiresVerifyBeforeRun: false,
      };
    }
    throw error;
  }
}

export async function writeFlowLocalMetadata(
  flowDir: string,
  metadata: RpaFlowLocalMetadata,
): Promise<void> {
  await writeJsonFile(path.join(flowDir, FLOW_LOCAL_METADATA_FILE), metadata);
}

export async function markFlowVerified(input: {
  storageRoot: string;
  flowId: string;
  executionId: string;
  verifiedAt?: string;
}): Promise<RpaFlowLocalMetadata> {
  const flowDir = resolveFlowDir(input.storageRoot, input.flowId);
  const current = await readFlowLocalMetadata(flowDir, input.flowId);
  const updated: RpaFlowLocalMetadata = {
    ...current,
    requiresVerifyBeforeRun: false,
    verified: {
      executionId: input.executionId,
      verifiedAt: input.verifiedAt ?? new Date().toISOString(),
    },
  };
  await writeFlowLocalMetadata(flowDir, updated);
  return updated;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
```

If `isNodeError` already exists in `flow-store.ts`, keep a single copy.

- [ ] **Step 5: Write generated-flow metadata when artifacts are promoted**

Modify `apps/rpa-local-web/src/server/workflows/generation-artifact-service.ts` input:

```ts
import type { RpaPackageManifest } from '../../shared/artifacts.js';
import {
  RPA_FLOW_LOCAL_METADATA_SCHEMA_VERSION,
} from '../../shared/artifacts.js';
import { writeFlowLocalMetadata } from '../flow-store.js';

export interface PersistRequiredGenerationArtifactsInput {
  daemonClient: GenerationArtifactDaemonClient;
  storageRoot: string;
  flowId: string;
  runId: string;
  tempSuffix: string;
  generator: RpaPackageManifest['generator'];
}
```

After `replaceFinalFlowDir(tempFlowDir, finalFlowDir);` write:

```ts
await writeFlowLocalMetadata(finalFlowDir, {
  schemaVersion: RPA_FLOW_LOCAL_METADATA_SCHEMA_VERSION,
  flowId: input.flowId,
  source: 'generated',
  createdAt: new Date().toISOString(),
  generator: input.generator,
  requiresVerifyBeforeRun: false,
});
```

Update callers:

```ts
generator: {
  mode: 'codegen',
  skillId: 'playwright-rpa-harden',
  daemonRunId: run.runId,
}
```

and:

```ts
generator: {
  mode: 'nl',
  skillId: 'rpa-script-generate',
  daemonRunId: run.runId,
}
```

- [ ] **Step 6: Implement manifest parser**

Create `apps/rpa-local-web/src/server/packages/manifest-schema.ts`:

```ts
import {
  RPA_PACKAGE_SCHEMA_VERSION,
  requiredGenerationArtifactNames,
  requiredArtifactRoleByName,
  type RpaPackageManifest,
} from '../../shared/artifacts.js';
import { RPA_DSL_VERSION } from '../../shared/dsl-schema.js';
import { safeFlowId } from '../flow-store.js';

export class RpaPackageManifestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RpaPackageManifestError';
    this.code = code;
  }
}

export async function parseRpaPackageManifest(input: unknown): Promise<RpaPackageManifest> {
  if (!isRecord(input)) throw invalid('Manifest must be an object.');
  if (input.schemaVersion !== RPA_PACKAGE_SCHEMA_VERSION) {
    throw new RpaPackageManifestError('PACKAGE_SCHEMA_UNSUPPORTED', `Expected ${RPA_PACKAGE_SCHEMA_VERSION}.`);
  }
  if (typeof input.flowId !== 'string') throw invalid('flowId is required.');
  safeFlowId(input.flowId);
  if (typeof input.name !== 'string' || input.name.trim().length === 0) throw invalid('name is required.');
  if (typeof input.createdAt !== 'string') throw invalid('createdAt is required.');
  if (!isRecord(input.generator)) throw invalid('generator is required.');
  if (input.generator.mode !== 'codegen' && input.generator.mode !== 'nl' && input.generator.mode !== 'imported') {
    throw invalid('generator.mode is invalid.');
  }
  if (!isRecord(input.dsl) || input.dsl.version !== RPA_DSL_VERSION || input.dsl.path !== 'flow.dsl.json') {
    throw invalid('dsl descriptor is invalid.');
  }
  if (!isRecord(input.artifacts)) throw invalid('artifacts is required.');
  for (const [name, role] of Object.entries(requiredArtifactRoleByName)) {
    if (input.artifacts[role] !== name) {
      throw invalid(`artifact mapping for ${role} must be ${name}.`);
    }
  }
  if (!isRecord(input.checksums)) throw invalid('checksums is required.');
  for (const artifactName of requiredGenerationArtifactNames) {
    const checksum = input.checksums[artifactName];
    if (typeof checksum !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(checksum)) {
      throw invalid(`checksum is invalid for ${artifactName}.`);
    }
  }
  if (!isRecord(input.params) || input.params.schemaPath !== 'flow.dsl.json#/params') {
    throw invalid('params descriptor is invalid.');
  }
  if (!isRecord(input.requirements) || input.requirements.runtime !== 'python-playwright') {
    throw invalid('requirements descriptor is invalid.');
  }
  return input as RpaPackageManifest;
}

function invalid(message: string): RpaPackageManifestError {
  return new RpaPackageManifestError('PACKAGE_MANIFEST_INVALID', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/flow-store.test.ts tests/server/packages/manifest-schema.test.ts tests/server/workflows/generation-artifact-service.test.ts tests/server/codegen-hardening-workflow.test.ts tests/server/natural-language-generation-workflow.test.ts
```

Expected: PASS.

---

## Task 3: Package ZIP Export And Import Service

**Files:**
- Create: `apps/rpa-local-web/src/server/zip/uncompressed-zip.ts`
- Modify: `apps/rpa-local-web/src/server/observability/review-zip.ts`
- Modify: `apps/rpa-local-web/src/server/observability/rpa-review-bundle-service.ts`
- Create: `apps/rpa-local-web/src/server/packages/rpa-package.ts`
- Test: `apps/rpa-local-web/tests/server/observability/review-zip.test.ts`
- Test: `apps/rpa-local-web/tests/server/packages/rpa-package.test.ts`

- [ ] **Step 1: Move ZIP helper to neutral server utility**

Create `apps/rpa-local-web/src/server/zip/uncompressed-zip.ts` by moving the implementation currently in `apps/rpa-local-web/src/server/observability/review-zip.ts`.

Replace `apps/rpa-local-web/src/server/observability/review-zip.ts` with:

```ts
export {
  appendZipEntries,
  createUncompressedZip,
  listZipEntryNames,
  readUncompressedZipEntries,
  type ReviewZipEntry,
} from '../zip/uncompressed-zip.js';
```

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/observability/review-zip.test.ts tests/server/observability/rpa-review-bundle-service.test.ts
```

Expected: PASS, proving observability ZIP behavior did not change.

- [ ] **Step 2: Write failing package service tests**

Create `apps/rpa-local-web/tests/server/packages/rpa-package.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMinimalRpaDsl } from '../../../src/shared/dsl-schema.js';
import { requiredGenerationArtifactNames } from '../../../src/shared/artifacts.js';
import { readUncompressedZipEntries } from '../../../src/server/zip/uncompressed-zip.js';
import {
  exportRpaPackage,
  importRpaPackage,
} from '../../../src/server/packages/rpa-package.js';
import { readFlowLocalMetadata, writeFlowLocalMetadata } from '../../../src/server/flow-store.js';

async function createGeneratedFlow(storageRoot: string) {
  const flowDir = path.join(storageRoot, 'flows', 'case_query');
  await mkdir(flowDir, { recursive: true });
  for (const name of requiredGenerationArtifactNames) {
    if (name === 'flow.dsl.json') {
      await writeFile(path.join(flowDir, name), `${JSON.stringify(createMinimalRpaDsl(), null, 2)}\n`);
    } else {
      await writeFile(path.join(flowDir, name), `${name}\n`);
    }
  }
  await writeFlowLocalMetadata(flowDir, {
    schemaVersion: 'rpa-flow-local.v0.1',
    flowId: 'case_query',
    source: 'generated',
    createdAt: '2026-06-06T00:00:00.000Z',
    generator: { mode: 'codegen', skillId: 'playwright-rpa-harden', daemonRunId: 'run_1' },
    requiresVerifyBeforeRun: false,
  });
}

describe('RPA package service', () => {
  it('exports only allowlisted package files with a valid manifest', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-export-package-'));
    await createGeneratedFlow(storageRoot);
    await writeFile(path.join(storageRoot, 'flows', 'case_query', 'storage_state.json'), 'secret');
    await writeFile(path.join(storageRoot, 'flows', 'case_query', 'trace.zip'), 'trace');

    const exported = await exportRpaPackage({ storageRoot, flowId: 'case_query' });
    const entries = readUncompressedZipEntries(exported.content);
    const names = entries.map((entry) => entry.path).sort();

    expect(exported.fileName).toBe('case_query.rpa.zip');
    expect(names).toEqual([
      'config.example.json',
      'flow.dsl.json',
      'flow.hardened.py',
      'hardening-report.md',
      'manifest.json',
      'parameterization-report.md',
    ]);
    expect(Buffer.concat(entries.map((entry) => entry.content)).toString('utf8')).not.toContain('secret');
  });

  it('imports a package into an empty flow directory and marks it verify-required', async () => {
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-import-source-'));
    await createGeneratedFlow(sourceRoot);
    const exported = await exportRpaPackage({ storageRoot: sourceRoot, flowId: 'case_query' });

    const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-import-target-'));
    const imported = await importRpaPackage({
      storageRoot: targetRoot,
      packageFileName: 'case_query.rpa.zip',
      content: exported.content,
    });

    expect(imported).toMatchObject({
      flowId: 'case_query',
      title: '案件查询',
      requiresVerifyBeforeRun: true,
      source: 'imported',
    });
    expect(await readFile(path.join(targetRoot, 'flows', 'case_query', 'flow.dsl.json'), 'utf8')).toContain('case_query');
    expect(await readFlowLocalMetadata(path.join(targetRoot, 'flows', 'case_query'), 'case_query')).toMatchObject({
      source: 'imported',
      requiresVerifyBeforeRun: true,
      imported: { originalFlowId: 'case_query', packageFileName: 'case_query.rpa.zip' },
    });
  });

  it('rejects duplicate flow ids and sensitive package entries', async () => {
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-import-duplicate-source-'));
    await createGeneratedFlow(sourceRoot);
    const exported = await exportRpaPackage({ storageRoot: sourceRoot, flowId: 'case_query' });

    const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-import-duplicate-target-'));
    await createGeneratedFlow(targetRoot);

    await expect(importRpaPackage({
      storageRoot: targetRoot,
      packageFileName: 'case_query.rpa.zip',
      content: exported.content,
    })).rejects.toThrow(/FLOW_ALREADY_EXISTS/);
  });
});
```

- [ ] **Step 3: Run failing tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/packages/rpa-package.test.ts
```

Expected: FAIL because `rpa-package.ts` does not exist.

- [ ] **Step 4: Implement package service**

Create `apps/rpa-local-web/src/server/packages/rpa-package.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  RPA_FLOW_LOCAL_METADATA_SCHEMA_VERSION,
  requiredGenerationArtifactNames,
  type RpaPackageManifest,
} from '../../shared/artifacts.js';
import type { RpaDslDocument } from '../../shared/dsl-schema.js';
import { createUncompressedZip, readUncompressedZipEntries, type ReviewZipEntry } from '../zip/uncompressed-zip.js';
import {
  buildRpaPackageManifest,
  readFlowLocalMetadata,
  resolveFlowDir,
  resolveFlowsRoot,
  safeFlowId,
  writeFlowLocalMetadata,
} from '../flow-store.js';
import { validateRpaDsl } from '../validators/dsl-validator.js';
import { parseRpaPackageManifest } from './manifest-schema.js';

export class RpaPackageError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'RpaPackageError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ExportRpaPackageResult {
  fileName: string;
  content: Buffer;
  mimeType: 'application/zip';
}

export interface ImportRpaPackageResult {
  flowId: string;
  title: string;
  source: 'imported';
  requiresVerifyBeforeRun: true;
  importedAt: string;
  packageSha256: `sha256:${string}`;
  ignoredEntries: string[];
}

export async function exportRpaPackage(input: {
  storageRoot: string;
  flowId: string;
}): Promise<ExportRpaPackageResult> {
  const flowId = safeFlowId(input.flowId);
  const flowDir = resolveFlowDir(input.storageRoot, flowId);
  const dsl = await readDsl(path.join(flowDir, 'flow.dsl.json'));
  const validation = validateRpaDsl(dsl);
  if (!validation.ok) {
    throw new RpaPackageError('DSL_INVALID', `DSL validation failed: ${validation.errors.map((issue) => issue.code).join(', ')}.`);
  }
  const metadata = await readFlowLocalMetadata(flowDir, flowId);
  const manifest = await buildRpaPackageManifest({
    flowDir,
    dsl: dsl as RpaDslDocument,
    generator: metadata.generator ?? {
      mode: dsl.meta.source === 'nl' ? 'nl' : 'codegen',
      skillId: dsl.meta.source === 'nl' ? 'rpa-script-generate' : 'playwright-rpa-harden',
    },
  });

  const entries: ReviewZipEntry[] = [
    { path: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
  ];
  for (const name of requiredGenerationArtifactNames) {
    entries.push({ path: name, content: await readFile(path.join(flowDir, name)) });
  }

  return {
    fileName: `${flowId}.rpa.zip`,
    content: createUncompressedZip(entries),
    mimeType: 'application/zip',
  };
}

export async function importRpaPackage(input: {
  storageRoot: string;
  packageFileName?: string;
  content: Buffer;
}): Promise<ImportRpaPackageResult> {
  const packageSha256 = `sha256:${sha256(input.content)}` as const;
  const entries = readUncompressedZipEntries(input.content);
  const byPath = new Map(entries.map((entry) => [entry.path, entry.content]));
  const manifestContent = byPath.get('manifest.json');
  if (!manifestContent) throw new RpaPackageError('PACKAGE_MANIFEST_MISSING', 'Package manifest.json is missing.');

  rejectSensitiveEntries(entries.map((entry) => entry.path));
  const manifest = await parseRpaPackageManifest(JSON.parse(manifestContent.toString('utf8')) as unknown);
  const flowId = safeFlowId(manifest.flowId);
  const flowDir = resolveFlowDir(input.storageRoot, flowId);
  await assertFlowDirAvailable(flowDir);

  for (const name of requiredGenerationArtifactNames) {
    const content = byPath.get(name);
    if (!content) throw new RpaPackageError('PACKAGE_ARTIFACT_MISSING', `Package artifact missing: ${name}.`);
    const actual = `sha256:${sha256(content)}`;
    if (actual !== manifest.checksums[name]) {
      throw new RpaPackageError('PACKAGE_CHECKSUM_MISMATCH', `Package checksum mismatch: ${name}.`);
    }
  }

  const dsl = JSON.parse(byPath.get('flow.dsl.json')!.toString('utf8')) as unknown;
  const validation = validateRpaDsl(dsl);
  if (!validation.ok) {
    throw new RpaPackageError('DSL_INVALID', `DSL validation failed: ${validation.errors.map((issue) => issue.code).join(', ')}.`);
  }
  if ((dsl as RpaDslDocument).flow_id !== manifest.flowId) {
    throw new RpaPackageError('PACKAGE_FLOW_ID_MISMATCH', 'Package manifest flowId does not match flow.dsl.json.');
  }

  const tempFlowDir = `${flowDir}.import-${Date.now()}`;
  await rm(tempFlowDir, { recursive: true, force: true });
  await mkdir(tempFlowDir, { recursive: true });
  let promoted = false;
  try {
    for (const name of requiredGenerationArtifactNames) {
      await writeFile(path.join(tempFlowDir, name), byPath.get(name)!);
    }
    const importedAt = new Date().toISOString();
    await writeFlowLocalMetadata(tempFlowDir, {
      schemaVersion: RPA_FLOW_LOCAL_METADATA_SCHEMA_VERSION,
      flowId,
      source: 'imported',
      createdAt: importedAt,
      generator: { mode: 'imported' },
      requiresVerifyBeforeRun: true,
      imported: {
        originalFlowId: manifest.flowId,
        packageCreatedAt: manifest.createdAt,
        packageSha256,
        packageFileName: input.packageFileName,
      },
    });
    await rename(tempFlowDir, flowDir);
    promoted = true;
    return {
      flowId,
      title: (dsl as RpaDslDocument).meta.title,
      source: 'imported',
      requiresVerifyBeforeRun: true,
      importedAt,
      packageSha256,
      ignoredEntries: entries
        .map((entry) => entry.path)
        .filter((entryPath) => entryPath !== 'manifest.json' && !requiredGenerationArtifactNames.includes(entryPath as never)),
    };
  } finally {
    if (!promoted) await rm(tempFlowDir, { recursive: true, force: true });
  }
}

async function readDsl(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch {
    throw new RpaPackageError('DSL_READ_FAILED', 'Failed to read flow.dsl.json.');
  }
}

async function assertFlowDirAvailable(flowDir: string): Promise<void> {
  try {
    const entries = await readdir(flowDir);
    if (entries.length > 0) {
      throw new RpaPackageError('FLOW_ALREADY_EXISTS', 'A flow with this flowId already exists.', 409);
    }
  } catch (error) {
    if (error instanceof RpaPackageError) throw error;
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
}

function rejectSensitiveEntries(paths: string[]): void {
  const sensitivePattern = /(^|\/)(storage_state|cookies?|tokens?|passwords?|secret|ca_|usbkey|trace|video|downloads?)(\.|\/|$)|\.(env|pem|key|pfx|p12|crt|cer)$/i;
  for (const entryPath of paths) {
    if (sensitivePattern.test(entryPath)) {
      throw new RpaPackageError('SENSITIVE_PACKAGE_ENTRY', `Package contains a sensitive entry: ${entryPath}.`);
    }
  }
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
```

Remove unused imports during implementation if TypeScript reports them.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/packages/rpa-package.test.ts tests/server/observability/review-zip.test.ts tests/server/observability/rpa-review-bundle-service.test.ts
```

Expected: PASS.

---

## Task 4: Package Routes And Browser API Client

**Files:**
- Create: `apps/rpa-local-web/src/server/routes/packages.ts`
- Modify: `apps/rpa-local-web/src/server/server.ts`
- Modify: `apps/rpa-local-web/src/shared/rpa-api-types.ts`
- Modify: `apps/rpa-local-web/src/api/rpa-api-client.ts`
- Test: `apps/rpa-local-web/tests/server/routes/packages.test.ts`
- Test: `apps/rpa-local-web/tests/server/server.test.ts`
- Test: `apps/rpa-local-web/tests/api/rpa-api-client.test.ts`

- [ ] **Step 1: Add shared import response types**

Modify `apps/rpa-local-web/src/shared/rpa-api-types.ts`:

```ts
export interface ImportRpaPackageResponse {
  flowId: string;
  title: string;
  source: 'imported';
  requiresVerifyBeforeRun: true;
  importedAt: string;
  packageSha256: string;
  ignoredEntries: string[];
}
```

- [ ] **Step 2: Write failing route tests**

Create `apps/rpa-local-web/tests/server/routes/packages.test.ts`:

```ts
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requiredGenerationArtifactNames } from '../../../src/shared/artifacts.js';
import { createMinimalRpaDsl } from '../../../src/shared/dsl-schema.js';
import { createRpaLocalServer } from '../../../src/server/server.js';

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function createFlow(storageRoot: string) {
  const flowDir = path.join(storageRoot, 'flows', 'case_query');
  await mkdir(flowDir, { recursive: true });
  for (const name of requiredGenerationArtifactNames) {
    if (name === 'flow.dsl.json') {
      await writeFile(path.join(flowDir, name), `${JSON.stringify(createMinimalRpaDsl(), null, 2)}\n`);
    } else {
      await writeFile(path.join(flowDir, name), `${name}\n`);
    }
  }
}

async function withServer(storageRoot: string, callback: (baseUrl: string) => Promise<void>) {
  const app = await createRpaLocalServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      daemonBaseUrl: 'http://daemon.local',
      daemonApiKey: 'secret',
      defaultProfileId: 'rpa-local',
      storageRoot,
      codegenCommand: 'playwright',
      codegenArgs: ['codegen'],
      mode: 'test',
    },
    daemonFetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  });
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  await callback(`http://127.0.0.1:${port}`);
}

describe('RPA package routes', () => {
  it('downloads and imports a .rpa.zip package without storage root leaks', async () => {
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-package-route-source-'));
    await createFlow(sourceRoot);
    let zip: Buffer;

    await withServer(sourceRoot, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/rpa/flows/case_query/package/download`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/zip');
      expect(response.headers.get('content-disposition')).toContain('case_query.rpa.zip');
      zip = Buffer.from(await response.arrayBuffer());
      expect(zip.toString('utf8')).not.toContain(sourceRoot);
    });

    const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-package-route-target-'));
    await withServer(targetRoot, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/rpa/flows/import-package`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/zip',
          'X-RPA-Package-File-Name': 'case_query.rpa.zip',
        },
        body: zip!,
      });
      expect(response.status).toBe(201);
      const payload = await response.json();
      expect(payload).toMatchObject({
        flowId: 'case_query',
        source: 'imported',
        requiresVerifyBeforeRun: true,
      });
      expect(JSON.stringify(payload)).not.toContain(targetRoot);
    });
  });
});
```

- [ ] **Step 3: Run failing route tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/routes/packages.test.ts
```

Expected: FAIL because package routes are not registered.

- [ ] **Step 4: Implement package routes**

Create `apps/rpa-local-web/src/server/routes/packages.ts`:

```ts
import express, { type Express, type Response } from 'express';
import { exportRpaPackage, importRpaPackage, RpaPackageError } from '../packages/rpa-package.js';

export interface RegisterPackageRoutesOptions {
  storageRoot: string;
}

export function registerPackageRoutes(app: Express, options: RegisterPackageRoutesOptions): void {
  app.get('/api/rpa/flows/:flowId/package/download', async (req, res) => {
    try {
      const result = await exportRpaPackage({
        storageRoot: options.storageRoot,
        flowId: String(req.params.flowId ?? ''),
      });
      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
      res.status(200).send(result.content);
    } catch (error) {
      sendError(res, error, options.storageRoot);
    }
  });

  app.post(
    '/api/rpa/flows/import-package',
    expressRawZipBody(),
    async (req, res) => {
      try {
        if (!Buffer.isBuffer(req.body) || req.body.byteLength === 0) {
          throw new RpaPackageError('PACKAGE_BODY_REQUIRED', 'Package body must be zip bytes.');
        }
        const result = await importRpaPackage({
          storageRoot: options.storageRoot,
          packageFileName: readPackageFileName(req.headers['x-rpa-package-file-name']),
          content: req.body,
        });
        res.status(201).json(result);
      } catch (error) {
        sendError(res, error, options.storageRoot);
      }
    },
  );
}

function expressRawZipBody() {
  return express.raw({
    type: ['application/zip', 'application/octet-stream', 'application/x-rpa-package'],
    limit: '20mb',
  });
}

function readPackageFileName(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

function sendError(res: Response, error: unknown, storageRoot: string): void {
  const status = error instanceof RpaPackageError ? error.statusCode : 500;
  const code = error instanceof RpaPackageError ? error.code : 'INTERNAL_ERROR';
  const rawMessage = error instanceof Error ? error.message : 'Internal server error.';
  const message = rawMessage.split(storageRoot).join('[rpa-storage]');
  res.status(status).json({ error: { code, message } });
}
```

- [ ] **Step 5: Register package routes**

Modify `apps/rpa-local-web/src/server/server.ts`:

```ts
import { registerPackageRoutes } from './routes/packages.js';
```

Register before Vite/static serving:

```ts
registerPackageRoutes(app, { storageRoot: input.config.storageRoot });
```

- [ ] **Step 6: Add browser API client methods**

Modify `apps/rpa-local-web/src/api/rpa-api-client.ts`:

```ts
import type { ImportRpaPackageResponse } from '../shared/rpa-api-types.js';

getPackageDownloadUrl(flowId: string): string {
  return `/api/rpa/flows/${encodeURIComponent(flowId)}/package/download`;
}

async importPackage(file: File): Promise<ImportRpaPackageResponse> {
  return this.requestJson('/api/rpa/flows/import-package', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/zip',
      'X-RPA-Package-File-Name': file.name,
    },
    body: await file.arrayBuffer(),
  });
}
```

- [ ] **Step 7: Add API client tests**

Extend `apps/rpa-local-web/tests/api/rpa-api-client.test.ts`:

```ts
it('builds package download URLs and imports package bytes', async () => {
  const file = new File([new Uint8Array([1, 2, 3])], 'case_query.rpa.zip', { type: 'application/zip' });
  const fetchImpl = vi.fn(async () => jsonResponse({
    flowId: 'case_query',
    title: '案件查询',
    source: 'imported',
    requiresVerifyBeforeRun: true,
    importedAt: '2026-06-06T00:00:00.000Z',
    packageSha256: 'sha256:abc',
    ignoredEntries: [],
  }));
  const client = new RpaApiClient({ fetchImpl });

  expect(client.getPackageDownloadUrl('case_query')).toBe('/api/rpa/flows/case_query/package/download');
  await expect(client.importPackage(file)).resolves.toMatchObject({ flowId: 'case_query' });
  expect(fetchImpl).toHaveBeenCalledWith(
    '/api/rpa/flows/import-package',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'Content-Type': 'application/zip',
        'X-RPA-Package-File-Name': 'case_query.rpa.zip',
      }),
    }),
  );
});
```

- [ ] **Step 8: Run focused route/client tests**

Run route tests with sandbox escalation if local port binding is blocked:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/routes/packages.test.ts tests/server/server.test.ts tests/api/rpa-api-client.test.ts
```

Expected: PASS.

---

## Task 5: Flow Detail Runtime Params And Provenance

**Files:**
- Modify: `apps/rpa-local-web/src/server/routes/flows.ts`
- Test: `apps/rpa-local-web/tests/server/routes/flows.test.ts`

- [ ] **Step 1: Add failing route assertion**

Extend `apps/rpa-local-web/tests/server/routes/flows.test.ts` success test:

```ts
expect(payload.runtimeParams).toMatchObject({
  requiresUserInput: true,
  maskedParamIds: ['case_no'],
  fields: [expect.objectContaining({ id: 'case_no', type: 'text', required: true, mask: true })],
});
expect(payload.provenance).toMatchObject({
  source: 'generated',
  requiresVerifyBeforeRun: false,
});
```

Add a second test that writes `flow.local.json` for imported provenance and expects:

```ts
expect(payload.provenance).toMatchObject({
  source: 'imported',
  requiresVerifyBeforeRun: true,
  originalFlowId: 'case_query',
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/routes/flows.test.ts
```

Expected: FAIL because `runtimeParams` and `provenance` are absent.

- [ ] **Step 3: Add runtime params and provenance to route response**

Modify `apps/rpa-local-web/src/server/routes/flows.ts`:

```ts
import { deriveRuntimeParamFields } from '../../shared/runtime-params.js';
import { readFlowLocalMetadata, resolveFlowDir } from '../flow-store.js';
```

Inside the successful handler:

```ts
const flowDir = resolveFlowDir(options.storageRoot, flowId);
const metadata = await readFlowLocalMetadata(flowDir, flowId);
const fields = deriveRuntimeParamFields(safeDsl.params);
const payload: RpaFlowDetailResponse = {
  flowId,
  title: safeDsl.meta.title,
  source: safeDsl.meta.source,
  dsl: safeDsl,
  warnings: validation.warnings.map(summarizeIssue),
  runtimeParams: {
    fields,
    requiresUserInput: fields.some((field) => field.required),
    maskedParamIds: fields.filter((field) => field.mask).map((field) => field.id),
  },
  provenance: {
    source: metadata.source,
    requiresVerifyBeforeRun: metadata.requiresVerifyBeforeRun,
    importedAt: metadata.source === 'imported' ? metadata.createdAt : undefined,
    originalFlowId: metadata.imported?.originalFlowId,
    packageCreatedAt: metadata.imported?.packageCreatedAt,
    packageSha256: metadata.imported?.packageSha256,
    verifiedAt: metadata.verified?.verifiedAt,
    verifiedExecutionId: metadata.verified?.executionId,
  },
};
```

- [ ] **Step 4: Run focused test**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/routes/flows.test.ts
```

Expected: PASS.

---

## Task 6: Executor Param Validation And Imported Verify Gate

**Files:**
- Modify: `apps/rpa-local-web/src/server/executor/python-playwright-executor.ts`
- Modify: `apps/rpa-local-web/src/server/executor/execution-store.ts`
- Test: `apps/rpa-local-web/tests/server/executor/python-playwright-executor.test.ts`
- Test: `apps/rpa-local-web/tests/server/executor/execution-store.test.ts`
- Test: `apps/rpa-local-web/tests/server/routes/executions.test.ts`

- [ ] **Step 1: Add failing executor tests**

Extend `apps/rpa-local-web/tests/server/executor/python-playwright-executor.test.ts`:

```ts
it('rejects missing required runtime params before spawning Python', async () => {
  const { executor, startManagedProcess, storageRoot } = await createExecutorHarness();
  await writeFlow(storageRoot, createMinimalRpaDsl());

  await expect(executor.start({ flowId: 'case_query', mode: 'verify', params: {} })).rejects.toMatchObject({
    code: 'PARAMS_INVALID',
  });
  expect(startManagedProcess).not.toHaveBeenCalled();
});

it('rejects imported production run until a successful local verify is recorded', async () => {
  const { executor, startManagedProcess, storageRoot } = await createExecutorHarness();
  await writeFlow(storageRoot, createMinimalRpaDsl(), {
    source: 'imported',
    requiresVerifyBeforeRun: true,
  });

  await expect(executor.start({
    flowId: 'case_query',
    mode: 'run',
    params: { case_no: 'A123' },
  })).rejects.toMatchObject({ code: 'FLOW_VERIFY_REQUIRED' });
  expect(startManagedProcess).not.toHaveBeenCalled();
});
```

Use the existing test helper style in that file; `writeFlow` should write `flow.local.json` when metadata is supplied.

- [ ] **Step 2: Run failing executor tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/executor/python-playwright-executor.test.ts
```

Expected: FAIL because executor accepts `{}` and does not read flow metadata.

- [ ] **Step 3: Validate params before execution creation**

Modify `apps/rpa-local-web/src/server/executor/python-playwright-executor.ts` imports:

```ts
import { normalizeRuntimeParams } from '../../shared/runtime-params.js';
import {
  markFlowVerified,
  readFlowLocalMetadata,
} from '../flow-store.js';
```

In `start(input)`, replace the existing `const params = input.params ?? {};` line with this block. It must run after `const flow = await loadFlow(...)` and before `store.createExecution(...)`, so invalid params or verify-gate failures do not create execution records and do not spawn Python:

```ts
const paramValidation = normalizeRuntimeParams(flow.dsl.params, input.params ?? {});
if (!paramValidation.ok) {
  throw new RpaExecutorError(
    'PARAMS_INVALID',
    `Runtime params failed validation: ${paramValidation.errors.map((error) => `${error.paramId}:${error.code}`).join(', ')}.`,
  );
}
const metadata = await readFlowLocalMetadata(flow.flowDir, flow.flowId);
if (input.mode === 'run' && metadata.requiresVerifyBeforeRun) {
  throw new RpaExecutorError(
    'FLOW_VERIFY_REQUIRED',
    'Imported flow must complete a successful local verify before production run.',
  );
}
const normalizedParams = paramValidation.value;
```

Change `loadFlow` return type to include `flowDir`:

```ts
): Promise<{ flowId: string; flowDir: string; dsl: RpaDslDocument; scriptPath: string }> {
```

Return:

```ts
flowDir: path.join(flowsRoot, flowId),
```

Pass `normalizedParams` into `store.createExecution` as `params`.

- [ ] **Step 4: Mark verify success in flow metadata**

Add `flowId` to `runExecution` input:

```ts
flowId: string;
```

Pass it from `start`.

In the successful exit branch:

```ts
} else if (result.exitCode === 0) {
  await input.store.finishExecution(input.recordId, { status: 'succeeded', exitCode: result.exitCode });
  if (input.mode === 'verify') {
    await markFlowVerified({
      storageRoot: input.storageRoot,
      flowId: input.flowId,
      executionId: input.recordId,
    }).catch((error) => {
      void input.store.appendLog(
        input.recordId,
        'stderr',
        `FLOW_VERIFY_MARK_FAILED: ${sanitizeStorageRoot(error instanceof Error ? error.message : 'Failed to mark flow verified.', input.storageRoot)}`,
      );
    });
  }
}
```

- [ ] **Step 5: Preserve masked `run.params.json` behavior**

Add an execution-store test:

```ts
it('writes normalized run params and masks summaries', async () => {
  const store = createFileExecutionStore({ storageRoot, idFactory: () => 'exec_params' });
  const record = await store.createExecution({
    flowId: 'case_query',
    mode: 'verify',
    dryRun: true,
    headless: false,
    timeoutMs: 1000,
    params: { case_no: 'A123', amount: 10 },
    maskedParamIds: ['case_no'],
  });

  expect(record.paramsSummary).toEqual({ case_no: '[masked]', amount: 10 });
  expect(JSON.parse(await readFile(path.join(storageRoot, 'executions', 'exec_params', 'run.params.json'), 'utf8'))).toEqual({
    case_no: 'A123',
    amount: 10,
  });
});
```

- [ ] **Step 6: Add route-level validation coverage**

Extend `apps/rpa-local-web/tests/server/routes/executions.test.ts`:

```ts
it('rejects missing required params before spawning a runner', async () => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-routes-param-validation-'));
  await createFlow(storageRoot);
  const runnerPath = await createFakeRunner(storageRoot, 'success');

  await withRpaServer(storageRoot, runnerPath, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/rpa/executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flowId: 'case_query', mode: 'verify', params: {} }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'PARAMS_INVALID' } });
  });
});
```

- [ ] **Step 7: Run focused executor tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/executor/python-playwright-executor.test.ts tests/server/executor/execution-store.test.ts tests/server/routes/executions.test.ts
```

Expected: PASS. Route tests may need sandbox escalation because they bind local ports.

---

## Task 7: Runtime Params Form UI

**Files:**
- Create: `apps/rpa-local-web/src/components/RuntimeParamsForm.tsx`
- Modify: `apps/rpa-local-web/src/components/ExecutionControlBar.tsx`
- Modify: `apps/rpa-local-web/src/components/RuntimeVerificationWorkspace.tsx`
- Modify: `apps/rpa-local-web/src/styles.css`
- Test: `apps/rpa-local-web/tests/components/RuntimeParamsForm.test.tsx`
- Test: `apps/rpa-local-web/tests/components/ExecutionControlBar.test.tsx`
- Test: `apps/rpa-local-web/tests/components/RuntimeVerificationWorkspace.test.tsx`

- [ ] **Step 1: Write failing RuntimeParamsForm tests**

Create `apps/rpa-local-web/tests/components/RuntimeParamsForm.test.tsx`:

```tsx
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeParamsForm } from '../../src/components/RuntimeParamsForm.js';
import type { RpaRuntimeParamField, RuntimeParamValue } from '../../src/shared/runtime-params.js';

afterEach(() => cleanup());

const fields: RpaRuntimeParamField[] = [
  { id: 'case_no', label: 'Case No', type: 'text', required: true, mask: false },
  { id: 'amount', label: 'Amount', type: 'number', required: false, mask: false, defaultValue: 10 },
  { id: 'include_closed', label: 'Include closed', type: 'checkbox', required: false, mask: false },
  {
    id: 'unit',
    label: 'Unit',
    type: 'select',
    required: true,
    mask: false,
    options: [{ label: 'City', value: 'city' }],
  },
  { id: 'password', label: 'Password', type: 'password', required: true, mask: true },
];

describe('RuntimeParamsForm', () => {
  it('renders typed controls and emits scalar values', async () => {
    const onChange = vi.fn();
    const values: Record<string, RuntimeParamValue> = {
      case_no: '',
      amount: 10,
      include_closed: false,
      unit: 'city',
      password: '',
    };

    render(<RuntimeParamsForm fields={fields} values={values} errors={[]} onChange={onChange} />);

    await userEvent.type(screen.getByLabelText('Case No'), 'A123');
    await userEvent.clear(screen.getByLabelText('Amount'));
    await userEvent.type(screen.getByLabelText('Amount'), '25');
    await userEvent.click(screen.getByLabelText('Include closed'));
    await userEvent.type(screen.getByLabelText('Password'), 'secret');

    expect(onChange).toHaveBeenCalledWith('case_no', 'A123');
    expect(onChange).toHaveBeenCalledWith('amount', 25);
    expect(onChange).toHaveBeenCalledWith('include_closed', true);
    expect(onChange).toHaveBeenCalledWith('password', 'secret');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  it('renders validation errors next to the field', () => {
    render(
      <RuntimeParamsForm
        fields={fields}
        values={{}}
        errors={[{ paramId: 'case_no', code: 'PARAM_REQUIRED', message: 'Case No is required.' }]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Case No is required.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run failing form test**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/components/RuntimeParamsForm.test.tsx
```

Expected: FAIL because component does not exist.

- [ ] **Step 3: Implement RuntimeParamsForm**

Create `apps/rpa-local-web/src/components/RuntimeParamsForm.tsx`:

```tsx
import type {
  RpaRuntimeParamField,
  RuntimeParamValidationError,
  RuntimeParamValue,
} from '../shared/runtime-params.js';

export interface RuntimeParamsFormProps {
  fields: RpaRuntimeParamField[];
  values: Record<string, RuntimeParamValue>;
  errors: RuntimeParamValidationError[];
  onChange: (paramId: string, value: RuntimeParamValue) => void;
}

export function RuntimeParamsForm({ fields, values, errors, onChange }: RuntimeParamsFormProps) {
  const errorsByParam = new Map(errors.map((error) => [error.paramId, error]));

  if (fields.length === 0) {
    return (
      <section className="runtime-params-form" aria-label="Runtime params">
        <h3>Runtime params</h3>
        <p className="runtime-params-form__empty">No runtime params required.</p>
      </section>
    );
  }

  return (
    <section className="runtime-params-form" aria-label="Runtime params">
      <h3>Runtime params</h3>
      <div className="runtime-params-form__grid">
        {fields.map((field) => {
          const value = values[field.id] ?? field.defaultValue ?? (field.type === 'checkbox' ? false : '');
          const error = errorsByParam.get(field.id);
          return (
            <label key={field.id} className={field.type === 'checkbox' ? 'checkbox-field' : 'field'}>
              <span>{field.label}{field.required ? ' *' : ''}</span>
              {field.type === 'select' ? (
                <select
                  aria-label={field.label}
                  value={typeof value === 'string' ? value : ''}
                  onChange={(event) => onChange(field.id, event.target.value)}
                >
                  <option value="">Select...</option>
                  {(field.options ?? []).map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              ) : field.type === 'checkbox' ? (
                <input
                  aria-label={field.label}
                  checked={value === true}
                  type="checkbox"
                  onChange={(event) => onChange(field.id, event.target.checked)}
                />
              ) : (
                <input
                  aria-label={field.label}
                  type={field.type === 'password' ? 'password' : field.type}
                  value={typeof value === 'string' || typeof value === 'number' ? value : ''}
                  onChange={(event) => {
                    const next = field.type === 'number' && event.target.value !== ''
                      ? Number(event.target.value)
                      : event.target.value;
                    onChange(field.id, next);
                  }}
                />
              )}
              {field.description ? <small>{field.description}</small> : null}
              {error ? <p className="field-error">{error.message}</p> : null}
            </label>
          );
        })}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Simplify ExecutionControlBar**

Modify `apps/rpa-local-web/src/components/ExecutionControlBar.tsx`:

```ts
export interface ExecutionControlBarStartInput {
  flowId: string;
  mode: RpaExecutionMode;
  dryRun: boolean;
  headless: boolean;
}
```

Remove `paramsText`, `onParamsTextChange`, JSON textarea, `parseParams`, and `isParamRecord`. `onStart` should receive only flow/mode/dryRun/headless.

- [ ] **Step 5: Wire param state in RuntimeVerificationWorkspace**

Modify `apps/rpa-local-web/src/components/RuntimeVerificationWorkspace.tsx`:

```ts
import {
  normalizeRuntimeParams,
  type RuntimeParamValidationError,
  type RuntimeParamValue,
} from '../shared/runtime-params.js';
import { RuntimeParamsForm } from './RuntimeParamsForm.js';
```

Replace `paramsText` state with:

```ts
const [paramValues, setParamValues] = useState<Record<string, RuntimeParamValue>>({});
const [paramErrors, setParamErrors] = useState<RuntimeParamValidationError[]>([]);
```

After a flow loads, initialize defaults:

```ts
const defaultValues = Object.fromEntries(
  detail.runtimeParams.fields.flatMap((field) =>
    field.defaultValue !== undefined ? [[field.id, field.defaultValue]] : [],
  ),
);
setParamValues((current) => ({ ...defaultValues, ...current }));
```

Add an optional verify-success callback to the props:

```ts
onVerifySucceeded?: (input: { flowId: string; executionId: string }) => void;
```

Change `startExecutionRequest` so it owns param validation for both manual starts and auto-start requests. The function must first load the requested flow when needed, then validate against that loaded DSL before calling `client.startExecution`:

```ts
const flowForRequest = flow?.flowId === input.flowId ? flow : await loadFlow(input.flowId);
if (!flowForRequest) return;

const requestedParams = input.params ?? paramValues;
const normalized = normalizeRuntimeParams(flowForRequest.dsl.params, requestedParams);
if (!normalized.ok) {
  setParamErrors(normalized.errors);
  setParamValues(requestedParams);
  setRuntimeError('Runtime params are required before execution can start.');
  return;
}
setParamErrors([]);

const started = await client.startExecution({
  ...input,
  params: normalized.value,
});
```

Render before logs/grid:

```tsx
<RuntimeParamsForm
  fields={flow?.runtimeParams.fields ?? []}
  values={paramValues}
  errors={paramErrors}
  onChange={(paramId, value) => setParamValues((current) => ({ ...current, [paramId]: value }))}
/>
```

Update `autoStartRequest`: do not perform a separate synchronous `loadedFlow` check in the effect. The effect should set visible field values from `autoStartRequest.params ?? {}` and call `startExecutionRequest`; `startExecutionRequest` performs the real DSL-based validation after `loadFlow` resolves. This avoids relying on stale `flow` state.

```ts
const nextParams = autoStartRequest.params ?? {};
setParamValues(nextParams);
void startExecutionRequest({
  flowId: autoStartRequest.flowId,
  daemonRunId: autoStartRequest.daemonRunId,
  mode: autoStartRequest.mode,
  dryRun: dryRunDefault,
  headless: headlessDefault,
  params: nextParams,
});
```

When handling `run.completed`, call the verify-success callback after refreshing status for a successful verify execution:

```ts
if (event.type === 'run.completed') {
  if (event.status) setExecutionStatus(event.status);
  refreshScreenshot(event.executionId, event.sequence ?? event.timestamp);
  void Promise.all([
    refreshStatus(event.executionId),
    refreshLogs(event.executionId),
    refreshArtifacts(event.executionId),
  ])
    .then(() => {
      if (event.status === 'succeeded' && mode === 'verify') {
        onVerifySucceeded?.({ flowId, executionId: event.executionId });
      }
    })
    .catch(handleRuntimeError);
}
```

- [ ] **Step 6: Update component tests**

Update `RuntimeVerificationWorkspace` start assertion to fill required `case_no` first:

```ts
await userEvent.type(screen.getByLabelText('案件编号'), 'A123');
await userEvent.click(screen.getByRole('button', { name: /Start/ }));
expect(client.startExecution).toHaveBeenCalledWith({
  flowId: 'case_query',
  mode: 'verify',
  dryRun: true,
  headless: false,
  params: { case_no: 'A123' },
});
```

Add a test:

```ts
it('does not auto-start when required params are missing', async () => {
  const client = new FakeRuntimeClient();
  render(
    <RuntimeVerificationWorkspace
      client={client}
      autoStartRequest={{ requestId: 'req_missing', flowId: 'case_query', mode: 'verify', params: {} }}
    />,
  );

  await screen.findByText('Runtime params are required before execution can start.');
  expect(client.startExecution).not.toHaveBeenCalled();
});
```

Add a verify-success callback test:

```ts
it('notifies the parent when a verify execution succeeds', async () => {
  const client = new FakeRuntimeClient();
  const onVerifySucceeded = vi.fn();

  render(<RuntimeVerificationWorkspace client={client} onVerifySucceeded={onVerifySucceeded} />);
  await screen.findByText('案件查询');
  await userEvent.type(screen.getByLabelText('案件编号'), 'A123');
  await userEvent.click(screen.getByRole('button', { name: /Start/ }));

  await act(async () => {
    client.emit({ type: 'run.completed', executionId: 'exec_1', status: 'succeeded', sequence: 1 });
  });

  await waitFor(() => expect(onVerifySucceeded).toHaveBeenCalledWith({
    flowId: 'case_query',
    executionId: 'exec_1',
  }));
});
```

Update `ExecutionControlBar` tests by removing Params JSON cases and asserting it passes flow/mode/dryRun/headless only.

- [ ] **Step 7: Add CSS**

Modify `apps/rpa-local-web/src/styles.css`:

```css
.runtime-params-form {
  padding: 12px;
  border: 1px solid #d7dee8;
  border-radius: 6px;
  background: #ffffff;
}

.runtime-params-form h3 {
  margin: 0 0 10px;
  font-size: 14px;
  line-height: 1.25;
  letter-spacing: 0;
}

.runtime-params-form__grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(140px, 1fr));
  gap: 10px;
}

.runtime-params-form__empty {
  margin: 0;
  color: #5b6677;
  font-size: 12px;
}

.field small {
  color: #6b7280;
  font-size: 11px;
}
```

Adjust `.execution-control-bar` columns after removing params textarea:

```css
.execution-control-bar {
  grid-template-columns: minmax(160px, 1.1fr) minmax(170px, auto) auto auto auto;
}
```

- [ ] **Step 8: Run component tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/components/RuntimeParamsForm.test.tsx tests/components/ExecutionControlBar.test.tsx tests/components/RuntimeVerificationWorkspace.test.tsx tests/components/codegen-workspace.test.tsx tests/components/NaturalLanguageWorkspace.test.tsx
```

Expected: PASS.

---

## Task 8: Flow Assets Workspace UI

**Files:**
- Create: `apps/rpa-local-web/src/components/FlowAssetsWorkspace.tsx`
- Modify: `apps/rpa-local-web/src/components/AppShell.tsx`
- Modify: `apps/rpa-local-web/src/styles.css`
- Test: `apps/rpa-local-web/tests/components/FlowAssetsWorkspace.test.tsx`
- Test: `apps/rpa-local-web/tests/App.test.tsx`

- [ ] **Step 1: Write failing FlowAssetsWorkspace tests**

Create `apps/rpa-local-web/tests/components/FlowAssetsWorkspace.test.tsx`:

```tsx
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlowAssetsWorkspace } from '../../src/components/FlowAssetsWorkspace.js';
import { createMinimalRpaDsl } from '../../src/shared/dsl-schema.js';
import type { RpaFlowDetailResponse } from '../../src/shared/rpa-api-types.js';

afterEach(() => cleanup());

class FakeFlowAssetsClient {
  private verified = false;

  readonly getFlow = vi.fn(async (): Promise<RpaFlowDetailResponse> => ({
    flowId: 'case_query',
    title: '案件查询',
    source: 'codegen',
    dsl: createMinimalRpaDsl(),
    warnings: [],
    runtimeParams: {
      fields: [{ id: 'case_no', label: '案件编号', type: 'text', required: true, mask: true }],
      requiresUserInput: true,
      maskedParamIds: ['case_no'],
    },
    provenance: {
      source: 'imported',
      requiresVerifyBeforeRun: !this.verified,
      originalFlowId: 'case_query',
      packageSha256: 'sha256:abc',
    },
  }));

  readonly getPackageDownloadUrl = vi.fn((flowId: string) => `/api/rpa/flows/${flowId}/package/download`);

  readonly importPackage = vi.fn(async () => ({
    flowId: 'imported_flow',
    title: 'Imported flow',
    source: 'imported' as const,
    requiresVerifyBeforeRun: true as const,
    importedAt: '2026-06-06T00:00:00.000Z',
    packageSha256: 'sha256:def',
    ignoredEntries: [],
  }));

  markVerified() {
    this.verified = true;
  }
}

class FakeRuntimeClient {
  private handler?: (event: any) => void;

  readonly getFlow = vi.fn(async (): Promise<RpaFlowDetailResponse> => ({
    flowId: 'case_query',
    title: '案件查询',
    source: 'codegen',
    dsl: { ...createMinimalRpaDsl(), params: {} },
    warnings: [],
    runtimeParams: { fields: [], requiresUserInput: false, maskedParamIds: [] },
    provenance: { source: 'generated', requiresVerifyBeforeRun: false },
  }));

  readonly startExecution = vi.fn(async () => ({
    executionId: 'exec_verify',
    flowId: 'case_query',
    status: 'queued' as const,
  }));

  readonly cancelExecution = vi.fn(async () => ({ ok: true as const }));
  readonly getExecutionStatus = vi.fn(async () => ({
    executionId: 'exec_verify',
    flowId: 'case_query',
    status: 'succeeded' as const,
    mode: 'verify' as const,
    dryRun: true,
    headless: false,
  }));
  readonly getExecutionLogs = vi.fn(async () => ({ executionId: 'exec_verify', stdout: '', stderr: '' }));
  readonly getExecutionArtifacts = vi.fn(async () => ({ executionId: 'exec_verify', artifacts: [] }));
  readonly getCurrentScreenshotUrl = vi.fn(() => '/api/rpa/executions/exec_verify/screenshots/current');
  readonly subscribeExecutionEvents = vi.fn((_executionId: string, handlers: { onEvent: (event: any) => void }) => {
    this.handler = handlers.onEvent;
    return vi.fn();
  });

  emit(event: any) {
    this.handler?.({ timestamp: '2026-06-06T00:00:00.000Z', ...event });
  }
}

describe('FlowAssetsWorkspace', () => {
  it('loads flow provenance and exposes export/verify/run controls', async () => {
    const client = new FakeFlowAssetsClient();
    render(<FlowAssetsWorkspace client={client} />);

    await userEvent.type(screen.getByLabelText('Flow ID'), 'case_query');
    await userEvent.click(screen.getByRole('button', { name: 'Load flow' }));

    expect(await screen.findByText('案件查询')).toBeInTheDocument();
    expect(screen.getByText('imported')).toBeInTheDocument();
    expect(screen.getByText('Verify required before run')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Export .rpa.zip' })).toHaveAttribute(
      'href',
      '/api/rpa/flows/case_query/package/download',
    );
    expect(screen.getByRole('button', { name: 'Run flow' })).toBeDisabled();
  });

  it('reloads provenance after verify succeeds so imported flows can run', async () => {
    const client = new FakeFlowAssetsClient();
    const runtimeClient = new FakeRuntimeClient();
    render(<FlowAssetsWorkspace client={client} runtimeClient={runtimeClient} />);

    await userEvent.clear(screen.getByLabelText('Flow ID'));
    await userEvent.type(screen.getByLabelText('Flow ID'), 'case_query');
    await userEvent.click(screen.getByRole('button', { name: 'Load flow' }));
    expect(await screen.findByRole('button', { name: 'Run flow' })).toBeDisabled();

    client.markVerified();
    await userEvent.click(screen.getByRole('button', { name: 'Verify flow' }));

    await waitFor(() => expect(runtimeClient.startExecution).toHaveBeenCalled());
    await act(async () => {
      runtimeClient.emit({
        type: 'run.completed',
        executionId: 'exec_verify',
        status: 'succeeded',
        sequence: 1,
      });
    });

    await waitFor(() => expect(client.getFlow).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run flow' })).toBeEnabled());
  });

  it('imports a package and loads the imported flow', async () => {
    const client = new FakeFlowAssetsClient();
    render(<FlowAssetsWorkspace client={client} />);

    const file = new File([new Uint8Array([1, 2, 3])], 'imported_flow.rpa.zip', { type: 'application/zip' });
    await userEvent.upload(screen.getByLabelText('Import .rpa.zip'), file);
    await userEvent.click(screen.getByRole('button', { name: 'Import package' }));

    await waitFor(() => expect(client.importPackage).toHaveBeenCalledWith(file));
    await waitFor(() => expect(client.getFlow).toHaveBeenLastCalledWith('imported_flow'));
  });
});
```

- [ ] **Step 2: Run failing UI test**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/components/FlowAssetsWorkspace.test.tsx
```

Expected: FAIL because component does not exist.

- [ ] **Step 3: Implement FlowAssetsWorkspace**

Create `apps/rpa-local-web/src/components/FlowAssetsWorkspace.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { RpaApiClient } from '../api/rpa-api-client.js';
import type { ImportRpaPackageResponse, RpaFlowDetailResponse } from '../shared/rpa-api-types.js';
import { RuntimeVerificationWorkspace, type RuntimeVerificationApiClient } from './RuntimeVerificationWorkspace.js';
import { StatusBadge } from './StatusBadge.js';

export interface FlowAssetsApiClient {
  getFlow(flowId: string): Promise<RpaFlowDetailResponse>;
  getPackageDownloadUrl(flowId: string): string;
  importPackage(file: File): Promise<ImportRpaPackageResponse>;
}

export interface FlowAssetsWorkspaceProps {
  client?: FlowAssetsApiClient;
  runtimeClient?: RuntimeVerificationApiClient;
}

export function FlowAssetsWorkspace({ client: injectedClient, runtimeClient }: FlowAssetsWorkspaceProps) {
  const defaultClient = useMemo(() => new RpaApiClient(), []);
  const client = injectedClient ?? defaultClient;
  const [flowIdInput, setFlowIdInput] = useState('case_query');
  const [flow, setFlow] = useState<RpaFlowDetailResponse | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verificationMode, setVerificationMode] = useState<'verify' | 'run' | null>(null);

  const loadFlow = async (nextFlowId = flowIdInput) => {
    setBusy(true);
    setError(null);
    try {
      const detail = await client.getFlow(nextFlowId.trim());
      setFlow(detail);
      setFlowIdInput(detail.flowId);
      setVerificationMode(null);
    } catch (loadError) {
      setFlow(null);
      setError(loadError instanceof Error ? loadError.message : 'Failed to load flow.');
    } finally {
      setBusy(false);
    }
  };

  const importPackage = async () => {
    if (!selectedFile) {
      setError('Choose a .rpa.zip package first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const imported = await client.importPackage(selectedFile);
      setMessage(`Imported ${imported.flowId}. Verify is required before run.`);
      await loadFlow(imported.flowId);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Package import failed.');
    } finally {
      setBusy(false);
    }
  };

  const canRun = flow !== null && flow.provenance.requiresVerifyBeforeRun === false;

  return (
    <div className="flow-assets-workspace">
      <form className="flow-assets-toolbar" onSubmit={(event) => { event.preventDefault(); void loadFlow(); }}>
        <label className="field">
          <span>Flow ID</span>
          <input aria-label="Flow ID" value={flowIdInput} onChange={(event) => setFlowIdInput(event.target.value)} />
        </label>
        <button type="submit" className="command-button" disabled={busy}>Load flow</button>
        <label className="field">
          <span>Import .rpa.zip</span>
          <input
            aria-label="Import .rpa.zip"
            type="file"
            accept=".rpa.zip,application/zip"
            onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <button type="button" className="command-button command-button--secondary" disabled={busy} onClick={importPackage}>
          <Upload aria-hidden="true" />
          <span>Import package</span>
        </button>
      </form>

      {error ? <p className="runtime-workspace__error">{error}</p> : null}
      {message ? <p className="flow-assets-workspace__message">{message}</p> : null}

      {flow ? (
        <section className="flow-assets-summary">
          <div>
            <h3>{flow.title}</h3>
            <p>{flow.flowId} · {flow.runtimeParams.fields.length} params · {flow.dsl.steps.length} steps</p>
          </div>
          <StatusBadge tone={flow.provenance.requiresVerifyBeforeRun ? 'warning' : 'ready'}>
            {flow.provenance.source}
          </StatusBadge>
          <dl>
            <div><dt>Verify state</dt><dd>{flow.provenance.requiresVerifyBeforeRun ? 'Verify required before run' : 'Ready to run'}</dd></div>
            <div><dt>Original flow</dt><dd>{flow.provenance.originalFlowId ?? flow.flowId}</dd></div>
            <div><dt>Package hash</dt><dd>{flow.provenance.packageSha256 ?? 'local'}</dd></div>
          </dl>
          <div className="flow-assets-actions">
            <a className="command-button command-button--secondary" href={client.getPackageDownloadUrl(flow.flowId)}>
              <Download aria-hidden="true" />
              <span>Export .rpa.zip</span>
            </a>
            <button type="button" className="command-button" onClick={() => setVerificationMode('verify')}>Verify flow</button>
            <button type="button" className="command-button" disabled={!canRun} onClick={() => setVerificationMode('run')}>Run flow</button>
          </div>
        </section>
      ) : null}

      {flow && verificationMode ? (
        <RuntimeVerificationWorkspace
          flowId={flow.flowId}
          onFlowIdChange={() => undefined}
          autoStartRequest={{ requestId: `${flow.flowId}-${verificationMode}-${Date.now()}`, flowId: flow.flowId, mode: verificationMode }}
          onVerifySucceeded={() => {
            void loadFlow(flow.flowId);
          }}
          client={runtimeClient}
        />
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Wire Flows tab**

Modify `apps/rpa-local-web/src/components/AppShell.tsx`:

```ts
import { FlowAssetsWorkspace } from './FlowAssetsWorkspace.js';
```

Replace the placeholder branch:

```tsx
{activeSection.id === 'codegen' ? (
  <CodegenWorkspace />
) : activeSection.id === 'natural-language' ? (
  <NaturalLanguageWorkspace />
) : activeSection.id === 'flows' ? (
  <FlowAssetsWorkspace />
) : activeSection.id === 'executions' ? (
  <RuntimeVerificationWorkspace />
) : (
  <PlaceholderGrid />
)}
```

Update `rpaSections` flow description to remove “后续” wording:

```ts
description: '查看已生成流程、执行参数、导入导出包和本地验证状态。',
```

- [ ] **Step 5: Add CSS**

Modify `apps/rpa-local-web/src/styles.css`:

```css
.flow-assets-workspace {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.flow-assets-toolbar,
.flow-assets-summary {
  border: 1px solid #d7dee8;
  border-radius: 6px;
  background: #ffffff;
}

.flow-assets-toolbar {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) auto minmax(220px, 1fr) auto;
  gap: 10px;
  align-items: end;
  padding: 12px;
}

.flow-assets-summary {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto;
  gap: 12px;
  padding: 12px 14px;
}

.flow-assets-summary h3 {
  margin: 0;
  font-size: 14px;
  line-height: 1.25;
}

.flow-assets-summary p,
.flow-assets-workspace__message {
  margin: 4px 0 0;
  color: #5b6677;
  font-size: 12px;
}

.flow-assets-summary dl {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
}

.flow-assets-summary dt {
  color: #526174;
  font-size: 11px;
  font-weight: 700;
}

.flow-assets-summary dd {
  margin: 2px 0 0;
  overflow-wrap: anywhere;
  font-size: 12px;
}

.flow-assets-actions {
  grid-column: 1 / -1;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
```

- [ ] **Step 6: Run UI tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/components/FlowAssetsWorkspace.test.tsx tests/App.test.tsx
```

Expected: PASS.

---

## Task 9: Route Integration And Safety Regression

**Files:**
- Existing tests across RPA Web.

- [ ] **Step 1: Run package and executor route tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/routes/packages.test.ts tests/server/routes/flows.test.ts tests/server/routes/executions.test.ts tests/server/server.test.ts
```

Expected: PASS. Use sandbox escalation if local port binding fails.

- [ ] **Step 2: Run component and API tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/api/rpa-api-client.test.ts tests/components/RuntimeParamsForm.test.tsx tests/components/RuntimeVerificationWorkspace.test.tsx tests/components/FlowAssetsWorkspace.test.tsx tests/App.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run full RPA Web validation**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web typecheck
pnpm --filter @lance-agent-runner/rpa-local-web test
pnpm --filter @lance-agent-runner/rpa-local-web build
```

Expected: all PASS.

- [ ] **Step 4: Run repo-level validation**

Run:

```bash
pnpm typecheck
pnpm build
pnpm test
```

Expected: all PASS. Use sandbox escalation if tests need local ports.

- [ ] **Step 5: Verify daemon boundary**

Run:

```bash
rg -n "RPA|Playwright|DSL|selector|screenshot|trace|video|executionId|flowId|rpa-package|runtime params" apps/daemon/src
```

Expected: no matches.

- [ ] **Step 6: Verify diff hygiene**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

---

## Task 10: Main Plan Progress Update And Commit

**Files:**
- Modify: `docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md`

- [ ] **Step 1: Update main plan status**

In `docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md`, change the current slice from planned checklist to completed after implementation and CC review:

```markdown
## Slice: 流程复用与执行闭环 (Completed)

**Execution plan:** `docs/superpowers/plans/2026-06-06-rpa-flow-reuse-execution-loop.md`

**Status:** Implemented and CC reviewed.
```

Keep the checklist items and mark them `[x]` only after implementation is actually complete.

- [ ] **Step 2: Commit**

Run:

```bash
git status --short
git add docs/superpowers/plans/2026-06-06-rpa-flow-reuse-execution-loop.md docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md apps/rpa-local-web
git commit -m "Add RPA flow import export and runtime params"
```

Expected: commit succeeds.

---
