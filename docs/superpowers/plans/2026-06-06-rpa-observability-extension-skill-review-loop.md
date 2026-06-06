# RPA Observability Extension And Skill Review Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add RPA-specific review materials on top of the generic daemon review bundle so `rpa-script-generate` and `playwright-rpa-harden` can be improved from real DSL, artifact, execution, screenshot/log, and user feedback evidence.

**Architecture:** Keep RPA semantics inside `apps/rpa-local-web`; daemon core remains business-agnostic. RPA Web exports a combined review bundle by downloading the daemon generic bundle, appending `extensions/rpa/*`, and returning a new ZIP. RPA extension files default to summaries and path/hash references; screenshots, trace, video, and downloads are included only when explicitly requested.

**Tech Stack:** TypeScript, Express, Node filesystem APIs, existing RPA DSL/artifact validators, existing RPA execution store/artifact collector, Fetch API daemon client, Vitest.

---

## Boundaries

This slice must not add RPA, Playwright, DSL, selector, screenshot, trace, video, or executor semantics to `apps/daemon/src`.

This slice may extend `apps/rpa-local-web` and its typed daemon client. If daemon API shape changes are needed, stop and discuss before changing daemon core.

The generic daemon bundle remains the source of prompt/skill/profile/log/message snapshots. RPA Web must not reconstruct final daemon prompts or read daemon internal filesystem paths.

RPA Web owns `extensions/rpa/*`:

```text
extensions/
+-- rpa/
    +-- extension-manifest.json
    +-- rpa-summary.md
    +-- rpa-diagnostics.json
    +-- dsl-validation.json
    +-- artifact-validation.json
    +-- executions/
        +-- exec_123/
            +-- execution.json
            +-- execution-log.jsonl
    +-- feedback.jsonl
```

High-sensitive files are referenced by path/hash by default:

- screenshots
- trace.zip
- video.webm
- downloads
- storage state, cookies, tokens, CA/USB-Key files

Only include high-sensitive file bodies when the RPA Web review export request explicitly sets `includeSensitiveFiles=true`.

All RPA extension `path` fields are bundle-relative logical paths, never host absolute paths. For example:

```text
extensions/rpa/executions/exec_123/artifacts/screenshots/search.png
extensions/rpa/executions/exec_123/artifacts/trace/trace.zip
```

When an original file lives under the local storage root, the exported reference must store only the bundle-relative path plus hash/size metadata.

## API Contract

Add these RPA Web endpoints:

```text
GET  /api/rpa/flows/:flowId/review-bundle/download?daemonRunId=run_...&executionId=exec_...&includeSensitiveFiles=false
POST /api/rpa/feedback
```

`GET /review-bundle/download` behavior:

- Requires a valid `flowId`.
- Requires `daemonRunId`.
- Accepts zero or more `executionId` query values. If omitted, export the flow/daemon diagnostics without execution-specific files.
- Does not discover daemon runs from `flowId`; the caller must pass the exact `daemonRunId` to review.
- Downloads the generic daemon bundle via `GET /api/runs/:runId/review-bundle/download`.
- Appends `extensions/rpa/*` entries to a new ZIP.
- Returns `application/zip` with a safe `Content-Disposition`.
- Does not expose local absolute storage paths in JSON, Markdown, headers, or errors.

`POST /api/rpa/feedback` body:

```json
{
  "daemonRunId": "run_123",
  "flowId": "case_query",
  "executionId": "exec_123",
  "stepId": "step_003",
  "category": "selector",
  "severity": "major",
  "message": "这里应该点击查询按钮，但脚本点到了重置按钮",
  "artifactPath": "flow.dsl.json",
  "screenshotPath": "executions/exec_123/artifacts/screenshots/step_003.png"
}
```

RPA Web validates the RPA category and metadata, applies RPA redaction, then forwards the feedback to daemon generic `POST /api/runs/:runId/feedback` as an opaque category and metadata object.

RPA Web does not require daemon to support category or source filtering. During bundle export, RPA Web calls generic `GET /api/runs/:runId/feedback`, then locally filters entries whose category is in the RPA allowlist and whose metadata has `source: "rpa-local-web"` when that field is present.

Allowed RPA feedback categories:

```text
dsl | selector | wait | assert | parameterization | write-risk | manual-step | executor
```

Allowed severities:

```text
minor | major | critical
```

## Bundle Merge Decision

The generic daemon `ReviewBundleService` has an extension-provider hook, but the default daemon process cannot receive RPA Web providers because RPA Web is a separate local B/S backend. Therefore the MVP implementation merges bundles in RPA Web:

1. `DaemonClient.downloadReviewBundle(daemonRunId)` returns the daemon-generated ZIP buffer.
2. `RpaReviewBundleService` reads entries from the daemon ZIP.
3. RPA Web appends `extensions/rpa/*` entries.
4. RPA Web writes a new uncompressed ZIP and returns it to the browser.

Do not import `apps/daemon/src/core/zip-writer.ts` from RPA Web. Keep a small RPA-local ZIP helper so packages remain independent.

## Task 1: RPA Review ZIP Helpers

