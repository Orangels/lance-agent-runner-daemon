# Phase 1 Minimal Run Implementation Plan

> Historical plan note: this phase plan records the original SQLite-based implementation path. The current daemon runtime is PostgreSQL-only; SQLite remains only as a read-only migration source and historical backup format.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the smallest useful Claude Code run lifecycle: create a durable run, spawn Claude Code for prompt-only `revise` runs, stream translated events over SSE, support cancel, and persist daemon-side `run_messages` without relying on an SSE consumer.

**Architecture:** Phase 1 adds runner behavior on top of the Phase 0 foundation without adding Phase 2 skill/artifact behavior or Phase 3 queue hardening. `src/http/*` remains Express-only, `src/core/*` owns process/runtime/domain logic, `src/db/*` owns SQLite writes, and `src/config/*` owns profiles/auth. Product-clean lanceDesign runner pieces must be ported behavior-equivalently into this repo; do not import lanceDesign private source.

**Tech Stack:** TypeScript ESM, Express 5, zod, better-sqlite3, Node `child_process.spawn`, Node streams, SSE, Vitest with fake spawn seams.

---

## Review Scope

This document is the Phase 1 plan and implementation guide. Review this plan before any Phase 1 code is written.

Phase 1 starts after Phase 0 is merged into `main` at:

```text
d545620 fix: preserve client error status in http handler
```

Create the implementation branch from `main` after this plan is reviewed:

```bash
git checkout main
git pull
git checkout -b codex/phase-1-minimal-run
```

This plan branch is:

```text
codex/phase-1-minimal-run-plan
```

## Source References

Local docs:

- `/home/orangels/ls_dev/lance-agent-runner-daemon/AGENTS.md`
- `/home/orangels/ls_dev/lance-agent-runner-daemon/REFERENCE.md`
- `/home/orangels/ls_dev/lance-agent-runner-daemon/docs/claude-code-runner-daemon-design.md`
- `/home/orangels/ls_dev/lance-agent-runner-daemon/docs/claude-code-runner-daemon-migration-assessment.md`
- `/home/orangels/ls_dev/lance-agent-runner-daemon/docs/claude-code-runner-daemon-implementation-plan.md`
- `/home/orangels/ls_dev/lance-agent-runner-daemon/docs/phase-0-foundation-plan.md`

lanceDesign migration sources:

These files are not package dependencies. Do not import them from the new daemon. They are the source implementation for the Claude Code CLI runner pipeline; port the directly reusable pieces into this repository's own `src/` tree and preserve behavior unless a product-boundary change is explicitly listed here.

- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/runs.ts`
  - Directly reusable/lightly reusable: port the in-memory run lifecycle mechanics, event buffer, monotonically increasing event ids, `Last-Event-ID` / `after` replay, subscriber set, terminal close, TTL cleanup with `unref`, cancel, and `isTerminal` semantics.
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/chat-routes.ts`
  - Reusable route pattern: `POST /api/runs -> 202 { runId }`, `GET /api/runs/:id/events`, `POST /api/runs/:id/cancel`; rewrite request/response bodies for the generic daemon contract.
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/claude-stream.ts`
  - Directly reusable: port the Claude Code `stream-json` JSONL parser near-verbatim, preserving streaming/fallback behavior and duplicate suppression.
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/runtimes/defs/claude.ts`
  - Lightly reusable: port Claude argv construction, prompt-via-stdin, capability probing, `--include-partial-messages`, `--add-dir`, `--model`, and `--permission-mode`; adapt profile-controlled model and permission settings.
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/server.ts`
  - Narrowed subset: extract only `startChatRun`'s generic spawn/stdin/stdout/stderr/watchdog/close/cancel chain and `createSseResponse`; do not copy product logic.
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/claude-diagnostics.ts`
  - Narrowed subset: reuse auth/model/config failure classification ideas; rewrite all product wording, path handling, and machine-readable error mapping.
- `/home/orangels/ls_dev/lanceDesign/apps/web/src/providers/daemon.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/web/src/components/ProjectView.tsx`
- `/home/orangels/ls_dev/lanceDesign/apps/web/src/state/projects.ts`
  - Semantic reference only: frontend message accumulation semantics that Phase 1 moves daemon-side.

Do not import from `/home/orangels/ls_dev/lanceDesign`. Copying lanceDesign product logic wholesale is out of scope. Porting product-clean Claude Code runner logic into this repository is required where the design marks it directly reusable.

## Phase 1 Scope Decisions

Phase 1 implements only the runnable prompt-only path:

```text
kind=revise
```

`kind=generate` stays in the API schema, but it is not runnable until Phase 2 skill registry and skill staging are implemented. In Phase 1, a valid `generate` request with `skillId` must return a structured `400 BAD_REQUEST` explaining that generate runs require Phase 2 skill support. Do not silently run a generate request without staging the selected skill.

Phase 1 must implement:

- `POST /api/runs`
- `GET /api/runs`
- `GET /api/runs/:runId`
- `GET /api/runs/:runId/events`
- `POST /api/runs/:runId/cancel`
- Claude Code CLI spawn for `revise` runs.
- Claude stream-json parser.
- In-memory SSE buffer with short replay.
- Daemon-side `run_messages` accumulator and durable flush.
- `profile_snapshots` insert paired with run create.
- Minimal per-workspace active-run guard so two Claude processes do not write the same workspace at once.
- Minimal inactivity watchdog based on lanceDesign's proven child-output activity guard, so a stuck Claude process cannot occupy a workspace forever.

Phase 1 must not implement:

- Skill root scan.
- Skill staging into `.claude-runner-skills/`.
- Skill body preamble injection.
- Artifact watcher.
- Artifact glob scan.
- Artifact list/download route behavior.
- Artifact upload API.
- Required artifact failure handling.
- Remote URL pull.
- S3/object storage pull.
- Browser-facing CORS or temporary signed download URLs.
- Full global/profile queue scheduler.
- Full timeout scheduler or timeout hardening beyond the minimal Phase 1 inactivity watchdog.
- Metrics endpoint.
- Logs route behavior.
- Claude Code native session resume/fork.
- OS-level isolation, separate uid execution, containers, seccomp/firejail, or Claude Code permission hooks.
- lanceDesign product logic: design systems, craft, memory, critique theater, analytics, preview comments, deployments, project tabs, routines/orbit, media tasks, live artifact MCP, local-client runtime, or `LANCE_DESIGN_*` env.

