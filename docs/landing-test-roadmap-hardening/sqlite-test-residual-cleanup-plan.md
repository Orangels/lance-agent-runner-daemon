# SQLite Test Residual Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove SQLite-backed runtime/service/HTTP tests now that PostgreSQL is the only runtime persistence backend, while preserving SQLite only as an offline migration source fixture.

**Architecture:** Runtime behavior should be tested through `RunnerPersistence` backed by PostgreSQL or through narrow non-persistence fakes when the test is explicitly about pure routing/service behavior. SQLite modules under `apps/daemon/src/db/` should stop being part of runtime tests; any SQLite schema helpers still needed for old-database migration tests should move into test or migration fixture code.

**Tech Stack:** TypeScript, Vitest, PostgreSQL test database via `CLAUDE_RUNNER_TEST_PG_URL`, `pg`, existing migration runner, existing daemon service and HTTP route tests.

---

## Current Inventory

### Runtime Tests Still Using SQLite Persistence

These tests currently import `openInMemoryDatabase`, `applySchema`, or `createSqliteRunnerPersistence` and should be migrated away from SQLite:

- `apps/daemon/tests/core/artifact-service.test.ts`
- `apps/daemon/tests/core/run-feedback-service.test.ts`
- `apps/daemon/tests/core/review-bundle-service.test.ts`
- `apps/daemon/tests/core/run-log-service.test.ts`
- `apps/daemon/tests/core/workspace-service.test.ts`
- `apps/daemon/tests/core/run-service.test.ts`
- `apps/daemon/tests/http/app-logging.test.ts`
- `apps/daemon/tests/http/artifacts-routes.test.ts`
- `apps/daemon/tests/http/feedback-routes.test.ts`
- `apps/daemon/tests/http/logs-routes.test.ts`
- `apps/daemon/tests/http/review-bundle-routes.test.ts`
- `apps/daemon/tests/http/runs-routes.test.ts`
- `apps/daemon/tests/http/workspace-files-routes.test.ts`
- `apps/daemon/tests/http/workspaces-routes.test.ts`

### SQLite DB Tests To Delete Or Replace

These tests validate the old runtime SQLite backend and should be deleted after equivalent PostgreSQL coverage is confirmed:

- `apps/daemon/tests/db/schema.test.ts`
- `apps/daemon/tests/db/repositories.test.ts`

PostgreSQL coverage already exists in:

- `apps/daemon/tests/db/postgres-connection.test.ts`
- `apps/daemon/tests/db/postgres-migrations.test.ts`
- `apps/daemon/tests/db/postgres-repositories.test.ts`
- `apps/daemon/tests/db/postgres-type-mapping.test.ts`
- `apps/daemon/tests/http/postgres-api-flow.test.ts`

### SQLite References That Should Stay

SQLite remains valid only as the old source format for migration tests and migration tooling:

- `apps/daemon/src/db/migration/sqlite-to-postgres.ts`
- `apps/daemon/src/db/migration/verify-sqlite-to-postgres.ts`
- `apps/daemon/tests/db/sqlite-to-postgres.test.ts`
- `apps/daemon/tests/db/verify-sqlite-to-postgres.test.ts`
- `scripts/migrate-sqlite-to-postgres.sh`

The migration tests currently import runtime SQLite helpers that must be moved before deleting the runtime modules:

- `openDatabase` from `apps/daemon/src/db/connection.ts`
- `applySchema` from `apps/daemon/src/db/schema.ts`
- `upsertWorkspace`, `createRunQueuedWithMessagesAndSnapshot`, and the currently imported `insertRunQueued` from `apps/daemon/src/db/repositories.ts`

### Source Files To Remove After Migration Fixtures Are Decoupled

Delete these runtime SQLite backend modules after no non-migration test imports them:

- `apps/daemon/src/db/connection.ts`
- `apps/daemon/src/db/schema.ts`
- `apps/daemon/src/db/repositories.ts`
- `apps/daemon/src/db/sqlite-persistence.ts`

If migration tests still need old SQLite schema creation, move that fixture code into a test-owned helper such as `apps/daemon/tests/db/sqlite-source-fixtures.ts` before deleting the runtime modules.

---

## Guardrails

