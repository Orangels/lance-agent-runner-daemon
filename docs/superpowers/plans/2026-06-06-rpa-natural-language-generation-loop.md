# RPA Natural Language Generation Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the natural-language RPA generation loop so a user can describe a no-login, low-risk flow, answer confirmation forms, receive the same required RPA artifacts as codegen hardening, and verify the generated flow locally.

**Architecture:** Keep all RPA product logic in `apps/rpa-local-web`. The natural-language workflow creates daemon runs with `kind: generate|revise`, `promptMode: business-context`, and `skillId: rpa-script-generate`; daemon remains the generic runner that injects skills/profile constraints and executes Claude Code. Reuse the existing artifact validation, flow storage, question-form UI, executor, runtime verification UI, and review-bundle observability rather than creating a parallel stack.

**Tech Stack:** TypeScript ESM, Express, React/Vite, Vitest, existing daemon HTTP/SSE client, existing RPA DSL/artifact validators, existing local Python/Playwright executor.

---

## Boundaries

This slice must not add RPA, Playwright, DSL, selector, screenshot, trace, video, executor, `flowId`, or `executionId` semantics to `apps/daemon/src`.

Do not make RPA Web read `SKILL.md` bodies or compose the final Claude Code prompt. RPA Web only sends `currentPrompt` and opaque `businessContext`; daemon composes the final prompt.

Do not add daemon core configuration for `chrome-devtools-mcp`. It is enabled only through the `rpa-local` profile's Claude Code `claudeConfigDir` and Claude Code's own MCP configuration.

Do not implement `.rpa.zip` import/export in this slice. That belongs to `流程复用与执行闭环`.

Do not implement SaaS/browserless/browser cluster behavior in this slice.

## API Contract

Add these RPA Web endpoints:

```text
POST /api/rpa/nl/sessions
GET  /api/rpa/nl/sessions/:sessionId
POST /api/rpa/nl/sessions/:sessionId/question-form/answers
POST /api/rpa/nl/sessions/:sessionId/repair
POST /api/rpa/nl/sessions/:sessionId/cancel
```

`POST /api/rpa/nl/sessions` body:

```json
{
  "targetUrl": "https://example.com/cases",
  "flowId": "case_query",
  "flowName": "案件查询",
  "requirement": "打开案件查询页面，按案件号和日期查询，确认结果表格出现。",
  "businessConstraints": "不登录，不提交，不删除，不导出真实数据。",
  "safetyNotes": "所有写操作都必须以 manual 或 write-risk 形式询问用户。"
}
```

The first daemon run must be:

```json
{
  "kind": "generate",
  "promptMode": "business-context",
  "skillId": "rpa-script-generate",
  "collectionMode": "diagnostic",
  "eventVisibility": "normal"
}
```

Follow-up question-form answer runs must be:

```json
{
  "kind": "revise",
  "promptMode": "business-context",
  "skillId": "rpa-script-generate",
  "conversationId": "previous conversation id",
  "businessContext": {
    "stage": "nl-generation-follow-up",
    "previousRunId": "run_...",
    "artifactPaths": ["output/flow.dsl.json", "output/flow.hardened.py"],
    "formAnswers": {}
  }
}
```

Verify-failure repair runs must be:

```json
{
  "kind": "revise",
  "promptMode": "business-context",
  "skillId": "rpa-script-generate",
  "conversationId": "previous conversation id",
  "businessContext": {
    "stage": "nl-generation-repair",
    "previousRunId": "run_...",
    "executionFailure": {
      "executionId": "exec_...",
      "failedStepId": "step_003",
      "status": "failed",
      "error": {
        "code": "STEP_TARGET_NOT_FOUND",
        "message": "target not found"
      },
      "logTail": "...",
      "artifactPaths": ["screenshots/current.png", "trace/trace.zip"]
    },
    "currentArtifacts": [
      "output/flow.dsl.json",
      "output/flow.hardened.py",
      "output/config.example.json"
    ]
  }
}
```

## File Map

Create reusable workflow helpers:

```text
apps/rpa-local-web/src/shared/question-form-types.ts
apps/rpa-local-web/src/server/workflows/question-form-parser.ts
apps/rpa-local-web/src/server/workflows/daemon-run-consumer.ts
apps/rpa-local-web/src/server/workflows/generation-artifact-service.ts
```

Create natural-language workflow:

```text
apps/rpa-local-web/src/shared/natural-language-types.ts
apps/rpa-local-web/src/server/natural-language/nl-session-store.ts
apps/rpa-local-web/src/server/workflows/natural-language-generation-workflow.ts
apps/rpa-local-web/src/server/routes/natural-language.ts
apps/rpa-local-web/src/components/NaturalLanguageWorkspace.tsx
```

Modify existing integration points:

```text
apps/rpa-local-web/src/shared/codegen-types.ts
apps/rpa-local-web/src/server/workflows/codegen-hardening-workflow.ts
apps/rpa-local-web/src/server/server.ts
apps/rpa-local-web/src/api/rpa-api-client.ts
apps/rpa-local-web/src/components/AppShell.tsx
apps/rpa-local-web/src/components/RuntimeVerificationWorkspace.tsx
apps/rpa-local-web/src/styles.css
docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md
```

Tests:

```text
apps/rpa-local-web/tests/server/workflows/question-form-parser.test.ts
apps/rpa-local-web/tests/server/workflows/daemon-run-consumer.test.ts
apps/rpa-local-web/tests/server/workflows/generation-artifact-service.test.ts
apps/rpa-local-web/tests/server/nl-session-store.test.ts
apps/rpa-local-web/tests/server/natural-language-generation-workflow.test.ts
apps/rpa-local-web/tests/server/routes/natural-language.test.ts
apps/rpa-local-web/tests/api/rpa-api-client.test.ts
apps/rpa-local-web/tests/components/NaturalLanguageWorkspace.test.tsx
apps/rpa-local-web/tests/components/RuntimeVerificationWorkspace.test.tsx
apps/rpa-local-web/tests/App.test.tsx
```

---

## Task 1: Shared Question-Form Types And Parser

**Purpose:** Remove question-form parsing from the codegen-only workflow so both codegen hardening and natural-language generation use one parser and one typed model.

**Files:**

- Create: `apps/rpa-local-web/src/shared/question-form-types.ts`
- Create: `apps/rpa-local-web/src/server/workflows/question-form-parser.ts`
- Modify: `apps/rpa-local-web/src/shared/codegen-types.ts`
- Modify: `apps/rpa-local-web/src/components/QuestionForm.tsx`
- Modify: `apps/rpa-local-web/src/server/workflows/codegen-hardening-workflow.ts`
- Test: `apps/rpa-local-web/tests/server/workflows/question-form-parser.test.ts`

- [ ] **Step 1: Add failing parser tests**

Create `apps/rpa-local-web/tests/server/workflows/question-form-parser.test.ts`:

```ts
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

  it('rejects unsupported question types instead of rendering arbitrary controls', () => {
    expect(() =>
      parseQuestionFormFromTranscript(`<question-form id="bad" version="rpa-question-form.v0.1">
{"version":"rpa-question-form.v0.1","questions":[{"id":"x","type":"direction-cards","label":"x"}]}
</question-form>`),
    ).toThrow(/unsupported question type/i);
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

    expect(form?.questions.map((question) => question.type)).toEqual(['text', 'textarea', 'radio', 'checkbox', 'select']);
  });
});
```

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/workflows/question-form-parser.test.ts
```

Expected: FAIL because the parser module does not exist.

- [ ] **Step 2: Create shared question-form types**

Create `apps/rpa-local-web/src/shared/question-form-types.ts` with:

```ts
export type RpaQuestionType = 'text' | 'textarea' | 'radio' | 'checkbox' | 'select';

