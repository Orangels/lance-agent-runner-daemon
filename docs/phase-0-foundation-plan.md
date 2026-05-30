# Phase 0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the trusted-deployment foundation for the standalone Claude Code runner daemon: config/profile loading, API-key auth, safe workspace create/prepare, SQLite schema/repositories, and startup interruption handling.

**Architecture:** Phase 0 keeps runtime execution out of scope and builds the service boundary that Phase 1 will run on. `src/config/*` owns config/profile/auth/env validation, `src/core/*` owns path/workspace/domain helpers without Express dependencies, `src/db/*` owns SQLite connection/schema/repositories, and `src/http/*` exposes only health/profile/workspace routes. lanceDesign remains a reference implementation only; do not import any private source.

**Tech Stack:** TypeScript ESM, Express 5, zod, better-sqlite3, Node fs/path APIs, Vitest.

---

## Review Scope

This document is the Phase 0 plan and implementation guide. Review this plan before any Phase 0 code is written.

Phase 0 starts from the reviewed Phase 0a API contract on branch:

```text
codex/phase-0-foundation
```

Phase 0 must preserve these Phase 0a decisions:

- `POST /api/runs` references `workspaceId`; it does not inline `originId/userId/projectId`.
- `kind=generate` requires `skillId`; `kind=revise` forbids `skillId`.
- No request may override `claudeConfigDir`, `claudeBin`, `skillRoots`, `allowedInputRoots`, or `permissionMode`.
- `run_events` table is not part of the first version.
- The workspace directory skeleton is `input/`, `output/`, `work/`, `.claude-runner-skills/`.

## Source References

Local docs:

- `AGENTS.md`
- `REFERENCE.md`
- `docs/claude-code-runner-daemon-design.md`
- `docs/claude-code-runner-daemon-migration-assessment.md`
- `docs/claude-code-runner-daemon-implementation-plan.md`
- `docs/phase-0a-api-contract-plan.md`

lanceDesign references, for behavior study only:

- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/db.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/project-routes.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/app-config.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/runtimes/env.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/chat-routes.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/runs.ts`

Use those files to understand patterns and semantics, not as package dependencies.

## Non-Scope

Phase 0 must not implement:

- Claude Code CLI spawn.
- SSE.
- cancel behavior.
- run queue/concurrency scheduler.
- skill scan or skill staging.
- artifact watcher, artifact scan, or artifact download behavior.
- upload API.
- remote URL pull, S3/object-storage pull, or browser CORS/signing.
- metrics exposure.
- OS-level isolation, separate uid execution, containers, seccomp/firejail, or Claude Code permission hooks.
- lanceDesign product logic such as design/craft/critique/analytics/preview/deployments/tabs/routines/media/live artifact MCP.

## Target File Map

Create:

- `src/config/env.ts`
- `src/config/profiles.ts`
- `src/config/auth.ts`
- `src/config/config.ts`
- `src/core/ids.ts`
- `src/core/path-safety.ts`
- `src/core/workspace-service.ts`
- `src/db/connection.ts`
- `src/db/schema.ts`
- `src/db/repositories.ts`
- `src/http/app.ts`
- `src/http/auth-middleware.ts`
- `src/http/health-routes.ts`
- `src/http/profiles-routes.ts`
- `src/http/workspaces-routes.ts`
- `src/config/__tests__/profiles.test.ts`
- `src/config/__tests__/auth.test.ts`
- `src/core/__tests__/path-safety.test.ts`
- `src/core/__tests__/workspace-service.test.ts`
- `src/db/__tests__/schema.test.ts`
- `src/db/__tests__/repositories.test.ts`
- `src/http/__tests__/workspaces-routes.test.ts`

Modify:

- `src/index.ts`
- `src/http/validation.ts`, only if Phase 0 needs a shared zod-to-structured-error helper.
- `src/core/run-types.ts`, only if Phase 0 needs additional public DTOs that were intentionally deferred from Phase 0a.

Do not create runtime runner files in this phase.

## Dependency Rules

- `src/index.ts` wires config, database, services, routes, and startup interruption handling.
- `src/http/*` may import config/core/db modules.
- `src/core/*` must not import Express.
- `src/db/*` must not import HTTP modules.
- `src/config/*` must not import HTTP or DB modules.
- `workspace-service` may depend on repository interfaces and profile data, but response DTOs must not expose absolute sandbox paths.
- `path-safety` is the only module that should centralize security-sensitive path segment and root containment checks.

## Data Model

Implement these tables exactly in Phase 0:

```text
workspaces
conversations
runs
run_messages
artifacts
run_logs
profile_snapshots
```

Full repository behavior is required for:

- `workspaces`
- `conversations`
- `runs`
- `run_messages`

Schema-only or minimal helpers are acceptable for:

- `artifacts`
- `run_logs`
- `profile_snapshots`

Do not create `run_events`.

### Required Repository Methods

Implement and test:

- `upsertWorkspace`
- `getWorkspaceForClient`
- `getOrCreateDefaultConversation`
- `insertRunQueued`
- `markInterruptedRunsOnStartup`
- `insertRunMessagesForRunCreate`
- `updateRunStatus`
- `updateRunMessage`
- `getRunDetail`
- `listRunsForClient`

`insertRunQueued` must insert `runs.status = queued` immediately at run creation time.

`markInterruptedRunsOnStartup` must update old `queued` and `running` rows to:

```text
status = interrupted
error_code = RUN_INTERRUPTED_BY_DAEMON_RESTART
```

## Task 1: Config And Profile Validation

**Files:**

- Create: `src/config/env.ts`
- Create: `src/config/profiles.ts`
- Create: `src/config/config.ts`
- Test: `src/config/__tests__/profiles.test.ts`

**Responsibilities:**

- Validate daemon config shape with zod.
- Resolve `env:` references for client API keys.
- Validate profile fields and profile-controlled execution settings.
- Reject profile `env` keys outside the first-version allowlist.
- Provide helpers for profile lookup, model allowlist, artifact rule lookup, and event visibility ceiling.

**Profile Env Allowlist:**

```text
ANTHROPIC_BASE_URL
ANTHROPIC_API_KEY
DISABLE_TELEMETRY
DO_NOT_TRACK
DISABLE_AUTOUPDATER
DISABLE_ERROR_REPORTING
DISABLE_BUG_COMMAND
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
```

`CLAUDE_CONFIG_DIR` and `CLAUDE_BIN` must not be accepted inside profile `env`; they are explicit profile fields: `claudeConfigDir` and `claudeBin`.

**TDD Steps:**

- [ ] Write a failing test that accepts a minimal valid config with one client and one profile.
- [ ] Write a failing test that resolves a client API key from `env:CLAUDE_RUNNER_TEST_KEY`.
- [ ] Write a failing test that rejects a profile env key such as `NODE_OPTIONS`.
- [ ] Write a failing test that rejects `CLAUDE_CONFIG_DIR` inside profile `env`.
- [ ] Write a failing test that rejects `defaultModel` when it is not included in `allowedModels`.
- [ ] Implement minimal schemas and helpers to pass the tests.
- [ ] Run `pnpm test src/config/__tests__/profiles.test.ts`.

**Acceptance Criteria:**

- Invalid config fails before server startup.
- Profile-controlled privileged fields cannot be supplied per request.
- Secret values can be loaded, but public profile responses later can redact them.

## Task 2: Auth And Client Authorization

**Files:**

- Create: `src/config/auth.ts`
- Test: `src/config/__tests__/auth.test.ts`

**Responsibilities:**

- Authenticate API keys from `Authorization: Bearer <key>` and `X-API-Key`.
- Map API key to client.
- Check client access to profile ids.
- Support an explicit admin-style client flag if present in config, but ordinary clients must only see authorized profiles.

**TDD Steps:**

- [ ] Write a failing test that authenticates a bearer token.
- [ ] Write a failing test that authenticates an `X-API-Key` token.
- [ ] Write a failing test that rejects missing/unknown API keys with `UNAUTHORIZED`.
- [ ] Write a failing test that rejects profile access outside `allowedProfileIds` with `PROFILE_NOT_ALLOWED`.
- [ ] Write a failing test that filters profiles to only those allowed for an ordinary client.
- [ ] Implement the smallest auth helpers needed to pass.
- [ ] Run `pnpm test src/config/__tests__/auth.test.ts`.

**Acceptance Criteria:**

- Auth logic is testable without Express.
- Client/profile authorization exists before any route can create workspaces.

## Task 3: Path Safety

**Files:**

- Create: `src/core/path-safety.ts`
- Test: `src/core/__tests__/path-safety.test.ts`

**Responsibilities:**

- Validate safe identity path segments for `originId`, `userId`, and `projectId`.
- Validate workspace-relative target paths.
- Reject protected `.claude-runner-skills` prepare targets.
- Resolve paths and verify they remain under an approved root.
- Normalize root containment checks without string-prefix vulnerabilities.

**TDD Steps:**

- [ ] Write a failing test that accepts safe segments like `lqbot`, `user_1`, `project-123`.
- [ ] Write failing tests that reject empty string, `.`, `..`, slash, backslash, and null byte segments.
- [ ] Write failing tests that reject absolute workspace target paths, parent traversal, empty segments, and `.claude-runner-skills/...`.
- [ ] Write a failing test that verifies a resolved source path is inside an allowed root.
- [ ] Write a failing test that rejects sibling-prefix escapes such as `/allowed-root-evil/file.txt` when root is `/allowed-root`.
- [ ] Implement minimal named helpers such as `assertSafePathSegment`, `assertWorkspaceRelativePath`, `resolveUnderRoot`, and `isPathInsideRoot`.
- [ ] Run `pnpm test src/core/__tests__/path-safety.test.ts`.

**Acceptance Criteria:**

- Security-sensitive path checks are named helpers.
- Later services do not duplicate path validation logic.
- Root containment checks are path-aware, not naive string prefix checks.

## Task 4: SQLite Connection And Schema

**Files:**

- Create: `src/db/connection.ts`
- Create: `src/db/schema.ts`
- Test: `src/db/__tests__/schema.test.ts`

**Responsibilities:**

- Open a better-sqlite3 database under `server.dataDir`.
- Enable `foreign_keys`.
- Apply idempotent schema creation for all Phase 0 tables.
- Create the required indexes.

**TDD Steps:**

- [ ] Write a failing test that opens an in-memory database and applies schema twice without error.
- [ ] Write a failing test that verifies all seven tables exist.
- [ ] Write a failing test that verifies `run_events` does not exist.
- [ ] Write a failing test that verifies key indexes exist:
  - `idx_workspaces_identity`
  - `idx_conversations_workspace`
  - `idx_runs_workspace_created`
  - `idx_runs_status_created`
  - `idx_run_messages_run`
  - `idx_run_messages_conversation`
  - `idx_artifacts_run`
- [ ] Implement `openDatabase` and `applySchema`.
- [ ] Run `pnpm test src/db/__tests__/schema.test.ts`.

**Acceptance Criteria:**

- Schema can initialize a fresh DB.
- Schema can run repeatedly.
- `run_events` is absent by design.

## Task 5: Repositories

**Files:**

- Create: `src/db/repositories.ts`
- Test: `src/db/__tests__/repositories.test.ts`

**Responsibilities:**

- Own all direct SQL for Phase 0 entities.
- Store JSON fields as strings.
- Preserve client/profile/workspace ownership boundaries.
- Insert `runs.status = queued` at creation time.
- Mark old `queued/running` runs as `interrupted` at daemon startup.

**TDD Steps:**

- [ ] Write a failing test for `upsertWorkspace` returning the same workspace for the same `clientId/profileId/originId/userId/projectId`.
- [ ] Write a failing test for `getWorkspaceForClient` denying a workspace owned by another client.
- [ ] Write a failing test for `getOrCreateDefaultConversation`.
- [ ] Write a failing test for `insertRunQueued` inserting `queued_at`, `created_at`, and `updated_at`.
- [ ] Write a failing test for `insertRunMessagesForRunCreate` inserting user position `0` and assistant draft position `1`.
- [ ] Write a failing test for `markInterruptedRunsOnStartup` changing old `queued/running` rows to `interrupted` with `RUN_INTERRUPTED_BY_DAEMON_RESTART`.
- [ ] Write a failing test for `listRunsForClient` applying client and status filters.
- [ ] Write a failing test for `getRunDetail` returning run plus messages without sandbox paths.
- [ ] Implement repository functions.
- [ ] Run `pnpm test src/db/__tests__/repositories.test.ts`.

**Acceptance Criteria:**

- The DB layer can support Phase 1 run creation without schema redesign.
- Startup interruption handling is durable and tested.
- Query methods are client-scoped.

## Task 6: Workspace Service

**Files:**

- Create: `src/core/ids.ts`
- Create: `src/core/workspace-service.ts`
- Test: `src/core/__tests__/workspace-service.test.ts`

**Responsibilities:**

- Create or get a workspace.
- Resolve internal workspace cwd as `profile.sandboxRoot / originId / userId / projectId`.
- Create directory skeleton:

```text
input/
output/
work/
.claude-runner-skills/
```

- Prepare files by copying from allowed input roots to safe workspace-relative targets.
- Return only public metadata: `workspaceId`, `workspaceKey`, copied target paths, and sizes.

**TDD Steps:**

- [ ] Write a failing test that creates the workspace directory skeleton.
- [ ] Write a failing test that create-or-get returns the existing workspace id.
- [ ] Write a failing test that the public response does not include absolute paths.
- [ ] Write a failing test that prepare rejects `sourcePath` outside `allowedInputRoots`.
- [ ] Write a failing test that prepare copies an allowed file to `input/source.docx`.
- [ ] Write a failing test that prepare rejects `.claude-runner-skills/...`.
- [ ] Implement `createOrGetWorkspace` and `prepareWorkspaceFiles`.
- [ ] Run `pnpm test src/core/__tests__/workspace-service.test.ts`.

**Acceptance Criteria:**

- Directory isolation is implemented as a trusted-deployment boundary, not advertised as strong sandboxing.
- Callers never receive sandbox absolute paths.
- Prepare copies only from `allowedInputRoots`.

## Task 7: HTTP App And Routes

**Files:**

- Create: `src/http/app.ts`
- Create: `src/http/auth-middleware.ts`
- Create: `src/http/health-routes.ts`
- Create: `src/http/profiles-routes.ts`
- Create: `src/http/workspaces-routes.ts`
- Test: `src/http/__tests__/workspaces-routes.test.ts`

**Responsibilities:**

- Build an Express app with JSON body parsing.
- Add structured error handling for zod and `DaemonError`.
- Implement:
  - `GET /api/health`
  - `GET /api/profiles`
  - `POST /api/workspaces`
  - `POST /api/workspaces/:workspaceId/prepare`
- Ensure `GET /api/profiles` returns only profiles allowed to the current client and redacts internal paths/secrets.

**TDD Steps:**

- [ ] Write a failing test that `GET /api/health` returns ok without auth.
- [ ] Write a failing test that `GET /api/profiles` requires auth.
- [ ] Write a failing test that `GET /api/profiles` redacts `sandboxRoot`, `claudeConfigDir`, `skillRoots`, `allowedInputRoots`, API keys, and secret env values.
- [ ] Write a failing test that `POST /api/workspaces` creates/gets a workspace and returns `workspaceId` plus `workspaceKey`.
- [ ] Write a failing test that `POST /api/workspaces` rejects unauthorized profile access.
- [ ] Write a failing test that `POST /api/workspaces/:workspaceId/prepare` copies an allowed file and returns only `targetPath` and `size`.
- [ ] Write a failing test that zod path validation maps to structured `INVALID_PATH_SEGMENT` or `PATH_NOT_ALLOWED` where appropriate.
- [ ] Implement route modules and middleware.
- [ ] Run `pnpm test src/http/__tests__/workspaces-routes.test.ts`.

**Acceptance Criteria:**

- Routes remain thin.
- Route responses are structured and redacted.
- Validation failures use structured daemon error responses.

## Task 8: Startup Wiring

**Files:**

- Modify: `src/index.ts`

**Responsibilities:**

- Load config from CLI/env.
- Open SQLite database under `server.dataDir`.
- Apply schema.
- Mark old `queued/running` runs as `interrupted`.
- Create services and Express app.
- Listen on configured host/port.

**TDD/Verification Steps:**

- [ ] Add a small testable `createServerContext` helper if needed, rather than putting all logic in `main`.
- [ ] Keep `main()` thin and side-effect-focused.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm build`.
- [ ] Run `pnpm dev` with a local test config only after code implementation begins.

**Acceptance Criteria:**

- Daemon can start without Claude Code runner support.
- Startup interruption handling runs before serving requests.
- No Phase 1 runner behavior is introduced.

## Phase 0 Validation

Required commands before Phase 0 is called ready:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Manual smoke after implementation:

```bash
pnpm dev -- --config /tmp/claude-runner-test/config.json
curl -s http://127.0.0.1:17890/api/health
curl -s -H 'Authorization: Bearer <api-key>' http://127.0.0.1:17890/api/profiles
curl -s -X POST -H 'Authorization: Bearer <api-key>' -H 'Content-Type: application/json' \
  http://127.0.0.1:17890/api/workspaces \
  -d '{"profileId":"report-docx","workspace":{"originId":"lqbot","userId":"user_1","projectId":"project_123"}}'
```

Expected smoke results:

- Health returns ok.
- Profiles route returns only public allowed profile metadata.
- Workspace create returns `workspaceId` and `workspaceKey`, not absolute paths.
- Workspace skeleton exists internally.
- SQLite contains `workspaces`, `conversations`, `runs`, `run_messages`, `artifacts`, `run_logs`, and `profile_snapshots`.
- Old `queued/running` runs are marked `interrupted` on startup.

## Review Checklist For CC

- [ ] Plan keeps Phase 0 limited to foundation work.
- [ ] Plan does not include Claude spawn, SSE, cancel, skill staging, artifacts, queue, metrics, upload, or OS-level isolation.
- [ ] Config/profile/auth tasks prevent request-time override of privileged profile settings.
- [ ] Path-safety tasks cover path segments, workspace-relative paths, root containment, and protected skill staging directory.
- [ ] Workspace service tasks avoid exposing sandbox absolute paths.
- [ ] SQLite plan includes required first-version tables and excludes `run_events`.
- [ ] Repositories insert `runs.status = queued` at run creation time.
- [ ] Startup interruption handling is included and tested.
- [ ] HTTP plan includes structured zod-to-error mapping, including path-related errors.
- [ ] lanceDesign references are absolute paths and reference-only.