- Do not reintroduce dual runtime database support. PostgreSQL is the only runtime persistence backend.
- Do not delete SQLite-to-PostgreSQL migration tooling in this task.
- Do not make PG-gated tests silently pass in CI without PostgreSQL. `CLAUDE_RUNNER_TEST_PG_URL` must be required when `CI=true`.
- Prefer PostgreSQL-backed tests for behavior that depends on persistence semantics, constraints, ordering, transactions, idempotency, webhooks, or run state.
- Use narrow typed fakes only when a test is about non-persistence service or route behavior and a real database would obscure the assertion.
- Preserve existing test intent and API response assertions while changing the backing persistence.
- Add a static guard that fails if runtime code or non-migration tests import the removed SQLite backend modules.
- Do not convert persistence-backed test files to one PostgreSQL schema reset plus full migration per `it`. Prefer `createPostgresFilePersistenceHarness()` with one file-level schema reset/migration, `afterEach` data truncation, and `afterAll` cleanup. Keep one-off reset/migrate harness usage only for migration tests or very small focused cases where the isolation cost is intentional.
- The final merge gate must include a command that proves PostgreSQL-gated tests actually ran with `CLAUDE_RUNNER_TEST_PG_URL` configured.
- A GitHub Actions workflow is recommended but not required by this cleanup plan. If the workflow is not added in this task, the PR must include manual `pnpm test:daemon:pg` evidence before merge.

---

## Task 1: Strengthen The PostgreSQL Test Harness

**Files:**

- Modify: `apps/daemon/tests/helpers/postgres-persistence-harness.ts`
- Create: `apps/daemon/tests/helpers/postgres-domain-fixtures.ts`
- Test through first converted service test.

- [x] **Step 1: Add reusable fixture helpers around the existing harness**

Add a helper file for repeated PG domain setup. Keep the helper small and PG-specific. Start with this workspace fixture:

```ts
import type { RunnerPersistence } from '../../src/db/types.js';

export async function seedWorkspace(
  persistence: RunnerPersistence,
  input: {
    id: string;
    clientId?: string;
    profileId?: string;
    originId?: string;
    userId?: string;
    projectId?: string;
    status?: string;
    metadata?: unknown;
    now?: number;
  },
): Promise<Awaited<ReturnType<RunnerPersistence['upsertWorkspace']>>> {
  return persistence.upsertWorkspace({
    id: input.id,
    clientId: input.clientId ?? 'lqbot',
    profileId: input.profileId ?? 'report-docx',
    originId: input.originId ?? 'origin',
    userId: input.userId ?? 'user',
    projectId: input.projectId ?? 'project',
    status: input.status ?? 'active',
    metadata: input.metadata ?? {},
    now: input.now ?? 1,
  });
}
```

- [x] **Step 2: Keep CI fail-fast semantics intact**

Do not change `apps/daemon/tests/helpers/postgres.ts` unless a converted test reveals a real harness gap. If it is touched, preserve this behavior:

```ts
if (process.env.CI === 'true' && databaseUrl === null) {
  throw new Error('CLAUDE_RUNNER_TEST_PG_URL is required in CI');
}
```

- [x] **Step 3: Run the first PG-backed test slice**

Run:

```bash
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm --filter @lance-agent-runner/daemon test -- tests/db/postgres-repositories.test.ts
```

Expected: the test runs against PostgreSQL and passes. If `CLAUDE_RUNNER_TEST_PG_URL` is unset locally, explicitly note that the PG-gated slice skipped locally and run it before merging.

---

## Task 2: Decouple Migration Tests From Runtime SQLite Modules

**Files:**

- Modify: `apps/daemon/tests/db/sqlite-to-postgres.test.ts`
- Modify: `apps/daemon/tests/db/verify-sqlite-to-postgres.test.ts`
- Create: `apps/daemon/tests/db/sqlite-source-fixtures.ts`
- Keep: `apps/daemon/src/db/migration/sqlite-to-postgres.ts`
- Keep: `apps/daemon/src/db/migration/verify-sqlite-to-postgres.ts`

- [x] **Step 1: Create a migration-only SQLite source fixture helper**

Create `apps/daemon/tests/db/sqlite-source-fixtures.ts`. It must replace all imports from runtime SQLite modules in migration tests.

Start with:

```ts
import Database from 'better-sqlite3';

export type SqliteSourceDatabase = Database.Database;

export function openSqliteSourceDatabase(filename = ':memory:'): SqliteSourceDatabase {
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  return db;
}
```

Then move the current `applySchema` implementation from `apps/daemon/src/db/schema.ts` into `applyLegacySqliteSourceSchema(db)`. The implementation must paste the real legacy SQLite schema SQL into the test fixture helper so migration tests can create old source databases without importing runtime SQLite modules.

- [x] **Step 2: Move migration-test SQLite write helpers into the fixture helper**

The migration tests currently use runtime repository helpers. Replace those dependencies by moving the needed old-source writes into `sqlite-source-fixtures.ts`.

The helper must provide equivalents for the current migration test usage:

```ts
export interface LegacyWorkspaceFixtureInput {
  id: string;
  clientId: string;
  profileId: string;
  originId: string;
  userId: string;
  projectId: string;
  now: number;
}

export interface LegacyRunWithMessagesFixtureInput {
  runId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  workspaceId: string;
  profileId: string;
  clientId: string;
  kind: 'generate' | 'revise';
  prompt: string;
  profileSnapshot: unknown;
  idempotencyKey?: string;
  idempotencyFingerprint?: string;
  now: number;
}
```

