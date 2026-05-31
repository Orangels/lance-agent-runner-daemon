# Phase 3 Queue Timeout Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-version queue scheduling, global/profile/workspace concurrency, total run timeout, authorized run logs, log retention, and graceful shutdown hardening without changing the daemon security boundary.

**Architecture:** Phase 3 turns Phase 2's immediate-start run service into a small scheduler backed by SQLite run rows and in-memory active state. Queue eligibility remains process-local because old `queued`/`running` rows are marked `interrupted` at daemon startup. Logs are written under daemon `dataDir`, indexed by the existing `run_logs` table, and exposed only as sanitized summaries to authorized clients.

**Tech Stack:** TypeScript ESM, Express 5, better-sqlite3, Node.js fs/path/stream timers, Vitest, existing Claude Code CLI runner.

---

## Current Baseline

Phase 2 on `main` provides:

- `POST /api/runs` for `generate` and `revise`.
- Immediate queued row insert with user/assistant messages and profile snapshot.
- Claude Code CLI spawn, stream-json parser, partial-message capability probing, inactivity watchdog, cancel SIGTERM/SIGKILL fallback.
- Skill staging and artifact finalization before terminal `end`.
- In-memory SSE event buffer for online and short reconnect replay.
- Durable history through `run_messages.events_json`.
- `artifacts` list/download APIs.
- `run_logs` table exists in schema, but no writer, repository helpers, or HTTP route.

Known Phase 2 limitations that Phase 3 intentionally addresses:

- `createRunQueuedWithMessagesAndSnapshot()` rejects another active run for the same workspace with `WORKSPACE_RUN_ACTIVE`; Phase 3 must queue instead.
- `globalConcurrency`, `profileConcurrency`, and `server.maxQueueSize` are parsed but not enforced.
- `profile.runTimeoutMs` is parsed but not enforced. Only `inactivityTimeoutMs` is active.
- `GET /api/runs/:runId/logs` is in the API contract but not wired.
- No graceful shutdown hook calls a run service shutdown path.

## Non-Negotiable Boundaries

- Repository path is `/home/orangels/ls_dev/lance-agent-runner-daemon`.
- Reference repository is `/home/orangels/ls_dev/lanceDesign`; inspect it only as reference, never import from it.
- Do not add a `run_events` table.
- Do not implement metrics exposure, upload API, remote URL pull, S3/object-storage pull, signed URLs, browser direct CORS, profile hot reload, OS-level isolation, separate uid execution, containers, seccomp/firejail, or Claude permission hooks.
- Keep `POST /api/runs` workspaceId-only. Do not reintroduce inline `originId/userId/projectId`.
- Requests still cannot override `claudeConfigDir`, `claudeBin`, `skillRoots`, `allowedInputRoots`, `permissionMode`, env, artifact glob patterns, queue limits, or timeout values.
- Queue state is in-memory for the current process. SQLite remains the durable run truth, and daemon startup continues to mark old `queued`/`running` rows as `interrupted`.
- SSE `/events` remains online/short-reconnect only. Long-term history remains `GET /api/runs/:runId` from `run_messages.events_json`.
- Logs must not expose sandbox absolute paths, `CLAUDE_CONFIG_DIR`, bearer/cookie/token/API-key-like strings, or raw profile env values through API responses.
- `profile.allowedInputRoots` and complete `profile.skillRoots` must never be passed to Claude Code `--add-dir`.

## Reference Map

Read these local docs before implementation:

- `/home/orangels/ls_dev/lance-agent-runner-daemon/AGENTS.md`
  - API contract and first-version security boundary.
- `/home/orangels/ls_dev/lance-agent-runner-daemon/REFERENCE.md`
  - `runs.ts` mapping, queue/concurrency gap, `run_logs` table, `/api/runs/:runId/logs`.
- `/home/orangels/ls_dev/lance-agent-runner-daemon/docs/claude-code-runner-daemon-design.md`
  - Config examples for `globalConcurrency`, `maxQueueSize`, `profileConcurrency`, `runTimeoutMs`, `inactivityTimeoutMs`, `cancelGraceMs`: around lines 119-171.
  - Run lifecycle and cancel behavior: around lines 473-492.
  - Persistence/log runtime directory and `run_logs` schema: around lines 690-703 and 942-958.
  - Concurrency and queue behavior: around lines 1150-1164.
  - Logs authorization: around lines 1257-1260.
  - Startup interrupted behavior, no `run_events`, and flush strategy: around lines 1403-1489.