## Minimum Runnable Goal

The first runnable Phase 1 target is:

1. Create or reuse a workspace through existing Phase 0 APIs.
2. Create a `kind=revise` run with `POST /api/runs`.
3. The daemon inserts a durable `runs.status = queued` row before any process starts.
4. The same transaction inserts user/assistant `run_messages` and a sanitized `profile_snapshots` row.
5. The run starts asynchronously and transitions `queued -> running -> succeeded | failed | canceled`.
6. Claude Code stdout JSONL is translated to internal events and emitted as SSE.
7. `run_messages.content` and `run_messages.events_json` are persisted even if nobody subscribes to SSE.
8. `GET /api/runs/:runId` returns durable run detail after terminal completion.
9. `POST /api/runs/:runId/cancel` can cancel a running process with SIGTERM then SIGKILL after `profile.cancelGraceMs`.
10. A stuck child that emits no stdout/stderr/parser activity is failed by the minimal inactivity watchdog instead of running forever.

Unit and route tests must use fake spawn seams. Manual smoke can use a real configured Claude Code profile after automated tests pass.

## Dependency Direction

Keep dependencies one-way:

```text
src/index.ts
  -> config, db, core services, http app

src/http/*
  -> config/auth helpers, core/run-service, core/workspace-service, db repositories, validation

src/core/run-service.ts
  -> db repositories, core/message-accumulator, core/cli-runner, core/event-visibility, core/ids, core/errors
  -> injects profile inactivityTimeoutMs and cancelGraceMs into cli-runner

src/core/cli-runner.ts
  -> core/claude-adapter, core/claude-stream, core/claude-diagnostics

src/core/message-accumulator.ts
  -> db repositories, core/run-events

src/core/claude-adapter.ts
  -> config/profile types, core/run-types

src/db/*
  -> core/run-types only for enum/type literals

src/config/*
  -> core/run-types only for shared enums
```

`src/core/*` must not import Express. `src/db/*` must not import HTTP modules.

## Target File Map

Create:

- `src/core/run-events.ts`
- `src/core/claude-adapter.ts`
- `src/core/claude-capabilities.ts`
- `src/core/claude-stream.ts`
- `src/core/claude-diagnostics.ts`
- `src/core/event-visibility.ts`
- `src/core/message-accumulator.ts`
- `src/core/profile-snapshot.ts`
- `src/core/cli-runner.ts`
- `src/core/run-service.ts`
- `src/http/sse.ts`
- `src/http/runs-routes.ts`
- `src/core/__tests__/run-events.test.ts`
- `src/core/__tests__/claude-adapter.test.ts`
- `src/core/__tests__/claude-capabilities.test.ts`
- `src/core/__tests__/claude-stream.test.ts`
- `src/core/__tests__/claude-diagnostics.test.ts`
- `src/core/__tests__/event-visibility.test.ts`
- `src/core/__tests__/message-accumulator.test.ts`
- `src/core/__tests__/profile-snapshot.test.ts`
- `src/core/__tests__/cli-runner.test.ts`
- `src/core/__tests__/run-service.test.ts`
- `src/http/__tests__/sse.test.ts`
- `src/http/__tests__/runs-routes.test.ts`

Modify:

- `src/core/run-types.ts`
- `src/core/errors.ts`
- `src/http/validation.ts`
- `src/http/app.ts`
- `src/index.ts`
- `src/db/repositories.ts`
- `src/db/__tests__/repositories.test.ts`
- `src/http/__tests__/validation.test.ts`
- `src/__tests__/index.test.ts`

Do not create:

- `src/core/skill-registry.ts`
- `src/core/skill-staging.ts`
- `src/core/artifact-scanner.ts`
- `src/http/artifacts-routes.ts`
- `src/http/logs-routes.ts`
- `src/core/run-queue.ts`
- `src/http/metrics-routes.ts`

Those are Phase 2/3 files.

## Data And Event Contracts

### Run Create Transaction

Phase 1 must introduce a single repository/service operation that creates a run atomically:

```text
begin better-sqlite3 synchronous transaction
select active queued/running run for workspace
fail with WORKSPACE_RUN_ACTIVE if one exists
get or create default conversation
insert runs queued row
insert user run_message
insert assistant draft run_message
insert sanitized profile_snapshot
commit transaction
only then schedule process start
```

The transaction must be the only path used by `POST /api/runs`.

The active-run check and queued insert must happen in the same synchronous `better-sqlite3` transaction, with no `await` or asynchronous boundary between them. SQLite is the serial truth source; any in-memory active-run set is only a fast path and must not be the only protection against concurrent same-workspace runs.

The route must never accept inline `originId`, `userId`, or `projectId`; it only receives `workspaceId`.

### Event Ids

Use numeric in-memory event ids internally and stringify them in SSE:

```text
1
2
3
...
```

`Last-Event-ID` header and `?after=` query both mean "replay events with id greater than this value".

Replay comparisons must parse ids numerically, never lexicographically, so `"10"` is greater than `"9"`.

SQLite does not get a `run_events` table. Long-term view is `run_messages.events_json`.

When a terminal run's in-memory event buffer has expired, or after daemon restart, `GET /api/runs/:runId/events` returns `404 NOT_FOUND` for the event stream even if `GET /api/runs/:runId` can still return durable run detail. This preserves the Phase 1 contract that `/events` is live/short-reconnect only.

### Internal Agent Events

Define translated event types in `src/core/run-events.ts`:

```text
status
text_delta
thinking_start
thinking_delta
tool_use
tool_result
usage
error
stderr
raw
end
```

`stderr` and `raw` are debug-only, capped to 2,000 characters per stored tail, and not persisted in `events_json` by default. Store stderr/stdout tails in memory for diagnostics in Phase 1; full log persistence and `GET /api/runs/:runId/logs` are out of scope.

### Message Persistence

`message-accumulator` owns the assistant draft:

- Append `text_delta.delta` to assistant `content`.
- Append structured visible events to assistant `events_json`.
- Keep `usage` so terminal run status can write `runs.usage_json`.
- Throttle DB updates to `runMessageFlushPolicy.throttleMs` from `src/core/run-types.ts`.
- Force flush before terminal run transition.
- Never require an SSE subscriber to persist messages.
- Each run gets its own accumulator, timer, content, events, and assistant message id.

### Event Visibility

Internal persistence keeps translated visible events. SSE/detail responses filter by the lower of:

```text
profile.eventVisibility
request.eventVisibility if supplied
client.canReadDebugEvents
```

Phase 1 visibility rules:

- `quiet`: `status`, `text_delta`, `usage`, `error`, `end`.
- `normal`: quiet plus `thinking_start`, `thinking_delta`, and `tool_use`. `tool_result` is persisted internally and written to debug logs, but filtered from public SSE/run detail responses.
- `debug`: normal plus capped `stderr` and `raw`, only when the client has `canReadDebugEvents`.

Do not expose sandbox absolute paths in any visibility mode.

## Task 1: Tighten Phase 1 Validation And Types

**Files:**

- Modify: `src/core/run-types.ts`
- Modify: `src/core/errors.ts`
- Modify: `src/http/validation.ts`
- Test: `src/http/__tests__/validation.test.ts`
- Test: `src/core/__tests__/run-types.test.ts`

**Responsibilities:**

- Keep `POST /api/runs` contract as `workspaceId`-only.
- Add length limits that Phase 0a recorded as follow-up.
- Add typed run event contracts.
- Add a dedicated `WORKSPACE_RUN_ACTIVE` structured error code for Phase 1 same-workspace conflicts.
- Keep query schemas strict unless a test proves Express query behavior requires a narrower compromise.

**Concrete Limits:**

- `profileId`: 1 to 128 chars.
- `workspaceId`: 1 to 128 chars.
- `skillId`: 1 to 128 chars.
- `model`: 1 to 128 chars.
- `artifactRuleIds[]`: max 32 ids, each 1 to 128 chars.
- `prompt`: 1 to 200_000 chars.
- `metadata`: object only; keep existing zod object validation.

**TDD Steps:**

- [ ] Add a failing test that `createRunRequestSchema` rejects `originId`, `userId`, and `projectId` in the run body because the schema is strict.
- [ ] Add a failing test that `prompt` longer than 200_000 chars is rejected with `BAD_REQUEST`.
- [ ] Add a failing test that oversized `skillId`, `model`, and `artifactRuleIds` are rejected.
- [ ] Add a passing test that `kind=revise` accepts `profileId`, `workspaceId`, `kind`, `prompt`, optional `model`, optional `eventVisibility`, and optional `metadata`.
- [ ] Add a passing test that `kind=generate` remains schema-valid only when `skillId` is present, even though the Phase 1 service rejects it before execution.
- [ ] Add a failing test that `daemonErrorCodes` includes `WORKSPACE_RUN_ACTIVE`.
- [ ] Add run event type tests for terminal status detection and event id string conversion helpers.
- [ ] Implement the smallest schema/type changes to pass.
- [ ] Run `pnpm test src/http/__tests__/validation.test.ts src/core/__tests__/run-types.test.ts`.
- [ ] Commit: `chore: tighten phase 1 run contract`.

**Acceptance Criteria:**

- Run create remains workspace-id-only.
- Phase 0a validation follow-ups are closed before runtime code depends on the schema.
- No Phase 2 skill behavior is introduced.

## Task 2: Repository Transaction And Profile Snapshots

**Files:**

- Modify: `src/db/repositories.ts`
- Modify: `src/db/__tests__/repositories.test.ts`
- Create: `src/core/profile-snapshot.ts`
- Test: `src/core/__tests__/profile-snapshot.test.ts`

**Responsibilities:**

- Create a transaction helper for Phase 1 run creation.
- Resolve or create the default conversation inside the same transaction.
- Insert sanitized profile snapshots in the same transaction as queued run creation.
- Add run lookup helpers needed by run service.
- Fix repository update semantics where `undefined` means preserve and `null` means write null.

**New Repository Methods:**

- `createRunQueuedWithMessagesAndSnapshot`
- `insertProfileSnapshot`
- `getRunForClient`
- `getRunWithWorkspaceForClient`
- `getActiveRunForWorkspace`
- `updateRunStarted`
- `updateRunTerminal`
- `updateRunLastEventId`
- `updateAssistantMessageStarted`
- `updateAssistantMessageTerminal`

`createRunQueuedWithMessagesAndSnapshot` must internally call or replace:

- `getOrCreateDefaultConversation`
- `insertRunQueued`
- `insertRunMessagesForRunCreate`
- `insertProfileSnapshot`

Do not leave route/service code manually composing three independent writes.

Use `better-sqlite3`'s synchronous `db.transaction()` wrapper. A thrown error from conversation, run, message, or snapshot insert must roll back the full transaction.

**Profile Snapshot Rules:**

- Store profile id, `permissionMode`, `defaultModel`, `allowedModels`, `eventVisibility`, timeout values, selected model, selected artifact rule ids, and env key names.
- Store profile env keys only; do not store env values. This avoids ambiguity around `ANTHROPIC_API_KEY`, private `ANTHROPIC_BASE_URL` endpoints, bearer-like values, cookies, and future token-shaped keys.
- Do not read files from `claudeConfigDir`.
- Do not store `ANTHROPIC_API_KEY`, API keys, token-like values, cookies, OAuth bearer values, or Claude login state.
- Do not expose profile snapshots in public HTTP responses in Phase 1.

**TDD Steps:**

- [ ] Add a failing repository test that `createRunQueuedWithMessagesAndSnapshot` inserts a `queued` run, two run messages, and one profile snapshot in one transaction.
- [ ] Add a failing repository test that the same transaction gets or creates the default conversation before inserting messages.
- [ ] Add a failing test that a forced snapshot insert failure rolls back the run and messages.
- [ ] Add a failing test that the stored snapshot contains env key names only and does not contain `ANTHROPIC_API_KEY` values, token values, cookie values, authorization values, `claudeConfigDir` contents, or any profile secret values.
- [ ] Add a failing test that `getActiveRunForWorkspace` returns a `queued` or `running` run and ignores terminal runs.
- [ ] Add a failing test that `updateRunTerminal` can persist `exitCode = null` and `signal = 'SIGTERM'` for signal exits.
- [ ] Add a failing test that `updateRunLastEventId` updates both `runs.last_run_event_id` and `updated_at`.
- [ ] Implement repository/profile-snapshot helpers.
- [ ] Run `pnpm test src/core/__tests__/profile-snapshot.test.ts src/db/__tests__/repositories.test.ts`.
- [ ] Commit: `feat: add atomic run create persistence`.

