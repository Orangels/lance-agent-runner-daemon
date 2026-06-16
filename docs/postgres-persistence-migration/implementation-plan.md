# PostgreSQL Persistence Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate daemon durable persistence from SQLite to PostgreSQL using `pg`, `node-pg-migrate`, and a project-owned SQLite-to-PostgreSQL data migration script. The final daemon runtime supports PostgreSQL only; the existing local SQLite file must be preserved during branch development and before merge so current main-branch business testing is not disrupted.

**Architecture:** Replace the daemon runtime persistence implementation with PostgreSQL while keeping HTTP/core behavior unchanged. Use `node-pg-migrate` for PostgreSQL schema migrations, use `pg` for runtime repositories, and provide a one-shot domain-aware migration/verification script that reads existing `runner.sqlite` data into PostgreSQL without deleting or mutating the source SQLite file. SQLite remains only as a migration input format, not as a runtime backend after this branch is merged.

**Tech Stack:** TypeScript ESM, `pg`, `node-pg-migrate`, `better-sqlite3` for migration-tool source reads only, Vitest, existing daemon repository/service modules.

---

## Non-Negotiable Constraints

- Do not delete, rename, truncate, or rewrite the existing local SQLite database file during this branch. The current main-branch business test path can continue using `.claude-runner/data/runner.sqlite` until this migration branch is reviewed, verified, and merged.
- Do not couple this migration to `gaclaw`, lqBot, RPA, or any specific business caller.
- Do not change daemon HTTP API contracts as part of this migration. Existing `POST /api/workspaces`, upload/prepare, `POST /api/runs`, poll/SSE, artifacts, logs, cancel, feedback, and idempotency behavior must stay semantically identical.
- Do not introduce a distributed queue in this plan. PG should prepare the persistence layer for later scale-out, but multi-daemon scheduling, leases, and cross-process workspace locks need a separate plan.
- Do not keep runtime dual-backend support. The final daemon process must start against PostgreSQL only.
- Do not keep dual-write behavior. The migration script copies historical SQLite data once; runtime writes go to PostgreSQL after cutover.
- Do not leave synchronous database operations in the daemon runtime path. After migration, repository methods, service methods that touch persistence, route handlers, startup checks, status polling, artifact/log metadata reads, idempotency replay, and run lifecycle updates must be async and must use non-blocking PostgreSQL driver calls.
- Do not wrap async PostgreSQL calls in fake synchronous helpers. If an existing method currently returns a value synchronously because SQLite allowed it, change the method contract to return `Promise<...>` and update callers/tests.
- Preserve streaming durable-message ordering when moving to async persistence. `message-accumulator` must not fire-and-forget database writes; per-run writes must be serialized so `text_delta`, `thinking_delta`, event arrays, assistant-message splits, and terminal flushes are persisted in event order without lost updates.
- PostgreSQL integration tests are required before merge. CI must provide a PostgreSQL service and set `CLAUDE_RUNNER_TEST_PG_URL`; local developer runs may skip PG tests only outside CI.
- Keep `run_events` out of scope. The current durable event history remains `run_messages.events_json`.

## Package Choice

- Add runtime dependency `pg` for PostgreSQL connections and pooling.
- Add development/runtime tooling dependency `node-pg-migrate` for schema migrations.
- Add development dependency `@types/pg` so repository and migration code typecheck consistently.
- Keep `better-sqlite3` available for the SQLite-to-PostgreSQL migration script, but remove it from daemon runtime imports.
- Do not add Prisma, Drizzle, or Knex for this migration. They introduce broader ORM/query-builder decisions that are not required for the current repository pattern.

## Target Operator Flow

Current main-branch SQLite command remains available until this branch is merged. This plan must not delete the local SQLite file while business testing continues on main:

```bash
env \
  CLAUDE_RUNNER_LQBOT_API_KEY=lancelocal-report \
  RPA_DAEMON_API_KEY=local-rpa-test-key \
  pnpm start:daemon:local
```

After this migration branch is merged, the daemon requires PostgreSQL config:

```json
{
  "server": {
    "persistence": {
      "databaseUrl": "env:CLAUDE_RUNNER_DATABASE_URL"
    }
  }
}
```

Schema migration:

```bash
CLAUDE_RUNNER_DATABASE_URL=postgres://user:pass@localhost:5432/daemon \
  pnpm db:migrate:pg
```

SQLite-to-PostgreSQL data copy:

```bash
CLAUDE_RUNNER_DATABASE_URL=postgres://user:pass@localhost:5432/daemon \
  pnpm db:migrate:sqlite-to-pg -- \
  --sqlite .claude-runner/data/runner.sqlite
```

Verification:

```bash
CLAUDE_RUNNER_DATABASE_URL=postgres://user:pass@localhost:5432/daemon \
  pnpm db:verify:sqlite-to-pg -- \
  --sqlite .claude-runner/data/runner.sqlite
```

Rollback before merging this branch is operationally simple: keep using main, which still reads the preserved SQLite file. After this migration branch is merged and new PG-only writes are accepted, this plan does not provide automatic PostgreSQL-to-SQLite rollback.

## File Structure

- Modify `apps/daemon/package.json`
  - Add `pg` and `node-pg-migrate` dependencies.
  - Add daemon package scripts for PG migration and migration verification.
- Modify root `package.json`
  - Add workspace convenience scripts `db:migrate:pg`, `db:migrate:pg:down`, `db:migrate:sqlite-to-pg`, and `db:verify:sqlite-to-pg`.
- Modify `apps/daemon/src/config/profiles.ts`
  - Add required `server.persistence.databaseUrl`.
  - Resolve `env:` database URL references without logging secrets.
  - Remove runtime backend selection from config.
- Modify `apps/daemon/src/config/config.ts`
  - Keep path normalization for `server.dataDir`.
  - Do not path-normalize PostgreSQL URLs.
- Create `apps/daemon/src/db/types.ts`
  - Define a database facade interface used by services and route tests.
  - Define transaction callback shape and close lifecycle.
  - Require all runtime repository methods to return `Promise`.
- Keep non-PG service/route fixtures explicitly scoped to behavioral compatibility tests.
  - PostgreSQL-specific correctness must be covered by PG-gated schema, repository, migration, and API-flow tests.
  - CI must provide `CLAUDE_RUNNER_TEST_PG_URL`; otherwise PG-gated tests fail fast.
- Modify `apps/daemon/src/db/connection.ts`
  - Replace runtime SQLite opening with PostgreSQL pool opening.
  - Move SQLite opening helpers into migration tooling if the migration script needs shared code.
- Create `apps/daemon/src/db/postgres/connection.ts`
  - Own `pg.Pool` construction and shutdown.
- Create `apps/daemon/src/db/postgres/repositories.ts`
  - Implement the repository facade over PostgreSQL.
- Create `apps/daemon/src/db/postgres/errors.ts`
  - Map PostgreSQL unique constraint code `23505` to a generic repository unique-constraint error used by run idempotency replay fallback.
- Create `apps/daemon/src/core/run-write-queue.ts`
  - Provide a per-run async write queue used by `message-accumulator` and run terminal flushing to preserve durable write order without blocking SSE delivery.
- Create `apps/daemon/src/db/postgres/migrations/`
  - Store `node-pg-migrate` migration files.
- Create `apps/daemon/src/db/postgres/migrate.ts`
  - Programmatic CLI wrapper for `node-pg-migrate` using `CLAUDE_RUNNER_DATABASE_URL`.
- Create `apps/daemon/src/db/migration/sqlite-to-postgres.ts`
  - Domain-aware data copy script from preserved SQLite file to PostgreSQL.
- Create `apps/daemon/src/db/migration/verify-sqlite-to-postgres.ts`
  - Counts, key-set, hash, and referential checks after migration.