**Files:**

- Create: `apps/rpa-local-web/src/server/observability/review-zip.ts`
- Test: `apps/rpa-local-web/tests/server/observability/review-zip.test.ts`

- [ ] **Step 1: Add failing ZIP helper tests**

Test cases:

```ts
import { describe, expect, it } from 'vitest';
import {
  appendZipEntries,
  createUncompressedZip,
  listZipEntryNames,
  readUncompressedZipEntries,
} from '../../../src/server/observability/review-zip.js';

describe('RPA review ZIP helpers', () => {
  it('creates and reads uncompressed ZIP entries', () => {
    const zip = createUncompressedZip([
      { path: 'manifest.json', content: '{\"ok\":true}\\n' },
      { path: 'extensions/rpa/rpa-summary.md', content: '# Summary\\n' },
    ]);

    expect(zip.subarray(0, 2).toString('utf8')).toBe('PK');
    expect(listZipEntryNames(zip)).toEqual(['manifest.json', 'extensions/rpa/rpa-summary.md']);
    expect(Object.fromEntries(readUncompressedZipEntries(zip).map((entry) => [entry.path, entry.content.toString('utf8')]))).toEqual({
      'manifest.json': '{\"ok\":true}\\n',
      'extensions/rpa/rpa-summary.md': '# Summary\\n',
    });
  });

  it('appends RPA extension entries without modifying existing daemon entries', () => {
    const daemonZip = createUncompressedZip([{ path: 'review-summary.md', content: 'daemon\\n' }]);
    const combined = appendZipEntries(daemonZip, [
      { path: 'extensions/rpa/rpa-summary.md', content: 'rpa\\n' },
    ]);

    expect(Object.keys(Object.fromEntries(readUncompressedZipEntries(combined).map((entry) => [entry.path, true])))).toEqual([
      'review-summary.md',
      'extensions/rpa/rpa-summary.md',
    ]);
  });

  it('rejects unsafe ZIP paths', () => {
    expect(() => createUncompressedZip([{ path: '../secret.txt', content: 'x' }])).toThrow(/unsafe/i);
    expect(() => createUncompressedZip([{ path: '/secret.txt', content: 'x' }])).toThrow(/unsafe/i);
    expect(() => createUncompressedZip([{ path: 'extensions\\\\rpa\\\\x', content: 'x' }])).toThrow(/unsafe/i);
  });
});
```

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/observability/review-zip.test.ts
```

Expected: FAIL because `review-zip.ts` does not exist.

- [ ] **Step 2: Implement local ZIP helper**

Implement:

```ts
export interface ReviewZipEntry {
  path: string;
  content: string | Buffer;
}

export function createUncompressedZip(entries: ReviewZipEntry[]): Buffer
export function readUncompressedZipEntries(zip: Buffer): Array<{ path: string; content: Buffer }>
export function appendZipEntries(zip: Buffer, entries: ReviewZipEntry[]): Buffer
export function listZipEntryNames(zip: Buffer): string[]
```

Rules:

- Normalize entry paths to forward slashes.
- Reject empty paths, absolute paths, `..`, backslashes, and duplicate paths.
- Read only ZIPs produced by the internal uncompressed writer. If a ZIP uses compression, throw `Unsupported ZIP compression method`.
- Keep CRC32 local to this file.

- [ ] **Step 3: Run ZIP helper tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/observability/review-zip.test.ts
```

Expected: PASS.

## Task 2: RPA Redaction And Shared Observability Types

**Files:**

- Create: `apps/rpa-local-web/src/server/observability/rpa-observability-types.ts`
- Create: `apps/rpa-local-web/src/server/observability/rpa-redaction.ts`
- Test: `apps/rpa-local-web/tests/server/observability/rpa-redaction.test.ts`

- [ ] **Step 1: Add failing redaction tests**

Test cases:

```ts
import { describe, expect, it } from 'vitest';
import { redactRpaText, redactRpaValue } from '../../../src/server/observability/rpa-redaction.js';

describe('RPA redaction', () => {
  it('redacts masked params', () => {
    const redacted = redactRpaText('case_no=A123', {
      storageRoot: '/tmp/rpa-local',
      maskedParamIds: ['case_no'],
      params: { case_no: 'A123' },
    });

    expect(redacted).toContain('[masked-param:case_no]');
    expect(redacted).not.toContain('A123');
  });

  it('redacts phone numbers and identity-like values', () => {
    const redacted = redactRpaText('phone=13800138000 id=110101199003074219', {
      storageRoot: '/tmp/rpa-local',
      maskedParamIds: [],
      params: {},
    });

    expect(redacted).not.toContain('13800138000');
    expect(redacted).not.toContain('110101199003074219');
    expect(redacted).toContain('[redacted-phone]');
    expect(redacted).toContain('[redacted-id]');
  });

  it('redacts local storage paths', () => {
    const redacted = redactRpaText('path=/tmp/rpa-local/flow', {
      storageRoot: '/tmp/rpa-local',
      maskedParamIds: [],
      params: {},
    });

    expect(redacted).not.toContain('/tmp/rpa-local');
    expect(redacted).toContain('[rpa-storage]');
  });

  it('redacts nested feedback metadata', () => {
    const value = redactRpaValue(
      { stepId: 's1', params: { password: 'secret' }, message: '13800138000' },
      { storageRoot: '/tmp/rpa-local', maskedParamIds: ['password'], params: { password: 'secret' } },
    );

    expect(value).toEqual({
      stepId: 's1',
      params: { password: '[masked-param:password]' },
      message: '[redacted-phone]',
    });
  });
});
```

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/observability/rpa-redaction.test.ts
```

Expected: FAIL because redaction helpers do not exist.

- [ ] **Step 2: Define observability types**

Define types for:

```ts
export type RpaFeedbackCategory =
  | 'dsl'
  | 'selector'
  | 'wait'
  | 'assert'
  | 'parameterization'
  | 'write-risk'
  | 'manual-step'
  | 'executor';