**Acceptance Criteria:**

- Run create persistence is atomic.
- The Phase 1 run/create snapshot pairing from CC review is explicitly implemented.
- No public API can expose snapshot internals.

## Task 3: Claude Stream Parser

**Files:**

- Create: `src/core/run-events.ts`
- Create: `src/core/claude-stream.ts`
- Test: `src/core/__tests__/claude-stream.test.ts`
- Test: `src/core/__tests__/run-events.test.ts`

**Responsibilities:**

- Port the lanceDesign Claude JSONL parser near-verbatim into this daemon.
- Translate Claude Code `--output-format stream-json --verbose` output into daemon internal events.
- Support both modern `stream_event` deltas and older final `assistant` wrapper fallback.
- Preserve `textStreamed` duplicate suppression, `streamedToolUseIds` duplicate suppression, per-content-block partial JSON assembly, line-buffered `feed`, and final `flush` behavior. Remove only UI/product-specific fields that are not part of the generic daemon event contract, and document any removal in tests.

**Reference:**

- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/claude-stream.ts`

**TDD Steps:**

- [ ] Add a failing test that `system init` emits `status` with model/session id.
- [ ] Add a failing test that `stream_event.content_block_delta.text_delta` emits `text_delta`.
- [ ] Add a failing test that final `assistant` wrapper emits text when no streamed text was seen.
- [ ] Add a failing test that streamed text and final wrapper do not duplicate content.
- [ ] Add a failing test that `thinking_start` and `thinking_delta` are emitted.
- [ ] Add a failing test that partial `input_json_delta` chunks are merged into one `tool_use`.
- [ ] Add a failing test that duplicate final-wrapper `tool_use` is suppressed after streamed tool input emitted.
- [ ] Add a failing test that `user` tool result wrappers emit `tool_result`.
- [ ] Add a failing test that `result` emits `usage` with cost/duration/stop reason.
- [ ] Add a failing test that invalid JSONL emits capped `raw` rather than throwing.
- [ ] Add a failing test that `flush()` drains a trailing JSON line that has no final newline.
- [ ] Implement `createClaudeStreamHandler`.
- [ ] Run `pnpm test src/core/__tests__/claude-stream.test.ts src/core/__tests__/run-events.test.ts`.
- [ ] Commit: `feat: add claude stream parser`.

**Acceptance Criteria:**

- Parser tests cover modern and fallback Claude Code formats.
- Parser has no lanceDesign product fields or wording.
- Raw invalid lines are capped before entering events.

## Task 4: Claude Adapter And Capability Probe

**Files:**

- Create: `src/core/claude-capabilities.ts`
- Create: `src/core/claude-adapter.ts`
- Test: `src/core/__tests__/claude-capabilities.test.ts`
- Test: `src/core/__tests__/claude-adapter.test.ts`

**Responsibilities:**

- Build Claude CLI argv and environment from profile/run settings.
- Keep prompt off argv and deliver it through stdin.
- Probe `claude -p --help` for optional flags and cache results.
- Validate selected model against `profile.allowedModels`.

**Reference:**

- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/runtimes/defs/claude.ts`

**Required Args:**

```text
-p
--output-format stream-json
--verbose
--include-partial-messages   only when probe says supported
--model <model>              model from request or profile.defaultModel
--add-dir <workspaceDir>     when extra allowed dirs exist and capability is not explicitly false
--permission-mode <profile.permissionMode>
```

Do not pass prompt as argv.

**Required Env:**

- Start from `process.env` filtered only by explicit implementation choice.
- Overlay allowlisted `profile.env`.
- Set `CLAUDE_CONFIG_DIR = profile.claudeConfigDir`.
- Do not accept request-level env overrides.
- Do not inject any `LANCE_DESIGN_*` env.

**TDD Steps:**

- [ ] Add a failing test that args include `-p --output-format stream-json --verbose`.
- [ ] Add a failing test that `--include-partial-messages` appears only when capability probe reports support.
- [ ] Add a failing test that `--add-dir <workspaceCwd>` appears when extra dirs exist and capability is supported or unknown, matching lanceDesign's `caps.addDir !== false` behavior.
- [ ] Add a failing test that `--add-dir` is omitted when capability probe explicitly reports unsupported.
- [ ] Add a failing test that request `model` overrides `profile.defaultModel` only when allowed.
- [ ] Add a failing test that disallowed model raises `MODEL_NOT_ALLOWED`.
- [ ] Add a failing test that `--permission-mode` uses `profile.permissionMode`.
- [ ] Add a failing test that env includes `CLAUDE_CONFIG_DIR` and allowlisted profile env.
- [ ] Add a failing test that prompt is returned separately as `stdinPrompt` and never appears in args.
- [ ] Implement adapter/probe with fake `execFile` or fake spawn seam.
- [ ] Run `pnpm test src/core/__tests__/claude-capabilities.test.ts src/core/__tests__/claude-adapter.test.ts`.
- [ ] Commit: `feat: add claude adapter`.

**Acceptance Criteria:**

- The first runtime path can build a Claude invocation without starting a process.
- Capability tests do not require Claude Code to be installed.

## Task 5: Event Visibility Filter

**Files:**

- Create: `src/core/event-visibility.ts`
- Test: `src/core/__tests__/event-visibility.test.ts`

**Responsibilities:**

- Compute effective visibility from client, profile, and request.
- Filter SSE and run detail events without mutating persisted accumulator state.
- Cap debug event payloads.

**TDD Steps:**