- Modify services that currently depend on `RunnerDatabase` directly:
  - `apps/daemon/src/core/workspace-service.ts`
  - `apps/daemon/src/core/artifact-service.ts`
  - `apps/daemon/src/core/review-bundle-service.ts`
  - `apps/daemon/src/core/run-feedback-service.ts`
  - `apps/daemon/src/core/run-log-service.ts`
  - `apps/daemon/src/core/run-service.ts`
  - `apps/daemon/src/core/message-accumulator.ts`
  - `apps/daemon/src/core/run-write-queue.ts`
  - `apps/daemon/src/http/app.ts` and route factories if they carry the DB type.
  - Convert persistence-touching service and route methods to async/await instead of preserving synchronous SQLite-style signatures.
  - In Task 2, change `message-accumulator` only enough to compile against the async facade. Task 3 owns the write queue, throttle/merge preservation, and ordered streaming persistence behavior.
- Modify `apps/daemon/src/index.ts`
  - Open PostgreSQL persistence.
  - Require PG migrations to be current before serving.
  - Mark interrupted runs on startup through repository facade.
- Modify docs:
  - `docs/configuration-reference.md`
  - `docs/api-reference.md` with a short note that persistence backend does not affect API shape.
  - `docs/claude-code-runner-daemon-version-roadmap.md` after implementation status is known.
- Tests:
  - Replace runtime repository/service tests with PostgreSQL-backed tests where persistence behavior matters.
  - Use PG-gated tests for persistence semantics. Non-PG tests may keep compatibility fixtures, but they must not be treated as PostgreSQL repository coverage.
  - Keep SQLite-only tests only for migration source reading and SQLite-to-PostgreSQL migration verification.
  - Add PostgreSQL integration tests gated behind `CLAUDE_RUNNER_TEST_PG_URL` locally and required when `CI=true`.
  - Add unit tests for config parsing, migration ordering, and verification script behavior.
  - Add a test preflight helper that throws when `CI=true` and `CLAUDE_RUNNER_TEST_PG_URL` is missing.

## Data Model Mapping

PostgreSQL tables must preserve existing logical columns and indexes:

- `workspaces`
  - Preserve `id`, `profile_id`, `client_id`, `origin_id`, `user_id`, `project_id`, `workspace_key`, `status`, `metadata_json`, `created_at`, `updated_at`.
  - Store current SQLite JSON text columns as `text` in the first PostgreSQL migration to preserve byte-for-byte behavior. A later plan may convert selected columns to `jsonb` after repository behavior is stable.
  - Preserve unique constraint on `(client_id, profile_id, workspace_key)`.
- `conversations`
  - Preserve workspace foreign key and conversation ordering indexes.
- `runs`
  - Preserve status lifecycle columns, prompt/context snapshot fields, `metadata_json`, `usage_json`, and all idempotency fields.
  - Preserve partial unique idempotency constraint:

```sql
CREATE UNIQUE INDEX idx_runs_idempotency_key
  ON runs (client_id, profile_id, workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

- `run_messages`
  - Preserve `events_json`, attachments, produced files, `conversation_seq`, and run/conversation ordering.
- `artifacts`
  - Preserve relative paths only. Do not expose or store absolute sandbox paths.
- `run_logs`
  - Preserve relative or local log path semantics exactly as the current API expects.
- `profile_snapshots`, `run_prompt_snapshots`, `run_skill_snapshots`, `run_context_snapshots`, `run_feedback`
  - Preserve primary keys and foreign keys.

### PostgreSQL Type Mapping

Use the following column type rules in the first PostgreSQL schema:

- Use `text` for all daemon ids, status/kind fields, path fields, hashes, model/profile/skill/rule ids, error codes/messages, signals, and current JSON text columns.
- Use `bigint` for every millisecond timestamp or byte-size column:
  - `workspaces.created_at`, `workspaces.updated_at`
  - `conversations.created_at`, `conversations.updated_at`
  - `runs.queued_at`, `runs.started_at`, `runs.finished_at`, `runs.created_at`, `runs.updated_at`
  - `run_messages.started_at`, `run_messages.ended_at`, `run_messages.created_at`, `run_messages.updated_at`
  - `artifacts.size`, `artifacts.mtime`, `artifacts.created_at`
  - `run_logs.created_at`
  - `profile_snapshots.created_at`
  - `run_prompt_snapshots.created_at`
  - `run_skill_snapshots.created_at`
  - `run_context_snapshots.created_at`
  - `run_feedback.created_at`
- Use `integer` for bounded counters and process values:
  - `runs.exit_code`
  - `runs.prompt_snapshot_char_count`, `runs.prompt_snapshot_byte_count`
  - `run_messages.position`, `run_messages.conversation_seq`
  - `run_prompt_snapshots.char_count`, `run_prompt_snapshots.byte_count`
- Preserve SQLite boolean-like columns as `integer`, not `boolean`, to keep mapper behavior stable:
  - `runs.prompt_snapshot_persisted INTEGER NOT NULL DEFAULT 0`
  - `run_prompt_snapshots.persisted INTEGER NOT NULL`
  - `run_skill_snapshots.persisted INTEGER NOT NULL`
  - `run_context_snapshots.persisted INTEGER NOT NULL`
- Use `text` for current JSON columns in the first PG schema, not `jsonb`, to preserve byte-for-byte migration and current mapper semantics:
  - `metadata_json`, `context_policy_json`, `artifact_rule_ids_json`, `usage_json`, `events_json`, `attachments_json`, `produced_files_json`, `profile_json`, `prompt_snapshot`, `side_files_manifest_json`, `business_context_json`.

`pg` returns `int8` as strings by default. Runtime PG connection setup must either:

```ts
import pg from 'pg';

pg.types.setTypeParser(20, (value) => Number(value));
```

or explicitly `Number(row.column)` in every mapper. This plan requires one project-wide parser in `apps/daemon/src/db/postgres/connection.ts`, plus mapper tests that prove timestamp and size fields remain numbers in API-facing records. Current millisecond timestamps and file sizes we support are below `Number.MAX_SAFE_INTEGER`; if a future artifact size can exceed that, add a separate API/type plan before accepting such files.

### Required Indexes And Constraints

The PostgreSQL migration must create the current SQLite logical indexes and constraints:

```sql
CREATE INDEX idx_workspaces_identity
  ON workspaces (origin_id, user_id, project_id);

CREATE UNIQUE INDEX idx_workspaces_client_profile_key
  ON workspaces (client_id, profile_id, workspace_key);

CREATE INDEX idx_conversations_workspace
  ON conversations (workspace_id, updated_at DESC);

CREATE INDEX idx_runs_workspace_created
  ON runs (workspace_id, created_at DESC);

CREATE INDEX idx_runs_status_created
  ON runs (status, created_at DESC);

