# Daemon Generic Review Bundle And Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add business-agnostic daemon review-bundle export, complete log download, generic feedback storage, and stronger redaction so business skill runs can be reviewed without polluting daemon core with RPA semantics.

**Architecture:** Keep all feature logic inside daemon generic modules. `RunLogService` owns complete sanitized log downloads; `ReviewBundleService` reads existing run, message, snapshot, log, artifact, and feedback records to build an on-demand bundle; `run_feedback` stores opaque feedback categories without daemon interpretation; HTTP routes only authenticate, validate, and stream service outputs. RPA-specific diagnostics remain deferred to the next slice through a generic extension-provider hook.

**Tech Stack:** TypeScript, Express, SQLite via `better-sqlite3`, Node filesystem APIs, an internal uncompressed ZIP writer, Vitest.

---

## Boundaries

This slice must not add RPA terms, Playwright terms, DSL validation, executor concepts, screenshots, traces, or RPA feedback category validation to `apps/daemon/src`.

This slice may add a generic review bundle extension hook. The default daemon app should pass no extension providers. The next RPA observability slice can decide whether to consume this hook or build a RPA-side bundle wrapper.

`collectionMode` continues to control what was persisted at run time. This slice must not retroactively reconstruct prompt, skill, or business context bodies when the stored snapshot says `persisted = false`.

`eventVisibility` continues to control real-time and run-detail event filtering only. It must not decide bundle persistence or bundle export contents.

## API Contract

Add these daemon endpoints:

```text
GET  /api/runs/:runId/logs/stdout/download
GET  /api/runs/:runId/logs/stderr/download
GET  /api/runs/:runId/logs/debug-events/download
GET  /api/runs/:runId/review-bundle/download
POST /api/runs/:runId/feedback
GET  /api/runs/:runId/feedback
```

Permission rules:

- `stdout/download` and `stderr/download` require readable run ownership plus `client.canReadLogs = true`.
- `debug-events/download` requires readable run ownership plus `client.canReadDebugEvents = true`.
- `review-bundle/download` requires readable run ownership plus `client.canReadLogs = true`; debug-only files are included only when `client.canReadDebugEvents = true`.
- `POST /feedback` and `GET /feedback` require readable run ownership. Feedback text and metadata are sanitized before persistence and before bundle export.

Bundle content type:

```text
Content-Type: application/zip
Content-Disposition: attachment; filename="run_<runId>_review_bundle.zip"
```

Use an internal uncompressed ZIP writer rather than adding a dependency.

## Bundle Layout

The generic bundle should contain:

```text
business-skill-review-bundle.zip
+-- manifest.json
+-- request.json
+-- prompt-snapshot.md
+-- profile-snapshot.json
+-- skill/
|   +-- SKILL.md
|   +-- side-files-manifest.json
+-- logs/
|   +-- stdout.log
|   +-- stderr.log
|   +-- debug-events.ndjson
+-- messages.filtered.json
+-- messages.debug.json
+-- artifacts/
|   +-- manifest.json
+-- diagnostics.json
+-- review-summary.md
+-- large-files-manifest.json
+-- feedback.jsonl
+-- extensions/
```

Rules:

- Include `logs/debug-events.ndjson` and `messages.debug.json` only when the requester has `canReadDebugEvents`.
- Include `skill/SKILL.md` only when a skill snapshot body is persisted. Always include `skill/side-files-manifest.json` when a skill snapshot row exists.
- Include artifact metadata in `artifacts/manifest.json`; do not inline artifact file bodies in this generic slice.
- Include `extensions/.keep` or omit `extensions/` when there are no extension providers. Do not create RPA extension files here.
- `large-files-manifest.json` should reference log and artifact metadata by path, size, hash when known, and reason.
- Enforce `server.maxReviewBundleBytes` before returning the ZIP buffer. If the bundle would exceed the cap, return a structured `REVIEW_BUNDLE_TOO_LARGE` error instead of allocating an oversized buffer.

`manifest.json` minimum schema:

```json
{
  "schemaVersion": "business-skill-review-bundle.v0.1",
  "runId": "run_123",
  "conversationId": "conv_123",
  "workspaceId": "ws_123",
  "collectionMode": "diagnostic",
  "redaction": { "applied": true, "version": "generic-v0.1" },
  "snapshots": {
    "prompt": { "persisted": true, "hash": "sha256:...", "byteCount": 1234 },
    "skill": { "persisted": true, "skillId": "skill-id", "bodyHash": "sha256:..." },
    "businessContext": { "persisted": true, "hash": "sha256:..." }
  },
  "files": [],
  "extensions": []
}
```