- [ ] Add a failing test that `quiet` includes only `status`, `text_delta`, `usage`, `error`, and `end`.
- [ ] Add a failing test that `normal` includes thinking/tool events and excludes `stderr`/`raw`.
- [ ] Add a failing test that `debug` includes capped `stderr`/`raw` only when `client.canReadDebugEvents` is true.
- [ ] Add a failing test that request `eventVisibility=debug` is downgraded when profile visibility is `normal`.
- [ ] Add a failing test that request `eventVisibility=debug` is downgraded when client cannot read debug events.
- [ ] Implement visibility helpers.
- [ ] Run `pnpm test src/core/__tests__/event-visibility.test.ts`.
- [ ] Commit: `feat: add event visibility filtering`.

**Acceptance Criteria:**

- Debug output is not leaked to ordinary clients.
- Filtering never exposes absolute workspace paths.

## Task 6: Message Accumulator

**Files:**

- Create: `src/core/message-accumulator.ts`
- Test: `src/core/__tests__/message-accumulator.test.ts`
- Modify: `src/db/repositories.ts`
- Modify: `src/db/__tests__/repositories.test.ts`

**Responsibilities:**

- Own assistant draft updates for one run.
- Throttle DB writes.
- Force flush before terminal transition.
- Keep usage data for the run terminal update.

**TDD Steps:**

- [ ] Add a failing test that run start marks assistant message `runStatus = running` and sets `startedAt`.
- [ ] Add a failing test that two `text_delta` events append to assistant `content`.
- [ ] Add a failing test that tool/thinking/status events are appended to `events_json`.
- [ ] Add a failing test that `stderr` and `raw` are not persisted by default.
- [ ] Add a failing test that updates are throttled to roughly `runMessageFlushPolicy.throttleMs`.
- [ ] Add a failing test that `forceFlush` writes pending content/events immediately.
- [ ] Add a failing test that terminal flush writes `runStatus`, `endedAt`, and `lastRunEventId`.
- [ ] Add a failing test that two accumulator instances do not share content, events, timers, or message ids.
- [ ] Implement accumulator with injectable clock/timer for deterministic tests.
- [ ] Run `pnpm test src/core/__tests__/message-accumulator.test.ts`.
- [ ] Commit: `feat: add daemon message accumulator`.

**Acceptance Criteria:**

- `run_messages` durability is daemon-side.
- SSE subscription is irrelevant to DB persistence.
- Terminal transition always flushes first.

## Task 7: SSE Helpers

**Files:**

- Create: `src/http/sse.ts`
- Test: `src/http/__tests__/sse.test.ts`

**Responsibilities:**

- Set SSE headers.
- Format `id`, `event`, and JSON `data` frames.
- Send keepalive comments.
- Clean up heartbeat timers on close/finish.

**Reference:**

- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/server.ts` `createSseResponse`

**TDD Steps:**

- [ ] Add a failing test that headers are `text/event-stream`, `no-cache, no-transform`, `keep-alive`, and `X-Accel-Buffering: no`.
- [ ] Add a failing test that `send('agent', { type: 'text_delta' }, '3')` writes one complete SSE frame.
- [ ] Add a failing test that multiline JSON data is serialized as a single `data:` JSON line.
- [ ] Add a failing test that heartbeat is cleared on response close.
- [ ] Implement SSE helper.
- [ ] Run `pnpm test src/http/__tests__/sse.test.ts`.
- [ ] Commit: `feat: add sse helpers`.

**Acceptance Criteria:**

- SSE writes are deterministic and testable.
- No run-service logic lives in the HTTP SSE helper.

## Task 8: CLI Runner With Fake Spawn Seam

**Files:**

- Create: `src/core/claude-diagnostics.ts`
- Create: `src/core/cli-runner.ts`
- Test: `src/core/__tests__/claude-diagnostics.test.ts`
- Test: `src/core/__tests__/cli-runner.test.ts`

**Responsibilities:**

- Spawn Claude Code.
- Write prompt to stdin.
- Attach stream parser to stdout.
- Keep capped stdout/stderr tails at 2,000 characters.
- Convert spawn error, stream error, close code/signal, and cancel into runner results.
- Diagnose Claude auth/model/config failures with generic daemon wording.
- Enforce the minimal Phase 1 inactivity watchdog using child stdout/stderr/parser activity.

**Reference:**

- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/server.ts` `startChatRun` spawn/stdin/stdout/stderr/close/cancel chain.
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/claude-diagnostics.ts`

**Phase 1 Timeout Boundary:**

Do not implement the full Phase 3 timeout scheduler or queue-wide timeout hardening in this task. Phase 1 must still port lanceDesign's minimal inactivity watchdog: reset the watchdog on stdout bytes, stderr bytes, and parsed agent events; if no activity occurs for `profile.inactivityTimeoutMs`, emit a generic `RUN_INACTIVITY_TIMEOUT` error, fail the run, send SIGTERM, and then SIGKILL after `profile.cancelGraceMs` if needed. `runTimeoutMs` enforcement remains Phase 3 unless it can be added without a scheduler. Phase 1 intentionally uses profile `cancelGraceMs` for inactivity SIGTERM-to-SIGKILL escalation instead of lanceDesign's hard-coded 3s/6s inactivity grace so profiles own process shutdown timing.

Before the watchdog emits an error or finishes a run, it must guard against `cancelRequested` and terminal status. This prevents a race where user cancel and inactivity timeout both try to finish the same run and overwrite terminal status.

**Diagnostics Redaction Requirements:**

- Do not expose `CLAUDE_CONFIG_DIR`, `profile.claudeConfigDir`, sandbox roots, workspace cwd, or any other absolute path in SSE/API error details.
- Do not expose raw stderr/stdout tails in API/SSE responses. Use tails only for internal classification.
- Remove all LanceRouter, Open Settings, Settings dialog, `LANCE_DESIGN_LOCAL_CLIENT`, and `LANCE_DESIGN_*` wording/fields.
- Map classified auth failures to `CLAUDE_AUTH_FAILED`.
- Map model/config/spawn/non-zero failures to `CLAUDE_CLI_FAILED` unless a more specific existing code applies.
- Return machine-readable safe details such as `{ "category": "auth" }`, `{ "category": "model" }`, or `{ "category": "config" }`, not raw provider output.

**TDD Steps:**

- [ ] Add a failing test that fake stdout JSONL emits parsed agent events.
- [ ] Add a failing test that stdin receives the prompt and args do not include the prompt.
- [ ] Add a failing test that `stdin` EPIPE does not crash the runner.
- [ ] Add a failing test that non-EPIPE stdin error emits an `error` event and fails the run.
- [ ] Add a failing test that spawn error emits `CLAUDE_CLI_FAILED`.
- [ ] Add a failing test that close code `0` without cancel succeeds.
- [ ] Add a failing test that close code non-zero without cancel fails and includes a generic diagnostic when auth/model text is detected.
- [ ] Add a failing test that auth failure maps to `CLAUDE_AUTH_FAILED` with no `CLAUDE_CONFIG_DIR`, absolute path, raw stderr, LanceRouter, Open Settings, or `LANCE_DESIGN_*` text.
- [ ] Add a failing test that cancel sends SIGTERM and then SIGKILL after `cancelGraceMs` if the fake process stays alive.
- [ ] Add a failing test that stdout/stderr tails are capped at 2,000 characters and never include uncapped huge chunks.
- [ ] Add a failing test that inactivity timeout fails the run with `RUN_INACTIVITY_TIMEOUT`, sends SIGTERM, and escalates to SIGKILL after `cancelGraceMs` if the child remains alive.
- [ ] Add a failing test that inactivity timeout does nothing when the run is already terminal or cancel has already been requested.
- [ ] Implement fake child process interfaces and runner.
- [ ] Run `pnpm test src/core/__tests__/claude-diagnostics.test.ts src/core/__tests__/cli-runner.test.ts`.
- [ ] Commit: `feat: add cli runner`.

**Acceptance Criteria:**

- Automated tests do not require Claude Code.
- Diagnostics contain no lanceDesign wording.
- No sandbox absolute path is exposed through runner errors.

## Task 9: Run Service

**Files:**

- Create: `src/core/run-service.ts`
- Test: `src/core/__tests__/run-service.test.ts`
- Modify: `src/db/repositories.ts`
- Modify: `src/db/__tests__/repositories.test.ts`

**Responsibilities:**

- Own Phase 1 lifecycle and active in-memory run state.
- Port lanceDesign `runs.ts` mechanics for event buffer, subscriber management, replay, terminal close, waiters, cleanup TTL, and cancel semantics as behavior-equivalent code.
- Create durable run transaction.
- Schedule immediate process start after transaction commit.
- Maintain per-run event buffer for short SSE replay.
- Prevent two active runs in the same workspace.
- Handle cancel and terminal transitions.

**Reference:**

- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/runs.ts`