export type RpaFeedbackSeverity = 'minor' | 'major' | 'critical';

export interface RpaReviewBundleRequest {
  flowId: string;
  daemonRunId: string;
  executionIds: string[];
  includeSensitiveFiles: boolean;
  collectionMode: 'lite' | 'diagnostic' | 'review';
}

export interface RpaLargeFileReference {
  path: string;
  kind: 'screenshot' | 'trace' | 'video' | 'download' | 'log' | 'other';
  sizeBytes: number;
  sha256: string;
  reason: string;
  included: boolean;
}
```

`RpaLargeFileReference.path` must always be a bundle-relative logical path under `extensions/rpa/`; it must never be a host absolute path.

- [ ] **Step 3: Implement redaction**

Implement:

```ts
export function redactRpaText(text: string, options: RpaRedactionOptions): string
export function redactRpaValue(value: unknown, options: RpaRedactionOptions): unknown
```

Rules:

- Replace storage root with `[rpa-storage]`.
- Replace exact masked param values with `[masked-param:<id>]`.
- Replace 11-digit phone-like values with `[redacted-phone]`.
- Replace 15/18-digit identity-like values with `[redacted-id]`.
- Redact object keys matching `password`, `passwd`, `secret`, `token`, `cookie`, `storage_state`, `storageState`.
- Be idempotent and handle circular values as `[redacted-circular]`.

- [ ] **Step 4: Run redaction tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/observability/rpa-redaction.test.ts
```

Expected: PASS.

## Task 3: RPA DSL And Artifact Diagnostics

**Files:**

- Create: `apps/rpa-local-web/src/server/observability/rpa-diagnostics.ts`
- Test: `apps/rpa-local-web/tests/server/observability/rpa-diagnostics.test.ts`

- [ ] **Step 1: Add failing diagnostics tests**

Test cases:

```ts
import { describe, expect, it } from 'vitest';
import { requiredGenerationArtifactNames } from '../../../src/shared/artifacts.js';
import { createMinimalRpaDsl } from '../../../src/shared/dsl-schema.js';
import { buildRpaDiagnostics } from '../../../src/server/observability/rpa-diagnostics.js';

describe('RPA diagnostics', () => {
  it('summarizes DSL warnings, missing artifacts, fragile selectors, waits, manuals, and writes', () => {
    const dsl = {
      ...createMinimalRpaDsl(),
      steps: [
        {
          id: 'search',
          name: '查询',
          action: 'click',
          target: { by: 'xpath', xpath: '//button[1]' },
          write: true,
          manual: null,
        },
        {
          id: 'captcha',
          name: '验证码',
          action: 'manual',
          write: false,
          manual: { type: 'captcha', instruction: '请处理验证码', riskLevel: 'medium' },
        },
      ],
    };

    const diagnostics = buildRpaDiagnostics({
      dsl,
      artifacts: requiredGenerationArtifactNames
        .filter((fileName) => fileName !== 'hardening-report.md')
        .map((fileName) => ({
          artifactId: `artifact_${fileName}`,
          fileName,
          relativePath: `output/${fileName}`,
          size: 10,
          sha256: 'a'.repeat(64),
        })),
      executions: [],
      maxItemsPerList: 20,
    });

    expect(diagnostics.missingArtifacts).toContain('hardening-report.md');
    expect(diagnostics.fragileSelectors[0]).toMatchObject({ stepId: 'search', selectorType: 'xpath' });
    expect(diagnostics.missingWaits).toContain('search');
    expect(diagnostics.unconfirmedWriteSteps).toContain('search');
    expect(diagnostics.manualSteps[0]).toMatchObject({ stepId: 'captcha', type: 'captcha' });
  });

  it('bounds large lists and reports omitted counts', () => {
    const dsl = {
      ...createMinimalRpaDsl(),
      steps: Array.from({ length: 25 }, (_, index) => ({
        id: `s${index}`,
        name: `Step ${index}`,
        action: 'click',
        target: { by: 'css', css: `.button-${index}` },
        write: false,
        manual: null,
      })),
    };

    const diagnostics = buildRpaDiagnostics({ dsl, artifacts: [], executions: [], maxItemsPerList: 5 });

    expect(diagnostics.fragileSelectors).toHaveLength(5);
    expect(diagnostics.limits.omitted.fragileSelectors).toBeGreaterThan(0);
  });
});
```

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/observability/rpa-diagnostics.test.ts
```

Expected: FAIL because diagnostics helper does not exist.

- [ ] **Step 2: Implement diagnostics builder**

Implement:

```ts
export function buildRpaDiagnostics(input: {
  dsl: unknown;
  artifacts: RpaGenerationArtifact[];
  executions: RpaExecutionRecord[];
  maxItemsPerList?: number;
}): RpaDiagnostics
```

Include:

- `limits.maxItemsPerList`
- `limits.omitted`
- `missingArtifacts`
- `schemaErrors`
- `schemaWarnings`
- `fragileSelectors`
- `missingWaits`
- `missingAsserts`
- `manualSteps`
- `unconfirmedWriteSteps`
- `parameterizationIssues`
- `executionFailures`

Detection rules:

- Use existing `validateRpaDsl`.
- Use existing `validateGenerationArtifacts`.
- Treat `target.by = css | xpath` as fragile for review purposes.
- Treat action steps `navigate | click | input | select | submit` with no `wait` as missing waits.
- Treat `submit | assert` with no assertions as missing asserts.
- Treat `write === true` without `idempotency_key` and without high-risk manual confirmation as unconfirmed write.
- Treat zero params as a parameterization issue because generated scripts should expose runtime variables when business values are fixed.
- Include failed/timed-out/canceled executions in `executionFailures`.

- [ ] **Step 3: Add JSON serializers**

Implement:

```ts
export function buildDslValidationDocument(input: unknown): unknown
export function buildArtifactValidationDocument(artifacts: RpaGenerationArtifact[]): unknown
```

The documents should contain the full existing validation results, but no local absolute paths.

- [ ] **Step 4: Run diagnostics tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/observability/rpa-diagnostics.test.ts
```