`diagnostics.json` minimum schema:

```json
{
  "schemaVersion": "business-skill-diagnostics.v0.1",
  "runId": "run_123",
  "collectionMode": "diagnostic",
  "missingFiles": [],
  "omittedFiles": [],
  "redactionApplied": true,
  "size": { "byteCount": 0, "maxReviewBundleBytes": 0 }
}
```

`review-summary.md` minimum sections:

```markdown
# Run Review Summary

## Task
## Skill And Snapshots
## Prompt And Context
## Artifacts
## Logs And Diagnostics
## Suggested Next Checks
```

## Task 1: Repository And Schema For Generic Feedback

**Files:**

- Modify: `apps/daemon/src/db/schema.ts`
- Modify: `apps/daemon/src/db/repositories.ts`
- Test: `apps/daemon/tests/db/repositories.test.ts`

- [x] **Step 1: Add failing repository tests for feedback ownership and ordering**

Add tests that insert two workspaces and runs, create feedback for `run_1`, and assert:

```ts
expect(listRunFeedbackForClient(db, { runId: 'run_1', clientId: 'lqbot' })).toHaveLength(2);
expect(listRunFeedbackForClient(db, { runId: 'run_1', clientId: 'other' })).toBeNull();
expect(listRunFeedbackForClient(db, { runId: 'run_1', clientId: 'admin', isAdmin: true })?.[0]).toMatchObject({
  runId: 'run_1',
  clientId: 'lqbot',
  category: 'prompt',
});
```

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run tests/db/repositories.test.ts
```

Expected: FAIL because `run_feedback` and repository helpers do not exist.

- [x] **Step 2: Add `run_feedback` table**

Add:

```sql
CREATE TABLE IF NOT EXISTS run_feedback (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_run_feedback_run_created
  ON run_feedback(run_id, created_at);
```

- [x] **Step 3: Add repository records and helpers**

Add `RunFeedbackRecord` plus:

```ts
export function insertRunFeedback(
  db: RunnerDatabase,
  input: {
    id: string;
    runId: string;
    clientId: string;
    category: string;
    message: string;
    metadata: unknown;
    now: number;
  },
): RunFeedbackRecord

export function listRunFeedbackForClient(
  db: RunnerDatabase,
  input: { runId: string; clientId: string; isAdmin?: boolean },
): RunFeedbackRecord[] | null
```

`listRunFeedbackForClient` must return `null` when the run is not readable by the client.

- [x] **Step 4: Run repository tests**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run tests/db/repositories.test.ts
```

Expected: PASS.

## Task 2: Redaction Utilities For Review Materials

**Files:**

- Modify: `apps/daemon/src/core/log-sanitizer.ts`
- Test: `apps/daemon/tests/core/log-sanitizer.test.ts`

- [x] **Step 1: Add failing sanitizer tests**

Cover:

```ts
expect(sanitizeLogText('password=hunter2 cookie=session private_key=abc')).not.toContain('hunter2');
expect(sanitizeLogText('storage_state=/tmp/state.json token=my-token')).not.toContain('/tmp/state.json');
expect(sanitizeReviewValue({ password: 'secret', nested: { token: 'abc' } })).toEqual({
  password: '[redacted]',
  nested: { token: '[redacted]' },
});
expect(sanitizeReviewValue({ path: '/home/orangels/project/file.txt' })).toEqual({
  path: '[redacted-path]',
});
```

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run tests/core/log-sanitizer.test.ts
```

Expected: FAIL because `sanitizeReviewValue` does not exist and current patterns are narrower.

- [x] **Step 2: Extend sanitizer without business semantics**

Add:

```ts
export function sanitizeReviewValue(value: unknown): unknown
export function sanitizeReviewJsonText(text: string): string
```

Rules:

- Extend `sanitizeLogText` itself so run log writing and review bundle text use the same minimum redaction strength. Merge existing `cookie|token|api[_-]?key` coverage with `password|passwd|secret|private_key|privateKey|storage_state|storageState`.
- Redact values for keys matching `password`, `passwd`, `secret`, `token`, `apiKey`, `api_key`, `cookie`, `authorization`, `privateKey`, `private_key`, `storage_state`, `storageState`.
- Redact bearer tokens, Anthropic-style `sk-ant-*`, `CLAUDE_CONFIG_DIR=...`, and POSIX absolute paths.
- Preserve relative paths such as `output/report.docx` and workspace-relative artifact paths.
- Limit recursive object traversal with a `WeakSet` to avoid cycles.
- Keep a regression assertion that existing log behavior still redacts bearer tokens and sandbox absolute paths while preserving relative paths such as `output/report.docx`.

- [x] **Step 3: Run sanitizer tests**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run tests/core/log-sanitizer.test.ts
```

Expected: PASS.

## Task 3: Generic Feedback Service

**Files:**

- Create: `apps/daemon/src/core/run-feedback-service.ts`
- Modify: `apps/daemon/src/core/ids.ts`
- Test: `apps/daemon/tests/core/run-feedback-service.test.ts`

- [x] **Step 1: Add failing service tests**

Cover:

- creating feedback validates run ownership and stores the authenticated `client.id`.
- feedback message and metadata are sanitized before persistence.
- listing feedback for another non-admin client returns `NOT_FOUND`.
- category is stored as an opaque string such as `custom.selector` without daemon interpretation.

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run tests/core/run-feedback-service.test.ts
```

Expected: FAIL because the service does not exist.

- [x] **Step 2: Implement service**

Add:

```ts
export interface RunFeedbackService {
  createRunFeedback(input: {
    runId: string;
    client: Pick<ClientConfig, 'id' | 'isAdmin'>;
    category: string;
    message: string;
    metadata?: unknown;
  }): RunFeedbackRecord;

  listRunFeedback(input: {
    runId: string;
    client: Pick<ClientConfig, 'id' | 'isAdmin'>;
  }): RunFeedbackRecord[];
}
```

Use `createId('feedback')`, repository ownership checks, and `sanitizeLogText` / `sanitizeReviewValue`.

Also extend `apps/daemon/src/core/ids.ts`:

```ts
export type IdPrefix = 'ws' | 'run' | 'msg' | 'conv' | 'artifact' | 'feedback';
```

- [x] **Step 3: Run feedback service tests**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run tests/core/run-feedback-service.test.ts
```

Expected: PASS.

## Task 4: Complete Log Download Service And Routes

**Files:**

- Modify: `apps/daemon/src/core/run-log-service.ts`
- Modify: `apps/daemon/src/http/logs-routes.ts`
- Test: `apps/daemon/tests/core/run-log-service.test.ts`
- Test: `apps/daemon/tests/http/logs-routes.test.ts`

- [x] **Step 1: Add failing service tests for complete log downloads**

Add tests for:

- stdout download returns file path, file name, size, and `text/plain`.
- stderr download requires `canReadLogs`.
- debug-events download requires `canReadDebugEvents`.
- missing log path returns `NOT_FOUND`.
- another client receives `NOT_FOUND`.

- [x] **Step 2: Add service method**

Extend `RunLogClient` with optional `canReadDebugEvents`. Add:

```ts
type RunLogDownloadKind = 'stdout' | 'stderr' | 'debug-events';

getRunLogDownload(input: {
  runId: string;
  kind: RunLogDownloadKind;
  client: RunLogClient;
}): RunLogDownload
```

`stdout` and `stderr` require `canReadLogs`. `debug-events` requires `canReadDebugEvents`.

- [x] **Step 3: Add routes**

Add:

```text
GET /api/runs/:runId/logs/stdout/download
GET /api/runs/:runId/logs/stderr/download
GET /api/runs/:runId/logs/debug-events/download
```

Stream files with `createReadStream`, set `Content-Type: text/plain; charset=utf-8`, and set a safe attachment file name.

- [x] **Step 4: Run log tests**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run tests/core/run-log-service.test.ts tests/http/logs-routes.test.ts
```

Expected: PASS.

## Task 5: Internal Uncompressed ZIP Writer

**Files:**

- Create: `apps/daemon/src/core/zip-writer.ts`
- Test: `apps/daemon/tests/core/zip-writer.test.ts`

- [x] **Step 1: Add failing ZIP writer tests**

Test that:

- `createZipBuffer([{ path: 'manifest.json', content: '{"ok":true}' }])` starts with local ZIP header bytes `50 4b 03 04`.
- The generated buffer contains a central directory and can be parsed by a small test helper to recover `manifest.json`.
- Entry paths with `..`, absolute paths, or backslashes throw `BAD_ZIP_ENTRY_PATH`.

- [x] **Step 2: Implement minimal ZIP writer**

Implement stored, uncompressed ZIP entries only:

```ts
export interface ZipEntry {
  path: string;
  content: string | Buffer;
  modifiedAt?: Date;
}

export function createZipBuffer(entries: ZipEntry[]): Buffer
```

Implementation requirements:

- Use CRC32.
- Normalize timestamps.
- Reject absolute paths, empty path segments, `..`, and backslashes.
- Throw a regular `Error` whose message contains `BAD_ZIP_ENTRY_PATH`; do not add this low-level utility error to `daemonErrorCodes`.
- Keep output deterministic for tests by sorting entries by path.

- [x] **Step 3: Run ZIP tests**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run tests/core/zip-writer.test.ts
```

Expected: PASS.

## Task 6: Review Bundle Service

**Files:**

- Create: `apps/daemon/src/core/review-bundle-service.ts`
- Modify: `apps/daemon/src/config/profiles.ts`
- Modify: `apps/daemon/src/core/run-types.ts`
- Test: `apps/daemon/tests/core/review-bundle-service.test.ts`
- Test: `apps/daemon/tests/config/profiles.test.ts`

- [x] **Step 1: Add failing service tests**

Create tests proving:

- A client with `canReadLogs` can export a bundle for its own run.
- A client without `canReadLogs` gets `FORBIDDEN`.
- A different non-admin client gets `NOT_FOUND`.
- `debug-events.ndjson` and `messages.debug.json` are omitted unless `canReadDebugEvents` is true.
- `prompt-snapshot.md` contains hash/size metadata but not body when snapshot was not persisted.
- `skill/SKILL.md` is omitted when `skillBody` is null, while `skill/side-files-manifest.json` is still included.
- Bundle JSON and markdown outputs do not contain bearer tokens, cookies, API keys, or absolute sandbox paths.
- `messages.filtered.json` does not include `thinkingContent`, raw debug events, or `tool_result` payloads.
- A bundle over `server.maxReviewBundleBytes` fails with `REVIEW_BUNDLE_TOO_LARGE` before building an oversized ZIP buffer.

- [x] **Step 2: Define service types**

Add:

```ts
export interface ReviewBundleExtensionProvider {
  id: string;
  collect(input: ReviewBundleExtensionInput): Promise<ReviewBundleExtensionEntry[]>;
}

export interface ReviewBundleService {
  createRunReviewBundle(input: {
    runId: string;
    client: ReviewBundleClient;
  }): Promise<ReviewBundleDownload>;
}
```

The default provider list is empty.

- [x] **Step 3: Add review bundle size config**

Extend `ServerConfig` and config parsing with:

```ts
maxReviewBundleBytes: number;
```

Default to `16 * 1024 * 1024`. Validate it as a positive integer. Add config tests for the default and for an explicit override.

Also extend `daemonErrorCodes` in `apps/daemon/src/core/run-types.ts`:

```ts
'REVIEW_BUNDLE_TOO_LARGE'
```

- [x] **Step 4: Build generic entries**

Use existing repository helpers:

- `getRunDetail`
- `getProfileSnapshotForRun`
- `getRunPromptSnapshot`
- `getRunSkillSnapshot`
- `getRunContextSnapshot`
- `getRunLogForRunForClient`
- `listArtifactsForRun`
- `listRunFeedbackForClient`

Create bundle entries:

- `manifest.json`
- `request.json`
- `prompt-snapshot.md`
- `profile-snapshot.json`
- `skill/side-files-manifest.json`
- optional `skill/SKILL.md`
- `logs/stdout.log`
- `logs/stderr.log`
- optional `logs/debug-events.ndjson`
- `messages.filtered.json`
- optional `messages.debug.json`
- `artifacts/manifest.json`
- `diagnostics.json`
- `review-summary.md`
- `large-files-manifest.json`
- `feedback.jsonl`

- [x] **Step 5: Define message export filters**

For `messages.filtered.json`, export only user/assistant-visible data:

```ts
{
  id,
  role,
  content,
  runStatus,
  createdAt,
  updatedAt
}
```

Do not include `thinkingContent`. Include only events that would be visible at normal event visibility after filtering, and strip `tool_result`, `raw`, and debug-only payloads.

For `messages.debug.json`, include the fuller sanitized message/event records only when `client.canReadDebugEvents = true`. `messages.debug.json` is for structured message history; `logs/debug-events.ndjson` is for raw chronological debug event log lines.

- [x] **Step 6: Keep bundle size bounded**

Do not inline artifact bodies. For logs, use `RunLogService.getRunLogDownload(kind)` instead of reading run log paths directly, so review bundle export reuses path safety and permission logic. If a log file is unavailable, write an empty placeholder entry only when useful and record the missing file in `diagnostics.json`.

Before calling `createZipBuffer`, sum planned entry byte sizes. If the sum exceeds `server.maxReviewBundleBytes`, throw `daemonError('REVIEW_BUNDLE_TOO_LARGE', 'Review bundle is too large', 413, { maxReviewBundleBytes, plannedByteCount })`.

- [x] **Step 7: Run service tests**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run tests/core/review-bundle-service.test.ts
```

Expected: PASS.

## Task 7: Review Bundle And Feedback HTTP Routes

**Files:**

- Create: `apps/daemon/src/http/review-bundle-routes.ts`
- Create: `apps/daemon/src/http/feedback-routes.ts`
- Modify: `apps/daemon/src/http/app.ts`
- Modify: `apps/daemon/src/http/validation.ts`
- Test: `apps/daemon/tests/http/review-bundle-routes.test.ts`
- Test: `apps/daemon/tests/http/feedback-routes.test.ts`

- [x] **Step 1: Add failing route tests**

Cover:

- unauthenticated requests return `401`.
- `GET /api/runs/run_1/review-bundle/download` returns `application/zip` for authorized clients.
- clients without `canReadLogs` receive `403` for bundle download.
- debug-only files are absent when `canReadDebugEvents` is false.
- `POST /api/runs/run_1/feedback` stores sanitized generic feedback.
- `GET /api/runs/run_1/feedback` returns feedback for the owning client and `404` for another client.

- [x] **Step 2: Add feedback validation schema**

Add:

```ts
export const createRunFeedbackRequestSchema = z.object({
  category: z.string().min(1).max(80),
  message: z.string().min(1).max(20_000),
  metadata: z.unknown().optional(),
}).strict();
```

- [x] **Step 3: Wire services into app**

Extend `CreateAppDependencies` with optional:

```ts
reviewBundleService?: ReviewBundleService;
feedbackService?: RunFeedbackService;
```

Mount:

```text
/api/runs/:runId/review-bundle
/api/runs/:runId/feedback
```

Mount these routers before the generic `/api/runs` router, matching the existing artifacts/logs route order, so sub-routes are not shadowed by `runsRouter`.

- [x] **Step 4: Run HTTP route tests**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run tests/http/review-bundle-routes.test.ts tests/http/feedback-routes.test.ts
```

Expected: PASS.

## Task 8: Daemon Wiring And Documentation

**Files:**

- Modify: `apps/daemon/src/index.ts`
- Modify: `docs/api-reference.md`
- Modify: `docs/configuration-reference.md`
- Modify: `docs/business-skill-observability-design.md` only if implementation details need alignment
- Test: `apps/daemon/tests/index.test.ts`

- [x] **Step 1: Instantiate services in daemon entrypoint**

Create `reviewBundleService` and `feedbackService` from db/config/run log dependencies. Pass them to `createApp`.

- [x] **Step 2: Update API docs**

Document all new endpoints, permissions, response content types, and error codes:

- `401 UNAUTHORIZED`
- `403 FORBIDDEN`
- `404 NOT_FOUND`
- `400 VALIDATION_ERROR`
- `413 REVIEW_BUNDLE_TOO_LARGE`

- [x] **Step 3: Update configuration docs**

Clarify:

- `clients[].canReadLogs` gates complete stdout/stderr and review bundle export.
- `clients[].canReadDebugEvents` gates debug event downloads and debug files inside bundles.
- `collectionMode: lite` still keeps production default lightweight; bundle export cannot invent missing snapshot bodies.

- [x] **Step 4: Run daemon validation**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon test
pnpm --filter @lance-agent-runner/daemon typecheck
pnpm typecheck
pnpm build
```

Expected: all pass.

## Task 9: Main Plan Status Update

**Files:**

- Modify: `docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md`

- [x] **Step 1: Mark this slice completed after implementation review**

Only after implementation and CC review pass, update the main plan:

```markdown
## Slice: Daemon Generic Review Bundle And Feedback (Completed)
```

Add the implementation commit and verification commands. Do not mark `RPA Observability Extension And Skill Review Loop` completed in this slice.

## Review Checklist Before Implementation

- [x] No RPA, Playwright, DSL, screenshot, trace, or executor semantics in daemon core.
- [x] Bundle export is manual/on-demand, not automatic production logging.
- [x] `collectionMode` and `eventVisibility` remain separate.
- [x] `canReadLogs` and `canReadDebugEvents` are both tested as negative and positive paths.
- [x] Feedback categories are stored as opaque strings.
- [x] Artifact file bodies are not inlined in the generic bundle.
- [x] Sanitizer covers logs, messages, request, snapshots, diagnostics, manifest, and feedback.
- [x] RPA-specific extension files are left to the next slice.