Implement the helpers with explicit SQLite `INSERT` statements into the legacy source tables. They must create the same rows that `sqlite-to-postgres.test.ts` and `verify-sqlite-to-postgres.test.ts` currently build through `upsertWorkspace` and `createRunQueuedWithMessagesAndSnapshot`.

`createLegacyRunWithMessages` must perform the write as one SQLite transaction and insert at least:

- `conversations`: one default or requested conversation row.
- `runs`: one queued run row with the same defaults currently produced by `insertRunQueued`.
- `run_messages`: exactly two rows, user at `position = 0` and assistant at `position = 1`, preserving the message ids used by the tests.
- `profile_snapshots`: one profile snapshot row for the run.
- `run_context_snapshots`: only when the fixture input includes `businessContextHash`, matching the current helper behavior.

This table list is required because migration tests assert run detail messages and the migration verifier compares copied table counts.

Also remove the unused `insertRunQueued` import from `sqlite-to-postgres.test.ts` if it is still unused after the helper migration.

- [x] **Step 3: Update migration tests to import only migration fixture helpers**

Replace imports of runtime SQLite modules:

```ts
import { openDatabase } from '../../src/db/connection.js';
import {
  createRunQueuedWithMessagesAndSnapshot,
  insertRunQueued,
  upsertWorkspace,
} from '../../src/db/repositories.js';
import { applySchema } from '../../src/db/schema.js';
```

with:

```ts
import {
  applyLegacySqliteSourceSchema,
  createLegacyRunWithMessages,
  createLegacyWorkspace,
  openSqliteSourceDatabase,
} from './sqlite-source-fixtures.js';
```

After this step, these two tests must not import from `../../src/db/connection.js`, `../../src/db/schema.js`, or `../../src/db/repositories.js`.

- [x] **Step 4: Run migration tests**

Run:

```bash
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm --filter @lance-agent-runner/daemon test -- tests/db/sqlite-to-postgres.test.ts tests/db/verify-sqlite-to-postgres.test.ts
```

Expected: migration tests still pass; their remaining SQLite references are explicitly old-source fixture references.

- [ ] **Step 5: Commit the migration-fixture decoupling**

```bash
git add apps/daemon/tests/db/sqlite-to-postgres.test.ts apps/daemon/tests/db/verify-sqlite-to-postgres.test.ts apps/daemon/tests/db/sqlite-source-fixtures.ts
git commit -m "test: isolate sqlite migration source fixtures"
```

---

## Task 3: Convert Small Core Service Tests First

**Files:**

- Modify: `apps/daemon/tests/core/run-feedback-service.test.ts`
- Modify: `apps/daemon/tests/core/workspace-service.test.ts`
- Modify: `apps/daemon/tests/core/artifact-service.test.ts`
- Modify: `apps/daemon/tests/core/run-log-service.test.ts`
- Modify: `apps/daemon/tests/core/review-bundle-service.test.ts`
- Use: `apps/daemon/tests/helpers/postgres-persistence-harness.ts`
- Use: `apps/daemon/tests/helpers/postgres-domain-fixtures.ts`

- [x] **Step 1: Wrap PostgreSQL-backed service tests with the same gate used by route tests**

At the top of each converted service test file, use:

```ts
import { createPostgresFilePersistenceHarness } from '../helpers/postgres-persistence-harness.js';
import { requirePostgresTestUrl } from '../helpers/postgres.js';

const postgresDescribe = requirePostgresTestUrl() === null ? describe.skip : describe;
```

Then change the suite wrapper from `describe('run feedback service', callback)` to `postgresDescribe('run feedback service', callback)`. This keeps local no-PG behavior consistent with route tests while `pnpm test:daemon:pg` provides the hard merge gate through `CI=true`.

- [x] **Step 2: Replace SQLite setup and seed writes in `run-feedback-service.test.ts`**

Change setup from:

```ts
const db = openInMemoryDatabase();
applySchema(db);
const persistence = createSqliteRunnerPersistence(db);
```

to:

```ts
let harness: Awaited<ReturnType<typeof createPostgresFilePersistenceHarness>> | null = null;

beforeAll(async () => {
  harness = await createPostgresFilePersistenceHarness();
  expect(harness).not.toBeNull();
});

afterEach(async () => {
  await harness?.resetData();
});

afterAll(async () => {
  await harness?.cleanup();
  harness = null;
});

async function setup() {
  expect(harness).not.toBeNull();
  const persistence = harness!.persistence;
  const workspace = await persistence.upsertWorkspace({
    id: 'ws_1',
    clientId: 'lqbot',
    profileId: 'report-docx',
    originId: 'lqbot',
    userId: 'user_1',
    projectId: 'project_1',
    now: 1000,
  });
  await persistence.createRunQueuedWithMessagesAndSnapshot({
    runId: 'run_1',
    conversationId: 'conv_1',
    userMessageId: 'msg_user',
    assistantMessageId: 'msg_assistant',
    workspaceId: workspace.id,
    profileId: workspace.profileId,
    clientId: workspace.clientId,
    kind: 'revise',
    prompt: 'Run.',
    profileSnapshot: { profileId: workspace.profileId },
    now: 2000,
  });
  const service = createRunFeedbackService({
    persistence,
    clock: () => 3000,
    ids: { feedbackId: () => 'feedback_1' },
  });
  return { service };
}
```

All test call sites must change from `const { service } = setup();` to:

```ts
const { service } = await setup();
```

Use file-level `beforeAll`/`afterEach`/`afterAll` lifecycle for persistence-backed service tests. `afterEach` should call `resetData()` and any temp directory cleanup. `afterAll` should call `cleanup()` once to close the persistence pool and release the advisory lock.

Do not stop after this partial replacement:

```ts
const harness = await createPostgresFilePersistenceHarness();
expect(harness).not.toBeNull();
const persistence = harness!.persistence;
```

That only replaces the database constructor; it leaves SQLite seed helpers behind.

For a single test's temp files, cleanup can still use a local `finally`, but database cleanup should stay in the shared lifecycle:

```ts
try {
  await service.createRunFeedback({
    runId: 'run_1',
    client: client(),
    category: 'custom.selector',
    message: 'password=hunter2 should be parameterized',
    metadata: {
      token: 'secret-token',
      artifactPath: 'output/result.json',
      localPath: '/home/orangels/private.txt',
    },
  });
} finally {
  await harness!.cleanup();
}
```

- [x] **Step 3: Convert each small core service file's SQLite helpers**

Apply the same async conversion to every core service file in this task:

- `run-feedback-service.test.ts`: replace SQLite `upsertWorkspace` and `createRunQueuedWithMessagesAndSnapshot` calls that pass `db` with `await persistence.upsertWorkspace(input)` and `await persistence.createRunQueuedWithMessagesAndSnapshot(input)`.
- `workspace-service.test.ts`: replace `openInMemoryDatabase`, `applySchema`, and `createSqliteRunnerPersistence` with the PG harness; this file does not need repository seed helpers.
- `artifact-service.test.ts`: replace SQLite `upsertWorkspace` and `insertRunQueued` calls that pass `db` with `await persistence.upsertWorkspace(input)` and `await persistence.insertRunQueued(input)`.
- `run-log-service.test.ts`: replace SQLite `upsertWorkspace`, `createRunQueuedWithMessagesAndSnapshot`, `getRunDetail`, `getRunLogForRunForClient`, `updateRunMessage`, and `updateRunTerminal` calls that pass `db` with the corresponding async `RunnerPersistence` methods.
- `review-bundle-service.test.ts`: replace SQLite `upsertWorkspace`, `createRunQueuedWithMessagesAndSnapshot`, `updateRunMessage`, `upsertRunPromptSnapshot`, `upsertRunSkillSnapshot`, `upsertRunContextSnapshot`, `replaceArtifactsForRun`, and `insertRunFeedback` calls that pass `db` with the corresponding async `RunnerPersistence` methods.

After conversion, none of these files should import from `../../src/db/connection.js`, `../../src/db/schema.js`, `../../src/db/repositories.js`, or `../../src/db/sqlite-persistence.js`.

- [x] **Step 4: Run the focused feedback test**

Run:

```bash
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm --filter @lance-agent-runner/daemon test -- tests/core/run-feedback-service.test.ts
```

Expected: pass on PostgreSQL.

- [x] **Step 5: Repeat the same pattern for workspace, artifact, run-log, and review-bundle services**

Convert one file at a time, then run the focused file:

```bash
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm --filter @lance-agent-runner/daemon test -- tests/core/workspace-service.test.ts
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm --filter @lance-agent-runner/daemon test -- tests/core/artifact-service.test.ts
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm --filter @lance-agent-runner/daemon test -- tests/core/run-log-service.test.ts
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm --filter @lance-agent-runner/daemon test -- tests/core/review-bundle-service.test.ts
```

Expected: each file passes on PostgreSQL.

- [x] **Step 6: Commit the small service migration slice**

```bash
git add apps/daemon/tests/core apps/daemon/tests/helpers
git commit -m "test: migrate small service tests to postgres"
```

---

## Task 4: Convert HTTP Route Tests

**Files:**