**Ported From `runs.ts`:**

- `events[]` buffer with a bounded max event count.
- `nextEventId` starting at 1 and incrementing per emitted event.
- Replay by numeric `record.id > lastEventId`.
- `clients` subscriber set and close cleanup.
- Terminal `finish` closes subscribers and schedules TTL cleanup with `unref`.
- `isTerminal` status helper.
- Cancel signal behavior as adapted by `cli-runner`.

**New For This Daemon:**

- SQLite run state transitions.
- Daemon-side message accumulator hook.
- Atomic run create transaction with default conversation and profile snapshot.
- Per-workspace active-run conflict using SQLite as the source of truth.

**Run Lifecycle:**

```text
POST /api/runs
  -> validate auth/profile/workspace
  -> reject kind=generate in Phase 1
  -> transaction: reject if workspace has DB queued/running run, get/create default conversation, insert queued run + messages + snapshot
  -> emit queued event to buffer
  -> schedule start asynchronously
  -> response 202 { runId, status: "queued" }

start
  -> update run running
  -> mark assistant running
  -> emit start/status events
  -> run cli-runner
  -> accumulator receives parser events
  -> terminal: force flush
  -> update run terminal
  -> emit end
  -> close SSE subscribers
```

**Active Workspace Conflict:**

Until Phase 3 implements a real queue, Phase 1 must reject a second active run for the same workspace. Use:

```text
HTTP 409
code WORKSPACE_RUN_ACTIVE
message "Workspace already has an active run"
details.reason "WORKSPACE_RUN_ACTIVE"
```

Do not use `RUN_QUEUE_FULL` here; Phase 3 reserves that code for real queue capacity. `getActiveRunForWorkspace` and queued insert must execute in the same synchronous SQLite transaction, with no `await` between the active check and insert. If an in-memory active map exists, treat it only as an optimization; DB state decides conflicts.

**TDD Steps:**

- [ ] Add a failing test that `createRun` rejects workspace/profile mismatch.
- [ ] Add a failing test that `createRun` rejects unauthorized client/profile access.
- [ ] Add a failing test that `createRun` rejects `kind=generate` with `BAD_REQUEST`.
- [ ] Add a failing test that `createRun` writes default conversation, queued run, messages, and snapshot before starting fake runner.
- [ ] Add a failing test that a second active run for the same workspace returns `WORKSPACE_RUN_ACTIVE`.
- [ ] Add a failing test that active-run check and queued insert are atomic by simulating two same-workspace create attempts and proving only one queued run is inserted.
- [ ] Add a failing test that events get monotonically increasing ids and update `runs.last_run_event_id`.
- [ ] Add a failing test that `replay(after)` returns only events with id greater than `after`.
- [ ] Add a failing test that terminal status closes subscribers and keeps terminal events available until in-memory TTL cleanup.
- [ ] Add a failing test that `/events` after in-memory TTL cleanup returns `404 NOT_FOUND` while `GET /api/runs/:runId` still returns durable detail.
- [ ] Add a failing test that cancel before runner start marks run `canceled`.
- [ ] Add a failing test that cancel while running calls runner cancel and terminal status is `canceled`.
- [ ] Add a failing test that runner failure marks run `failed`, persists error fields, and flushes messages first.
- [ ] Implement run service with injectable fake runner factory, clock, and cleanup timers.
- [ ] Run `pnpm test src/core/__tests__/run-service.test.ts`.
- [ ] Commit: `feat: add run service`.

**Acceptance Criteria:**

- Run service can be tested without Express and without Claude Code.
- No full queue is implemented.
- Workspace serial execution is protected for Phase 1.