export interface RpaQuestionOption {
  label: string;
  value: string;
}

export interface RpaQuestionBase {
  id: string;
  type: RpaQuestionType;
  label: string;
  required?: boolean;
  description?: string;
}

export interface RpaTextQuestion extends RpaQuestionBase {
  type: 'text' | 'textarea';
  placeholder?: string;
  defaultValue?: string;
}

export interface RpaChoiceQuestion extends RpaQuestionBase {
  type: 'radio' | 'checkbox' | 'select';
  options: RpaQuestionOption[];
  defaultValue?: string | string[];
}

export type RpaQuestion = RpaTextQuestion | RpaChoiceQuestion;

export interface RpaQuestionForm {
  formId: string;
  version?: 'rpa-question-form.v0.1' | string;
  title?: string;
  description?: string;
  questions: RpaQuestion[];
}

export type RpaQuestionAnswers = Record<string, string | string[] | boolean | number | null>;
```

Modify `apps/rpa-local-web/src/shared/codegen-types.ts` so existing codegen names remain compatible:

```ts
import type {
  RpaQuestion,
  RpaQuestionAnswers,
  RpaQuestionForm,
  RpaQuestionOption,
  RpaQuestionType,
} from './question-form-types.js';

export type CodegenQuestionType = RpaQuestionType;
export type CodegenQuestionOption = RpaQuestionOption;
export type CodegenQuestion = RpaQuestion;
export type CodegenQuestionForm = RpaQuestionForm;
export type CodegenQuestionAnswers = RpaQuestionAnswers;
```

Keep the rest of `codegen-types.ts` unchanged.

- [ ] **Step 3: Implement parser**

Create `apps/rpa-local-web/src/server/workflows/question-form-parser.ts`:

```ts
import type { RpaQuestion, RpaQuestionForm } from '../../shared/question-form-types.js';

const allowedQuestionTypes = new Set(['text', 'textarea', 'radio', 'checkbox', 'select']);

export class QuestionFormParseError extends Error {
  readonly code = 'QUESTION_FORM_INVALID';
}

export function parseQuestionFormFromTranscript(transcript: string): RpaQuestionForm | null {
  const match = transcript.match(/<question-form\b([^>]*)>([\s\S]*?)<\/question-form>/);
  if (!match) return null;

  const attrs = match[1] ?? '';
  const parsed = JSON.parse((match[2] ?? '').trim()) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.questions)) {
    throw new QuestionFormParseError('Question form payload is invalid.');
  }

  const questions = parsed.questions.map(parseQuestion);
  return {
    formId: readAttr(attrs, 'id') ?? 'rpa-question-form',
    version: readString(parsed.version) ?? readAttr(attrs, 'version'),
    title: readString(parsed.title),
    description: readString(parsed.description),
    questions,
  };
}

function parseQuestion(value: unknown): RpaQuestion {
  if (!isRecord(value)) throw new QuestionFormParseError('Question must be an object.');
  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw new QuestionFormParseError('Question id is required.');
  }
  if (typeof value.type !== 'string' || !allowedQuestionTypes.has(value.type)) {
    throw new QuestionFormParseError(`Unsupported question type: ${String(value.type)}.`);
  }
  if (typeof value.label !== 'string' || value.label.length === 0) {
    throw new QuestionFormParseError('Question label is required.');
  }
  if ((value.type === 'radio' || value.type === 'checkbox' || value.type === 'select') && !Array.isArray(value.options)) {
    throw new QuestionFormParseError('Choice question options are required.');
  }
  return value as RpaQuestion;
}

function readAttr(attrs: string, name: string): string | undefined {
  return attrs.match(new RegExp(`${name}="([^"]+)"`))?.[1];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 4: Update codegen workflow to use the parser**

In `apps/rpa-local-web/src/server/workflows/codegen-hardening-workflow.ts`:

- Import `parseQuestionFormFromTranscript`.
- Replace `parseQuestionForm(transcript)` with `parseQuestionFormFromTranscript(transcript)`.
- Remove the local `parseQuestionForm`, `attr`, and duplicate `isRecord` parser helpers if no longer needed.

- [ ] **Step 5: Run parser and codegen workflow tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/workflows/question-form-parser.test.ts tests/server/codegen-hardening-workflow.test.ts
```

Expected: PASS.

---

## Task 2: Shared Daemon Run Consumer And Generation Artifact Service

**Purpose:** Reuse daemon event consumption and artifact persistence between codegen hardening and natural-language generation.

**Files:**

- Create: `apps/rpa-local-web/src/server/workflows/daemon-run-consumer.ts`
- Create: `apps/rpa-local-web/src/server/workflows/generation-artifact-service.ts`
- Modify: `apps/rpa-local-web/src/server/workflows/codegen-hardening-workflow.ts`
- Test: `apps/rpa-local-web/tests/server/workflows/daemon-run-consumer.test.ts`
- Test: `apps/rpa-local-web/tests/server/workflows/generation-artifact-service.test.ts`
- Update: `apps/rpa-local-web/tests/server/codegen-hardening-workflow.test.ts`

- [ ] **Step 1: Add failing daemon run consumer tests**

Create `apps/rpa-local-web/tests/server/workflows/daemon-run-consumer.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { consumeDaemonRun } from '../../../src/server/workflows/daemon-run-consumer.js';

describe('daemon run consumer', () => {
  it('returns transcript and terminal status while forwarding visible log lines', async () => {
    const daemonClient = {
      subscribeRunEvents: vi.fn(async function* () {
        yield { id: '1', event: { type: 'text_delta', delta: 'hello ' } };
        yield { id: '2', event: { type: 'artifact_finalized', artifact: { relativePath: 'output/flow.dsl.json' } } };
        yield { id: '3', event: { type: 'text_delta', delta: 'world' } };
        yield { id: '4', event: { type: 'end', status: 'succeeded' } };
      }),
    };
    const logs: string[] = [];

    const result = await consumeDaemonRun({
      daemonClient,
      runId: 'run_1',
      appendLog: async (message) => {
        logs.push(message);
      },
    });

    expect(result).toEqual({ transcript: 'hello world', terminalStatus: 'succeeded' });
    expect(logs).toContain('Artifact created: output/flow.dsl.json');
  });
});
```

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/workflows/daemon-run-consumer.test.ts
```

Expected: FAIL because module does not exist.

- [ ] **Step 2: Implement daemon run consumer**

Create `apps/rpa-local-web/src/server/workflows/daemon-run-consumer.ts`:

```ts
import {
  isDaemonArtifactFinalizedEvent,
  isDaemonEndEvent,
  isDaemonErrorEvent,
  isDaemonTextDeltaEvent,
} from '../../shared/daemon-event-types.js';

export interface DaemonRunConsumerClient {
  subscribeRunEvents(runId: string, after?: string): AsyncGenerator<{ id: string; event: unknown }>;
}

export interface ConsumeDaemonRunInput {
  daemonClient: DaemonRunConsumerClient;
  runId: string;
  appendLog?: (message: string) => Promise<void>;
}

export interface ConsumedDaemonRun {
  transcript: string;
  terminalStatus?: string;
}

export async function consumeDaemonRun(input: ConsumeDaemonRunInput): Promise<ConsumedDaemonRun> {
  let transcript = '';
  let terminalStatus: string | undefined;
  for await (const record of input.daemonClient.subscribeRunEvents(input.runId)) {
    const { event } = record;
    if (isDaemonTextDeltaEvent(event)) {
      transcript += event.delta;
    } else if (isDaemonArtifactFinalizedEvent(event)) {
      await input.appendLog?.(`Artifact created: ${event.artifact.relativePath}`);
    } else if (isDaemonErrorEvent(event)) {
      await input.appendLog?.(`${event.code ?? 'ERROR'}: ${event.message}`);
    } else if (isDaemonEndEvent(event)) {
      terminalStatus = event.status;
    }
  }
  return { transcript, terminalStatus };
}
```

- [ ] **Step 3: Add failing generation artifact service tests**

Create `apps/rpa-local-web/tests/server/workflows/generation-artifact-service.test.ts` covering:

- successful required artifact download to `flows/<flowId>/`.
- invalid DSL removes temp directory and does not leave final flow.
- required artifact missing fails before download.

Use the same `requiredGenerationArtifactNames`, `createMinimalRpaDsl`, and fake artifact helpers already used by `codegen-hardening-workflow.test.ts`.

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/workflows/generation-artifact-service.test.ts
```

Expected: FAIL because module does not exist.

- [ ] **Step 4: Implement generation artifact service**

Create `apps/rpa-local-web/src/server/workflows/generation-artifact-service.ts`:

```ts
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactsResponse } from '../../shared/daemon-types.js';
import { requiredGenerationArtifactNames, type RpaGenerationArtifact } from '../../shared/artifacts.js';
import { validateGenerationArtifacts } from '../validators/artifact-validator.js';
import { validateRpaDsl } from '../validators/dsl-validator.js';
import { resolveFinalFlowDir } from '../codegen/codegen-session-store.js';