- Modify: `apps/daemon/tests/http/app-logging.test.ts`
- Modify: `apps/daemon/tests/http/artifacts-routes.test.ts`
- Modify: `apps/daemon/tests/http/feedback-routes.test.ts`
- Modify: `apps/daemon/tests/http/logs-routes.test.ts`
- Modify: `apps/daemon/tests/http/review-bundle-routes.test.ts`
- Modify: `apps/daemon/tests/http/runs-routes.test.ts`
- Modify: `apps/daemon/tests/http/workspace-files-routes.test.ts`
- Modify: `apps/daemon/tests/http/workspaces-routes.test.ts`
- Reference: `apps/daemon/tests/http/postgres-api-flow.test.ts`

- [x] **Step 1: Use `postgres-api-flow.test.ts` as the route-test pattern**

For each route test, prefer:

```ts
import { createPostgresFilePersistenceHarness } from '../helpers/postgres-persistence-harness.js';
import { requirePostgresTestUrl } from '../helpers/postgres.js';

const postgresDescribe = requirePostgresTestUrl() === null ? describe.skip : describe;
```

Wrap persistence-backed route tests inside a `postgresDescribe` block with the file's concrete suite name. Prefer file-level harness lifecycle: `beforeAll` creates the harness, `afterEach` calls `resetData()` plus temp cleanup, and `afterAll` calls `cleanup()`.

`apps/daemon/tests/http/app-logging.test.ts` may use a narrow typed `RunnerPersistence` fake instead of PostgreSQL if the test only asserts request logging behavior and does not verify persistence semantics. The fake must not import SQLite modules.

- [x] **Step 2: Remove direct SQLite DB fields and helper calls from route tests**

For each converted route test, remove `db` from helper return types such as the `withApp` helper in `runs-routes.test.ts` and delete imports from:

```ts
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { applySchema } from '../../src/db/schema.js';
import { createSqliteRunnerPersistence } from '../../src/db/sqlite-persistence.js';
import { getRunDetail, upsertWorkspace } from '../../src/db/repositories.js';
```

Use PostgreSQL persistence methods or test fixture helpers instead:

```ts
const workspace = await persistence.upsertWorkspace({
  id: 'ws_1',
  clientId: 'lqbot',
  profileId: 'report-docx',
  originId: 'lqbot',
  userId: 'user_1',
  projectId: 'project_123',
  now: 1000,
});

expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.status).toBe('succeeded');
```

Apply the same async conversion to route tests that currently seed or assert with SQLite helpers:

- `runs-routes.test.ts`: remove `db` from `withApp` return type and replace `getRunDetail` calls that pass `db`.
- `workspaces-routes.test.ts`: replace `openInMemoryDatabase`, `applySchema`, and `createSqliteRunnerPersistence` with the PG harness.
- `workspace-files-routes.test.ts`: replace `upsertWorkspace` calls that pass `db`.
- `logs-routes.test.ts`: replace `upsertWorkspace` and `createRunQueuedWithMessagesAndSnapshot` calls that pass `db`.
- `review-bundle-routes.test.ts`: replace `upsertWorkspace`, `createRunQueuedWithMessagesAndSnapshot`, and `upsertRunPromptSnapshot` calls that pass `db`.
- `artifacts-routes.test.ts`: replace `upsertWorkspace`, `insertRunQueued`, and `replaceArtifactsForRun` calls that pass `db`.
- `feedback-routes.test.ts`: replace `upsertWorkspace` and `createRunQueuedWithMessagesAndSnapshot` calls that pass `db`.

- [x] **Step 3: Keep pure HTTP utility tests database-free**

Do not add PG to tests that do not currently use persistence, such as:

- `apps/daemon/tests/http/http-utils.test.ts`
- `apps/daemon/tests/http/sse.test.ts`
- `apps/daemon/tests/http/validation.test.ts`

- [x] **Step 4: Run each route test after conversion**

Run:

```bash
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm --filter @lance-agent-runner/daemon test -- tests/http/workspaces-routes.test.ts
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm --filter @lance-agent-runner/daemon test -- tests/http/workspace-files-routes.test.ts
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm --filter @lance-agent-runner/daemon test -- tests/http/runs-routes.test.ts
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm --filter @lance-agent-runner/daemon test -- tests/http/artifacts-routes.test.ts
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm --filter @lance-agent-runner/daemon test -- tests/http/logs-routes.test.ts
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm --filter @lance-agent-runner/daemon test -- tests/http/feedback-routes.test.ts
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm --filter @lance-agent-runner/daemon test -- tests/http/review-bundle-routes.test.ts
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm --filter @lance-agent-runner/daemon test -- tests/http/app-logging.test.ts
```

Expected: each converted file passes on PostgreSQL.

- [x] **Step 5: Commit the route migration slice**

```bash
git add apps/daemon/tests/http apps/daemon/tests/helpers
git commit -m "test: migrate route tests to postgres"
```

---

## Task 5: Convert `run-service.test.ts` Last

**Files:**