Expected: PASS.

## Task 4: RPA Execution Material Collector

**Files:**

- Create: `apps/rpa-local-web/src/server/observability/rpa-execution-materials.ts`
- Test: `apps/rpa-local-web/tests/server/observability/rpa-execution-materials.test.ts`

- [ ] **Step 1: Add failing collector tests**

Test cases:

```ts
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectRpaExecutionMaterials } from '../../../src/server/observability/rpa-execution-materials.js';

describe('RPA execution materials', () => {
  it('collects sanitized execution JSON, logs, events, and large file references', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-exec-materials-'));
    const executionDir = path.join(storageRoot, 'executions', 'exec_1');
    await mkdir(path.join(executionDir, 'logs'), { recursive: true });
    await mkdir(path.join(executionDir, 'artifacts', 'screenshots'), { recursive: true });
    await writeFile(path.join(executionDir, 'execution.json'), JSON.stringify({
      executionId: 'exec_1',
      flowId: 'case_query',
      daemonRunId: 'run_1',
      mode: 'verify',
      dryRun: true,
      headless: false,
      status: 'failed',
      createdAt: '2026-06-06T00:00:00.000Z',
      timeoutMs: 1000,
      paramsSummary: { case_no: '[masked]' },
      failedStepId: 'search',
      error: { code: 'STEP_TARGET_NOT_FOUND', message: `missing ${storageRoot} 13800138000` },
    }, null, 2));
    await writeFile(path.join(executionDir, 'logs', 'stdout.log'), `case_no=A123 ${storageRoot}\\n`);
    await writeFile(path.join(executionDir, 'events.jsonl'), '{\"type\":\"step.failed\",\"executionId\":\"exec_1\",\"stepId\":\"search\",\"timestamp\":\"2026-06-06T00:00:01.000Z\"}\\n');
    await writeFile(path.join(executionDir, 'artifacts', 'screenshots', 'search.png'), 'fake screenshot');

    const materials = await collectRpaExecutionMaterials({
      storageRoot,
      executionIds: ['exec_1'],
      collectionMode: 'diagnostic',
      redaction: { storageRoot, maskedParamIds: ['case_no'], params: { case_no: 'A123' } },
      includeSensitiveFiles: false,
    });

    expect(materials.entries.map((entry) => entry.path)).toContain('executions/exec_1/execution.json');
    expect(materials.entries.map((entry) => entry.path)).toContain('executions/exec_1/execution-log.jsonl');
    expect(JSON.stringify(materials.entries)).not.toContain(storageRoot);
    expect(JSON.stringify(materials.entries)).not.toContain('A123');
    expect(materials.largeFiles[0]).toMatchObject({ kind: 'screenshot', included: false });
  });

  it('uses collectionMode to decide execution log detail', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-exec-collection-'));
    const executionDir = path.join(storageRoot, 'executions', 'exec_1');
    await mkdir(path.join(executionDir, 'logs'), { recursive: true });
    await writeFile(path.join(executionDir, 'execution.json'), JSON.stringify({
      executionId: 'exec_1',
      flowId: 'case_query',
      mode: 'verify',
      dryRun: true,
      headless: false,
      status: 'succeeded',
      createdAt: '2026-06-06T00:00:00.000Z',
      timeoutMs: 1000,
      paramsSummary: {},
    }));
    await writeFile(path.join(executionDir, 'logs', 'stdout.log'), `${'x'.repeat(20000)}tail-marker`);

    const lite = await collectRpaExecutionMaterials({
      storageRoot,
      executionIds: ['exec_1'],
      collectionMode: 'lite',
      redaction: { storageRoot, maskedParamIds: [], params: {} },
      includeSensitiveFiles: false,
    });
    const diagnostic = await collectRpaExecutionMaterials({
      storageRoot,
      executionIds: ['exec_1'],
      collectionMode: 'diagnostic',
      redaction: { storageRoot, maskedParamIds: [], params: {} },
      includeSensitiveFiles: false,
    });

    expect(lite.entries.map((entry) => entry.path)).not.toContain('executions/exec_1/execution-log.jsonl');
    expect(lite.largeFiles).toEqual([expect.objectContaining({ kind: 'log', included: false })]);
    expect(JSON.stringify(diagnostic.entries)).toContain('tail-marker');
    expect(JSON.stringify(diagnostic.entries)).not.toContain('x'.repeat(20000));
  });
});
```

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/observability/rpa-execution-materials.test.ts
```

Expected: FAIL because material collector does not exist.

- [ ] **Step 2: Implement execution directory helpers**

Implement:

```ts
export function resolveExecutionDirForReview(storageRoot: string, executionId: string): string
```

Rules:

- Accept only `exec_[a-zA-Z0-9_]+`.
- Resolve under `<storageRoot>/executions/<executionId>`.
- Throw a public error that does not include `storageRoot`.

- [ ] **Step 3: Implement material collector**

Implement:

```ts
export async function collectRpaExecutionMaterials(input: {
  storageRoot: string;
  executionIds: string[];
  collectionMode: 'lite' | 'diagnostic' | 'review';
  redaction: RpaRedactionOptions;
  includeSensitiveFiles: boolean;
}): Promise<{
  executionRecords: RpaExecutionRecord[];
  entries: ReviewZipEntry[];
  largeFiles: RpaLargeFileReference[];
}>
```

Rules:

- Read `execution.json`, `events.jsonl`, `logs/stdout.log`, and `logs/stderr.log` when present.
- Emit `executions/<executionId>/execution.json`.
- Emit `executions/<executionId>/execution-log.jsonl` according to collection mode:
  - `lite`: omit execution log content; put a `largeFiles` reference with `included=false` and reason `collectionMode lite`.
  - `diagnostic`: emit a redacted tail/summary capped at 16 KiB per stream and event file.
  - `review`: emit redacted full text, subject to bundle size limits.
- Use existing `listExecutionArtifacts` for artifact metadata.
- For screenshots, trace, video, and downloads:
  - default: add only `largeFiles` reference with `included=false`;
  - if `includeSensitiveFiles=true`: include file bodies under `executions/<executionId>/<relativePath>` and mark `included=true`.
- Never emit `run.params.json`.
- Never emit absolute local paths.
- Every large file `path` must be the bundle-relative path where the file would appear if included, such as `extensions/rpa/executions/exec_1/artifacts/screenshots/search.png`.

- [ ] **Step 4: Run collector tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/observability/rpa-execution-materials.test.ts
```