export interface GenerationArtifactDaemonClient {
  listRunArtifacts(runId: string): Promise<ArtifactsResponse>;
  downloadArtifact(input: { runId: string; artifactId: string }): Promise<Response>;
}

export class GenerationArtifactError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'GenerationArtifactError';
  }
}

export async function persistRequiredGenerationArtifacts(input: {
  daemonClient: GenerationArtifactDaemonClient;
  storageRoot: string;
  flowId: string;
  runId: string;
  tempSuffix: string;
}): Promise<RpaGenerationArtifact[]> {
  const artifactsResponse = await input.daemonClient.listRunArtifacts(input.runId);
  const generationArtifacts = artifactsResponse.artifacts
    .filter((artifact) => artifact.relativePath.startsWith('output/'))
    .map((artifact): RpaGenerationArtifact => ({
      artifactId: artifact.id,
      relativePath: artifact.relativePath,
      fileName: artifact.fileName,
      mimeType: artifact.mimeType ?? undefined,
      size: artifact.size ?? 0,
      sha256: artifact.sha256 ?? undefined,
    }));
  const artifactValidation = validateGenerationArtifacts(generationArtifacts);
  if (!artifactValidation.ok) {
    throw new GenerationArtifactError(
      'ARTIFACT_VALIDATION_FAILED',
      `Generated artifacts failed validation: ${artifactValidation.errors.map((issue) => issue.code).join(', ')}.`,
    );
  }

  const finalFlowDir = resolveFinalFlowDir(input.storageRoot, input.flowId);
  const tempFlowDir = `${finalFlowDir}.tmp-${input.tempSuffix}`;
  await rm(tempFlowDir, { recursive: true, force: true });
  await mkdir(tempFlowDir, { recursive: true });
  let promoted = false;
  try {
    for (const artifact of artifactValidation.artifacts) {
      const response = await input.daemonClient.downloadArtifact({ runId: input.runId, artifactId: artifact.artifactId });
      if (!response.ok) {
        throw new GenerationArtifactError('ARTIFACT_DOWNLOAD_FAILED', `Failed to download generation artifact: ${artifact.fileName}.`);
      }
      await writeFile(path.join(tempFlowDir, artifact.fileName), await response.text(), 'utf8');
    }

    const dsl = JSON.parse(await readFile(path.join(tempFlowDir, 'flow.dsl.json'), 'utf8')) as unknown;
    const dslValidation = validateRpaDsl(dsl);
    if (!dslValidation.ok) {
      throw new GenerationArtifactError(
        'DSL_INVALID',
        `Generated DSL failed validation: ${dslValidation.errors.map((issue) => issue.code).join(', ')}.`,
      );
    }

    await rename(tempFlowDir, finalFlowDir);
    promoted = true;
    return artifactValidation.artifacts;
  } finally {
    if (!promoted) {
      await rm(tempFlowDir, { recursive: true, force: true });
    }
  }
}
```

Note: If importing `resolveFinalFlowDir` from the codegen store feels semantically wrong during implementation, move that helper to `apps/rpa-local-web/src/server/flow-store.ts` and update imports in the same task.

- [ ] **Step 5: Update codegen workflow to use shared helpers**

In `apps/rpa-local-web/src/server/workflows/codegen-hardening-workflow.ts`:

- Replace local daemon run event loop with `consumeDaemonRun`.
- Replace local artifact persistence with `persistRequiredGenerationArtifacts`.
- Keep codegen-specific workspace creation and `input/flow.py` upload in the codegen workflow.
- Preserve all existing codegen tests.
- Preserve the existing cancellation behavior: if the session has already become `cancelled`, daemon event completion must not attach a failure error or promote artifacts.
- Preserve the existing terminal failure behavior: if `terminalStatus !== 'succeeded'`, fail with `DAEMON_RUN_FAILED` before artifact validation.
- Preserve existing error-code propagation for thrown workflow/artifact errors.

- [ ] **Step 6: Run shared helper and codegen workflow tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/workflows/daemon-run-consumer.test.ts tests/server/workflows/generation-artifact-service.test.ts tests/server/codegen-hardening-workflow.test.ts
```

Expected: PASS.

---

## Task 3: Natural-Language Session Store And Shared Types

**Purpose:** Add an in-memory local session model for natural-language generation that mirrors codegen session ergonomics without recording-specific fields.

**Files:**

- Create: `apps/rpa-local-web/src/shared/natural-language-types.ts`
- Create: `apps/rpa-local-web/src/server/natural-language/nl-session-store.ts`
- Test: `apps/rpa-local-web/tests/server/nl-session-store.test.ts`

- [ ] **Step 1: Add failing store tests**

Create `apps/rpa-local-web/tests/server/nl-session-store.test.ts`:

```ts
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNaturalLanguageSessionStore } from '../../src/server/natural-language/nl-session-store.js';

describe('natural-language session store', () => {
  it('creates sessions with safe ids and sanitized public output', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-nl-store-'));
    const store = createNaturalLanguageSessionStore({ storageRoot, idFactory: () => 'nl_abc123' });

    const session = await store.createSession({
      flowId: 'case_query',
      flowName: '案件查询',
      targetUrl: 'https://example.com/cases',
      requirement: '按案件号查询。',
      businessConstraints: '不登录。',
      safetyNotes: '不提交。',
    });

    expect(session.sessionId).toBe('nl_abc123');
    expect(session.status).toBe('starting');
    await expect(readdir(path.join(storageRoot, 'nl-sessions', 'nl_abc123'))).resolves.toEqual([]);
    expect(await store.getPublicSession('nl_abc123')).toMatchObject({
      sessionId: 'nl_abc123',
      flowId: 'case_query',
      status: 'starting',
      targetUrl: 'https://example.com/cases',
      questionForm: null,
      artifacts: [],
      error: null,
    });
  });

  it('rejects unsafe flow ids and illegal transitions', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-nl-store-'));
    const store = createNaturalLanguageSessionStore({ storageRoot, idFactory: () => 'nl_abc123' });

    await expect(store.createSession({
      flowId: '../bad',
      targetUrl: 'https://example.com',
      requirement: 'x',
    })).rejects.toThrow(/invalid flow id/i);

    await store.createSession({ flowId: 'case_query', targetUrl: 'https://example.com', requirement: 'x' });
    await expect(store.transition('nl_abc123', 'generated')).rejects.toThrow(/illegal/i);
  });
});
```

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/nl-session-store.test.ts
```

Expected: FAIL because the store does not exist.

- [ ] **Step 2: Define natural-language shared types**

Create `apps/rpa-local-web/src/shared/natural-language-types.ts`:

```ts
import type { RpaQuestionAnswers, RpaQuestionForm } from './question-form-types.js';

export const naturalLanguageSessionStatuses = [
  'starting',
  'generating',
  'needs_input',
  'generated',
  'repairing',
  'failed',
  'cancelled',
] as const;

export type NaturalLanguageSessionStatus = (typeof naturalLanguageSessionStatuses)[number];

export interface StartNaturalLanguageSessionRequest {
  targetUrl: string;
  flowId: string;
  flowName?: string;
  requirement: string;
  businessConstraints?: string;
  safetyNotes?: string;
}

export interface NaturalLanguageArtifactSummary {
  artifactId: string;
  fileName: string;
  relativePath: string;
  size?: number | null;
}

export interface NaturalLanguageSessionStatusResponse {
  sessionId: string;
  flowId: string;
  flowName?: string;
  status: NaturalLanguageSessionStatus;
  targetUrl: string;
  requirement: string;
  daemonRunId?: string;
  workspaceId?: string;
  conversationId?: string;
  logs: string[];
  questionForm: RpaQuestionForm | null;
  artifacts: NaturalLanguageArtifactSummary[];
  error: { code: string; message: string } | null;
}

export interface StartNaturalLanguageSessionResponse {
  sessionId: string;
  flowId: string;
  status: NaturalLanguageSessionStatus;
  targetUrl: string;
}

export interface SubmitNaturalLanguageQuestionAnswersRequest {
  formId: string;
  answers: RpaQuestionAnswers;
}

export interface SubmitNaturalLanguageQuestionAnswersResponse {
  sessionId: string;
  status: NaturalLanguageSessionStatus;
  daemonRunId?: string;
}

export interface RepairNaturalLanguageSessionRequest {
  executionId: string;
  userInstruction?: string;
}
```

- [ ] **Step 3: Implement session store**

Create `apps/rpa-local-web/src/server/natural-language/nl-session-store.ts`.

Use the same storage-root sanitization and max-log pattern as `codegen-session-store.ts`, but without recording fields:

```ts
export interface NaturalLanguageSessionRecord {
  sessionId: string;
  flowId: string;
  flowName?: string;
  targetUrl: string;
  requirement: string;
  businessConstraints?: string;
  safetyNotes?: string;
  status: NaturalLanguageSessionStatus;
  createdAt: string;
  updatedAt: string;
  workspaceId?: string;
  daemonRunId?: string;
  conversationId?: string;
  questionForm: RpaQuestionForm | null;
  artifacts: NaturalLanguageArtifactSummary[];
  logs: string[];
  error: { code: string; message: string } | null;
}
```

The store interface must expose the methods used by workflow and routes:

```ts
export interface NaturalLanguageDaemonRunMetadata {
  workspaceId: string;
  daemonRunId: string;
  conversationId?: string;
}

export interface NaturalLanguageSessionStore {
  createSession(input: StartNaturalLanguageSessionRequest): Promise<NaturalLanguageSessionRecord>;
  getSession(sessionId: string): Promise<NaturalLanguageSessionRecord>;
  getPublicSession(sessionId: string): Promise<NaturalLanguageSessionStatusResponse>;
  transition(sessionId: string, nextStatus: NaturalLanguageSessionStatus): Promise<NaturalLanguageSessionRecord>;
  setDaemonRun(sessionId: string, metadata: NaturalLanguageDaemonRunMetadata): Promise<NaturalLanguageSessionRecord>;
  setQuestionForm(sessionId: string, questionForm: RpaQuestionForm | null): Promise<NaturalLanguageSessionRecord>;
  setArtifacts(sessionId: string, artifacts: NaturalLanguageArtifactSummary[]): Promise<NaturalLanguageSessionRecord>;
  appendLog(sessionId: string, message: string): Promise<NaturalLanguageSessionRecord>;
  setError(sessionId: string, error: { code: string; message: string } | null): Promise<NaturalLanguageSessionRecord>;
}
```

Allowed transitions:

```ts
const allowedTransitions = {
  starting: new Set(['generating', 'cancelled', 'failed']),
  generating: new Set(['needs_input', 'generated', 'failed', 'cancelled']),
  needs_input: new Set(['generating', 'cancelled']),
  generated: new Set(['repairing', 'generated']),
  repairing: new Set(['needs_input', 'generated', 'failed', 'cancelled']),
  failed: new Set([]),
  cancelled: new Set([]),
} satisfies Record<NaturalLanguageSessionStatus, ReadonlySet<NaturalLanguageSessionStatus>>;
```

ID validation:

```ts
export function safeNaturalLanguageSessionId(sessionId: string): string {
  if (!/^nl_[a-zA-Z0-9_]{3,64}$/.test(sessionId)) {
    throw new Error(`Invalid natural-language session id: ${sessionId}`);
  }
  return sessionId;
}
```

Session directory:

```text
<storageRoot>/nl-sessions/<sessionId>/
```

Do not persist user secrets or generated artifacts under the session directory. Final artifacts still go to `flows/<flowId>/`.

- [ ] **Step 4: Run store tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/nl-session-store.test.ts
```

Expected: PASS.

---

## Task 4: Natural-Language Generation Workflow

**Purpose:** Create daemon generate/revise runs for natural-language RPA generation, handle question forms, persist required artifacts, and support verify-failure repair.

**Files:**

- Create: `apps/rpa-local-web/src/server/workflows/natural-language-generation-workflow.ts`
- Test: `apps/rpa-local-web/tests/server/natural-language-generation-workflow.test.ts`

- [ ] **Step 1: Add failing workflow tests**

Create `apps/rpa-local-web/tests/server/natural-language-generation-workflow.test.ts`.

Cover these cases:

1. `startGeneration(sessionId)` creates workspace and daemon `generate + business-context + rpa-script-generate`.
2. A terminal `<question-form>` moves session to `needs_input` before artifact validation.
3. `submitQuestionAnswers` creates `revise + business-context + skillId rpa-script-generate` with previous run id, artifact paths, and answers.
4. Successful daemon run downloads and validates required artifacts into `flows/<flowId>/`.
5. `repairFromExecutionFailure` creates `revise + business-context + skillId rpa-script-generate` with execution failure summary and current artifact paths.
6. A daemon run that ends with `status: "failed"` marks the session `failed` with error code `DAEMON_RUN_FAILED` before artifact validation.
7. `cancel(sessionId)` cancels an active daemon run during `generating` or `repairing`, transitions to `cancelled`, and does not attach a daemon failure error after cancellation.