- `/home/orangels/ls_dev/lance-agent-runner-daemon/docs/claude-code-runner-daemon-migration-assessment.md`
  - Queue and concurrency: around lines 354-365.
  - Recommended Phase 3 scope: around lines 542-551.
- `/home/orangels/ls_dev/lance-agent-runner-daemon/docs/phase-2-skill-artifact-plan.md`
  - Deferred Phase 3 exclusions and terminal artifact flow assumptions.

Study these lanceDesign files as references only:

- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/runs.ts`
  - `create()`, `start()`, `stream()`, `cancel()`, `shutdownActive()`, terminal TTL cleanup.
  - Important: lanceDesign has no generic queue/profile concurrency. Do not copy product metadata.
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/server.ts`
  - Inactivity watchdog and SIGTERM/SIGKILL hardening around lines 3958-4017.
  - stdin EPIPE and child close handling around lines 4118 and following.
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/runtimes/defs/claude.ts`
  - Claude Code CLI invocation remains Phase 1/2 behavior; Phase 3 should not change args except log plumbing.

## Phase 3 Minimal Runnable Target

Phase 3 is complete when this flow works:

1. `server.globalConcurrency`, `profile.profileConcurrency`, per-workspace serial execution, and `server.maxQueueSize` are enforced.
2. A run is always inserted as `queued` before execution. If capacity is available, it transitions to `running`; otherwise it remains `queued`.
3. When a running run reaches terminal, the scheduler starts the next eligible queued run.
4. Queued runs can be canceled before spawn; they never start later and their assistant message becomes terminal `canceled`.
5. Queue full returns `429 RUN_QUEUE_FULL` before any run row is inserted.
6. `profile.runTimeoutMs` enforces total running time from `startedAt`, independent of queued wait time. Timeout ends the run as `failed` with `RUN_TIMEOUT` and cancels the child if one exists.
7. `profile.inactivityTimeoutMs` behavior from Phase 1 remains intact and still returns `RUN_INACTIVITY_TIMEOUT`.
8. `GET /api/runs/:runId/logs` returns sanitized, authorized log summaries for clients with `canReadLogs=true`.
9. `run_logs` rows are created for runs that start, and log files live under daemon `dataDir`, not the workspace.
10. Graceful shutdown cancels/kills active children, marks queued/running in-memory runs terminal, flushes messages, closes log writers, and leaves startup interruption behavior unchanged.

## Module Map And Dependencies

Create these modules:

- `src/core/run-queue.ts`
  - Pure queue eligibility logic.
  - Computes dispatchable queued run ids from current in-memory run states and config limits.
  - No DB, Express, fs, or child process dependency.
- `src/core/log-sanitizer.ts`
  - Shared sanitizer for stderr/raw/debug/log text.
  - Reuses the Phase 1 redaction rules currently duplicated in `cli-runner.ts` and `event-visibility.ts`.
- `src/core/run-log-service.ts`
  - Owns log file path allocation, append writers, tail reading, and retention pruning.
  - Uses `config.server.dataDir`.
  - Stores paths in `run_logs` through DB repositories.
  - Returns public log summaries without absolute paths.
- `src/http/logs-routes.ts`
  - `GET /api/runs/:runId/logs`.
  - Uses auth middleware and `runLogService`.
  - Enforces `client.canReadLogs`.

Modify these existing modules:

- `src/config/profiles.ts`
  - Add optional `server.logRetentionMs` and `server.maxLogBytesPerRun` defaults if log retention uses config.
  - Keep existing configs backwards compatible.
- `src/core/cli-runner.ts`
  - Accept optional log sink callbacks.
  - Write sanitized stdout/stderr/debug-event chunks to sinks.
  - Keep existing inactivity/cancel behavior.
- `src/core/event-visibility.ts`
  - Import sanitizer from `log-sanitizer.ts`; do not duplicate regexes.
- `src/core/run-service.ts`
  - Replace immediate `scheduleStart()` with queue dispatch.
  - Add queued/running counters and dispatch loop.
  - Add total run timeout timer.
  - Add queued cancel terminal handling.
  - Integrate run log writer lifecycle.
  - Add `shutdownActive()`.
- `src/db/repositories.ts`
  - Remove or bypass same-workspace active-run rejection inside run create transaction.
  - Add `run_logs` helpers.
  - Add query helpers needed for log retention if implemented.
- `src/http/app.ts`
  - Wire logs route under `/api/runs/:runId/logs`.
- `src/index.ts`
  - Construct `runLogService`.
  - Pass it to `createRunService()` and `createApp()`.
  - Add graceful process signal handling in `startServer()` or a small helper.

Tests to create:

- `src/core/__tests__/run-queue.test.ts`
- `src/core/__tests__/log-sanitizer.test.ts`
- `src/core/__tests__/run-log-service.test.ts`
- `src/http/__tests__/logs-routes.test.ts`

Tests to modify:

- `src/core/__tests__/cli-runner.test.ts`
- `src/core/__tests__/event-visibility.test.ts`
- `src/core/__tests__/run-service.test.ts`
- `src/core/__tests__/run-types.test.ts`
- `src/db/__tests__/repositories.test.ts`
- `src/http/__tests__/runs-routes.test.ts`
- `src/__tests__/index.test.ts`
- `src/config/__tests__/profiles.test.ts`

Dependency direction:

```text
index.ts
  -> config, db, workspace service, artifact service, run log service, run service, http app