CREATE UNIQUE INDEX idx_runs_idempotency_key
  ON runs (client_id, profile_id, workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_run_messages_run
  ON run_messages (run_id, position);

CREATE INDEX idx_run_messages_conversation
  ON run_messages (conversation_id, position);

CREATE INDEX idx_run_messages_conversation_seq
  ON run_messages (conversation_id, conversation_seq);

CREATE INDEX idx_artifacts_run
  ON artifacts (run_id, role);

CREATE INDEX idx_run_feedback_run_created
  ON run_feedback (run_id, created_at);
```

The migration test must assert this full index set, not only `idx_runs_idempotency_key`.

### Foreign Keys And Defaults

The PostgreSQL migration must preserve current foreign-key delete behavior:

```text
conversations.workspace_id -> workspaces.id ON DELETE CASCADE
runs.workspace_id -> workspaces.id ON DELETE CASCADE
run_messages.workspace_id -> workspaces.id ON DELETE CASCADE
run_messages.conversation_id -> conversations.id ON DELETE SET NULL
run_messages.run_id -> runs.id ON DELETE CASCADE
artifacts.run_id -> runs.id ON DELETE CASCADE
artifacts.workspace_id -> workspaces.id ON DELETE CASCADE
run_logs.run_id -> runs.id ON DELETE CASCADE
profile_snapshots.run_id -> runs.id ON DELETE CASCADE
run_prompt_snapshots.run_id -> runs.id ON DELETE CASCADE
run_skill_snapshots.run_id -> runs.id ON DELETE CASCADE
run_context_snapshots.run_id -> runs.id ON DELETE CASCADE
run_feedback.run_id -> runs.id ON DELETE CASCADE
```

The PostgreSQL migration must preserve these current `NOT NULL` / default semantics:

```text
workspaces.id/profile_id/client_id/origin_id/user_id/project_id/workspace_key/status/created_at/updated_at NOT NULL
conversations.id/workspace_id/created_at/updated_at NOT NULL
runs.id/workspace_id/profile_id/client_id/kind/status/prompt/created_at/updated_at NOT NULL
runs.prompt_mode NOT NULL DEFAULT 'legacy'
runs.collection_mode NOT NULL DEFAULT 'lite'
runs.prompt_snapshot_persisted NOT NULL DEFAULT 0
run_messages.id/workspace_id/run_id/role/content/position/created_at/updated_at NOT NULL
run_messages.thinking_content NOT NULL DEFAULT ''
artifacts.id/run_id/workspace_id/rule_id/role/relative_path/file_name/created_at NOT NULL
run_logs.run_id/created_at NOT NULL
profile_snapshots.run_id/profile_json/created_at NOT NULL
run_prompt_snapshots.run_id/persisted/created_at NOT NULL
run_skill_snapshots.run_id/persisted/created_at NOT NULL
run_context_snapshots.run_id/persisted/created_at NOT NULL
run_feedback.id/run_id/client_id/category/message/created_at NOT NULL
```

The migration tests must inspect PostgreSQL catalog metadata for these foreign-key actions and default/nullability rules, at least for the non-obvious cases: `run_messages.conversation_id ON DELETE SET NULL`, `runs.prompt_mode DEFAULT 'legacy'`, `runs.collection_mode DEFAULT 'lite'`, `run_messages.thinking_content DEFAULT ''`, `runs.prompt_snapshot_persisted DEFAULT 0`, and the three snapshot `persisted` columns being `NOT NULL` with no database default.

The migration script must insert parent tables before child tables:

```text
workspaces
conversations
runs
run_messages
artifacts
run_logs
profile_snapshots
run_prompt_snapshots
run_skill_snapshots
run_context_snapshots
run_feedback
```

## Task 1: Dependency And Config Plan

**Files:**
- Modify: `apps/daemon/package.json`
- Modify: `package.json`
- Modify: `apps/daemon/src/config/profiles.ts`
- Modify: `apps/daemon/src/config/config.ts`
- Test: `apps/daemon/tests/config/config.test.ts`
- Test: `apps/daemon/tests/config/profiles.test.ts`

- [ ] **Step 1: Write failing config tests**

Add tests that existing runtime configs must now include PostgreSQL persistence before merge:

```ts
expect(() => parseDaemonConfig(existingRawConfigWithoutPersistence)).toThrow();
```

Add tests that parse required PostgreSQL config:

```ts
const parsed = parseDaemonConfig(
  {
    ...existingRawConfig,
    server: {
      ...existingRawConfig.server,
      persistence: {
        databaseUrl: 'env:CLAUDE_RUNNER_DATABASE_URL',
      },
    },
  },
  { env: { CLAUDE_RUNNER_DATABASE_URL: 'postgres://user:pass@localhost:5432/daemon' } },
);

expect(parsed.server.persistence).toEqual({
  databaseUrl: 'postgres://user:pass@localhost:5432/daemon',
});
```

Add a test that missing env fails with a non-secret message:

```ts
expect(() =>
  parseDaemonConfig(rawPgConfig, { env: {} }),
).toThrow('Missing required environment variable for databaseUrl: CLAUDE_RUNNER_DATABASE_URL');
```

- [ ] **Step 2: Add dependencies and scripts**

Add to `apps/daemon/package.json`:

```json
"pg": "^8.13.0",
"node-pg-migrate": "^8.0.0"
```

Add `@types/pg` under `devDependencies`:

```json
"@types/pg": "^8.11.0"
```

Add scripts:

```json
"db:migrate:pg": "tsx src/db/postgres/migrate.ts up",
"db:migrate:pg:down": "tsx src/db/postgres/migrate.ts down",
"db:migrate:sqlite-to-pg": "tsx src/db/migration/sqlite-to-postgres.ts",
"db:verify:sqlite-to-pg": "tsx src/db/migration/verify-sqlite-to-postgres.ts"
```

Add root convenience scripts:

```json
"db:migrate:pg": "pnpm --filter @lance-agent-runner/daemon db:migrate:pg",
"db:migrate:pg:down": "pnpm --filter @lance-agent-runner/daemon db:migrate:pg:down",
"db:migrate:sqlite-to-pg": "pnpm --filter @lance-agent-runner/daemon db:migrate:sqlite-to-pg",
"db:verify:sqlite-to-pg": "pnpm --filter @lance-agent-runner/daemon db:verify:sqlite-to-pg"
```

- [ ] **Step 3: Implement config type**

Add:

```ts
export interface PersistenceConfig {
  databaseUrl: string;
}
```

Add `persistence: PersistenceConfig` to `ServerConfig`.

Extend `serverSchema` with:

```ts
persistence: z.object({
  databaseUrl: nonEmptyString,
}).strict(),
```

Resolve `env:` for `persistence.databaseUrl`.

- [ ] **Step 4: Verify**

Run:

```bash
pnpm typecheck:daemon
pnpm test:daemon -- tests/config/config.test.ts tests/config/profiles.test.ts
```

Expected: config tests pass after local/example test fixtures include PostgreSQL persistence.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/package.json package.json pnpm-lock.yaml apps/daemon/src/config apps/daemon/tests/config
git commit -m "feat: require postgres persistence config"
```

## Task 2: PostgreSQL Persistence Facade Preparation

**Files:**
- Create: `apps/daemon/src/db/types.ts`
- Modify: `apps/daemon/src/db/connection.ts`
- Modify: `apps/daemon/src/db/repositories.ts`
- Modify: all services importing `RunnerDatabase`
- Modify: route/app types carrying `RunnerDatabase`
- Test: existing daemon unit tests

- [ ] **Step 1: Define repository facade and shared record types**

Create `apps/daemon/src/db/types.ts` and move all public persistence record/input types out of `apps/daemon/src/db/repositories.ts`:

- `WorkspaceRecord`
- `ConversationRecord`
- `RunRecord`
- `RunMessageRecord`
- `ArtifactRecord`
- `RunDetailRecord`
- `RunWithWorkspaceRecord`
- `RunLogRecord`
- `ProfileSnapshotRecord`
- `RunPromptSnapshotRecord`
- `RunSkillSnapshotRecord`
- `RunContextSnapshotRecord`
- `RunFeedbackRecord`
- `CreateRunQueuedWithMessagesAndSnapshotResult`
- named repository input interfaces used by `RunnerPersistence`

After this task, core and HTTP modules must import persistence types from `apps/daemon/src/db/types.ts`, not from `apps/daemon/src/db/repositories.ts`.

In the same file, define an interface that exposes the existing repository operations as async methods instead of free functions. Start with every operation currently imported from `apps/daemon/src/db/repositories.ts`, including:

```ts
export interface RunnerPersistence {
  close(): Promise<void>;
  transaction<T>(fn: (persistence: RunnerPersistence) => Promise<T>): Promise<T>;
  upsertWorkspace(input: UpsertWorkspaceInput): Promise<WorkspaceRecord>;
  getWorkspaceForClient(input: GetWorkspaceForClientInput): Promise<WorkspaceRecord | null>;
  insertRunQueued(input: InsertRunQueuedInput): Promise<RunRecord>;
  createRunQueuedWithMessagesAndSnapshot(
    input: CreateRunQueuedWithMessagesAndSnapshotInput,
  ): Promise<CreateRunQueuedWithMessagesAndSnapshotResult>;
  getRunByIdempotencyKey(input: GetRunByIdempotencyKeyInput): Promise<RunRecord | null>;
  markInterruptedRunsOnStartup(now: number): Promise<number>;
}
```

Use complete named input interfaces. Do not use `any` for repository payloads.

Every method on `RunnerPersistence` must return a `Promise`, including simple read operations like status/detail/artifact/log lookups. This is required so daemon HTTP handlers never block the Node event loop on database I/O after PostgreSQL migration.

Before implementing PG repositories, make a checklist from every current exported repository function and either:

- move it to `RunnerPersistence`;
- move it to migration-only SQLite source helpers; or
- remove it only if no production/test caller remains.

The current exported function set to reconcile is:

```text
makeWorkspaceKey
upsertWorkspace
getWorkspaceForClient
getOrCreateDefaultConversation
getConversationForWorkspace
listConversationMessagesForPrompt
insertRunQueued
createRunQueuedWithMessagesAndSnapshot
getProfileSnapshotForRun
upsertRunPromptSnapshot
updateRunPromptSnapshotFields
upsertRunSkillSnapshot
upsertRunContextSnapshot
getRunPromptSnapshot
getRunSkillSnapshot
getRunContextSnapshot
markInterruptedRunsOnStartup
insertRunMessagesForRunCreate
insertAssistantRunMessage
updateAssistantMessagesTerminalForRun
updateRunStarted
updateRunTerminal
updateAssistantMessageStarted
updateAssistantMessageTerminal
updateRunMessage
replaceArtifactsForRun
listArtifactsForRun
getArtifactForRunForClient
upsertRunLogPaths
getRunLogForRunForClient
listRunLogsFinishedBefore
deleteRunLogRows
insertRunFeedback
listRunFeedbackForClient
getRunDetail
getRunForClient
getRunWithWorkspaceForClient
listRunsForClient
getRunByIdempotencyKey
isSqliteUniqueConstraintError
```

`upsertRunLogPaths` currently rejects absolute log paths through `assertRelativeLogPath`; preserve that safety check in the PG implementation.

`getOrCreateDefaultConversation` becomes concurrency-sensitive under async PG. Prefer a transaction-scoped PostgreSQL advisory lock keyed by workspace id for default-conversation creation, then reselect the oldest existing `Default` row and insert only when none exists. This preserves current SQLite semantics, which tolerate historical duplicate `Default` rows by selecting `ORDER BY created_at LIMIT 1`, and avoids adding a new `(workspace_id, title)` unique constraint that could make Task 7 fail on existing SQLite data.

If implementation chooses a uniqueness-based strategy instead, the plan must be updated before implementation starts: add the new constraint/index to `Required Indexes And Constraints`, add migration tests for it, and define how the SQLite-to-PostgreSQL migration canonicalizes or rejects historical duplicate `Default` conversations without mutating the source SQLite file.

Tests must cover concurrent create-run calls without explicit `conversationId` and must cover a migrated workspace that already contains duplicate `Default` conversations, proving the repository returns the oldest existing row rather than failing migration or creating another duplicate.

- [ ] **Step 2: Define test coverage boundaries**

Do not add an unused in-memory `RunnerPersistence` implementation. Service/route tests that do not need PostgreSQL-specific semantics may keep explicit compatibility fixtures, but PostgreSQL repository behavior must be covered by PG-gated tests that run against `CLAUDE_RUNNER_TEST_PG_URL`.

CI must provide `CLAUDE_RUNNER_TEST_PG_URL`; without it, PG-gated tests fail fast instead of silently giving a SQLite-only green run.

- [ ] **Step 3: Stop adding runtime SQLite adapter code**

Do not create `createSqlitePersistence` for daemon startup. Existing SQLite repository functions can remain temporarily only to support the migration script and incremental test conversion, but no runtime service or route should depend on them after this plan is complete.

- [ ] **Step 4: Convert services to the facade**

Change service constructors from:

```ts
{ db: RunnerDatabase }
```

to:

```ts
{ persistence: RunnerPersistence }
```

Inside services, replace free function calls with facade methods. Example:

```ts
const run = await input.persistence.insertRunQueued({...});
```

This will make service methods asynchronous. Update every caller and test in the same task. Do not mix synchronous SQLite assumptions into core services.

At minimum these contracts must become Promise-based:

```ts
export interface RunService {
  createRun(input: { client: ClientConfig; request: CreateRunRequest }): Promise<CreateRunResult>;
  listRuns(input: { client: ClientConfig; query?: ListRunsQuery }): Promise<RunRecord[]>;
  getRunStatus(input: { client: ClientConfig; runId: string }): Promise<RunRecord>;
  getRunDetail(input: { client: ClientConfig; runId: string }): Promise<RunDetailRecord>;
  cancelRun(input: { client: ClientConfig; runId: string }): Promise<{ ok: true }>;
}
```

Apply the same rule to workspace, artifact, log, review bundle, feedback, and upload services whenever they touch persistence.

- [ ] **Step 5: Keep SQLite code isolated to migration tooling**

Runtime startup must no longer call:

```ts
openRunnerDatabase(config.server.dataDir);
applySchema(rawDb);
```

Move any SQLite helpers needed by the migration script under `apps/daemon/src/db/migration/` or `apps/daemon/src/db/sqlite-source/` so they are visibly migration-only.

- [ ] **Step 6: Verify runtime compile path**

Run:

```bash
pnpm test:daemon
pnpm typecheck:daemon
```

Expected: code compiles after service constructors accept async PostgreSQL persistence abstractions. Non-PG service/route tests remain compatibility coverage only; PG-gated tests provide PostgreSQL persistence coverage. SQLite-specific repository tests may be rewritten or moved to migration-script tests in later tasks.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src apps/daemon/tests
git commit -m "refactor: prepare postgres persistence facade"
```

## Task 3: Async Run Event Persistence Ordering

**Files:**
- Create: `apps/daemon/src/core/run-write-queue.ts`
- Modify: `apps/daemon/src/core/message-accumulator.ts`
- Modify: `apps/daemon/src/core/run-service.ts`
- Test: `apps/daemon/tests/core/message-accumulator.test.ts`
- Test: `apps/daemon/tests/core/run-service.test.ts`

- [ ] **Step 1: Write failing ordering tests**

Add tests that simulate a fast stream of run events while persistence writes resolve out of order:

```ts
it('persists fast text deltas in event order through async writes', async () => {
  const writes: Array<() => void> = [];
  const persistence = createDelayedMessagePersistence({ writes });
  const accumulator = createMessageAccumulator({
    persistence,
    messageId: 'msg_assistant',
    workspaceId: 'ws_1',
    conversationId: 'conv_1',
    runId: 'run_1',
    initialPosition: 1,
    nextMessageId: () => 'msg_next',
    clock: { now: () => 1000 },
    timer: immediateTestTimer,
  });

  accumulator.startRun({ startedAt: 1000 });
  accumulator.consume({ type: 'text_delta', text: 'A' }, '000001');
  accumulator.consume({ type: 'text_delta', text: 'B' }, '000002');
  accumulator.consume({ type: 'text_delta', text: 'C' }, '000003');

  writes.reverse().forEach((resolve) => resolve());
  await accumulator.flushTerminal({
    status: 'succeeded',
    endedAt: 2000,
    lastRunEventId: '000004',
  });

  expect(await persistence.getMessageContent('msg_assistant')).toBe('ABC');
  expect(await persistence.getMessageEvents('msg_assistant')).toEqual([
    expect.objectContaining({ id: '000001' }),
    expect.objectContaining({ id: '000002' }),
    expect.objectContaining({ id: '000003' }),
    expect.objectContaining({ id: '000004' }),
  ]);
});
```

`createDelayedMessagePersistence` is a test-local helper in `apps/daemon/tests/core/message-accumulator.test.ts`. It should implement only the message methods needed by this test and expose held write resolvers so the test can complete writes out of order intentionally.

Add a run-service test proving terminal completion awaits pending durable writes before considering the run fully finished:

```ts
it('awaits pending assistant message writes before terminal run persistence completes', async () => {
  const persistence = createDelayedRunPersistence();
  const service = createRunServiceWithFakeRunner({ persistence });

  const run = await service.createRun(createGenerateRequest());
  await persistence.waitForAssistantMessageUpdateToBePending(run.runId);

  const statusBeforeResolve = await service.getRunStatus({
    client: testClient,
    runId: run.runId,
  });
  expect(statusBeforeResolve.status).not.toBe('succeeded');

  persistence.resolvePendingAssistantMessageWritesOutOfOrder();
  await service.waitForRunToFinish(run.runId);

  const detail = await service.getRunDetail({ client: testClient, runId: run.runId });
  expect(detail.status).toBe('succeeded');
  expect(detail.messages.at(-1)?.content).toContain('expected final text');
});
```

`createDelayedRunPersistence` and `createRunServiceWithFakeRunner` are test-local helpers in `apps/daemon/tests/core/run-service.test.ts`. They should use the async `RunnerPersistence` shape, but add explicit promise gates around assistant-message updates so the test can assert status before and after terminal message persistence resolves.

- [ ] **Step 2: Implement per-run write queue**

Create `apps/daemon/src/core/run-write-queue.ts`:

```ts
export interface RunWriteQueue {
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  drain(): Promise<void>;
}

export function createRunWriteQueue(): RunWriteQueue {
  let tail: Promise<unknown> = Promise.resolve();

  return {
    enqueue<T>(operation: () => Promise<T>): Promise<T> {
      const runAfterPrevious = tail.catch(() => undefined).then(operation);
      const next = runAfterPrevious;
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    async drain(): Promise<void> {
      await tail;
    },
  };
}
```

Each active run gets one queue. The queue serializes durable writes for that run only; it must not serialize unrelated runs globally.

`drain()` intentionally reports only queue idleness; it must not be used as the only error signal for critical terminal writes because `tail` is normalized to keep the queue usable after an intermediate failure. Critical writes must await their own `enqueue()` promise.

- [ ] **Step 3: Convert message accumulator to async ordered writes**

Change `message-accumulator` so:

- `consume()` updates in-memory content/events synchronously for SSE responsiveness and calls the existing dirty/throttle mechanism. It must not enqueue one database write per delta.
- `flushPending()` returns `Promise<void>` and enqueues exactly one write for the current in-memory snapshot after the throttle interval.
- `flushTerminal()` returns `Promise<void>`, enqueues the terminal snapshot, awaits the `enqueue()` promise for that terminal write, then awaits `queue.drain()` so earlier best-effort writes are settled.
- assistant message split/insert operations use the same queue so message creation and updates stay ordered.

Do not let multiple pending writes race against each other for the same assistant message row.

When enqueueing a write for an assistant message segment, capture `messageId`, position, and content snapshot at enqueue time. Do not read mutable `this.messageId` later inside the async operation, because segment switches can happen before the queued write executes.

- [ ] **Step 4: Convert run-service finish/start paths to await ordered writes**

`emitRunEvent()` may keep notifying SSE subscribers synchronously, but any durable persistence triggered by the event must go through the queue.

`finishRun()` must:

1. stop accepting new event writes for that run;
2. preserve the existing artifact-first semantic order by calling `artifactService.finalizeRunArtifacts()` before terminal message/run writes when `finalizeArtifacts !== false`;
3. allow artifact scan results to rewrite `finalStatus` and `finalErrorCode` before any terminal persistence;
4. emit final artifact/error/end events using the rewritten `finalStatus`;
5. enqueue and await terminal assistant-message writes with the rewritten `finalStatus`;
6. await the run write queue drain;
7. persist terminal run status with the rewritten `finalStatus`;
8. close/finalize log metadata and schedule cleanup.

Keep the current semantic separation between assistant-message flush and `runs` terminal update unless implementation explicitly proves a transaction is needed. Do not accidentally add a large transaction around the entire stream finish path.

Do not move artifact finalization after `updateRunTerminal()`. Required artifact misses must still turn a would-be `succeeded` run into `failed` with `ARTIFACT_REQUIRED_MISSING`.

- [ ] **Step 5: Verify**

Run:

```bash
pnpm test:daemon -- tests/core/message-accumulator.test.ts tests/core/run-service.test.ts
pnpm typecheck:daemon
```

Expected: fast delta streams persist final content/events in order, terminal flush waits for pending writes, and SSE subscriber notifications still happen without waiting on database writes.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/core apps/daemon/tests/core
git commit -m "refactor: serialize async run message writes"
```

## Task 4: PostgreSQL Schema Migrations

**Files:**
- Create: `apps/daemon/src/db/postgres/migrations/`
- Create: `apps/daemon/src/db/postgres/migrate.ts`
- Create: `apps/daemon/src/db/postgres/schema-version.ts`
- Modify: `apps/daemon/src/db/postgres/connection.ts`
- Test: `apps/daemon/tests/db/postgres-migrations.test.ts`
- Test: `apps/daemon/tests/db/postgres-type-mapping.test.ts`

- [ ] **Step 1: Add migration runner**

Create a `node-pg-migrate` wrapper that:

- reads `CLAUDE_RUNNER_DATABASE_URL`;
- refuses to run without a database URL;
- points migrations to `apps/daemon/src/db/postgres/migrations`;
- supports `up`, `down`, and `status`;
- never logs the full connection string.

- [ ] **Step 2: Write initial PG schema migration**

Create a migration file named like:

```text
20260614T000000_create_daemon_schema.ts
```

The `up` migration must create all current daemon tables and indexes. Use the exact type rules from `PostgreSQL Type Mapping`: `bigint` for all timestamp/byte-size columns, `integer` for bounded counters/process values, `integer 0/1` for persisted flags, and `text` for current JSON text columns.

The migration must include:

```sql
CREATE UNIQUE INDEX idx_runs_idempotency_key
  ON runs (client_id, profile_id, workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

It must also include every index listed in `Required Indexes And Constraints`.

The `down` migration must drop tables in child-to-parent order.

- [ ] **Step 3: Add PostgreSQL int8 parser and type round-trip tests**

In `apps/daemon/src/db/postgres/connection.ts`, register the project-wide int8 parser before pools are used:

```ts
import pg from 'pg';

pg.types.setTypeParser(20, (value) => Number(value));
```

Add `apps/daemon/tests/db/postgres-type-mapping.test.ts` gated by `CLAUDE_RUNNER_TEST_PG_URL`. It must insert and read:

- millisecond timestamp `1_765_000_000_000`;
- artifact `mtime` `1_765_000_000_001`;
- artifact `size` `4_294_967_296`;
- persisted flag `1`;

and assert mapped records expose `number` fields and `persisted === true`.

- [ ] **Step 4: Add migration status check for startup**

Create a helper:

```ts
export async function assertPostgresSchemaReady(databaseUrl: string): Promise<void>
```

It should check the migration table created by `node-pg-migrate` and throw a clear error when migrations have not been run. The error message must not include credentials.

- [ ] **Step 5: Integration test with required PG in CI**

Add tests that run when `CLAUDE_RUNNER_TEST_PG_URL` is present, and fail fast when `CI=true` but the variable is absent:

```ts
const pgUrl = process.env.CLAUDE_RUNNER_TEST_PG_URL;
if (process.env.CI === 'true' && !pgUrl) {
  throw new Error('CLAUDE_RUNNER_TEST_PG_URL is required in CI');
}
const testPg = pgUrl ? describe : describe.skip;

testPg('postgres migrations', () => {
  it('creates required tables and idempotency index', async () => {
    await runPostgresMigrations({ databaseUrl: pgUrl!, direction: 'up' });
    const result = await pool.query(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'runs'",
    );
    expect(result.rows.map((row) => row.indexname)).toContain('idx_runs_idempotency_key');
    expect(result.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'idx_workspaces_identity',
        'idx_workspaces_client_profile_key',
        'idx_conversations_workspace',
        'idx_runs_workspace_created',
        'idx_runs_status_created',
        'idx_runs_idempotency_key',
        'idx_run_messages_run',
        'idx_run_messages_conversation',
        'idx_run_messages_conversation_seq',
        'idx_artifacts_run',
        'idx_run_feedback_run_created',
      ]),
    );
  });
});
```

- [ ] **Step 6: Verify**

Without PG:

```bash
pnpm typecheck:daemon
pnpm test:daemon
```

With PG:

```bash
CLAUDE_RUNNER_TEST_PG_URL=postgres://user:pass@localhost:5432/daemon_test \
  pnpm test:daemon -- tests/db/postgres-migrations.test.ts tests/db/postgres-type-mapping.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/db/postgres apps/daemon/tests/db/postgres-migrations.test.ts apps/daemon/tests/db/postgres-type-mapping.test.ts