- Modify: `apps/daemon/tests/core/run-service.test.ts`
- Modify: `apps/daemon/tests/helpers/postgres-domain-fixtures.ts`
- Modify: `apps/daemon/src/db/postgres/repositories.ts` only if a missing production persistence method is discovered.

- [x] **Step 1: Replace the SQLite-backed setup with the PG harness and keep webhook spy wiring accurate**

The existing setup currently creates an in-memory SQLite DB and calls direct SQLite helpers. Preserve the real `withWebhookSpy?: boolean` option and the existing single-argument `createWebhookSpyPersistence(base)` helper shape:

```ts
const harness = await createPostgresFilePersistenceHarness();
expect(harness).not.toBeNull();
const basePersistence = harness!.persistence;
const webhookSpies = options.withWebhookSpy ? createWebhookSpyPersistence(basePersistence) : null;
const persistence = webhookSpies?.persistence ?? basePersistence;
```

Return `cleanup` from setup and call it from `afterEach` or a guaranteed `finally`. Do not leave individual tests responsible for remembering to release the PG advisory lock:

```ts
return {
  persistence,
  webhookSpies,
  cleanup: harness!.cleanup,
};
```

Keep the rest of the existing setup return fields that the current tests already destructure, such as `root`, `workspace`, `workspaceCwd`, `service`, runner controls, and timer helpers. Remove the returned `db` field.

For this file, do not perform one full `DROP SCHEMA + migrate` setup per `it` without measuring the runtime. Use one of these explicit lifecycle shapes:

- Prefer `beforeAll` creating `createPostgresFilePersistenceHarness()`, `afterEach` truncating data with `resetData()`, and `afterAll` awaiting `cleanup()`.
- If a specific subset needs full schema rebuild per case, document why that test cannot use file-level truncate reset.

- [x] **Step 2: Remove direct SQLite repository calls from the test**

Replace direct imports such as `upsertWorkspace`, `getRunDetail`, and snapshot helpers from `apps/daemon/src/db/repositories.ts`.

Use these mappings:

```ts
// Before
const workspace = upsertWorkspace(db, input);
expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run.status).toBe('succeeded');
expect(getProfileSnapshotForRun(db, 'run_1')?.profile).toMatchObject({ profileId: 'report-docx' });

// After
const workspace = await persistence.upsertWorkspace(input);
expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.status).toBe('succeeded');
expect((await persistence.getProfileSnapshotForRun('run_1'))?.profile).toMatchObject({
  profileId: 'report-docx',
});
```

Apply the same async conversion for:

- `getRunDetail`.
- `getProfileSnapshotForRun`.
- `getRunContextSnapshot`.
- `getRunPromptSnapshot`.
- `getRunSkillSnapshot`.
- all secondary workspace setup that currently calls `upsertWorkspace(db, { id, clientId, profileId, originId, userId, projectId, now })`.

Add a small PG test helper in `apps/daemon/tests/helpers/postgres-domain-fixtures.ts` only for repeated setup-only seeding. Add or expose a production persistence method only when the behavior is a real runtime capability, not a test convenience.

- [x] **Step 3: Preserve current run-service assertions**

Do not weaken assertions for:

- idempotency replay.
- webhook creation and terminal delivery creation.
- terminal artifacts before terminal status.
- durable warning events.
- interrupted replay after shutdown.
- queue capacity behavior.
- run status transitions.

- [x] **Step 4: Run the focused run-service suite**

Run:

```bash
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm --filter @lance-agent-runner/daemon test -- tests/core/run-service.test.ts
```

Expected: pass on PostgreSQL.

- [x] **Step 5: Commit the run-service migration slice**

```bash
git add apps/daemon/tests/core/run-service.test.ts apps/daemon/tests/helpers
git commit -m "test: migrate run service tests to postgres"
```

---

## Task 6: Remove Legacy Runtime SQLite DB Tests

**Files:**

- Delete: `apps/daemon/tests/db/schema.test.ts`
- Delete: `apps/daemon/tests/db/repositories.test.ts`
- Verify: `apps/daemon/tests/db/postgres-migrations.test.ts`
- Verify: `apps/daemon/tests/db/postgres-repositories.test.ts`

- [x] **Step 1: Confirm PostgreSQL tests cover the old SQLite DB concerns**

Run:

```bash
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm --filter @lance-agent-runner/daemon test -- tests/db/postgres-migrations.test.ts tests/db/postgres-repositories.test.ts tests/db/postgres-type-mapping.test.ts
```

Expected: PostgreSQL schema, repository, and type-mapping tests pass.

- [x] **Step 2: Delete old SQLite runtime DB tests**

Delete:

```text
apps/daemon/tests/db/schema.test.ts
apps/daemon/tests/db/repositories.test.ts
```

- [x] **Step 3: Run the DB test slice**

