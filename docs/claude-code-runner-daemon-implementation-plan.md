# Claude Code Runner Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working standalone Claude Code CLI runner daemon with stable API contracts, profile/auth/workspace/SQLite foundations, and a minimal run pipeline that persists daemon-side messages.

**Architecture:** The daemon is an Express HTTP/SSE service over TypeScript ESM modules. HTTP routes stay thin, core modules own domain behavior without Express dependencies, database modules own SQLite schema/repositories, and config modules own profiles/auth/env validation. lanceDesign is a reference implementation only; do not import its private source.

**Tech Stack:** TypeScript, Node.js ESM, Express 5, better-sqlite3, zod, fast-glob, Vitest, Claude Code CLI stream-json.

---

## Non-Negotiable Boundaries

- This repository remains a standalone daemon, not a lanceDesign package.
- Do not import from `/home/orangels/ls_dev/lanceDesign`; use those files only as references.
- First version uses directory isolation only. Do not claim OS-level sandboxing.
- Do not implement separate uid execution, containers, seccomp/firejail, Claude Code permission hooks, or untrusted multi-tenant isolation.
- `POST /api/runs` references `workspaceId`; it does not inline `originId`, `userId`, or `projectId`.
- Requests must not override `claudeConfigDir`, `claudeBin`, `skillRoots`, `allowedInputRoots`, or `permissionMode`.
- `workspaces`, `runs`, and `run_messages` are Phase 0/1 foundations. `runs` must be inserted as `queued` at run create time.
- Do not add a `run_events` table in the first version.
- SSE `/events` only promises live delivery and short reconnect replay from memory. Long-term run detail reads `run_messages.events_json`.
- Never expose sandbox absolute paths through API responses.

## Current Milestone Status

The original first-version implementation path is complete:

- Phase 0a: API contract freeze.
- Phase 0: profile, auth, workspace, and SQLite foundation.
- Phase 1: minimal Claude Code run with daemon-side message persistence.
- Phase 2: skill staging and artifact scan/download.
- Phase 3: queue, timeout, logs, and hardening.

Phase 4 has also landed as a narrow input-ingestion extension:

- `POST /api/workspaces/:workspaceId/files` accepts exactly one trusted multipart upload.
- The upload is copied into a safe workspace-relative target.
- Upload temp files stay under daemon `server.dataDir/uploads/tmp`.
- Remote URL pull and S3/object-storage pull remain later-version work.

The current codebase should now be treated as the **first-version landing-test candidate**. Further capabilities should be planned as later versions, not folded into the first landing test.

See `docs/claude-code-runner-daemon-version-roadmap.md` for the current landing-test scope and later-version backlog.

## Reference Files

Use these lanceDesign files for behavior and edge-case study only:

- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/runs.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/chat-routes.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/runtimes/defs/claude.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/claude-stream.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/server.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/skills.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/cwd-aliases.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/db.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/project-routes.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/app-config.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/runtimes/env.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/runtimes/registry.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/claude-diagnostics.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/web/src/providers/daemon.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/web/src/components/ProjectView.tsx`
- `/home/orangels/ls_dev/lanceDesign/apps/web/src/state/projects.ts`
- `/home/orangels/ls_dev/lanceDesign/packages/contracts/src/api/chat.ts`
- `/home/orangels/ls_dev/lanceDesign/packages/contracts/src/sse/chat.ts`

Important reference scopes:

- `runs.ts`: in-memory run lifecycle, SSE replay, cancel, terminal cleanup.
- `chat-routes.ts`: `POST /api/runs -> 202 { runId }`, `GET /api/runs/:id/events`.
- `claude.ts`: prompt via stdin, `stream-json`, `--verbose`, model and permission mode args, feature probing.
- `claude-stream.ts`: JSONL parser and translated agent event model.
- `server.ts`: study only `startChatRun` around the spawn/stdout/stderr/watchdog/close/cancel chain; do not copy product logic.
- `skills.ts` and `cwd-aliases.ts`: skill scan/stage ideas; rename `.lancedesign-skills` to `.claude-runner-skills`.
- web provider/components/state files: message accumulator semantics only; rebuild on daemon side.
- contracts files: shape inspiration for Phase 0a contract freeze.

## Target Source Layout

Phase 0a creates contract-only source modules. Phase 0 and Phase 1 fill the foundation and minimal runner:

```text
src/
  config/
    auth.ts
    config.ts
    env.ts
    profiles.ts
  core/
    claude-adapter.ts
    claude-diagnostics.ts
    claude-stream.ts
    cli-runner.ts
    errors.ts
    event-visibility.ts
    ids.ts
    message-accumulator.ts
    path-safety.ts
    run-service.ts
    run-types.ts
    skill-registry.ts
    skill-staging.ts
    workspace-service.ts
  db/
    connection.ts
    repositories.ts
    schema.ts
  http/
    app.ts
    artifacts-routes.ts
    auth-middleware.ts
    health-routes.ts
    profiles-routes.ts
    runs-routes.ts
    sse.ts
    validation.ts
    workspaces-routes.ts
  index.ts