git commit -m "feat: add postgres schema migrations"
```

## Task 5: PostgreSQL Repository Adapter

**Files:**
- Create: `apps/daemon/src/db/postgres/connection.ts`
- Create: `apps/daemon/src/db/postgres/repositories.ts`
- Create: `apps/daemon/src/db/postgres/errors.ts`
- Modify: `apps/daemon/src/core/run-service.ts`
- Test: `apps/daemon/tests/db/postgres-repositories.test.ts`
- Test: `apps/daemon/tests/core/run-service.test.ts`

- [ ] **Step 1: Port repository behavior tests to PostgreSQL**

Port the current repository behavior coverage to PostgreSQL. Keep SQLite repository coverage only where the migration script needs to read source data. Cover at least:

- workspace upsert and client/profile/workspace isolation;
- conversation create/list behavior;
- run insert/update/status transitions;
- run idempotency lookup and unique conflict behavior;
- run messages ordering and conversation sequence;
- artifact replacement/listing;
- run logs;
- snapshots;
- feedback.
- async contract: repository methods return promises and route/service callers `await` them instead of reading synchronous results.
- transaction rollback: if any step in `createRunQueuedWithMessagesAndSnapshot` fails, no partial `runs`, `run_messages`, `profile_snapshots`, or context snapshots remain.
- concurrent idempotency: two concurrent create-run attempts with the same `(client_id, profile_id, workspace_id, idempotency_key)` produce one run row; the loser path maps the `23505` conflict into idempotent replay/conflict handling.

For PG-specific tests, gate with `CLAUDE_RUNNER_TEST_PG_URL`.

- [ ] **Step 2: Implement PG connection**

Use `pg.Pool`:

```ts
import { Pool } from 'pg';