Run:

```bash
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm --filter @lance-agent-runner/daemon test -- tests/db/postgres-connection.test.ts tests/db/postgres-migrations.test.ts tests/db/postgres-repositories.test.ts tests/db/postgres-type-mapping.test.ts
```

Expected: pass on PostgreSQL.

- [x] **Step 4: Commit the SQLite DB test removal**

```bash
git add apps/daemon/tests/db
git commit -m "test: remove sqlite runtime db tests"
```

---

## Task 7: Delete Runtime SQLite Backend Modules

**Files:**

- Delete: `apps/daemon/src/db/connection.ts`
- Delete: `apps/daemon/src/db/schema.ts`
- Delete: `apps/daemon/src/db/repositories.ts`
- Delete: `apps/daemon/src/db/sqlite-persistence.ts`
- Verify imports across: `apps/daemon/src`, `apps/daemon/tests`, `docs`

- [x] **Step 1: Run static search before deleting**

Run:

```bash
rg -n "createSqliteRunnerPersistence|openInMemoryDatabase|applySchema|src/db/(connection|schema|repositories|sqlite-persistence)" apps/daemon/src apps/daemon/tests
```

Expected: matches only in files that will be deleted or in migration fixture code that no longer imports runtime SQLite modules.

- [x] **Step 2: Delete the runtime SQLite modules**

Delete:

```text
apps/daemon/src/db/connection.ts
apps/daemon/src/db/schema.ts
apps/daemon/src/db/repositories.ts
apps/daemon/src/db/sqlite-persistence.ts
```

- [x] **Step 3: Run static search after deleting**

Run:

```bash
rg -n "createSqliteRunnerPersistence|openInMemoryDatabase|applySchema|src/db/(connection|schema|repositories|sqlite-persistence)" apps/daemon/src apps/daemon/tests
```

Expected: no runtime SQLite backend imports remain. If `applyLegacySqliteSourceSchema` appears in migration fixture tests, that is allowed.

- [x] **Step 4: Commit module deletion**

```bash
git add apps/daemon/src/db apps/daemon/tests
git commit -m "refactor: remove sqlite runtime backend modules"
```

---

## Task 8: Update Docs And Add Static Guards

**Files:**

- Modify: `docs/landing-test-roadmap-hardening/checklist.md`
- Review and modify when matches are found: `docs/claude-code-runner-daemon-version-roadmap.md`
- Review and modify when matches are found: `docs/configuration-reference.md`
- Review and modify when matches are found: `docs/postgres-persistence-migration/operator-runbook.md`
- Modify: `package.json`
- Create: `apps/daemon/tests/static/no-runtime-sqlite-imports.test.ts`

- [x] **Step 1: Update checklist status**

Mark Task 3 complete only after all runtime SQLite test references are gone and final PG-gated tests pass.

- [x] **Step 2: Update docs that still describe SQLite as runtime persistence**

Run:

```bash
rg -n "SQLite|sqlite|better-sqlite3" docs AGENTS.md CLAUDE.md REFERENCE.md
```

Expected: runtime docs describe PostgreSQL as the only daemon persistence backend. Mentions of SQLite should be historical, migration-source, or checklist context.

- [x] **Step 3: Add a root PostgreSQL daemon test gate**

Add a root package script that makes PostgreSQL-gated daemon tests fail fast when the test database URL is missing:

```json
{
  "scripts": {
    "test:daemon:pg": "env CI=true pnpm --filter @lance-agent-runner/daemon exec vitest run --no-file-parallelism"
  }
}
```

This script is intentionally separate from `pnpm test:daemon`. Developers may still run the normal daemon test suite locally, but merge verification must run `pnpm test:daemon:pg` with `CLAUDE_RUNNER_TEST_PG_URL` set.

- [x] **Step 4: Add a mandatory static guard for SQLite runtime imports**

Create `apps/daemon/tests/static/no-runtime-sqlite-imports.test.ts`. The test must fail if any non-whitelisted file imports:

```text
apps/daemon/src/db/connection.ts
apps/daemon/src/db/schema.ts
apps/daemon/src/db/repositories.ts
apps/daemon/src/db/sqlite-persistence.ts
better-sqlite3
```

Allowed SQLite locations:

```text
apps/daemon/src/db/migration/
apps/daemon/tests/db/sqlite-source-fixtures.ts
apps/daemon/tests/db/sqlite-to-postgres.test.ts
apps/daemon/tests/db/verify-sqlite-to-postgres.test.ts
scripts/migrate-sqlite-to-postgres.sh
```

The static test should scan TypeScript import statements rather than rely only on broad free-text `rg` output. It may still include a small free-text assertion for `createSqliteRunnerPersistence` and `openInMemoryDatabase` because those symbols should disappear entirely.