Use the existing fake daemon pattern from `codegen-hardening-workflow.test.ts`.

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/natural-language-generation-workflow.test.ts
```

Expected: FAIL because workflow does not exist.

- [ ] **Step 2: Implement workflow interfaces**

Create `apps/rpa-local-web/src/server/workflows/natural-language-generation-workflow.ts` with:

```ts
import type {
  ArtifactsResponse,
  CreateRunRequest,
  CreateRunResponse,
  CreateWorkspaceRequest,
  PublicWorkspace,
} from '../../shared/daemon-types.js';
import type {
  RepairNaturalLanguageSessionRequest,
  SubmitNaturalLanguageQuestionAnswersRequest,
} from '../../shared/natural-language-types.js';
import type { NaturalLanguageSessionStore } from '../natural-language/nl-session-store.js';

export interface NaturalLanguageDaemonClient {
  createWorkspace(request: CreateWorkspaceRequest): Promise<PublicWorkspace>;
  createRun(request: CreateRunRequest): Promise<CreateRunResponse>;
  cancelRun(runId: string): Promise<{ ok: true }>;
  listRunArtifacts(runId: string): Promise<ArtifactsResponse>;
  downloadArtifact(input: { runId: string; artifactId: string }): Promise<Response>;
  subscribeRunEvents(runId: string, after?: string): AsyncGenerator<{ id: string; event: unknown }>;
}

export interface NaturalLanguageExecutionReader {
  getStatus(executionId: string): Promise<{ status: string; failedStepId?: string; error?: { code: string; message: string } }>;
  getLogs(executionId: string): Promise<{ stdout: string; stderr: string }>;
  listArtifacts(executionId: string): Promise<{ artifacts: Array<{ role: string; relativePath: string }> }>;
}
```

Workflow methods:

```ts
export interface NaturalLanguageGenerationWorkflow {
  startGeneration(sessionId: string): Promise<void>;
  submitQuestionAnswers(sessionId: string, request: SubmitNaturalLanguageQuestionAnswersRequest): Promise<void>;
  repairFromExecutionFailure(sessionId: string, request: RepairNaturalLanguageSessionRequest): Promise<void>;
  cancel(sessionId: string): Promise<void>;
}
```

- [ ] **Step 3: Implement initial generation run**

`startGeneration` must:

- Transition `starting -> generating`.
- Create daemon workspace:

```ts
{
  profileId: defaultProfileId,
  workspace: {
    originId: 'rpa-local-web',
    userId: 'local-user',
    projectId: `nl_${session.flowId}_${session.sessionId}`,
  },
  metadata: {
    naturalLanguageSessionId: session.sessionId,
    flowId: session.flowId,
    source: 'natural-language',
  },
}
```

- Create daemon run:

```ts
{
  profileId: defaultProfileId,
  workspaceId: workspace.workspaceId,
  kind: 'generate',
  promptMode: 'business-context',
  currentPrompt: `Generate an RPA flow from the user's natural-language requirement for ${session.targetUrl}.`,
  skillId: 'rpa-script-generate',
  collectionMode: 'diagnostic',
  eventVisibility: 'normal',
  businessContext: {
    stage: 'nl-generation',
    naturalLanguageSessionId: session.sessionId,
    flowId: session.flowId,
    targetUrl: session.targetUrl,
    flowName: session.flowName,
    requirement: session.requirement,
    businessConstraints: session.businessConstraints,
    safetyNotes: session.safetyNotes,
    expectedArtifacts: [
      'output/flow.dsl.json',
      'output/flow.hardened.py',
      'output/config.example.json',
      'output/parameterization-report.md',
      'output/hardening-report.md',
    ],
    exploration: {
      chromeDevtoolsMcp: 'profile-provided',
      notesPath: 'notes/',
    },
  },
  metadata: {
    app: 'rpa-local-web',
    workflow: 'nl-generation',
    naturalLanguageSessionId: session.sessionId,
    flowId: session.flowId,
  },
}
```

- Persist workspace/run/conversation ids.
- Consume daemon run with `consumeDaemonRun`.
- If `terminalStatus !== 'succeeded'`, set session error `{ code: 'DAEMON_RUN_FAILED', message: ... }`, transition to `failed`, and return before parsing artifacts.
- If question form exists, store it and transition to `needs_input`.
- Otherwise persist required generation artifacts with `persistRequiredGenerationArtifacts` and transition to `generated`.

Workflow error ownership:

- Once a workflow method has accepted a session, it owns expected workflow failures and should set session state itself.
- Wrap daemon run consumption and artifact persistence in workflow-level `try/catch`.
- Convert `GenerationArtifactError`, `QuestionFormParseError`, and `WorkflowError` into `store.setError(...); transition(..., 'failed')` through a private `failSession()` helper.
- If the session is already `cancelled`, `failSession()` must return without setting an error or transitioning.
- Route-level `markFailed()` is only a safety net for unexpected rejected background promises; it should not be the primary owner for normal daemon/artifact/question-form failures.

Implement this as a shared private helper inside the workflow:

```ts
async function handleConsumedRun(input: {
  sessionId: string;
  runId: string;
  transcript: string;
  terminalStatus?: string;
  nextGeneratedStatus: 'generated';
}): Promise<void> {
  if (input.terminalStatus !== 'succeeded') {
    await failSession(input.sessionId, 'DAEMON_RUN_FAILED', `Daemon run ended with status: ${input.terminalStatus ?? 'unknown'}.`);
    return;
  }
  const questionForm = parseQuestionFormFromTranscript(input.transcript);
  if (questionForm) {
    await store.setQuestionForm(input.sessionId, questionForm);
    await store.transition(input.sessionId, 'needs_input');
    return;
  }
  const artifacts = await persistRequiredGenerationArtifacts({
    daemonClient,
    storageRoot,
    flowId: (await store.getSession(input.sessionId)).flowId,
    runId: input.runId,
    tempSuffix: input.sessionId,
  });
  await store.setArtifacts(input.sessionId, artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    fileName: artifact.fileName,
    relativePath: artifact.relativePath,
    size: artifact.size,
  })));
  await store.transition(input.sessionId, input.nextGeneratedStatus);
}
```

- [ ] **Step 4: Implement question-form follow-up**

`submitQuestionAnswers` must:

- Require session status `needs_input`.
- Require `request.formId === session.questionForm.formId`.
- Transition `needs_input -> generating`.
- Clear question form.
- Create daemon run with:

```ts
{
  kind: 'revise',
  promptMode: 'business-context',
  skillId: 'rpa-script-generate',
  conversationId: session.conversationId,
  currentPrompt: "Continue the natural-language RPA generation after the user's question-form answers.",
  businessContext: {
    stage: 'nl-generation-follow-up',
    naturalLanguageSessionId: session.sessionId,
    flowId: session.flowId,
    flowName: session.flowName,
    previousRunId: session.daemonRunId,
    artifactPaths: session.artifacts.map((artifact) => artifact.relativePath),
    formAnswers: request.answers,
  },
}
```

- Consume daemon run and use the same question-form-or-artifact logic as initial generation.
- Apply the same `terminalStatus !== 'succeeded' -> DAEMON_RUN_FAILED` branch before parsing question forms or artifacts.

- [ ] **Step 5: Implement verify-failure repair**

`repairFromExecutionFailure` must:

- Require an existing daemon workspace/run and generated artifacts.
- Transition `generated -> repairing`.
- Read execution status/logs/artifacts through the injected execution reader.
- Treat execution artifact paths as RPA Web local review references. Do not imply Claude Code can open local executor files from the daemon workspace. The primary repair evidence sent to Claude Code is `failedStepId`, structured error, bounded `stdout/stderr` tails, and current DSL/script/config artifact paths.
- Build a bounded log tail:

```ts
function tail(value: string, maxChars = 4000): string {
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}
```

- Create daemon run with:

```ts
{
  kind: 'revise',
  promptMode: 'business-context',
  skillId: 'rpa-script-generate',
  conversationId: session.conversationId,
  currentPrompt: request.userInstruction ?? 'Repair the generated RPA flow using the local verify failure evidence.',
  businessContext: {
    stage: 'nl-generation-repair',
    naturalLanguageSessionId: session.sessionId,
    flowId: session.flowId,
    flowName: session.flowName,
    previousRunId: session.daemonRunId,
    executionFailure: {
      executionId: request.executionId,
      status: execution.status,
      failedStepId: execution.failedStepId,
      error: execution.error,
      logTail: {
        stdout: tail(logs.stdout),
        stderr: tail(logs.stderr),
      },
      artifactPaths: artifacts.artifacts.map((artifact) => artifact.relativePath),
    },
    currentArtifacts: session.artifacts.map((artifact) => artifact.relativePath),
  },
}
```

- Consume daemon run and use the same question-form-or-artifact logic.
- Apply the same `terminalStatus !== 'succeeded' -> DAEMON_RUN_FAILED` branch before parsing question forms or artifacts.

- [ ] **Step 6: Implement cancellation**

`cancel` must:

- If current status is `generating`, `repairing`, or `needs_input`, transition to `cancelled`.
- If a daemon run is active in `generating` or `repairing`, call `daemonClient.cancelRun(daemonRunId)`.
- Do not attach daemon failure errors to already cancelled sessions.

- [ ] **Step 7: Run workflow tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/natural-language-generation-workflow.test.ts
```