## Task 10: Runs HTTP Routes

**Files:**

- Create: `src/http/runs-routes.ts`
- Test: `src/http/__tests__/runs-routes.test.ts`
- Modify: `src/http/app.ts`
- Modify: `src/http/validation.ts`
- Modify: `src/http/__tests__/validation.test.ts`

**Responsibilities:**

- Wire Phase 1 run APIs behind auth.
- Keep route code thin and delegate lifecycle to run service.
- Return structured errors.
- Filter events/messages by effective visibility.

**Routes:**

```text
POST /api/runs
GET  /api/runs
GET  /api/runs/:runId
GET  /api/runs/:runId/events
POST /api/runs/:runId/cancel
```

**Response Shapes:**

`POST /api/runs`:

```json
{
  "runId": "run_...",
  "status": "queued"
}
```

`GET /api/runs`:

```json
{
  "runs": [
    {
      "id": "run_...",
      "workspaceId": "ws_...",
      "profileId": "report-docx",
      "kind": "revise",
      "skillId": null,
      "status": "succeeded",
      "lastRunEventId": "5",
      "queuedAt": 1770000000000,
      "startedAt": 1770000000100,
      "finishedAt": 1770000002000,
      "createdAt": 1770000000000,
      "updatedAt": 1770000002000
    }
  ]
}
```

`GET /api/runs/:runId`:

```json
{
  "run": {
    "id": "run_...",
    "workspaceId": "ws_...",
    "profileId": "report-docx",
    "kind": "revise",
    "skillId": null,
    "status": "succeeded",
    "lastRunEventId": "5",
    "queuedAt": 1770000000000,
    "startedAt": 1770000000100,
    "finishedAt": 1770000002000,
    "exitCode": 0,
    "signal": null,
    "errorCode": null,
    "errorMessage": null,
    "usage": null,
    "metadata": null,
    "createdAt": 1770000000000,
    "updatedAt": 1770000002000
  },
  "messages": [
    {
      "id": "msg_...",
      "role": "user",
      "content": "List files.",
      "events": null,
      "runStatus": null,
      "lastRunEventId": null,
      "startedAt": null,
      "endedAt": null,
      "position": 0,
      "createdAt": 1770000000000,
      "updatedAt": 1770000000000
    },
    {
      "id": "msg_...",
      "role": "assistant",
      "content": "Done.",
      "events": [{ "type": "text_delta", "delta": "Done." }],
      "runStatus": "succeeded",
      "lastRunEventId": "5",
      "startedAt": 1770000000100,
      "endedAt": 1770000002000,
      "position": 1,
      "createdAt": 1770000000000,
      "updatedAt": 1770000002000
    }
  ]
}
```

Do not include sandbox absolute paths in list/detail responses.

**TDD Steps:**

- [ ] Add a failing route test that unauthenticated run create returns 401.
- [ ] Add a failing route test that run create validates `workspaceId` and rejects inline identity fields.
- [ ] Add a failing route test that client cannot create a run for another client's workspace.
- [ ] Add a failing route test that workspace/profile mismatch returns structured 400 or 404 without leaking ids from another client.
- [ ] Add a failing route test that `kind=generate` returns Phase 1 structured 400.
- [ ] Add a failing route test that successful `POST /api/runs` returns 202 `{ runId, status: "queued" }`.
- [ ] Add a failing route test that `GET /api/runs` is client-scoped and supports `originId`, `userId`, `projectId`, `workspaceKey`, `workspacePrefix`, and `status`.
- [ ] Add a failing route test that `GET /api/runs/:runId` returns durable messages with visibility filtering.
- [ ] Add a failing route test that `GET /api/runs/:runId/events` sends replayed SSE events after `?after=`.
- [ ] Add a failing route test that `Last-Event-ID` takes the same replay path as `after`.
- [ ] Add a failing route test that `/events` returns `404 NOT_FOUND` after the in-memory stream state is gone, while run detail remains readable from SQLite.
- [ ] Add a failing route test that `POST /api/runs/:runId/cancel` returns `{ "ok": true }` for active runs.
- [ ] Add a failing route test that cancel on terminal run returns `RUN_NOT_CANCELABLE`.
- [ ] Implement routes and app wiring.
- [ ] Run `pnpm test src/http/__tests__/runs-routes.test.ts`.
- [ ] Commit: `feat: add run http routes`.

**Acceptance Criteria:**

- HTTP route behavior matches the contract.
- Route tests do not spawn Claude Code.
- SSE replay is memory-only and explicitly short-term.

## Task 11: Server Wiring And Lifecycle

**Files:**

- Modify: `src/index.ts`
- Modify: `src/__tests__/index.test.ts`
- Modify: `src/http/app.ts`

**Responsibilities:**

- Construct run service in `createServerContext`.
- Pass run service into `createApp`.
- Keep `import src/index.ts` side-effect free.
- Keep startup interruption handling before accepting requests.

**TDD Steps:**

- [ ] Add a failing test that `createServerContext` exposes `runService`.
- [ ] Add a failing test that importing `src/index.ts` still does not start the server.
- [ ] Add a failing test that startup still applies schema and marks old `queued/running` runs as `interrupted`.
- [ ] Add a failing test that app wiring includes `/api/runs` only when a run service is provided.
- [ ] Implement server wiring.
- [ ] Run `pnpm test src/__tests__/index.test.ts src/http/__tests__/runs-routes.test.ts`.
- [ ] Commit: `feat: wire run service startup`.

**Acceptance Criteria:**

- Phase 0 startup invariants still hold.
- Run service starts only through explicit server context creation.

## Task 12: End-To-End Tests With Fake Runner

**Files:**

- Test: `src/http/__tests__/runs-routes.test.ts`
- Test: `src/core/__tests__/run-service.test.ts`
- Modify only implementation files needed to satisfy the tests.

**Responsibilities:**

- Prove the complete Phase 1 path without real Claude Code.
- Prove no SSE consumer is required for durable messages.

**TDD Steps:**