export function createPostgresPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}
```

Do not log the URL. If connection fails, log only host/database if safely parsed without credentials.

- [ ] **Step 3: Implement PG transactions**

Implement facade `transaction` using one client:

```ts
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const result = await fn(clientBackedPersistence);
  await client.query('COMMIT');
  return result;
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
}
```

All multi-row operations that are atomic in current SQLite transactions must remain atomic in PG:

- queued run insert plus conversation/message/profile snapshot creation;
- artifact replacement;
- startup interrupted status update;
- run log row deletion for retention cleanup;

Use a client-bound persistence object inside `transaction(fn)`. Calls made inside the callback must use the transaction client, not `pool.query`, so `BEGIN`, writes, and `COMMIT` occur on the same PostgreSQL connection.

Keep the current finish-run semantic separation between assistant-message flush and `runs` terminal update unless a later task explicitly changes it. Do not merge them into one large transaction as part of the PG adapter work.

- [ ] **Step 4: Implement idempotency unique error mapping**

Map PostgreSQL `23505` for `idx_runs_idempotency_key` to the same generic unique constraint signal used by `RunService.createRun` replay fallback. The detector must work whether the error is thrown by the `INSERT` or by transaction commit after rollback handling.

Do not keep `isSqliteUniqueConstraintError` inside core service code. Replace it with:

```ts
isRepositoryUniqueConstraintError(error)
```

provided by the persistence layer.

- [ ] **Step 5: Implement async repository methods**

Use parameterized queries only:

```ts
await client.query(
  'SELECT * FROM runs WHERE client_id = $1 AND profile_id = $2 AND workspace_id = $3 AND idempotency_key = $4',
  [clientId, profileId, workspaceId, idempotencyKey],
);
```

Map snake_case rows to the same camelCase records returned by SQLite.

Do not use `better-sqlite3`, `deasync`, `execFileSync`, synchronous filesystem reads, or other blocking mechanisms in runtime repository methods. Synchronous filesystem APIs are allowed only in CLI migration scripts where they do not run in the daemon request path.

- [ ] **Step 6: Add run-service concurrency tests**

Add a PostgreSQL-backed run-service test that starts two `createRun` calls concurrently with the same idempotency key and same fingerprint. Expected:

- both calls resolve successfully;
- both return the same `runId`;
- only one `runs` row exists for the idempotency key;
- only one user/assistant message pair exists for that run.

Add a second concurrent test with the same key and different fingerprint. Expected:

- one call creates the run;
- the other returns `409 IDEMPOTENCY_KEY_CONFLICT`;
- no duplicate run/messages are inserted.

- [ ] **Step 7: Verify**

Without PG:

```bash
pnpm test:daemon
pnpm typecheck:daemon
```

With PG:

```bash
CLAUDE_RUNNER_TEST_PG_URL=postgres://user:pass@localhost:5432/daemon_test \
  pnpm test:daemon -- tests/db/postgres-repositories.test.ts tests/core/run-service.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/src apps/daemon/tests