Expected: PASS.

---

## Task 5: Natural-Language Routes And Server Wiring

**Purpose:** Expose the natural-language workflow through RPA Web backend APIs.

**Files:**

- Create: `apps/rpa-local-web/src/server/routes/natural-language.ts`
- Modify: `apps/rpa-local-web/src/server/server.ts`
- Test: `apps/rpa-local-web/tests/server/routes/natural-language.test.ts`
- Test: `apps/rpa-local-web/tests/server/server.test.ts`

- [ ] **Step 1: Add failing route tests**

Create `apps/rpa-local-web/tests/server/routes/natural-language.test.ts`.

Test cases:

- `POST /api/rpa/nl/sessions` validates URL, flow id, and requirement, triggers `workflow.startGeneration(sessionId)` in the background, then returns `202` without waiting for the daemon run to finish.
- `POST /api/rpa/nl/sessions` still returns `202` when a fake `startGeneration` promise remains pending, proving the route is fire-and-forget.
- `GET /api/rpa/nl/sessions/:sessionId` returns public session.
- `POST /api/rpa/nl/sessions/:sessionId/question-form/answers` triggers workflow with form answers in the background and returns `202`.
- `POST /api/rpa/nl/sessions/:sessionId/repair` triggers workflow with execution id and optional instruction in the background and returns `202`.
- `POST /api/rpa/nl/sessions/:sessionId/cancel` cancels workflow.
- Errors redact `storageRoot`.

Use fake store/workflow objects the same way codegen route tests do.

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/routes/natural-language.test.ts
```

Expected: FAIL because routes do not exist.

- [ ] **Step 2: Implement route parser and handlers**

Create `apps/rpa-local-web/src/server/routes/natural-language.ts`.

Validation rules:

- `targetUrl` must be `http:` or `https:`.
- `flowId` must pass `safeFlowId`.
- `requirement` must be a non-empty string.
- `flowName`, `businessConstraints`, and `safetyNotes` are optional strings.
- `answers` must be a JSON object.
- `executionId` must be a string.

Register endpoints:

```ts
app.post('/api/rpa/nl/sessions', ...)
app.get('/api/rpa/nl/sessions/:sessionId', ...)
app.post('/api/rpa/nl/sessions/:sessionId/question-form/answers', ...)
app.post('/api/rpa/nl/sessions/:sessionId/repair', ...)
app.post('/api/rpa/nl/sessions/:sessionId/cancel', ...)
```

Route errors should mirror `CodegenRouteError` style:

```json
{ "error": { "code": "INVALID_REQUEST", "message": "requirement is required." } }
```

The `POST /api/rpa/nl/sessions` handler must not `await workflow.startGeneration(sessionId)`. It must create the session, start the workflow in the background, and return the public session immediately:

```ts
const session = await createSession(options.store, request);
void options.workflow.startGeneration(session.sessionId).catch(async (error) => {
  await options.store.setError(session.sessionId, {
    code: routeErrorCode(error),
    message: routeErrorMessage(error),
  });
  const latest = await options.store.getSession(session.sessionId);
  if (latest.status !== 'failed' && latest.status !== 'cancelled') {
    await options.store.transition(session.sessionId, 'failed');
  }
});
res.status(202).json(await options.store.getPublicSession(session.sessionId));
```

Question-form answer and repair handlers also call Claude Code and may take minutes, so they must use the same fire-and-forget pattern and return `202` after accepting the continuation request. The only difference is that they do not create a new session first; they start from an existing `sessionId`.

For question-form answers:

```ts
const request = parseAnswersBody(req.body);
const sessionId = String(req.params.sessionId);
void options.workflow.submitQuestionAnswers(sessionId, request).catch((error) =>
  markFailed(options.store, sessionId, routeErrorCode(error), routeErrorMessage(error)),
);
res.status(202).json(await options.store.getPublicSession(sessionId));
```

For repair:

```ts
const request = parseRepairBody(req.body);
const sessionId = String(req.params.sessionId);
void options.workflow.repairFromExecutionFailure(sessionId, request).catch((error) =>
  markFailed(options.store, sessionId, routeErrorCode(error), routeErrorMessage(error)),
);
res.status(202).json(await options.store.getPublicSession(sessionId));
```

Implement `markFailed()` with the same cancelled-session guard used by the codegen routes so background failures do not overwrite cancelled sessions.

- [ ] **Step 3: Wire store and workflow in server**

In `apps/rpa-local-web/src/server/server.ts`:

- Create `nlStore = createNaturalLanguageSessionStore({ storageRoot })`.
- Create `nlWorkflow = createNaturalLanguageGenerationWorkflow({ daemonClient, executionReader: executor, defaultProfileId, storageRoot, store: nlStore })`.
- Register routes after codegen routes:

```ts
registerNaturalLanguageRoutes(app, {
  storageRoot: input.config.storageRoot,
  store: nlStore,
  workflow: nlWorkflow,
});
```

- [ ] **Step 4: Run route/server tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/routes/natural-language.test.ts tests/server/server.test.ts
```

Expected: PASS.

---

## Task 6: RPA API Client Natural-Language Methods

**Purpose:** Add typed browser client methods for the new natural-language APIs.

**Files:**

- Modify: `apps/rpa-local-web/src/api/rpa-api-client.ts`
- Test: `apps/rpa-local-web/tests/api/rpa-api-client.test.ts`

- [ ] **Step 1: Add failing API client tests**