- [ ] Add an integration test that creates workspace, creates a revise run, fake runner emits text/usage/end, and `GET /api/runs/:runId` returns assistant content/events.
- [ ] Add an integration test that no call to `/events` is made and messages still persist.
- [ ] Add an integration test that SSE subscriber receives replayed events and live events in order.
- [ ] Add an integration test that cancel changes DB status to `canceled` and closes SSE subscribers.
- [ ] Add an integration test that runner failure changes DB status to `failed` with generic error fields.
- [ ] Add an integration test that no response body includes the workspace absolute path, sandbox root, `claudeConfigDir`, or API key values.
- [ ] Implement any missing glue.
- [ ] Run `pnpm test src/core/__tests__/run-service.test.ts src/http/__tests__/runs-routes.test.ts`.
- [ ] Commit: `test: cover phase 1 run lifecycle`.

**Acceptance Criteria:**

- The hardest architecture decision is proven: daemon-side persistence does not depend on SSE consumption.
- The test suite protects run create, stream, cancel, and durable detail.

## Task 13: Manual Smoke And Documentation Check

**Files:**

- Modify docs only if implementation behavior differs from this reviewed plan.
- Do not modify implementation during this task except for test fixes discovered by smoke.

**Automated Verification:**

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Expected:

```text
typecheck passes
all tests pass
build succeeds
```

**Manual Fake-Profile Smoke:**

Use a fake runner seam in tests as the authoritative smoke. Real Claude Code smoke is optional because CI/dev machines may not have an authenticated Claude profile.

**Manual Real Claude Smoke, only when a configured profile exists:**

Start daemon:

```bash
pnpm dev -- --config /absolute/path/to/local-config.json
```

Create or reuse a workspace:

```bash
curl -s -X POST \
  -H 'Authorization: Bearer <api-key>' \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:17890/api/workspaces \
  -d '{"profileId":"<profileId>","workspace":{"originId":"manual","userId":"user_1","projectId":"phase_1_smoke"}}'
```

Create a revise run:

```bash
curl -s -X POST \
  -H 'Authorization: Bearer <api-key>' \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:17890/api/runs \
  -d '{"profileId":"<profileId>","workspaceId":"<workspaceId>","kind":"revise","prompt":"Reply with exactly: phase 1 smoke ok"}'
```

Subscribe to events:

```bash
curl -N \
  -H 'Authorization: Bearer <api-key>' \
  http://127.0.0.1:17890/api/runs/<runId>/events
```

Fetch detail:

```bash
curl -s \
  -H 'Authorization: Bearer <api-key>' \
  http://127.0.0.1:17890/api/runs/<runId>
```

Expected:

- `POST /api/runs` returns 202 with `status: "queued"`.
- SSE emits status/agent/end frames.
- DB-backed run detail shows terminal status.
- Assistant message has content and `events`.
- No response exposes sandbox absolute paths.

**Commit:**

```bash
git status --short
git add docs/phase-1-minimal-run-plan.md src
git commit -m "feat: complete phase 1 minimal run"
```

Only commit implementation files that belong to Phase 1.

## CC Review Gate

After implementation and automated verification, ask CC to review the range from the Phase 1 base commit to HEAD.

Required review focus:

- No lanceDesign private imports.
- Directly reusable lanceDesign runner pieces are ported behavior-equivalently into this repo, especially `claude-stream.ts`, `runs.ts` mechanics, Claude argv/capability behavior, and SSE helper behavior.
- `kind=generate` is not silently executed without Phase 2 skill staging.
- `POST /api/runs` only references `workspaceId`.
- Run create transaction checks active workspace state, gets/creates default conversation, and inserts queued run, user/assistant messages, and sanitized profile snapshot atomically.
- Daemon-side message persistence works without SSE consumers.
- SSE replay is memory-only and short-term.
- No `run_events` table.
- No artifact watcher/scan/download/upload.
- No remote URL/S3 pull.
- No full queue/timeout/metrics.
- No OS-level sandbox claims.
- No API response leaks sandbox absolute paths, `claudeConfigDir`, API keys, or profile secrets.
- Claude diagnostics do not expose raw stderr/stdout tails or lanceDesign product wording.
- Cancel uses SIGTERM and SIGKILL after `cancelGraceMs`.
- Minimal inactivity watchdog is implemented and tested; full timeout/queue hardening remains Phase 3.
- Tests use fake spawn and do not require Claude Code.

## Final Phase 1 Acceptance Criteria

- `pnpm typecheck` passes.
- `pnpm test` passes.
- `pnpm build` passes.
- `POST /api/runs` creates durable queued runs for authorized `revise` requests.
- `POST /api/runs` rejects Phase 1 `generate` execution instead of running without skill staging.
- Profile/model/workspace/client authorization is enforced.
- Same-workspace concurrent execution is prevented.
- Claude CLI invocation uses stdin prompt, stream-json output, profile permission mode, profile `CLAUDE_CONFIG_DIR`, allowlisted env, and allowed model.
- SSE events are visible live and replayable from memory for short reconnects.
- `/events` returns a clear `404 NOT_FOUND` after in-memory stream state expires; durable history remains available through `GET /api/runs/:runId`.
- `GET /api/runs/:runId` reads durable SQLite state and `run_messages.events_json`.
- Assistant message persistence is driven by daemon accumulator, not frontend consumption.
- Cancel transitions active runs to `canceled`.
- Stuck children fail through the minimal inactivity watchdog instead of occupying a workspace indefinitely.
- Failed CLI runs transition to `failed` with generic structured diagnostics.
- No Phase 2/3 scope is implemented.

## Backlog For Phase 2/3

Carry these forward intentionally:

- Phase 2: skill registry, skill staging, skill body prompt preamble, artifact rules, artifact scan, artifact list/download.
- Phase 2: required artifact missing maps to `ARTIFACT_REQUIRED_MISSING`.
- Phase 3: real queue, `globalConcurrency`, `profileConcurrency`, `maxQueueSize`, deterministic queued run promotion.
- Phase 3: full `runTimeoutMs` enforcement and richer timeout hardening beyond Phase 1's minimal inactivity watchdog.
- Phase 3: log files, `GET /api/runs/:runId/logs`, retention cleanup.
- Phase 3: timing-safe API key comparison.
- Phase 3: symlink-aware path containment if stronger directory isolation is approved.
- Phase 3: graceful shutdown with active child cancellation and `db.close()`.