Expected: PASS.

## Task 5: RPA Review Bundle Service

**Files:**

- Modify: `apps/rpa-local-web/src/server/daemon-client.ts`
- Create: `apps/rpa-local-web/src/server/observability/rpa-review-bundle-service.ts`
- Test: `apps/rpa-local-web/tests/server/observability/rpa-review-bundle-service.test.ts`

- [ ] **Step 1: Add failing daemon client tests**

Extend `apps/rpa-local-web/tests/server/daemon-client.test.ts` to cover:

```ts
const response = await client.downloadReviewBundle('run_1');
expect(response).toBeInstanceOf(Response);
expect(fetchImpl).toHaveBeenCalledWith(
  'http://daemon.local/api/runs/run_1/review-bundle/download',
  expect.objectContaining({ headers: { Authorization: 'Bearer secret' }, method: 'GET' }),
);

await client.createRunFeedback({
  runId: 'run_1',
  category: 'selector',
  message: 'wrong selector',
  metadata: { executionId: 'exec_1' },
});

const feedback = await client.listRunFeedback('run_1');
expect(feedback.feedback).toEqual([expect.objectContaining({ category: 'selector' })]);
```

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/daemon-client.test.ts
```

Expected: FAIL because methods do not exist.

- [ ] **Step 2: Implement daemon client additions**

Add:

```ts
downloadReviewBundle(runId: string): Promise<Response>
createRunFeedback(input: {
  runId: string;
  category: string;
  message: string;
  metadata?: unknown;
}): Promise<{ feedback: unknown }>
listRunFeedback(runId: string): Promise<{ feedback: unknown[] }>
```

Use existing auth/error handling patterns.

- [ ] **Step 3: Add failing review bundle service tests**

Test cases:

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { requiredGenerationArtifactNames } from '../../../src/shared/artifacts.js';
import { createMinimalRpaDsl } from '../../../src/shared/dsl-schema.js';
import { createRpaReviewBundleService } from '../../../src/server/observability/rpa-review-bundle-service.js';
import { createUncompressedZip, readUncompressedZipEntries } from '../../../src/server/observability/review-zip.js';

describe('RPA review bundle service', () => {
  it('combines daemon generic bundle with RPA extension entries', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-review-bundle-'));
    const flowDir = path.join(storageRoot, 'flows', 'case_query');
    await mkdir(flowDir, { recursive: true });
    for (const artifactName of requiredGenerationArtifactNames) {
      await writeFile(
        path.join(flowDir, artifactName),
        artifactName === 'flow.dsl.json'
          ? JSON.stringify(createMinimalRpaDsl(), null, 2)
          : `${artifactName}\\n`,
      );
    }

    const daemonClient = {
      downloadReviewBundle: vi.fn(async () => new Response(createUncompressedZip([
        { path: 'manifest.json', content: JSON.stringify({ collectionMode: 'diagnostic' }) },
        { path: 'review-summary.md', content: 'daemon\\n' },
      ]))),
      listRunFeedback: vi.fn(async () => ({ feedback: [] })),
    };

    const service = createRpaReviewBundleService({ storageRoot, daemonClient });
    const bundle = await service.createReviewBundle({
      flowId: 'case_query',
      daemonRunId: 'run_1',
      executionIds: [],
      includeSensitiveFiles: false,
    });
    const entries = Object.fromEntries(readUncompressedZipEntries(bundle.buffer).map((entry) => [entry.path, entry.content.toString('utf8')]));

    expect(entries['review-summary.md']).toBe('daemon\\n');
    expect(entries['extensions/rpa/rpa-summary.md']).toContain('case_query');
    expect(entries['extensions/rpa/rpa-diagnostics.json']).toContain('rpa-diagnostics.v0.1');
    expect(entries['extensions/rpa/dsl-validation.json']).toContain('ok');
    expect(entries['extensions/rpa/artifact-validation.json']).toContain('ok');
  });
});
```

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/observability/rpa-review-bundle-service.test.ts
```

Expected: FAIL because the service does not exist.

- [ ] **Step 4: Implement review bundle service**

Implement:

```ts
export interface RpaReviewBundleService {
  createReviewBundle(input: RpaReviewBundleRequest): Promise<{
    buffer: Buffer;
    fileName: string;
    mimeType: 'application/zip';
    size: number;
  }>;
}
```

Behavior:

- Validate `flowId` with `safeFlowId`.
- Download daemon bundle through `DaemonClient`.
- Parse daemon bundle `manifest.json` and use its `collectionMode` to decide RPA extension log detail.
- Read local flow artifacts from `<storageRoot>/flows/<flowId>/`.
- Build:
  - `extensions/rpa/extension-manifest.json`
  - `extensions/rpa/rpa-summary.md`
  - `extensions/rpa/rpa-diagnostics.json`
  - `extensions/rpa/dsl-validation.json`
  - `extensions/rpa/artifact-validation.json`
  - execution extension entries from Task 4
  - `extensions/rpa/feedback.jsonl` from daemon generic feedback filtered to allowed RPA categories
- Append entries to daemon ZIP.
- File name: `rpa_${flowId}_${daemonRunId}_review_bundle.zip`, sanitized through the route header helper.
- RPA feedback is not stored separately in RPA Web; the service reads daemon generic feedback and emits only entries whose category is in the RPA category allowlist.
- RPA feedback entries should already be redacted at ingestion time by the `POST /api/rpa/feedback` route; bundle export should still run an idempotent RPA redaction pass before writing `feedback.jsonl`.
- The service does not infer `daemonRunId` from `flowId`; the route requires `daemonRunId` and passes it through explicitly.

- [ ] **Step 5: Run service tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/observability/rpa-review-bundle-service.test.ts tests/server/daemon-client.test.ts
```