In `apps/rpa-local-web/tests/api/rpa-api-client.test.ts`, add tests that assert exact paths and request bodies for:

```ts
client.startNaturalLanguageSession(request)
client.getNaturalLanguageSession('nl_1')
client.submitNaturalLanguageQuestionAnswers('nl_1', { formId: 'qf_1', answers: { date: '2026-06-06' } })
client.repairNaturalLanguageSession('nl_1', { executionId: 'exec_1', userInstruction: 'Fix selector' })
client.cancelNaturalLanguageSession('nl_1')
```

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/api/rpa-api-client.test.ts
```

Expected: FAIL because methods do not exist.

- [ ] **Step 2: Implement API client methods**

In `apps/rpa-local-web/src/api/rpa-api-client.ts`, import natural-language types and add:

```ts
startNaturalLanguageSession(request: StartNaturalLanguageSessionRequest): Promise<StartNaturalLanguageSessionResponse> {
  return this.requestJson('/api/rpa/nl/sessions', { method: 'POST', body: JSON.stringify(request) });
}

getNaturalLanguageSession(sessionId: string): Promise<NaturalLanguageSessionStatusResponse> {
  return this.requestJson(`/api/rpa/nl/sessions/${encodeURIComponent(sessionId)}`);
}

submitNaturalLanguageQuestionAnswers(
  sessionId: string,
  request: SubmitNaturalLanguageQuestionAnswersRequest,
): Promise<SubmitNaturalLanguageQuestionAnswersResponse> {
  return this.requestJson(`/api/rpa/nl/sessions/${encodeURIComponent(sessionId)}/question-form/answers`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

repairNaturalLanguageSession(
  sessionId: string,
  request: RepairNaturalLanguageSessionRequest,
): Promise<SubmitNaturalLanguageQuestionAnswersResponse> {
  return this.requestJson(`/api/rpa/nl/sessions/${encodeURIComponent(sessionId)}/repair`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

cancelNaturalLanguageSession(sessionId: string): Promise<{ sessionId: string; status: NaturalLanguageSessionStatus }> {
  return this.requestJson(`/api/rpa/nl/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST' });
}
```

- [ ] **Step 3: Run API client tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/api/rpa-api-client.test.ts
```

Expected: PASS.

---

## Task 7: Runtime Verification Repair Callback

**Purpose:** Let natural-language UI detect failed local verify runs and offer a repair action without duplicating runtime UI internals.

**Files:**

- Modify: `apps/rpa-local-web/src/components/RuntimeVerificationWorkspace.tsx`
- Test: `apps/rpa-local-web/tests/components/RuntimeVerificationWorkspace.test.tsx`

- [ ] **Step 1: Add failing callback test**

In `apps/rpa-local-web/tests/components/RuntimeVerificationWorkspace.test.tsx`, add:

```tsx
it('notifies callers when an execution completes failed', async () => {
  const client = new FakeRuntimeClient();
  const onExecutionCompleted = vi.fn();
  render(<RuntimeVerificationWorkspace client={client} onExecutionCompleted={onExecutionCompleted} />);

  await screen.findByText('案件查询');
  await userEvent.click(screen.getByRole('button', { name: /Start/ }));

  await act(async () => {
    client.emit({ type: 'step.failed', executionId: 'exec_1', stepId: 's1', sequence: 1 });
    client.emit({ type: 'run.completed', executionId: 'exec_1', status: 'failed', exitCode: 1, sequence: 2 });
  });

  await waitFor(() =>
    expect(onExecutionCompleted).toHaveBeenCalledWith(expect.objectContaining({
      executionId: 'exec_1',
      status: 'failed',
      failedStepId: 's1',
    })),
  );
});
```

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/components/RuntimeVerificationWorkspace.test.tsx
```

Expected: FAIL because prop does not exist.

- [ ] **Step 2: Add callback type and invocation**

In `RuntimeVerificationWorkspace.tsx`:

```ts
export interface RuntimeExecutionCompletedSummary {
  executionId: string;
  status: RpaExecutionStatus;
  failedStepId?: string;
}
```

Add prop:

```ts
onExecutionCompleted?: (summary: RuntimeExecutionCompletedSummary) => void;
```

When handling `run.completed`, after refreshing status, call callback with the freshest known data. If `refreshStatus` returns only a partial shape today, update `RuntimeVerificationApiClient.getExecutionStatus` return type to include `executionId` and keep existing fake clients compatible.

- [ ] **Step 3: Run runtime workspace tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/components/RuntimeVerificationWorkspace.test.tsx
```

Expected: PASS.

---

## Task 8: Natural-Language Workspace UI

**Purpose:** Replace the natural-language placeholder with a real operational workflow that starts generation, renders daemon progress, handles question forms, verifies generated flows, and repairs failed verify runs.

**Files:**

- Create: `apps/rpa-local-web/src/components/NaturalLanguageWorkspace.tsx`
- Modify: `apps/rpa-local-web/src/components/AppShell.tsx`
- Modify: `apps/rpa-local-web/src/styles.css`
- Test: `apps/rpa-local-web/tests/components/NaturalLanguageWorkspace.test.tsx`
- Update: `apps/rpa-local-web/tests/App.test.tsx`

- [ ] **Step 1: Add failing UI tests**

Create `apps/rpa-local-web/tests/components/NaturalLanguageWorkspace.test.tsx`.

Cover:

1. User fills target URL, flow id, requirement, constraints, safety notes, and clicks `Generate flow`.
2. Component shows daemon logs/artifacts through `DaemonHardeningPanel`.
3. Component renders `QuestionForm` and submits answers.
4. When status is `generated`, clicking `Verify flow` reveals `RuntimeVerificationWorkspace` preloaded with the generated `flowId` and `daemonRunId`; it does not auto-start by default so users can fill required runtime params first.
5. When runtime verify completes failed, component shows `Repair with Claude Code`; clicking it calls `repairNaturalLanguageSession(sessionId, { executionId })`.

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/components/NaturalLanguageWorkspace.test.tsx
```

Expected: FAIL because component does not exist.

- [ ] **Step 2: Implement component props and client interface**

Create `apps/rpa-local-web/src/components/NaturalLanguageWorkspace.tsx`:

```ts
export interface NaturalLanguageApiClient {
  startNaturalLanguageSession(request: StartNaturalLanguageSessionRequest): Promise<StartNaturalLanguageSessionResponse>;
  getNaturalLanguageSession(sessionId: string): Promise<NaturalLanguageSessionStatusResponse>;
  cancelNaturalLanguageSession(sessionId: string): Promise<{ sessionId: string; status: NaturalLanguageSessionStatus }>;
  submitNaturalLanguageQuestionAnswers(
    sessionId: string,
    request: SubmitNaturalLanguageQuestionAnswersRequest,
  ): Promise<SubmitNaturalLanguageQuestionAnswersResponse>;
  repairNaturalLanguageSession(
    sessionId: string,
    request: RepairNaturalLanguageSessionRequest,
  ): Promise<SubmitNaturalLanguageQuestionAnswersResponse>;
}
```

Use default `new RpaApiClient()` when no client prop is injected.

- [ ] **Step 3: Implement form and polling**

Fields:

- Target URL default `https://example.com`.
- Flow ID default `case_query`.
- Flow name optional.
- Requirement textarea.
- Business constraints textarea default `No login, no captcha, no CA/USB-Key, no real write operation.`
- Safety notes textarea default `Ask before uncertain page branches or write-risk actions.`

Polling should match `CodegenWorkspace`: poll every second while status is not terminal and clear interval on unmount.

Terminal statuses for polling:

```ts
const terminalStatuses = new Set<NaturalLanguageSessionStatus>(['generated', 'failed', 'cancelled']);
```

- [ ] **Step 4: Render shared panels**

Use:

- `DaemonHardeningPanel` for logs/artifacts.
- `QuestionForm` for `session.questionForm`.
- `RuntimeVerificationWorkspace` when generated and user clicks `Verify flow`.

Do not pass `autoStartRequest` for the natural-language path by default. Natural-language DSL often contains required params that are unknown until the user reviews the generated flow; the user should fill the runtime params JSON in `RuntimeVerificationWorkspace` and then start verify manually.

Preload verification with:

```ts
<RuntimeVerificationWorkspace flowId={session.flowId} onFlowIdChange={() => undefined} />
```

If a later implementation adds a typed parameter form from `flow.dsl.json.params`, that can become the source of an explicit `autoStartRequest`; do not use `params: {}` as the default natural-language verify behavior.

- [ ] **Step 5: Implement repair UI**

Track last completed runtime execution summary through `onExecutionCompleted`.

When `summary.status === 'failed'`, render:

```text
Repair with Claude Code
```

Clicking it calls:

```ts
client.repairNaturalLanguageSession(session.sessionId, {
  executionId: summary.executionId,
})
```

Then refreshes the session and resumes polling.

- [ ] **Step 6: Wire natural-language tab**

In `AppShell.tsx`:

```tsx
import { NaturalLanguageWorkspace } from './NaturalLanguageWorkspace.js';
```

Render:

```tsx
{activeSection.id === 'natural-language' ? (
  <NaturalLanguageWorkspace />
) : ...}
```

Status badge for natural-language should no longer say `Skeleton`.

- [ ] **Step 7: Run UI tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/components/NaturalLanguageWorkspace.test.tsx tests/App.test.tsx
```

Expected: PASS.

---

## Task 9: Chrome-DevTools MCP Profile Boundary Documentation

**Purpose:** Make the natural-language implementation's MCP boundary explicit without changing daemon core.

**Files:**

- Modify: `docs/configuration-reference.md`
- Modify: `docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md`

- [ ] **Step 1: Update configuration docs**

In `docs/configuration-reference.md`, add a short note under `profiles[].claudeConfigDir` or `profiles[].allowedSkillIds`:

```markdown
For the RPA local profile, `chrome-devtools-mcp` is configured through the Claude Code config directory referenced by `claudeConfigDir`. The daemon does not have RPA-specific MCP fields; it only passes `CLAUDE_CONFIG_DIR` to the Claude Code child process. The `rpa-local` profile should allow both `rpa-script-generate` and `playwright-rpa-harden`.
```

- [ ] **Step 2: Verify main plan link and defer completion status**

`docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md` should already contain:

```markdown
**Execution plan:** `docs/superpowers/plans/2026-06-06-rpa-natural-language-generation-loop.md`
```

under `## Slice: 自然语言生成闭环`.

Do not mark `自然语言生成闭环` completed until after tests and CC review pass.

- [ ] **Step 3: Run docs check**

Run:

```bash
git diff --check
```

Expected: PASS.

---

## Task 10: Final Verification And Review

**Purpose:** Verify the slice end to end and get CC review before commit.

**Files:**

- Modify: `docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md`
- Possibly update this plan with completion notes.

- [ ] **Step 1: Run targeted natural-language tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run \
  tests/server/workflows/question-form-parser.test.ts \
  tests/server/workflows/daemon-run-consumer.test.ts \
  tests/server/workflows/generation-artifact-service.test.ts \
  tests/server/nl-session-store.test.ts \
  tests/server/natural-language-generation-workflow.test.ts \
  tests/server/routes/natural-language.test.ts \
  tests/components/NaturalLanguageWorkspace.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run RPA package validation**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web test
pnpm --filter @lance-agent-runner/rpa-local-web typecheck
pnpm --filter @lance-agent-runner/rpa-local-web build
```

Expected: all pass.

- [ ] **Step 3: Run repository validation**

Run:

```bash
pnpm typecheck
pnpm build
git diff --check
```

Expected: all pass.

- [ ] **Step 4: Run daemon boundary grep**

Run:

```bash
rg -n "RPA|Playwright|DSL|selector|screenshot|trace|video|executionId|flowId|chrome-devtools|mcp" apps/daemon/src
```

Expected: no new RPA/MCP-specific daemon core matches. If matches appear, stop and move that logic back to RPA Web/profile docs.

- [ ] **Step 5: Request CC review with opus**

Use model `opus` and a 20-minute timeout.

Review prompt:

```text
Review only the RPA Natural Language Generation Loop implementation.

Confirm:
- RPA semantics stay in apps/rpa-local-web.
- daemon core remains generic and does not gain RPA/Playwright/DSL/chrome-devtools-mcp logic.
- Natural-language initial run uses generate + business-context + skillId rpa-script-generate.
- Question-form follow-up and verify-failure repair use revise + business-context + skillId rpa-script-generate with explicit businessContext.
- RPA Web never reads SKILL.md body or composes final Claude Code prompt.
- chrome-devtools-mcp remains profile/Claude Code config owned, not daemon-owned.
- Required artifacts are downloaded, validated, and stored in RPA Web flow storage exactly like codegen.
- Runtime verification UI is reused and repair flow uses execution failure evidence without absolute path leakage.

Output:
1. Overall judgment: can this proceed to commit?
2. P0/P1 findings only, with file/line references and concrete fixes.
3. P2 follow-ups, maximum 3.
4. Boundary verdict against the design docs.
```

Expected: no P0/P1 before commit.

- [ ] **Step 6: Mark main plan slice completed after CC review**

Only after verification and CC review:

- Change heading to `## Slice: 自然语言生成闭环 (Completed)`.
- Check off all tasks in that slice.
- Add verification command list.
- Add CC review summary.
- Do not mark `流程复用与执行闭环` or `Demo Flow And Compatibility Gate` completed.

- [ ] **Step 7: Commit**

Commit message:

```bash
git add apps/rpa-local-web docs/configuration-reference.md docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md docs/superpowers/plans/2026-06-06-rpa-natural-language-generation-loop.md
git commit -m "Implement natural language RPA generation loop"
```

## Deferred Follow-Ups

These are explicitly outside this slice and must not be bundled into the natural-language implementation:

- Align the existing codegen question-form answers route with the fire-and-forget pattern used by natural-language answers/repair. This is a route behavior consistency improvement for the completed codegen flow, not a blocker for `自然语言生成闭环`.

## Self-Review Checklist

- [x] The plan does not require daemon core to understand RPA, DSL, Playwright, chrome-devtools-mcp, `flowId`, or `executionId`.
- [x] Natural-language and codegen paths share question-form parsing and generation artifact persistence.
- [x] Initial generation, question-form follow-up, and verify repair all use `business-context`.
- [x] RPA Web never reads `SKILL.md` body.
- [x] The UI reuses `QuestionForm`, `DaemonHardeningPanel`, and `RuntimeVerificationWorkspace`.
- [x] All generated required artifacts are validated before being promoted to `flows/<flowId>/`.
- [x] The plan includes tests for routes, workflow, API client, UI, and daemon boundary.
- [x] The plan does not mark import/export or demo slices complete.