git commit -m "feat: add postgres repository adapter"
```

## Task 6: PostgreSQL-Only Server Startup

**Files:**
- Modify: `apps/daemon/src/db/connection.ts`
- Modify: `apps/daemon/src/index.ts`
- Modify: `apps/daemon/tests/index.test.ts`
- Test: existing HTTP route tests

- [ ] **Step 1: Write startup tests**

Add a test that missing `server.persistence.databaseUrl` fails config validation before server startup.

Add a test that PostgreSQL config opens the PG persistence path and refuses to start when migrations are not current.

Add a test that startup interruption marking goes through the PostgreSQL facade.

Add a route-level test with a deliberately delayed persistence promise to prove the route awaits async service results before sending the response. This catches accidental synchronous assumptions during the migration.

- [ ] **Step 2: Implement PostgreSQL startup**

Implement:

```ts
export async function openRunnerPersistence(serverConfig: ServerConfig): Promise<RunnerPersistence>
```

Behavior:

- assert `serverConfig.persistence.databaseUrl` exists;
- assert migrations are current;
- open PG pool;
- return PG persistence.

Make `createServerContext` async if needed and update callers cleanly. Do not add a SQLite fallback for tests.

- [ ] **Step 3: Update local config before merge**

Before this branch is merged, update tracked local/example config so the normal local command includes `server.persistence.databaseUrl` through `env:CLAUDE_RUNNER_DATABASE_URL`.

Run:

```bash
env \
  CLAUDE_RUNNER_LQBOT_API_KEY=lancelocal-report \
  RPA_DAEMON_API_KEY=local-rpa-test-key \
  CLAUDE_RUNNER_DATABASE_URL=postgres://user:pass@localhost:5432/daemon \
  pnpm start:daemon:local
```

Expected: daemon starts with PostgreSQL. It should fail clearly if `CLAUDE_RUNNER_DATABASE_URL` is absent.

- [ ] **Step 4: Verify**

```bash
pnpm test:daemon
pnpm typecheck:daemon
```

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src apps/daemon/tests
git commit -m "feat: start daemon with postgres persistence"
```

## Task 7: SQLite-To-PostgreSQL Data Migration Script

**Files:**
- Create: `apps/daemon/src/db/migration/sqlite-to-postgres.ts`
- Create: `apps/daemon/src/db/migration/migration-types.ts`
- Test: `apps/daemon/tests/db/sqlite-to-postgres.test.ts`

- [ ] **Step 1: Write migration script tests**