Expected: PASS.

## Task 6: RPA Summary Markdown

**Files:**

- Create: `apps/rpa-local-web/src/server/observability/rpa-summary.ts`
- Test: `apps/rpa-local-web/tests/server/observability/rpa-summary.test.ts`

- [ ] **Step 1: Add failing summary tests**

Test cases:

```ts
import { describe, expect, it } from 'vitest';
import { createMinimalRpaDsl } from '../../../src/shared/dsl-schema.js';
import { buildRpaSummaryMarkdown } from '../../../src/server/observability/rpa-summary.js';

describe('RPA review summary', () => {
  it('summarizes the RPA goal, source, artifacts, params, diagnostics, and executions without large raw content', () => {
    const summary = buildRpaSummaryMarkdown({
      flowId: 'case_query',
      daemonRunId: 'run_1',
      dsl: createMinimalRpaDsl(),
      diagnostics: {
        missingArtifacts: ['hardening-report.md'],
        fragileSelectors: [{ stepId: 's1', selectorType: 'xpath', path: 'steps[0].target' }],
        executionFailures: [{ executionId: 'exec_1', stepId: 's1', category: 'selector', message: 'target not found' }],
      },
      executionRecords: [{ executionId: 'exec_1', status: 'failed', failedStepId: 's1' }],
    });

    expect(summary).toContain('# RPA Review Summary');
    expect(summary).toContain('case_query');
    expect(summary).toContain('hardening-report.md');
    expect(summary).toContain('exec_1');
    expect(summary).not.toContain('trace.zip content');
  });
});
```

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/observability/rpa-summary.test.ts
```

Expected: FAIL because summary helper does not exist.

- [ ] **Step 2: Implement concise summary**

Sections:

```markdown
# RPA Review Summary