- [x] **Step 5: Run the static guard**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon test -- tests/static/no-runtime-sqlite-imports.test.ts
```

Expected: pass, proving SQLite runtime imports are blocked outside migration-source tooling/tests.

- [x] **Step 6: Run the PostgreSQL daemon test gate**

Run:

```bash
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm test:daemon:pg
```

Expected: daemon tests run with `CI=true` and fail if `CLAUDE_RUNNER_TEST_PG_URL` is missing.

- [x] **Step 7: Commit docs, scripts, and guard updates**

```bash
git add docs package.json apps/daemon/tests/static
git commit -m "docs: finalize sqlite test cleanup status"
```

---

## Task 9: Final Verification

**Files:** no planned source edits.

- [ ] **Step 1: Run static SQLite residual gate**

Run:

```bash
rg -n "createSqliteRunnerPersistence|openInMemoryDatabase|src/db/(connection|schema|repositories|sqlite-persistence)" apps/daemon/src apps/daemon/tests
```

Expected: no matches.

- [ ] **Step 2: Run migration-source SQLite gate**

Run:

```bash
rg -n "better-sqlite3|SQLite|sqlite" apps/daemon/src apps/daemon/tests
```

Expected: matches only in the static guard allowlist: migration tooling, migration tests, `sqlite-source-fixtures.ts`, package dependency names, or explanatory docs.

- [ ] **Step 3: Run full typecheck and build**

Run:

```bash
pnpm typecheck
pnpm build
```

Expected: both pass.

- [ ] **Step 4: Run daemon tests with PostgreSQL configured**

Run:

```bash
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm test:daemon:pg
```

Expected: daemon tests pass under `CI=true`. This must fail fast if `CLAUDE_RUNNER_TEST_PG_URL` is missing.

- [ ] **Step 5: Prove PostgreSQL-gated tests did not silently skip**

Run at least one PG-only representative test with the test database URL set:

```bash
CLAUDE_RUNNER_TEST_PG_URL="$CLAUDE_RUNNER_TEST_PG_URL" pnpm --filter @lance-agent-runner/daemon test -- tests/http/postgres-api-flow.test.ts tests/db/postgres-repositories.test.ts
```

Expected: output shows these suites executed, not skipped.

If a GitHub Actions workflow is added in this task, it must start/provide PostgreSQL and inject `CLAUDE_RUNNER_TEST_PG_URL`; the `test:daemon:pg` script already sets `CI=true`. If no workflow is added, include manual `pnpm test:daemon:pg` output in the PR notes before merge.

- [ ] **Step 6: Final commit if any verification-only docs changed**

```bash
git status --short
git add docs apps/daemon
git commit -m "test: complete sqlite test residual cleanup"
```

---

## Risks And Decisions

- `run-service.test.ts` is the highest-risk migration because it uses direct SQLite repository helpers and checks detailed run lifecycle behavior. Convert it after smaller tests prove the PG harness pattern.
- PG-gated tests can skip locally when `CLAUDE_RUNNER_TEST_PG_URL` is unset. Before merge, run them with the real test database and keep `CI=true` fail-fast behavior intact.
- This plan adds `test:daemon:pg` as the required merge gate but does not require creating GitHub Actions in the same cleanup slice. If CI is not added, manual PG-gated evidence is required before merge.
- Migration tests legitimately need SQLite as the source database format. The cleanup target is runtime SQLite persistence, not old-data migration coverage.
- Copying the entire old SQLite schema into test fixtures is acceptable if it is clearly named `legacy` or `source`; do not leave it in production runtime modules.
- Converting every route test to PG may increase test time. Use the file-level advisory-lock harness with per-test data truncation for persistence-backed tests, and use narrow typed fakes only for tests whose assertion is independent of persistence behavior.
- `run-service.test.ts` has enough cases that one full schema reset plus migration per `it` can become slow. Its conversion must use `createPostgresFilePersistenceHarness()` or another explicit lifecycle that avoids per-`it` full migrations.

## Completion Criteria

- No `createSqliteRunnerPersistence` references remain.
- No runtime/service/HTTP tests import `apps/daemon/src/db/connection.ts`, `schema.ts`, `repositories.ts`, or `sqlite-persistence.ts`.
- `apps/daemon/src/db/connection.ts`, `schema.ts`, `repositories.ts`, and `sqlite-persistence.ts` are deleted.
- SQLite references that remain are explicitly migration-source only.
- Static guard coverage rejects runtime SQLite imports outside the migration allowlist.
- `pnpm typecheck`, `pnpm build`, and PostgreSQL-backed `pnpm test:daemon:pg` pass.
- At least one representative PostgreSQL-gated test command is shown to execute suites, not skip them.
- `docs/landing-test-roadmap-hardening/checklist.md` marks SQLite Test Residual Cleanup complete only after the criteria above are met.