http/logs-routes.ts
  -> auth middleware, run log service

core/run-service.ts
  -> run-queue, run-log-service, artifact-service, skill modules, db repositories, cli-runner

core/run-log-service.ts
  -> db repositories, log-sanitizer, fs/path

core/cli-runner.ts
  -> log-sanitizer, claude-stream, diagnostics

core/run-queue.ts
  -> run-types/config-like primitive types only

db/*
  -> no core runtime process modules
```

## Implementation Sequence

### Task 1: Shared Log Sanitizer

**Files:**

- Create: `src/core/log-sanitizer.ts`
- Test: `src/core/__tests__/log-sanitizer.test.ts`
- Modify: `src/core/cli-runner.ts`
- Modify: `src/core/event-visibility.ts`
- Test: `src/core/__tests__/cli-runner.test.ts`
- Test: `src/core/__tests__/event-visibility.test.ts`

- [ ] Write tests for `sanitizeLogText()`:
  - redacts `CLAUDE_CONFIG_DIR=/private/path`;
  - redacts `authorization: Bearer abc`, `cookie=...`, `token=...`, `api_key=...`;
  - redacts `sk-ant-...`;
  - redacts absolute POSIX paths;
  - preserves ordinary relative paths such as `output/report.docx`.
- [ ] Move the current sanitizer regex from `src/core/cli-runner.ts` into `src/core/log-sanitizer.ts`.
- [ ] Import `sanitizeLogText()` in `cli-runner.ts`.
- [ ] Import `sanitizeLogText()` in `event-visibility.ts` for `stderr`, `raw`, and nested string redaction.
- [ ] Run:

```bash
pnpm exec vitest run src/core/__tests__/log-sanitizer.test.ts src/core/__tests__/cli-runner.test.ts src/core/__tests__/event-visibility.test.ts
```

Expected: sanitizer, cli-runner, and event-visibility tests pass.

**Acceptance:** Sanitization is shared and remains behaviorally equivalent to Phase 2.

### Task 2: Queue Eligibility Pure Module

**Files:**

- Create: `src/core/run-queue.ts`
- Test: `src/core/__tests__/run-queue.test.ts`

- [ ] Define a pure state shape:

```ts
export interface QueueCandidate {
  runId: string;
  profileId: string;
  workspaceId: string;
  status: 'queued' | 'starting' | 'running' | 'finishing' | 'terminal';
  sequence: number;
}
```

- [ ] Define limits:

```ts
export interface QueueLimits {
  globalConcurrency: number;
  profileConcurrencyById: Map<string, number>;
}
```

- [ ] Implement:
  - `countQueued(candidates)`;
  - `countRunning(candidates)`;
  - `canStartCandidate(candidate, candidates, limits)`;
  - `selectDispatchableCandidates(candidates, limits)`.
- [ ] Required behavior:
  - only `queued` candidates are dispatchable;
  - `running`, `starting`, and `finishing` consume global/profile/workspace capacity;
  - workspace serial execution allows at most one non-queued active runner per workspace;
  - selection scans FIFO by `sequence`;
  - a queued candidate blocked by its workspace does not block a later eligible candidate from a different workspace.
- [ ] Write tests for:
  - global concurrency limit;
  - profile concurrency limit;
  - workspace serial limit;
  - `finishing` still consumes global/profile/workspace capacity until artifact/log finalization completes;
  - FIFO dispatch when all are eligible;
  - no head-of-line blocking when first queued run is blocked by workspace.
- [ ] Run:

```bash
pnpm exec vitest run src/core/__tests__/run-queue.test.ts
```

Expected: run-queue tests pass.

**Acceptance:** Queue selection can be reasoned about without DB or timers.

### Task 3: Repository Changes For Queued Runs And Run Logs

**Files:**

- Modify: `src/db/repositories.ts`
- Test: `src/db/__tests__/repositories.test.ts`

- [ ] Remove the Phase 0/1/2 same-workspace active-run rejection from `createRunQueuedWithMessagesAndSnapshot()`.
- [ ] Keep the transaction atomic for conversation, run, messages, and profile snapshot.
- [ ] Keep `getActiveRunForWorkspace()` if useful for tests or diagnostics, but it must not prevent queue insertion.
- [ ] Add `RunLogRecord` matching existing `run_logs` schema:

```ts
export interface RunLogRecord {
  runId: string;
  stdoutLogPath: string | null;
  stderrLogPath: string | null;
  debugEventsLogPath: string | null;
  createdAt: number;
}
```

- [ ] Add helpers:
  - `upsertRunLogPaths(db, { runId, stdoutLogPath, stderrLogPath, debugEventsLogPath, now })`;
  - `getRunLogForRunForClient(db, { runId, clientId, isAdmin })`;
  - `listRunLogsFinishedBefore(db, { finishedBefore, limit })` if log retention is time-based;
  - `deleteRunLogRows(db, runIds)` or `clearRunLogPaths(db, runIds, now)` depending on retention choice.
- [ ] Store log paths relative to `config.server.dataDir`, not absolute paths.
- [ ] Write tests:
  - two queued runs for the same workspace can now be inserted;
  - user and assistant messages are still inserted for every queued run;
  - run log paths upsert and map correctly;
  - non-admin clients cannot read another client's log row;
  - admin can read across clients;
  - returned log records use relative paths only.
- [ ] Run:

```bash
pnpm exec vitest run src/db/__tests__/repositories.test.ts
```

Expected: repository tests pass.

**Acceptance:** SQLite permits durable queued backlog and can index run log files without exposing absolute paths.

### Task 4: Run Log Service

**Files:**

- Create: `src/core/run-log-service.ts`
- Test: `src/core/__tests__/run-log-service.test.ts`
- Modify: `src/config/profiles.ts`
- Test: `src/config/__tests__/profiles.test.ts`

- [ ] Decide config defaults:

```ts
server: {
  logRetentionMs: 7 * 24 * 60 * 60 * 1000,
  maxLogBytesPerRun: 4 * 1024 * 1024
}
```

These fields must be optional in config files so existing tests/configs keep working. Implement the defaults in the config schema/normalization layer, not as ad hoc hard-coded constants inside the log service.

- [ ] Implement `createRunLogService({ config, db, clock? })`.
- [ ] Implement `openRunLogs({ runId })` returning:
  - `stdout(chunk: string): void`;
  - `stderr(chunk: string): void`;
  - `debugEvent(event: RunEvent): void`;
  - `close(): Promise<void> | void`.
- [ ] Write files under:

```text
<dataDir>/logs/runs/<runId>/stdout.log
<dataDir>/logs/runs/<runId>/stderr.log
<dataDir>/logs/runs/<runId>/debug-events.ndjson
```

- [ ] Store relative paths such as `logs/runs/run_1/stdout.log` in `run_logs`.
- [ ] Keep `debug-events.ndjson` separate from `run_messages.events_json`: log files are sanitized diagnostics, while `events_json` remains durable API history filtered by event visibility.
- [ ] Sanitize all text before writing.
- [ ] Bound per-run log file size using `server.maxLogBytesPerRun`; once a file reaches the cap, stop appending and write one final marker line:

```text
[truncated: max log bytes reached]
```

- [ ] Implement `getRunLogs({ client, runId })`:
  - requires run/client access;
  - requires `client.canReadLogs === true`;
  - returns `{ runId, logs: { stdout, stderr, debugEvents } }` where each log includes `{ available, size, tail }`;
  - tail reads the last 16 KiB from file;
  - response contains no absolute paths.
- [ ] Implement `pruneExpiredLogs({ now })`:
  - finds terminal runs older than `server.logRetentionMs`;
  - removes only log files/directories under `<dataDir>/logs/runs/<runId>`;
  - clears or deletes corresponding `run_logs` rows;
  - never deletes workspace directories, artifacts, run rows, or messages.
- [ ] Write tests:
  - creates log files and `run_logs` row with relative paths;
  - sanitizes secrets and absolute paths before writing;
  - caps log size and writes truncation marker;
  - `getRunLogs` denies `canReadLogs=false` with `FORBIDDEN`;
  - cross-client log read returns `NOT_FOUND`;
  - public response has tails but no filesystem paths;
  - retention prune deletes only expired log directories and leaves DB run/messages/artifacts intact.
- [ ] Run:

```bash
pnpm exec vitest run src/core/__tests__/run-log-service.test.ts src/config/__tests__/profiles.test.ts
```

Expected: log service and config tests pass.

**Acceptance:** Runs have bounded, sanitized, authorized logs under daemon `dataDir`.

### Task 5: CLI Runner Log Sink

**Files:**

- Modify: `src/core/cli-runner.ts`
- Test: `src/core/__tests__/cli-runner.test.ts`

- [ ] Add optional input:

```ts
logSink?: {
  stdout?(chunk: string): void;
  stderr?(chunk: string): void;
  debugEvent?(event: RunEvent): void;
}
```

- [ ] On stdout chunk:
  - keep existing tail behavior;
  - feed Claude stream parser as before;
  - write sanitized chunk to `logSink.stdout`.
- [ ] On stderr chunk:
  - keep existing tail behavior;
  - emit sanitized `stderr` event as before;
  - write sanitized chunk to `logSink.stderr`.
- [ ] When emitting a sanitized event to `input.onEvent`, also write it to `logSink.debugEvent`.
- [ ] Log sink errors must not crash the run. Convert sync throw from log sink into a sanitized `stderr` debug event and continue.
- [ ] Keep stdin EPIPE, spawn error, inactivity timeout, cancel SIGTERM/SIGKILL behavior unchanged.
- [ ] Write tests:
  - stdout/stderr chunks are sent to log sink;
  - debug events are sent to log sink after sanitization;
  - log sink throw does not fail an otherwise successful run;
  - inactivity timeout still works with log sink present;
  - cancel still schedules SIGKILL fallback with log sink present.
- [ ] Run:

```bash
pnpm exec vitest run src/core/__tests__/cli-runner.test.ts
```

Expected: cli-runner tests pass.

**Acceptance:** CLI raw output can be persisted without changing runner terminal semantics.

### Task 6: Run Service Queue Integration

**Files:**

- Modify: `src/core/run-service.ts`
- Test: `src/core/__tests__/run-service.test.ts`
- Modify: `src/core/run-types.ts`
- Test: `src/core/__tests__/run-types.test.ts`

- [ ] Add `RUN_QUEUE_FULL` route behavior if not already covered by tests: `429`.
- [ ] Extend `RunState` with:

```ts
queueStatus: 'queued' | 'starting' | 'running' | 'finishing' | 'terminal';
sequence: number;
runTimeoutTimer: unknown;
logHandle: RunLogHandle | null;
```

- [ ] Replace `scheduleStart(state)` with `scheduleDispatch()`.
- [ ] `createRun()` flow:
  - validate profile/model/workspace/skill/artifact rule ids;
  - calculate whether the new run can start immediately from current states;
  - if it cannot start and current queued count is `>= server.maxQueueSize`, throw `RUN_QUEUE_FULL` 429 before inserting rows;
  - insert queued rows atomically;
  - add state with `queueStatus='queued'`;
  - emit queued status;
  - call `scheduleDispatch()`;
  - return `202 { runId, status: "queued" }`.
- [ ] `dispatch()` flow:
  - call `selectDispatchableCandidates()`;
  - for each selected queued state, set `queueStatus='starting'`;
  - call `startRun(state)` asynchronously;
  - do not start the same state twice if dispatch runs again before the timer fires.
- [ ] `startRun()` flow:
  - skip if terminal/canceled;
  - update DB to `running`;
  - set `queueStatus='running'`;
  - create message accumulator;
  - open run logs and write `run_logs` row;
  - start total run timeout timer using `profile.runTimeoutMs`;
  - continue existing skill staging, capability probe, prompt composition, and runner factory flow;
  - after every awaited pre-spawn step, re-check terminal/canceled.
- [ ] `finishRun()` flow:
  - clear total timeout timer;
  - set `queueStatus='finishing'` during artifact/log finalization;
  - close log handle after terminal flush;
  - set `queueStatus='terminal'`;
  - schedule TTL cleanup as before;
  - call `scheduleDispatch()` so queued runs can start.
- [ ] `cancelRun()` flow:
  - terminal and finishing runs return `RUN_NOT_CANCELABLE` 409;
  - queued or starting run with no child finishes as `canceled` and never spawns;
  - queued cancel must persist the assistant message terminal state through repository updates because the message accumulator is only created inside `startRun()`;
  - running run calls child cancel and finishes through runner completion unless timeout already terminalized it;
  - canceling a queued run calls `scheduleDispatch()` so later eligible runs are not blocked.
- [ ] Write tests:
  - `globalConcurrency=1`: second run in another workspace remains queued until first terminal;
  - `profileConcurrency=1`: second same-profile run queues even if global has capacity;
  - different profiles can run concurrently when global has capacity;
  - same workspace second run queues even when global/profile capacity is available;
  - first queued blocked by workspace does not prevent later eligible workspace from starting;
  - `maxQueueSize=0` rejects a waiting run with `RUN_QUEUE_FULL` and no run row;
  - `maxQueueSize=1` accepts one waiting run and rejects the next waiting run;
  - queued cancel marks run and assistant message `canceled` and never calls runner factory;
  - after canceling queued run, next eligible queued run starts;
  - Phase 2 generate/staging/artifact tests still pass under scheduler.
- [ ] Run:

```bash
pnpm exec vitest run src/core/__tests__/run-service.test.ts src/core/__tests__/run-types.test.ts
```

Expected: run-service and run-types tests pass.

**Acceptance:** Queue/concurrency replaces same-workspace rejection while preserving durable queued rows.

### Task 7: Total Run Timeout

**Files:**

- Modify: `src/core/run-service.ts`
- Test: `src/core/__tests__/run-service.test.ts`

- [ ] Treat total run timeout as a new daemon design requirement. lanceDesign only provides an inactivity watchdog reference; do not copy or reinterpret the lanceDesign watchdog as total wall-clock timeout.
- [ ] Start the total timeout only after DB status changes to `running`.
- [ ] Timeout action:
  - emit error event `{ type: "error", code: "RUN_TIMEOUT", message: "Run exceeded total timeout." }`;
  - call `state.runner.cancel()` if a child has started;
  - terminalize the run as `failed` with `RUN_TIMEOUT`;
  - skip artifact scan on timeout;
  - force-flush assistant message with `runStatus='failed'`;
  - close logs;
  - dispatch next queued run.
- [ ] Queued wait time must not count against `profile.runTimeoutMs`.
- [ ] If timeout fires during pre-spawn async skill/capability work, terminalize as `RUN_TIMEOUT` and do not spawn later.
- [ ] If runner completes before timeout, clear timeout timer and do not emit timeout error.
- [ ] If cancel completes before timeout, clear timeout timer and do not emit timeout error.
- [ ] Write tests:
  - running fake runner that never completes fails with `RUN_TIMEOUT`;
  - runner cancel function is called on timeout;
  - queued run waits longer than `runTimeoutMs`, then starts and only times out after running for `runTimeoutMs`;
  - completion before timeout succeeds;
  - user cancel before timeout returns `canceled`, not `RUN_TIMEOUT`;
  - timeout before capability probe resolves prevents runner factory call.
- [ ] Run:

```bash
pnpm exec vitest run src/core/__tests__/run-service.test.ts
```

Expected: timeout tests pass.

**Acceptance:** `runTimeoutMs` is enforced separately from inactivity watchdog.

### Task 8: Logs HTTP Route

**Files:**

- Create: `src/http/logs-routes.ts`
- Create: `src/http/__tests__/logs-routes.test.ts`
- Modify: `src/http/app.ts`
- Modify: `src/index.ts`

- [ ] Add route:

```text
GET /api/runs/:runId/logs
```

- [ ] Response shape:

```json
{
  "runId": "run_123",
  "logs": {
    "stdout": { "available": true, "size": 1234, "tail": "..." },
    "stderr": { "available": true, "size": 234, "tail": "..." },
    "debugEvents": { "available": true, "size": 3456, "tail": "{...}\n" }
  }
}
```

- [ ] Route behavior:
  - missing API key returns `401`;
  - `canReadLogs=false` returns `403 FORBIDDEN`;
  - cross-client run returns `404 NOT_FOUND`;
  - missing log files return `available:false`, not 500;
  - response contains no absolute paths.
- [ ] Wire route before `/api/runs` generic router:

```ts
app.use('/api/runs/:runId/logs', createLogsRouter(...));
```

- [ ] Update `createApp()` dependencies to accept `runLogService`.
- [ ] Update `createServerContext()` to construct and pass `runLogService`.
- [ ] Write route tests with in-memory DB and temporary dataDir:
  - auth required;
  - authorized client gets tails;
  - unauthorized logs permission denied;
  - other client cannot read;
  - tails are sanitized and do not include `sandboxRoot`, `CLAUDE_CONFIG_DIR`, or token-like values.
- [ ] Run:

```bash
pnpm test -- src/http/__tests__/logs-routes.test.ts
```

Expected: logs route tests pass. Use escalated execution if local HTTP listener needs it.

**Acceptance:** The last missing first-version API route is wired with authorization.

### Task 9: Graceful Shutdown Hardening

**Files:**

- Modify: `src/core/run-service.ts`
- Test: `src/core/__tests__/run-service.test.ts`
- Modify: `src/index.ts`
- Test: `src/__tests__/index.test.ts`

- [ ] Extend `RunService`:

```ts
shutdownActive(input?: { graceMs?: number }): Promise<{ interrupted: number }>;
```

- [ ] `shutdownActive()` behavior:
  - queued runs finish as `interrupted` without spawning;
  - starting/running runs call child cancel;
  - wait up to `graceMs` for fake/real runner completion if practical;
  - if not completed, mark run `interrupted` and rely on runner cancel SIGKILL fallback;
  - force-flush messages;
  - close log handles;
  - clear queued dispatch timers and run timeout timers;
  - no artifact scan on shutdown interruption.
- [ ] Use existing error code unless a new code is explicitly added:

```text
RUN_INTERRUPTED_BY_DAEMON_RESTART
```

Message can be `"Run interrupted by daemon shutdown"`.

- [ ] `startServer()` should register `SIGINT` and `SIGTERM` handlers:
  - stop accepting HTTP connections with `server.close()`;
  - await `context.runService.shutdownActive({ graceMs: max profile cancelGraceMs })`;
  - close SQLite database after shutdown completes;
  - set `process.exitCode = 0` for normal signal shutdown;
  - do not call `process.exit()` directly in tests.
- [ ] Keep startup behavior unchanged: old persisted `queued/running` rows are still marked interrupted before service starts.
- [ ] Write tests:
  - `shutdownActive()` interrupts queued run and it never spawns;
  - `shutdownActive()` cancels running fake runner;
  - shutdown clears run timeout timer;
  - shutdown closes log handles;
  - `createServerContext()` still marks old persisted queued/running rows interrupted on startup;
  - signal handler registration can be injected/tested without killing the test process.
- [ ] Run:

```bash
pnpm exec vitest run src/core/__tests__/run-service.test.ts src/__tests__/index.test.ts
```

Expected: shutdown tests pass.

**Acceptance:** The daemon can stop without orphaning in-memory queued/running state or child processes.

### Task 10: Full Regression And Scope Guard

**Files:**

- Modify tests only if failures expose real regressions.

- [ ] Run:

```bash
pnpm typecheck
pnpm build
pnpm test
git diff --check
```

- [ ] Run scope guard:

```bash
rg -n "run_events|chokidar|multer|prom-client|undici|fetch\\(|S3|signed URL|upload|metrics|seccomp|firejail|container" src
```

Expected:

- No `run_events` table or runtime code.
- No new watcher/upload/remote/metrics/OS-isolation code.
- Existing `multer`, `prom-client`, `undici`, `chokidar` may still appear only in `package.json` if already present; do not wire them in `src`.

- [ ] Run import guard:

```bash
rg -n "/home/orangels/ls_dev/lanceDesign|apps/daemon/src|from ['\\\"].*lanceDesign" src
```

Expected: no source imports from lanceDesign.

- [ ] Commit:

```bash
git add src docs
git commit -m "feat: implement phase 3 queue timeout hardening"
```

**Acceptance:** Phase 3 implementation is verified and ready for CC review.

## Explicit Non-Goals For Phase 3

Do not implement:

- OS-level isolation, separate uid, containers, seccomp/firejail, or Claude permission hooks.
- Upload API, remote URL pull, S3/object-storage pull, signed artifact/log URLs.
- Browser direct CORS or user-level browser auth.
- Metrics exposure or `prom-client` instrumentation.
- Persistent event replay from SQLite or a `run_events` table.
- Profile hot reload.
- Workspace deletion API or artifact retention jobs.
- Full distributed queue across multiple daemon processes.
- Recovery/resume of already-started Claude child processes after daemon restart.
- Claude Code native resume/fork.
- Product-specific lanceDesign logic such as craft, critique, analytics, preview comments, design systems, routines, local-client runtime, or `LANCE_DESIGN_*`.

## Phase 3 Acceptance Criteria

- Queue:
  - `globalConcurrency`, `profileConcurrency`, per-workspace serial execution, and `maxQueueSize` are enforced.
  - Waiting runs remain durable `queued` rows.
  - Queue full returns `429 RUN_QUEUE_FULL` before row insert.
  - Queued cancel is terminal, durable, and never later spawns.
- Timeout:
  - `runTimeoutMs` produces `RUN_TIMEOUT`.
  - `inactivityTimeoutMs` still produces `RUN_INACTIVITY_TIMEOUT`.
  - Timeout/cancel/shutdown clear timers and do not double-finish.
- Logs:
  - `run_logs` rows are written with dataDir-relative paths.
  - `GET /api/runs/:runId/logs` is authorized by `canReadLogs`.
  - Log API responses contain no sandbox absolute paths or credentials.
  - Retention pruning touches only daemon log files and `run_logs`, not workspaces/artifacts/messages.
- Shutdown:
  - `shutdownActive()` interrupts queued/running states and cancels child processes.
  - Startup interruption behavior for persisted old runs remains unchanged.
- Boundaries:
  - No lanceDesign imports.
  - No `run_events` table.
  - No watcher/upload/remote/metrics/OS-isolation scope creep.

## Suggested Review Prompt After Plan

```text
请 review 当前仓库 /home/orangels/ls_dev/lance-agent-runner-daemon 的 Phase 3 计划文档。

计划文件：
docs/phase-3-queue-timeout-hardening-plan.md

请三向交叉：
1. docs/claude-code-runner-daemon-design.md
2. docs/claude-code-runner-daemon-migration-assessment.md
3. 参考仓库 /home/orangels/ls_dev/lanceDesign 的 runs.ts / server.ts / Claude Code CLI pipeline

重点检查：
- Phase 3 是否准确覆盖 queue / timeout / hardening / log retention。
- 是否仍保持 standalone daemon，不 import lanceDesign 私有源码。
- queue 语义是否符合：globalConcurrency、profileConcurrency、per-workspace serial、maxQueueSize、queued durable rows。
- 是否应移除 Phase 2 的 same-workspace active-run repository rejection。
- queued cancel、timeout、shutdown 的 terminal/message flush 设计是否完整。
- run_logs / GET /api/runs/:runId/logs 是否符合 canReadLogs 和不暴露绝对路径要求。
- logRetentionMs/maxLogBytesPerRun 作为新增 server config 是否合理，还是应改为硬编码或延后。
- 是否有 scope creep：metrics、upload、remote pull、OS isolation、run_events、distributed queue 等。

请按 Critical / Important / Minor 输出 review 结论，并明确是否建议进入实现。
```