Use a temporary SQLite database populated through existing SQLite repositories. Use a temporary PostgreSQL database when `CLAUDE_RUNNER_TEST_PG_URL` exists.

Required assertions:

- source SQLite file still exists and row counts are unchanged after migration;
- source SQLite file `sha256`, size, and mtime are unchanged after migration;
- read-only migration fails with a clear operator message if the SQLite file appears to have an active journal/WAL state because the daemon was not stopped cleanly;
- parent/child rows are copied in valid order;
- idempotency fields survive exactly;
- JSON text fields are preserved byte-for-byte as PostgreSQL `text` columns;
- running/queued rows are copied as-is, then PG daemon startup marks them interrupted with the same semantics as the current implementation;
- historical duplicate `Default` conversations for a workspace are copied without violating PostgreSQL constraints, and subsequent `getOrCreateDefaultConversation` behavior selects the oldest existing `Default` row;
- old SQLite schemas missing later `ensureColumn` columns migrate successfully with current defaults;
- rerunning the script with `--dry-run` writes nothing;
- rerunning against a non-empty PostgreSQL target fails before writing.

- [ ] **Step 2: Implement CLI arguments**

Support:

```text
--sqlite <path>
--database-url <url>
--dry-run
```

Default database URL source:

```text
CLAUDE_RUNNER_DATABASE_URL
```

The script must fail fast if:

- SQLite path does not exist;
- SQLite source has no daemon schema;
- PG migrations are not current;
- PG target has existing rows.

Do not implement an overwrite/truncate mode in this script. It is only for empty PostgreSQL database initialization from a preserved SQLite source. If an operator needs to rerun migration, they must create a fresh empty PG database or manually reset it outside this daemon tool.

- [ ] **Step 3: Implement copy order**

Copy in this order:

```text
workspaces
conversations
runs
run_messages
artifacts
run_logs
profile_snapshots
run_prompt_snapshots
run_skill_snapshots
run_context_snapshots
run_feedback
```

Use transactions around the entire copy by default. If the database is too large later, add chunked transactions in a separate plan.

- [ ] **Step 4: Preserve SQLite source file**

Open SQLite read-only:

```ts
const sqlite = new Database(sqlitePath, { readonly: true });
```

Do not call SQLite `applySchema` inside the data migration script because it can mutate old files. The script should inspect and copy the schema as found.

Before reading rows, record source file `sha256`, `size`, and `mtimeMs`. After the migration transaction completes or rolls back, record them again and fail if any value changed.

The operator runbook must instruct operators to stop the daemon cleanly before running this script. A read-only SQLite open can still fail or see an unsafe state if there is an active hot journal or WAL from a running/crashed daemon. Do not work around that by opening the source file read-write or checkpointing it inside the migration script; fail with a clear message and ask the operator to stop/recover the SQLite database first.

- [ ] **Step 5: Handle old SQLite schemas**

The script must read the source schema with `PRAGMA table_info` and provide defaults for missing columns that current `applySchema` would have added:

- `run_messages.thinking_content` -> `''`
- `run_messages.conversation_seq` -> `NULL`
- `runs.prompt_mode` -> `'legacy'`
- `runs.current_prompt` -> `runs.prompt`
- `runs.context_policy_json` -> `NULL`
- `runs.collection_mode` -> `'lite'`
- `runs.prompt_snapshot_hash` -> `NULL`
- `runs.prompt_snapshot_char_count` -> `NULL`
- `runs.prompt_snapshot_byte_count` -> `NULL`
- `runs.prompt_snapshot_persisted` -> `0`
- `runs.business_context_hash` -> `NULL`
- `runs.idempotency_key` -> `NULL`
- `runs.idempotency_fingerprint` -> `NULL`

Add a fixture-style migration test with an intentionally old SQLite schema that omits those columns.

- [ ] **Step 6: Verify**

```bash
pnpm typecheck:daemon
pnpm test:daemon -- tests/db/sqlite-to-postgres.test.ts
```

With PG:

```bash
CLAUDE_RUNNER_TEST_PG_URL=postgres://user:pass@localhost:5432/daemon_test \
  pnpm test:daemon -- tests/db/sqlite-to-postgres.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/db/migration apps/daemon/tests/db/sqlite-to-postgres.test.ts
git commit -m "feat: add sqlite to postgres migration script"
```

## Task 8: Migration Verification Script

**Files:**
- Create: `apps/daemon/src/db/migration/verify-sqlite-to-postgres.ts`
- Test: `apps/daemon/tests/db/verify-sqlite-to-postgres.test.ts`

- [ ] **Step 1: Write verification tests**

Tests should create a matching SQLite/PG pair and assert verification passes.

Create mismatch cases:

- missing run row;
- mismatched idempotency fingerprint;
- missing artifact row;
- mismatched run message count;
- broken foreign key relation.

- [ ] **Step 2: Implement verification**

Verification output should include:

```text
table row counts
primary-key set comparison
row-level business-column hashes
foreign-key consistency summary
idempotency index check
```

The script should return non-zero on mismatch and print a concise table of failures. Do not print prompt content, API keys, full metadata payloads, or full database URLs.

For each table, compute deterministic hashes over all non-time bookkeeping business columns plus relevant timestamps/counts needed for API parity. At minimum include:

- `workspaces`: all columns except no exclusions.
- `conversations`: all columns.
- `runs`: all columns, including `prompt`, `current_prompt`, `context_policy_json`, `artifact_rule_ids_json`, `usage_json`, `metadata_json`, `idempotency_key`, and `idempotency_fingerprint`.
- `run_messages`: all columns, including `content`, `thinking_content`, `events_json`, `attachments_json`, and `produced_files_json`.
- `artifacts`: all columns, including `relative_path`, `file_name`, `size`, `mtime`, `sha256`, and `metadata_json`.
- `run_logs`: all columns.
- `profile_snapshots`: all columns, including `profile_json`.
- `run_prompt_snapshots`: all columns, including `prompt_snapshot`.
- `run_skill_snapshots`: all columns, including `skill_body` and `side_files_manifest_json`.
- `run_context_snapshots`: all columns, including `business_context_json`.
- `run_feedback`: all columns.

Sort rows by primary key before hashing. Normalize `NULL`, numbers, and strings consistently so SQLite numeric values and PostgreSQL numeric values compare by value, not driver representation.

The verification script must either import the same PostgreSQL connection setup that registers the `int8` parser or explicitly normalize PG `int8` fields with `Number(row.column)` before hashing. Do not compare raw PG driver strings against SQLite numbers, because that can produce false mismatches for timestamps and artifact sizes even when the data is correct.

- [ ] **Step 3: Add JSON report option**

Support:

```text
--json
```

JSON output should include machine-readable counts and mismatches, not sensitive field values.

- [ ] **Step 4: Verify**

```bash
pnpm typecheck:daemon
pnpm test:daemon -- tests/db/verify-sqlite-to-postgres.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/db/migration apps/daemon/tests/db/verify-sqlite-to-postgres.test.ts
git commit -m "feat: add sqlite to postgres verification"
```

## Task 9: End-To-End PG Backend Verification

**Files:**
- Test: `apps/daemon/tests/http/*.test.ts`
- Test: `apps/daemon/tests/core/*.test.ts`
- Create: `apps/daemon/tests/helpers/postgres-persistence-harness.ts`

- [ ] **Step 1: Build a PostgreSQL test harness**

Add a helper that creates isolated PostgreSQL persistence for route/service tests when `CLAUDE_RUNNER_TEST_PG_URL` exists:

```ts
export interface PostgresPersistenceHarness {
  persistence: RunnerPersistence;
  cleanup(): Promise<void>;
}
```

Do not create a SQLite runtime harness. SQLite test helpers belong only to migration source tests.

- [ ] **Step 2: Run critical API flows against PG**

Cover:

- workspace create/reuse;
- upload/prepare metadata persistence if DB-backed fields exist;
- generate run create;
- revise run create;
- poll status;
- SSE connection;
- cancel;
- artifacts list/download metadata;
- logs;
- startup interruption marking;
- idempotency replay and conflict.
- concurrent status polling does not throw or return before async persistence promises resolve.

- [ ] **Step 3: Verify no API response shape drift**

For representative HTTP tests, assert response JSON is unchanged except for timestamps/ids already variable today.

- [ ] **Step 4: Verify**

```bash
pnpm test:daemon
pnpm typecheck:daemon
pnpm build:daemon
```

With PG:

```bash
CLAUDE_RUNNER_TEST_PG_URL=postgres://user:pass@localhost:5432/daemon_test \
  pnpm test:daemon
```

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/tests
git commit -m "test: cover postgres persistence backend"
```

## Task 10: Documentation And Operations

**Files:**
- Modify: `docs/configuration-reference.md`
- Modify: `docs/claude-code-runner-daemon-version-roadmap.md`
- Create: `docs/postgres-persistence-migration/operator-runbook.md`
- Modify: `docs/api-reference.md`

- [ ] **Step 1: Document config**

Add `server.persistence`:

```json
{
  "databaseUrl": "env:CLAUDE_RUNNER_DATABASE_URL"
}
```

State clearly:

- omitted config is invalid after the PG migration branch is merged;
- SQLite file path `.claude-runner/data/runner.sqlite` is preserved only as a migration source and historical backup;
- PostgreSQL runtime requires running migrations before startup;
- database URLs must be supplied through env in shared environments.
- all daemon runtime persistence operations are asynchronous PostgreSQL operations; SQLite is migration-source tooling only.

- [ ] **Step 2: Document migration runbook**

Create `docs/postgres-persistence-migration/operator-runbook.md` with:

```text
1. Stop daemon.
2. Back up .claude-runner/data/runner.sqlite and any sibling .claude-runner/data/runner.sqlite-wal or .claude-runner/data/runner.sqlite-shm files if they exist.
3. Create PostgreSQL database.
4. Run pnpm db:migrate:pg.
5. Run pnpm db:migrate:sqlite-to-pg.
6. Run pnpm db:verify:sqlite-to-pg.
7. Start daemon with server.persistence.databaseUrl.
8. Run smoke tests.
9. Before merge, roll back by continuing to use main and the preserved SQLite file. After merge, restore PostgreSQL from backup; no SQLite runtime rollback is provided.
```

Explicitly state that rollback does not copy PG-only post-cutover writes back into SQLite, and the merged daemon runtime does not support SQLite.

Also state that the daemon must be stopped cleanly before running the read-only SQLite migration. If the migration reports an active journal/WAL or cannot open the SQLite source read-only, operators should resolve the SQLite state outside the daemon migration tool and rerun against the unchanged source file.

- [ ] **Step 3: Document API stability**

Add a short note to `docs/api-reference.md` that persistence backend does not change API request/response shape. Do not alter business integration examples unless implementation actually changes API behavior.

- [ ] **Step 4: Verify docs**

```bash
pnpm typecheck
pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add docs package.json apps/daemon/package.json
git commit -m "docs: add postgres persistence migration runbook"
```

## Task 11: Final Migration Gate

**Files:**
- Modify this plan with completion notes after implementation and review.

- [ ] **Step 1: Full verification**

Run without PG env:

```bash
pnpm typecheck
pnpm build
pnpm test:web
pnpm test:rpa-local-web
```

This block intentionally does not run `pnpm test:daemon` without PostgreSQL because daemon persistence tests are required to fail fast in CI when `CLAUDE_RUNNER_TEST_PG_URL` is missing. Daemon tests are run in the PostgreSQL sections below.

Run daemon tests with PG env:

```bash
CLAUDE_RUNNER_TEST_PG_URL=postgres://user:pass@localhost:5432/daemon_test \
  pnpm test:daemon
```

Run the CI-equivalent daemon test gate:

```bash
CI=true \
CLAUDE_RUNNER_TEST_PG_URL=postgres://user:pass@localhost:5432/daemon_test \
  pnpm test:daemon
```

Also verify that `CI=true pnpm test:daemon` fails fast when `CLAUDE_RUNNER_TEST_PG_URL` is missing.

Run one manual PG daemon smoke test after applying migrations. Confirm the preserved SQLite file still exists on disk, but do not start the daemon against it.

- [ ] **Step 2: Review high-risk invariants**

Before merging, verify:

- existing SQLite database remains present and readable;
- daemon startup requires PostgreSQL config;
- PG startup refuses unmigrated schema;
- idempotency replay works on PG under duplicate `POST /api/runs`;
- queued/running rows become `interrupted` on PG restart;
- runtime persistence methods and HTTP routes use async/await and do not perform synchronous database I/O;
- CI daemon tests require PostgreSQL and do not silently skip persistence coverage;
- no API response includes DB URLs, absolute sandbox paths, prompts in error payloads, or API keys;
- no product-specific business names or assumptions entered `apps/daemon/src`.

- [ ] **Step 3: Implementation review**

Review the implementation and tests before merge. Include this plan path and the final diff.

- [ ] **Step 4: Commit completion note**

After review fixes:

```bash
git add docs/postgres-persistence-migration/implementation-plan.md
git commit -m "docs: record postgres persistence migration completion"
```

## Implementation Watchpoints

1. Do not replace the method-based persistence facade with a raw query executor that leaks SQL into core/http modules.
2. Keep current JSON columns as `text` for the first PG cutover unless a separate plan changes mapper/API behavior.
3. Convert `createServerContext` and all persistence-touching services/routes to async consistently, without sync wrappers that block the daemon.
4. `node-pg-migrate` migrations are operator-run before daemon startup. Daemon startup checks schema readiness; it does not auto-run migrations.
5. Keep `run_logs` path semantics compatible with the current local filesystem behavior unless a separate path-normalization plan changes the API.
6. Use one full-copy transaction for the initial SQLite-to-PG migration. If the SQLite database becomes too large, create a separate chunked-migration plan.
7. CI must provide PostgreSQL for daemon persistence tests. Local runs may skip PG tests only when `CI` is not true.
8. Preserve current `finishRun()` artifact-first semantics. Artifact finalization can rewrite `succeeded` to `failed` before assistant terminal writes and `runs` terminal persistence.
9. Treat PG-gated tests as the source of truth for persistence semantics. Daemon startup must never fall back to SQLite or in-memory persistence.
10. Keep `message-accumulator.consume()` as in-memory plus throttled persistence. Do not enqueue one database write per streaming delta.
11. Await each critical terminal write's own `enqueue()` promise. `RunWriteQueue.drain()` is an idleness check, not a replacement for terminal write error handling.
12. Make default-conversation creation transaction-safe under async PG without breaking migration of historical duplicate `Default` rows. Prefer a transaction-scoped advisory lock and oldest-row reselect; do not add a `(workspace_id, title)` unique constraint unless the migration plan is updated to handle existing duplicates.
13. Verification hashes must normalize PostgreSQL `int8` values to numbers before comparing with SQLite values.
14. The SQLite migration source must be opened read-only and left unchanged. If an active journal/WAL prevents safe reading, fail and require operator cleanup rather than mutating the source file.


## Self-Review

- Spec coverage: Covers package choice, final PostgreSQL-only runtime, temporary SQLite file preservation during migration, `node-pg-migrate` schema migrations, self-owned SQLite-to-PG data copy, verification script, API stability, docs, rollback, async runtime persistence, PG type mapping, ordered run-message persistence, artifact-first terminal semantics, and CI PG coverage.
- Placeholder scan: No deferred implementation placeholders are left. Implementation watchpoints are recorded as concrete constraints rather than open-ended review prompts.
- Boundary check: Plan keeps business-specific logic out of daemon core, excludes distributed queue and webhook delivery, and keeps `run_events` out of scope.
- Migration safety check: Existing SQLite file is preserved as migration source and historical backup; absent `server.persistence.databaseUrl` is invalid after this branch is merged.