## Flow
## Generation
## DSL And Artifacts
## Parameterization
## Selector Wait Assert Risk
## Executions
## Suggested Skill Improvements
## Files To Inspect Next
```

Rules:

- Keep summary bounded by listing at most 10 items per section.
- Do not inline screenshots, trace, video, downloads, full scripts, or full logs.
- Point to `extensions/rpa/rpa-diagnostics.json`, `dsl-validation.json`, `artifact-validation.json`, and execution files.

- [ ] **Step 3: Run summary tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/observability/rpa-summary.test.ts
```

Expected: PASS.

## Task 7: RPA Review And Feedback Routes

**Files:**

- Modify: `apps/rpa-local-web/src/shared/rpa-api-types.ts`
- Create: `apps/rpa-local-web/src/server/routes/review.ts`
- Modify: `apps/rpa-local-web/src/server/server.ts`
- Test: `apps/rpa-local-web/tests/server/routes/review.test.ts`

- [ ] **Step 1: Add failing route tests**

Test cases:

```ts
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requiredGenerationArtifactNames } from '../../../src/shared/artifacts.js';
import { createMinimalRpaDsl } from '../../../src/shared/dsl-schema.js';
import { createRpaLocalServer } from '../../../src/server/server.js';
import { createUncompressedZip, readUncompressedZipEntries } from '../../../src/server/observability/review-zip.js';

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe('RPA review routes', () => {
  it('downloads a combined RPA review bundle and forwards sanitized RPA feedback', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-review-route-'));
    const flowDir = path.join(storageRoot, 'flows', 'case_query');
    await mkdir(flowDir, { recursive: true });
    for (const artifactName of requiredGenerationArtifactNames) {
      await writeFile(
        path.join(flowDir, artifactName),
        artifactName === 'flow.dsl.json' ? JSON.stringify(createMinimalRpaDsl()) : `${artifactName}\\n`,
      );
    }

    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const pathText = String(url);
      if (pathText.endsWith('/api/runs/run_1/review-bundle/download')) {
        return new Response(createUncompressedZip([
          { path: 'manifest.json', content: JSON.stringify({ collectionMode: 'diagnostic' }) },
          { path: 'review-summary.md', content: 'daemon\\n' },
        ]), {
          status: 200,
          headers: { 'Content-Type': 'application/zip' },
        });
      }
      if (pathText.endsWith('/api/runs/run_1/feedback') && init?.method !== 'POST') {
        return new Response(JSON.stringify({ feedback: [] }), { status: 200 });
      }
      if (pathText.endsWith('/api/runs/run_1/feedback')) {
        return new Response(JSON.stringify({ feedback: { id: 'feedback_1' } }), { status: 201 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

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
      daemonFetch: fetchImpl as typeof fetch,
    });
    const server = app.listen(0);
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    const bundleResponse = await fetch(`${baseUrl}/api/rpa/flows/case_query/review-bundle/download?daemonRunId=run_1`);
    expect(bundleResponse.status).toBe(200);
    expect(bundleResponse.headers.get('content-type')).toContain('application/zip');
    const bundleEntries = Object.fromEntries(readUncompressedZipEntries(Buffer.from(await bundleResponse.arrayBuffer())).map((entry) => [entry.path, entry.content.toString('utf8')]));
    expect(bundleEntries['review-summary.md']).toBe('daemon\\n');
    expect(bundleEntries['extensions/rpa/rpa-summary.md']).toContain('case_query');

    const feedbackResponse = await fetch(`${baseUrl}/api/rpa/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        daemonRunId: 'run_1',
        flowId: 'case_query',
        category: 'selector',
        severity: 'major',
        message: `wrong selector ${storageRoot} 13800138000`,
      }),
    });
    expect(feedbackResponse.status).toBe(201);
    const feedbackCall = fetchImpl.mock.calls.find(([url]) => String(url).endsWith('/api/runs/run_1/feedback'));
    expect(JSON.stringify(feedbackCall?.[1]?.body)).not.toContain(storageRoot);
    expect(JSON.stringify(feedbackCall?.[1]?.body)).not.toContain('13800138000');
  });
});
```

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/routes/review.test.ts
```

Expected: FAIL because routes do not exist.

- [ ] **Step 2: Add shared request/response types**

Add:

```ts
export interface RpaReviewBundleQuery {
  daemonRunId: string;
  executionId?: string | string[];
  includeSensitiveFiles?: boolean;
}

export interface CreateRpaFeedbackRequest {
  daemonRunId: string;
  flowId?: string;
  executionId?: string;
  stepId?: string;
  category: RpaFeedbackCategory;
  severity: RpaFeedbackSeverity;
  message: string;
  artifactPath?: string;
  screenshotPath?: string;
}
```

- [ ] **Step 3: Implement routes**

Register:

```ts
GET /api/rpa/flows/:flowId/review-bundle/download
POST /api/rpa/feedback
```

Rules:

- Validate `flowId`, `daemonRunId`, `executionId`, `category`, and `severity`.
- Parse `includeSensitiveFiles` only from `true | false`; default false.
- Use safe `Content-Disposition` helper in RPA Web, not `res.download` with raw dynamic names.
- Return structured RPA errors without absolute paths.
- Feedback route forwards to daemon generic feedback endpoint with:
  - `category`: the RPA category string
  - `message`: redacted text
  - `metadata`: `flowId`, `executionId`, `stepId`, `severity`, `artifactPath`, `screenshotPath`, `source: "rpa-local-web"`

- [ ] **Step 4: Wire route into server**

In `apps/rpa-local-web/src/server/server.ts`:

- Create `RpaReviewBundleService` with `storageRoot` and `daemonClient`.
- Register review routes after flow/codegen/execution routes.

- [ ] **Step 5: Run route tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/routes/review.test.ts
```

Expected: PASS.

## Task 8: Docs And Main Plan Update

**Files:**

- Modify: `docs/api-reference.md` only if daemon API docs need a cross-reference. Do not document RPA Web endpoints as daemon endpoints.
- Modify: `docs/rpa-skill-observability-design.md` only if implementation clarifies route names.
- Modify: `docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md`

- [x] **Step 1: Update RPA observability design route names**

If the implementation uses the planned endpoint names, add a short “MVP route mapping” section:

```markdown
## MVP Route Mapping

- RPA Web combined bundle export: `GET /api/rpa/flows/:flowId/review-bundle/download?daemonRunId=...`
- RPA feedback submit: `POST /api/rpa/feedback`
- Daemon generic bundle source: `GET /api/runs/:runId/review-bundle/download`
```

- [x] **Step 2: Update main plan status after CC review**

Only after implementation and CC review pass, update:

```markdown
## Slice: RPA Observability Extension And Skill Review Loop (Completed)
```

Add verification commands and CC review summary. Do not mark natural-language generation, import/export, or demo slices complete.

## Task 9: Final Verification And Review

**Files:**

- No code files beyond previous tasks.

- [x] **Step 1: Run targeted RPA observability tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/observability tests/server/routes/review.test.ts
```

Expected: PASS.

- [x] **Step 2: Run RPA package validation**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web test
pnpm --filter @lance-agent-runner/rpa-local-web typecheck
pnpm --filter @lance-agent-runner/rpa-local-web build
```

Expected: all pass. Route tests may need sandbox escalation because they listen on local ports.

- [x] **Step 3: Run repository-level validation**

Run:

```bash
pnpm typecheck
pnpm build
git diff --check
```

Expected: all pass.

- [x] **Step 4: Run daemon boundary grep**

Run:

```bash
rg -n "RPA|Playwright|DSL|selector|screenshot|trace|video|executionId|flowId" apps/daemon/src
```

Expected: only generic words from existing allowed surfaces should appear. If new RPA-specific daemon core matches appear, stop and fix the boundary.

- [x] **Step 5: Request CC review**

Review prompt should state:

```text
Review only the RPA Observability Extension And Skill Review Loop implementation.
Confirm RPA semantics stay in apps/rpa-local-web and daemon core remains generic.
Focus on P0/P1: sensitive file export, redaction, path leakage, bundle merge safety, feedback validation, route validation, and whether this supports improving rpa-script-generate/playwright-rpa-harden.
```

Expected: no P0/P1 before commit.

CC review result: Opus review found no P0/P1 and confirmed the daemon/RPA boundaries. The P2-1 short masked-param text replacement issue was fixed before commit; P2-2 and P2-3 remain follow-up candidates.

## Review Checklist Before Implementation

- [x] Daemon core does not gain RPA-specific semantics.
- [x] RPA Web combined bundle includes generic daemon material plus `extensions/rpa/*`.
- [x] RPA extension summaries are AI-first and bounded.
- [x] `rpa-diagnostics.json` includes bounded lists and omitted counts.
- [x] DSL and artifact validation documents are exported.
- [x] Execution records link `flowId`, `daemonRunId`, and `executionId`.
- [x] Screenshots, trace, video, and downloads are referenced by default, not inlined.
- [x] Explicit sensitive export flag is required before high-sensitive file bodies are included.
- [x] RPA feedback categories are validated by RPA Web and stored by daemon as opaque categories.
- [x] Absolute local storage paths, masked params, phone numbers, ID-like values, tokens, cookies, and storage state do not leak into summaries, JSON, logs, feedback, headers, or route errors.