```

Tests should live under `src/**/__tests__/*.test.ts` so `tsconfig.json` can keep `rootDir: "src"` until the project intentionally moves tests elsewhere.

## Dependency Direction

- `src/index.ts` wires config, database, services, routes, and server startup.
- `src/http/*` may depend on `src/config/*`, `src/core/*`, and `src/db/*`.
- `src/core/*` may depend on `src/config/*` types and `src/db/*` repositories only through explicit interfaces passed in by constructors.
- `src/core/*` must not import Express.
- `src/db/*` must not import Express or runner process modules.
- `src/config/*` must not import HTTP or DB modules.
- `src/core/claude-adapter.ts` must know Claude CLI flags, not business fields.
- `src/core/workspace-service.ts` owns sandbox path resolution and must not return absolute paths to HTTP response DTOs.
- `src/core/message-accumulator.ts` is per-run state. No global `currentRun`, global text buffer, or shared event array.

## Phase 0a: API Contract 定稿

### Objective

Freeze the daemon's first-version contract before implementation, including request/response DTOs, structured error codes, workspace directory skeleton, SSE event semantics, and message flush rules.

### Files

- Create: `src/core/run-types.ts`
- Create: `src/core/errors.ts`
- Create: `src/http/validation.ts`
- Test: `src/core/__tests__/run-types.test.ts`
- Test: `src/http/__tests__/validation.test.ts`
- Modify: `package.json` to add a Vitest test script if implementation begins from this plan.

### Module Responsibilities

- `src/core/run-types.ts`: shared enums and DTO types for profiles, clients, workspaces, runs, run statuses, run kinds, event visibility, artifact rules, and public API response shapes.
- `src/core/errors.ts`: structured daemon error codes and a typed error object used by routes and services.
- `src/http/validation.ts`: zod schemas for API input validation and request normalization.

### Required Contract Decisions

- `POST /api/workspaces` accepts `profileId` and `workspace.originId/userId/projectId`.
- `POST /api/workspaces/:workspaceId/prepare` accepts `files[].sourcePath` and `files[].targetPath`.
- `POST /api/runs` accepts `profileId`, `workspaceId`, `kind`, `prompt`, optional `skillId`, optional `model`, optional `artifactRuleIds`, optional `eventVisibility`, and optional `metadata`.
- `kind=generate` requires `skillId`.
- `kind=revise` forbids `skillId`.
- Run statuses are exactly `queued`, `running`, `succeeded`, `failed`, `canceled`, `interrupted`.
- Error codes include at least:
  - `BAD_REQUEST`
  - `UNAUTHORIZED`
  - `FORBIDDEN`
  - `NOT_FOUND`
  - `MODEL_NOT_ALLOWED`
  - `PROFILE_NOT_ALLOWED`
  - `SKILL_NOT_ALLOWED`
  - `RUN_QUEUE_FULL`
  - `RUN_NOT_CANCELABLE`
  - `RUN_TIMEOUT`
  - `RUN_INACTIVITY_TIMEOUT`
  - `ARTIFACT_REQUIRED_MISSING`
  - `RUN_INTERRUPTED_BY_DAEMON_RESTART`
  - `CLAUDE_AUTH_FAILED`
  - `CLAUDE_CLI_FAILED`
  - `PATH_NOT_ALLOWED`
  - `INVALID_PATH_SEGMENT`
- Workspace directory skeleton is fixed:

```text
<workspace>/
  input/
  output/
  work/
  .claude-runner-skills/
```

- `run_messages` flush strategy is fixed:
  - create user message and assistant draft at run creation;
  - update assistant draft every roughly 500ms while events stream;
  - force flush before any terminal transition;
  - after daemon crash, preserve the last successful partial write.

### Tasks

- [ ] Define `RunKind`, `RunStatus`, `EventVisibility`, `DaemonErrorCode`, `WorkspaceIdentity`, `CreateWorkspaceRequest`, `PrepareWorkspaceRequest`, `CreateRunRequest`, and core response DTOs in `src/core/run-types.ts`.
- [ ] Define `DaemonError` and helpers such as `badRequest`, `notFound`, `forbidden`, and `toErrorResponse` in `src/core/errors.ts`.
- [ ] Define zod schemas in `src/http/validation.ts` for workspace create, workspace prepare, run create, list query, and event replay query.
- [ ] Add tests that reject `POST /api/runs` bodies containing `originId/userId/projectId` directly.
- [ ] Add tests that reject `kind=generate` without `skillId`.
- [ ] Add tests that reject `kind=revise` with `skillId`.
- [ ] Add tests that reject unknown statuses, unknown event visibility values, absolute `targetPath`, and `..` target paths.
- [ ] Add a Vitest script to `package.json`: `test: "vitest run"`.

### Validation Commands

Run after this phase:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Expected:

- TypeScript compiles.
- Contract validation tests pass.
- No runtime code starts Claude Code yet.

### Do Not Implement In Phase 0a

- No Express route behavior beyond validation helpers.
- No SQLite schema creation.
- No workspace directory writes.
- No Claude CLI spawn.
- No skill registry or artifact scan.
- No queue implementation.
- No upload API, remote URL pull, S3/object storage pull, metrics endpoint, or browser CORS work.

### Acceptance Criteria

- API request shapes are represented in TypeScript and zod.
- `POST /api/runs` contract only references `workspaceId`.
- Structured error code list is explicit and importable.
- The plan for `run_messages` flush and workspace skeleton is encoded in constants or documented type comments.
- Phase 0 implementers can write routes/services without re-deciding contract names.

## Phase 0: Profile / Auth / Workspace / SQLite 地基

### Objective

Create a trusted-deployment foundation: config loading, API key auth, client/profile authorization, safe workspace creation/prepare, SQLite schema/repositories, and startup interruption handling for old `queued`/`running` runs.

### Files

- Create: `src/config/config.ts`
- Create: `src/config/profiles.ts`
- Create: `src/config/auth.ts`
- Create: `src/config/env.ts`
- Create: `src/core/ids.ts`
- Create: `src/core/path-safety.ts`
- Create: `src/core/workspace-service.ts`
- Create: `src/db/connection.ts`
- Create: `src/db/schema.ts`
- Create: `src/db/repositories.ts`
- Create: `src/http/app.ts`
- Create: `src/http/auth-middleware.ts`
- Create: `src/http/health-routes.ts`
- Create: `src/http/profiles-routes.ts`
- Create: `src/http/workspaces-routes.ts`
- Modify: `src/index.ts`
- Test: `src/config/__tests__/profiles.test.ts`
- Test: `src/config/__tests__/auth.test.ts`
- Test: `src/core/__tests__/path-safety.test.ts`
- Test: `src/core/__tests__/workspace-service.test.ts`
- Test: `src/db/__tests__/schema.test.ts`
- Test: `src/db/__tests__/repositories.test.ts`
- Test: `src/http/__tests__/workspaces-routes.test.ts`

### Module Responsibilities

- `src/config/config.ts`: read daemon config path from CLI/env, parse JSON, validate server/clients/profiles, resolve `env:` API key references.
- `src/config/profiles.ts`: profile schema, profile lookup, model allowlist, artifact rule lookup, event visibility ceiling helpers.
- `src/config/auth.ts`: API key lookup, client identity, profile authorization, admin/client filtering helpers.
- `src/config/env.ts`: environment allowlist for profile `env`; keep `CLAUDE_CONFIG_DIR` and `claudeBin` as explicit profile fields, not free env.
- `src/core/ids.ts`: generate stable prefixed ids such as `ws_`, `run_`, `msg_`, `conv_`.
- `src/core/path-safety.ts`: validate path segments and workspace-relative paths; resolve paths and verify they remain under approved roots.
- `src/core/workspace-service.ts`: create/get workspace, create directory skeleton, prepare input files, and return only public metadata.
- `src/db/connection.ts`: open better-sqlite3 database under `server.dataDir`, enable pragmas, expose close.
- `src/db/schema.ts`: apply first-version schema and indexes.
- `src/db/repositories.ts`: repositories for `workspaces`, `conversations`, `runs`, `run_messages`, plus placeholder tables for `artifacts`, `run_logs`, and `profile_snapshots`.
- `src/http/app.ts`: create Express app and mount routes/middleware.
- `src/http/auth-middleware.ts`: authenticate API key and attach client context.
- `src/http/health-routes.ts`: `GET /api/health`.
- `src/http/profiles-routes.ts`: `GET /api/profiles`, returning only profiles allowed to the current client and hiding internal absolute paths/secrets.
- `src/http/workspaces-routes.ts`: `POST /api/workspaces` and `POST /api/workspaces/:workspaceId/prepare`.

### SQLite Schema Scope

Implement these tables in Phase 0:

- `workspaces`
- `conversations`
- `runs`
- `run_messages`
- `artifacts`
- `run_logs`
- `profile_snapshots`

Only `workspaces`, `conversations`, `runs`, and `run_messages` need full repository behavior in Phase 0. The other tables can have schema-only or minimal insert/list helpers so Phase 1/2 have stable targets.

Do not create `run_events`.

### Tasks

- [ ] Add config validation for `server.host`, `server.port`, `server.dataDir`, `server.globalConcurrency`, `server.maxQueueSize`, `clients[]`, and `profiles[]`.
- [ ] Validate each profile includes `id`, `sandboxRoot`, `claudeConfigDir`, `claudeBin`, `skillRoots`, `allowedInputRoots`, `allowedSkillIds`, `artifactRules`, `defaultArtifactRuleIds`, `permissionMode`, `defaultModel`, `allowedModels`, `eventVisibility`, timeout settings, and optional allowlisted `env`.
- [ ] Reject profile `env` keys outside the first-version allowlist:
  - `ANTHROPIC_BASE_URL`
  - `ANTHROPIC_API_KEY`
  - `DISABLE_TELEMETRY`
  - `DO_NOT_TRACK`
  - `DISABLE_AUTOUPDATER`
  - `DISABLE_ERROR_REPORTING`
  - `DISABLE_BUG_COMMAND`
  - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
- [ ] Implement API key authentication for `Authorization: Bearer <key>` and `X-API-Key`.
- [ ] Implement client-to-profile authorization; ordinary clients only see and use allowed profiles.
- [ ] Implement safe path segment validation for `originId`, `userId`, and `projectId`: non-empty, single segment, no `/`, `\`, `.`, `..`, or null byte.
- [ ] Implement workspace-relative path validation for prepare `targetPath`: no absolute path, no `..`, no null byte, no `.claude-runner-skills` target.
- [ ] Implement `POST /api/workspaces` as create-or-get by `clientId/profileId/originId/userId/projectId` and create the directory skeleton.
- [ ] Implement `POST /api/workspaces/:workspaceId/prepare` by verifying `sourcePath` is under the profile's `allowedInputRoots`, then copying to safe workspace-relative `targetPath`.
- [ ] Implement `GET /api/profiles` without returning `sandboxRoot`, `claudeConfigDir`, full `skillRoots`, full `allowedInputRoots`, API keys, or secret env values.
- [ ] Implement schema migration/initialization with indexes from the design document.
- [ ] Implement repositories:
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
- [ ] On daemon startup, mark old `queued` and `running` rows as `interrupted` with `RUN_INTERRUPTED_BY_DAEMON_RESTART`.
- [ ] Keep all API responses free of sandbox absolute paths.

### Minimum Runnable Goal

At the end of Phase 0, the daemon can start, authenticate a configured client, list allowed profiles, create/get a workspace, copy allowed input files into `input/` or another safe relative path, initialize SQLite, insert a `queued` run row through repository code, and mark old non-terminal runs as `interrupted` on startup. It still does not spawn Claude Code.

### Validation Commands

Run after this phase:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm dev
```

Manual smoke checks against a local config:

```bash
curl -s http://127.0.0.1:17890/api/health
curl -s -H 'Authorization: Bearer <api-key>' http://127.0.0.1:17890/api/profiles
curl -s -X POST -H 'Authorization: Bearer <api-key>' -H 'Content-Type: application/json' \
  http://127.0.0.1:17890/api/workspaces \
  -d '{"profileId":"report-docx","workspace":{"originId":"lqbot","userId":"user_1","projectId":"project_123"}}'
```

Expected:

- Health route returns ok.
- Profiles route returns only allowed public profile data.
- Workspace route returns `workspaceId` and `workspaceKey`, not absolute paths.
- SQLite contains `workspaces` and can insert `runs.status = queued`.

### Do Not Implement In Phase 0

- No Claude CLI spawn.
- No SSE.
- No cancel behavior.
- No skill scan/staging.
- No artifact watcher or artifact scan.
- No artifact download API behavior beyond route placeholders if desired.
- No upload API.
- No remote URL pull.
- No queue or concurrency scheduler.
- No metrics exposure.
- No OS-level isolation or permission hooks.

### Acceptance Criteria

- Config/auth/profile boundaries prevent request-time override of privileged profile settings.
- Workspace prepare only copies from `allowedInputRoots` to safe workspace-relative paths.
- Workspace skeleton exists for new workspaces.
- `workspaces`, `conversations`, `runs`, and `run_messages` schema and core repositories work.
- `runs` can be inserted as `queued` before any execution begins.
- Startup interruption handling is implemented and tested.

## Phase 1: 最小 Claude Code Run + Daemon-Side Message Persistence

### Objective

Implement the smallest useful Claude Code run lifecycle: create run, start Claude process, parse stream-json, emit SSE with short replay, support cancel, update SQLite run status, and persist user/assistant messages from daemon-side accumulator even when no SSE client is connected.

### Files

- Create: `src/core/claude-adapter.ts`
- Create: `src/core/claude-stream.ts`
- Create: `src/core/claude-diagnostics.ts`
- Create: `src/core/cli-runner.ts`
- Create: `src/core/event-visibility.ts`
- Create: `src/core/message-accumulator.ts`
- Create: `src/core/run-service.ts`
- Create: `src/http/runs-routes.ts`
- Create: `src/http/sse.ts`
- Modify: `src/http/app.ts`
- Modify: `src/db/repositories.ts`
- Test: `src/core/__tests__/claude-adapter.test.ts`
- Test: `src/core/__tests__/claude-stream.test.ts`
- Test: `src/core/__tests__/event-visibility.test.ts`
- Test: `src/core/__tests__/message-accumulator.test.ts`
- Test: `src/core/__tests__/run-service.test.ts`
- Test: `src/http/__tests__/runs-routes.test.ts`

### Module Responsibilities

- `src/core/claude-adapter.ts`: build Claude CLI args and spawn environment from profile/run settings. Keep prompt on stdin. Use profile `permissionMode`, profile `defaultModel`, and allowed request model.
- `src/core/claude-stream.ts`: translate Claude Code stream-json JSONL into internal agent events. Base behavior on lanceDesign parser but remove product-specific assumptions.
- `src/core/claude-diagnostics.ts`: classify auth/model/CLI failures into generic daemon error codes and machine-readable details.
- `src/core/cli-runner.ts`: spawn child process, write stdin prompt, attach stdout parser, stderr tail, inactivity watchdog, run timeout, and close/error handling.
- `src/core/event-visibility.ts`: filter internal events for quiet/normal/debug response contexts. Internal persistence keeps full translated events.
- `src/core/message-accumulator.ts`: per-run accumulator that merges `text_delta` into assistant content, records structured events, throttles DB updates, and force-flushes on terminal.
- `src/core/run-service.ts`: run lifecycle, in-memory event buffer, SSE subscriber management, `Last-Event-ID` / `after` replay, cancel, DB state transitions, accumulator ownership.
- `src/http/runs-routes.ts`: `POST /api/runs`, `GET /api/runs`, `GET /api/runs/:runId`, `GET /api/runs/:runId/events`, `POST /api/runs/:runId/cancel`.
- `src/http/sse.ts`: common SSE response helpers, heartbeat, event formatting, disconnect cleanup.

### Required Behavior

- `POST /api/runs` validates client/profile/workspace access.
- `POST /api/runs` inserts `runs.status = queued` immediately.
- Phase 1 may start the run immediately after creation, without a full Phase 3 queue, when no other same-workspace run is active.
- Same workspace should not run two Claude child processes in Phase 1; if Phase 3 queue is not implemented yet, reject or hold later same-workspace starts with a clear structured error rather than allowing concurrent writes.
- `GET /api/runs/:runId/events` streams from memory and supports short replay by `Last-Event-ID` or `after`.
- Terminal run details are durable via `GET /api/runs/:runId`, reading `runs` and `run_messages`.
- Cancel sends SIGTERM then SIGKILL after profile `cancelGraceMs`.
- Run timeout and inactivity timeout can be wired here if simple; deeper scheduler hardening remains Phase 3.
- `events_json` persists translated/merged events, not raw SSE chunks.
- `raw` and large debug output should go to logs later; do not bloat first-pass `events_json` with unbounded chunks.

### Tasks

- [ ] Copy/rewrite the Claude stream parser into `src/core/claude-stream.ts`, keeping support for `status`, `text_delta`, `thinking_delta`, `thinking_start`, `tool_use`, `tool_result`, `usage`, `raw`, and parser error events.
- [ ] Add parser tests for JSONL text deltas, assistant wrapper fallback, partial tool input merge, duplicate tool use suppression, tool result extraction, and usage extraction.
- [ ] Implement `buildClaudeArgs` using `claude -p --output-format stream-json --verbose`, optional `--include-partial-messages`, optional `--add-dir`, optional `--model`, and profile `--permission-mode`.
- [ ] Validate request `model` against profile `allowedModels`; otherwise return `MODEL_NOT_ALLOWED`.
- [ ] Inject `CLAUDE_CONFIG_DIR` from profile `claudeConfigDir` and allowlisted profile env values.
- [ ] Implement a fake-spawn test seam for `cli-runner` so tests can simulate stdout JSONL, stderr, exit code, signal, spawn error, timeout, and cancel without requiring Claude Code.
- [ ] Implement `message-accumulator` so run creation inserts a user message and assistant draft, run start marks assistant `running`, parser events update assistant content/events, and terminal transition force-flushes.
- [ ] Add accumulator tests proving two concurrent accumulators cannot share content/events/timers.
- [ ] Implement `run-service` memory state with per-run event buffer, event ids, subscribers, terminal cleanup timer, and DB transitions.
- [ ] Implement `POST /api/runs` route returning `202 { "runId": "...", "status": "queued" | "running" }`.
- [ ] Implement `GET /api/runs` with client-scoped filters: `originId`, `userId`, `projectId`, `workspaceKey`, `workspacePrefix`, and `status`.
- [ ] Implement `GET /api/runs/:runId` returning run metadata and `run_messages`, filtered for the client's allowed visibility.
- [ ] Implement `GET /api/runs/:runId/events` using SSE response helpers, memory replay, and visibility filtering.
- [ ] Implement `POST /api/runs/:runId/cancel` for running runs and queued Phase 1 runs.
- [ ] Ensure terminal transitions update `runs.finished_at`, `runs.exit_code`, `runs.signal`, `runs.error_code`, `runs.error_message`, `runs.usage_json`, and `runs.last_run_event_id`.
- [ ] Ensure terminal transitions update assistant `run_status`, `ended_at`, and `last_run_event_id`.

### Minimum Runnable Goal

At the end of Phase 1, a trusted backend can:

1. Create/prepare a workspace.
2. Create a run for that workspace.
3. Subscribe to `/api/runs/:runId/events`.
4. See Claude Code stream-json events translated to SSE.
5. Cancel an active run.
6. Query `/api/runs/:runId` after completion and see durable `run_messages.content` and `run_messages.events_json` even if no SSE client was connected during execution.

This is the first end-to-end daemon slice.

### Validation Commands

Run after this phase:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Manual smoke checks with a harmless local workspace and a configured Claude profile:

```bash
pnpm dev
curl -s -X POST -H 'Authorization: Bearer <api-key>' -H 'Content-Type: application/json' \
  http://127.0.0.1:17890/api/runs \
  -d '{"profileId":"report-docx","workspaceId":"ws_123","kind":"revise","prompt":"List files and write a short note to output/summary.txt"}'
curl -N -H 'Authorization: Bearer <api-key>' \
  http://127.0.0.1:17890/api/runs/<runId>/events
curl -s -H 'Authorization: Bearer <api-key>' \
  http://127.0.0.1:17890/api/runs/<runId>
```

Expected:

- Run create inserts a durable `queued` row before execution.
- SSE shows start/status/text/error/end events.
- SQLite run status reaches `succeeded`, `failed`, or `canceled`.
- `run_messages` has one user message and one assistant message.
- `assistant.events_json` is present without relying on an SSE consumer.

### Do Not Implement In Phase 1

- No artifact watcher.
- No final artifact glob scan unless needed for a tiny placeholder; full artifact behavior is Phase 2.
- No artifact upload API.
- No remote URL pull.
- No S3/object storage pull.
- No full queue with global/profile concurrency.
- No metrics exposure.
- No browser-facing CORS or temporary signed downloads.
- No product-specific lqBot/lanceDesign prompt logic.
- No Claude Code native session resume/fork.

### Acceptance Criteria

- Minimal run lifecycle works end to end.
- `POST /api/runs` still only references `workspaceId`.
- A run can be observed live through SSE and inspected later through SQLite-backed run detail.
- Durable message persistence is daemon-side, not frontend-triggered.
- Cancel and process close handling produce correct terminal statuses.
- No API response leaks sandbox absolute paths.

## Phase 2: Skill And Artifact

### Objective

Add profile-governed skill selection/staging for `generate` runs and profile-governed artifact discovery/download after runs finish.

### Files

- Create/complete: `src/core/skill-registry.ts`
- Create/complete: `src/core/skill-staging.ts`
- Create: `src/core/artifact-scanner.ts`
- Create/complete: `src/http/artifacts-routes.ts`
- Modify: `src/core/run-service.ts`
- Modify: `src/core/cli-runner.ts`
- Modify: `src/db/repositories.ts`
- Test: `src/core/__tests__/skill-registry.test.ts`
- Test: `src/core/__tests__/skill-staging.test.ts`
- Test: `src/core/__tests__/artifact-scanner.test.ts`
- Test: `src/http/__tests__/artifacts-routes.test.ts`

### Scope

- Scan only profile `skillRoots`.
- Use only profile `allowedSkillIds`.
- `kind=generate` requires `skillId`, injects `SKILL.md` body, and stages active skill files to `.claude-runner-skills/<skill-folder>/`.
- `kind=revise` forbids skill staging and does not inject skill body.
- Artifact rules come only from profile `artifactRules`.
- Request `artifactRuleIds` may only choose allowed rule ids.
- Run-end artifact glob scan is authoritative.
- Required artifact missing marks run `failed` with `ARTIFACT_REQUIRED_MISSING`, even if Claude exits `0`.
- Artifact API returns relative paths and proxies download without exposing sandbox absolute paths.

### Validation Commands

```bash
pnpm typecheck
pnpm test
pnpm build
```

### Do Not Implement In Phase 2

- No live artifact watcher.
- No `artifact_candidate` realtime preview.
- No upload API.
- No remote URL pull.
- No arbitrary request-supplied glob patterns.
- No business-specific report/design artifact semantics.

### Acceptance Criteria

- Generate and revise skill rules are enforced.
- Active skill files are copied, not symlinked.
- Artifact scan records matching files in SQLite.
- Required artifact missing fails the run after message flush.
- Artifact download is authorized, path-checked, and path-redacted.

## Phase 3: Queue / Timeout / Hardening

### Objective

Complete operational hardening: queue, global/profile concurrency, per-workspace serial execution, timeout behavior, log retention, diagnostics polish, and structured error consistency.

### Files

- Create: `src/core/run-queue.ts`
- Create: `src/core/run-logs.ts`
- Modify: `src/core/run-service.ts`
- Modify: `src/core/cli-runner.ts`
- Modify: `src/core/claude-diagnostics.ts`
- Modify: `src/db/repositories.ts`
- Modify: `src/http/runs-routes.ts`
- Test: `src/core/__tests__/run-queue.test.ts`
- Test: `src/core/__tests__/run-logs.test.ts`
- Test: `src/core/__tests__/claude-diagnostics.test.ts`

### Scope

- Enforce `server.globalConcurrency`.
- Enforce profile `profileConcurrency`.
- Enforce per-workspace serial execution.
- Enforce `server.maxQueueSize`.
- Return `429 RUN_QUEUE_FULL` only when queue is full.
- Start next eligible queued run when a run terminates.
- Apply `runTimeoutMs`, `inactivityTimeoutMs`, and `cancelGraceMs` consistently.
- Persist stderr/stdout/debug log indexes without returning sandbox paths.
- Improve generic Claude diagnostics for auth failure, model issues, spawn failure, and non-zero exits.

### Validation Commands

```bash
pnpm typecheck
pnpm test
pnpm build
```

### Do Not Implement In Phase 3

- No OS-level isolation.
- No separate uid/container/seccomp/firejail.
- No Claude Code permission hooks.
- No public metrics endpoint unless explicitly approved after the queue foundation works.
- No browser direct-download token flow.
- No workspace deletion or retention automation unless requested separately.

### Acceptance Criteria

- Queue behavior is deterministic and tested.
- Per-workspace serial execution prevents two Claude children writing the same workspace.
- Queued/running rows interrupted by daemon restart are marked `interrupted`.
- Timeouts and cancel use structured error codes.
- Logs support diagnosis without exposing absolute sandbox paths.

## Historical First Implementation Slice

The first round of implementation should stop after Phase 1 unless a reviewer explicitly approves continuing. The minimal working product is:

- authenticated daemon startup;
- public health/profile routes;
- workspace create/prepare;
- SQLite schema and repositories;
- run create with durable `queued` insert;
- immediate minimal run execution;
- live SSE;
- cancel;
- durable run detail via `run_messages.events_json`.

This slice proves the hardest architecture decision: persistence is daemon-side and independent of SSE consumption.

## Later-Version Exclusions After Phase 4

Phase 4 has intentionally added the narrow daemon upload API. The following capabilities are still later-version work and should not be implemented as part of the current first-version landing test:

- artifact watcher;
- remote URL pull;
- S3/object storage pull;
- metrics exposure;
- browser CORS and temporary signed download URLs;
- workspace deletion/retention policy;
- `run_events` table;
- OS sandboxing, separate uid, containers, seccomp/firejail, permission hooks;
- lanceDesign design/craft/critique/analytics/preview/deployment/tabs/routines/media/live artifact MCP logic;
- lqBot-specific business logic;
- request-level overrides for profile-controlled Claude settings.

## Self-Review Checklist

- [ ] Every Phase 0a/0/1 task has concrete files and validation commands.
- [ ] `POST /api/runs` never accepts inline `originId/userId/projectId`.
- [ ] `runs` queued insert is in Phase 0/1, not later.
- [ ] `run_messages` daemon-side accumulator is in Phase 1.
- [ ] SSE replay is memory-only and described as short-term.
- [ ] No `run_events` table is planned for first version.
- [ ] Phase 2/3 are scoped but not expanded into premature implementation details.
- [ ] All lanceDesign references use absolute paths.
- [ ] No plan step imports lanceDesign private source.
- [ ] No first-version step claims strong sandboxing.
