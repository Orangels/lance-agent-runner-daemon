# Runtime Reliability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound terminal run-log finalization so daemon terminal status, webhook terminal delivery creation, and SSE `end` cannot wait indefinitely on slow or stuck log storage.

**Architecture:** Keep artifact finalization before terminal status. Add a small run-service helper that closes the per-run log handle with a configurable timeout using the existing `RunServiceTimer` seam. A close failure or timeout emits a durable `warning` event before the terminal `end` event, logs through `DaemonLogger.warn`, and never changes the terminal run status.

**Tech Stack:** TypeScript ESM, Vitest, PostgreSQL-backed test harness, existing in-memory timer seam, existing `RunEvent` warning payload.

---

## Current Behavior

- `finishRun()` finalizes artifacts, then awaits `state.logHandle.close()`, then emits terminal `end`, flushes the accumulator, and persists `runs.status`.
- A rejected `close()` already emits `RUN_LOG_WRITE_FAILED` before `end`.
- A never-settling or very slow `close()` can currently block terminal persistence, SSE completion, and terminal webhook delivery creation.
- `shutdownActive()` already cancels active runners and waits up to its own `graceMs` for runner completion after marking runs interrupted.
- The CLI runner may still emit output around cancellation. Events emitted after terminal persistence should not be appended after `end`.

## Semantics To Preserve Or Define

- `succeeded`: artifact finalization remains first. Log close success/failure/timeout happens after artifact events and before `end`.
- `canceled`: when the runner eventually resolves as `canceled`, final status remains `canceled`; close failure or timeout only adds a warning.
- `failed` from run timeout: timeout emits `RUN_TIMEOUT`, cancels the runner, and persists `failed` with `errorCode='RUN_TIMEOUT'`; close failure or timeout only adds a warning.
- `interrupted`: shutdown marks active or queued work as `interrupted` with `RUN_INTERRUPTED_BY_DAEMON_RESTART`; close failure or timeout only adds a warning.
- Late runner events after terminal completion are ignored so `end` remains the last persisted run event.
- Late file writes through an already captured log sink are best-effort after close timeout. They must not block daemon terminal persistence.

## New Config

Add `server.runLogCloseTimeoutMs`.

- Type: integer milliseconds.
- Default: `5000`.
- Minimum: `0`.
- `0` means do not wait for log close at terminal; emit a timeout warning immediately if the close promise has not already settled.
- This timeout is independent from profile `cancelGraceMs`, profile `runTimeoutMs`, and webhook timeouts.

## Files

- Modify: `apps/daemon/src/config/profiles.ts`
  - Add `ServerConfig.runLogCloseTimeoutMs`.
  - Add strict schema default.
- Modify: `.claude-runner/config.local.json`
  - Add local explicit value near log settings.
- Modify: `apps/daemon/src/core/run-service.ts`
  - Add `RunLogCloseTimeoutError`.
  - Add `closeRunLogHandleWithTimeout()` and a timer-backed `withTimeout()` helper.
  - Guard `emitRunEvent()` so non-terminal late events are ignored after `state.terminal`.
- Modify: `apps/daemon/tests/config/profiles.test.ts`
  - Assert default and explicit parsing.
- Modify: `apps/daemon/tests/core/run-service.test.ts`
  - Add close success, close timeout, canceled, timeout failed, interrupted, and late-event regression tests.
- Modify: `docs/configuration-reference.md`
  - Document `server.runLogCloseTimeoutMs`.
- Modify as needed: `docs/api-reference.md`, `docs/business-run-chat-integration-guide.md`, `docs/business-agent-adapter-handoff.md`
  - Only if warning behavior needs clearer client guidance.
- Modify: `docs/landing-test-roadmap-hardening/checklist.md`
  - Mark completed items as they land.

## Task 1: Config And Documentation Baseline

- [x] **Step 1: Write failing config assertions**

In `apps/daemon/tests/config/profiles.test.ts`, extend the default server assertions:

```ts
expect(config.server.runLogCloseTimeoutMs).toBe(5000);
```

Extend the explicit server override test with:

```ts
runLogCloseTimeoutMs: 250,
```

and assert:

```ts
expect(config.server.runLogCloseTimeoutMs).toBe(250);
```

- [x] **Step 2: Run config tests and verify red**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run tests/config/profiles.test.ts
```

Expected before implementation: TypeScript compile or assertion failure because `runLogCloseTimeoutMs` is not yet part of `ServerConfig`.

- [x] **Step 3: Add config implementation**

In `apps/daemon/src/config/profiles.ts`:

```ts
export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  globalConcurrency: number;
  maxQueueSize: number;
  logRetentionMs: number;
  maxLogBytesPerRun: number;
  runLogCloseTimeoutMs: number;
  maxReviewBundleBytes: number;
  maxUploadBytesPerFile: number;
  uploadTempRetentionMs: number;
  persistence: PersistenceConfig;
  webhooks: WebhookConfig;
}
```

Add the schema default directly after `maxLogBytesPerRun`:

```ts
runLogCloseTimeoutMs: z.number().int().min(0).default(5000),
```

- [x] **Step 4: Update local config and docs**

Add to `.claude-runner/config.local.json` near `maxLogBytesPerRun`:

```json
"runLogCloseTimeoutMs": 5000
```

Add `docs/configuration-reference.md` section:

```md
### `server.runLogCloseTimeoutMs`

Maximum milliseconds the daemon waits for per-run stdout, stderr, and debug event log writers to flush during terminal run finalization.

If the timeout is reached, the daemon emits a durable `warning` run event with `code: "RUN_LOG_WRITE_TIMEOUT"` and continues terminal status persistence, SSE `end`, and terminal webhook delivery creation. The terminal run status is not changed. Set to `0` to avoid waiting for log close at terminal.
```

- [x] **Step 5: Run config tests and verify green**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run tests/config/profiles.test.ts
```

Expected: pass.

## Task 2: Bounded Run Log Close

- [x] **Step 1: Write a failing close timeout regression test**

In `apps/daemon/tests/core/run-service.test.ts`, add a test near the existing close failure test:

```ts
it('persists a run log close timeout warning before terminal end without changing final status', async () => {
  const daemonLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(async () => {}),
  };
  const closeDeferred = createDeferred<void>();
  const close = vi.fn(() => closeDeferred.promise);
  const runLogService = {
    dataDir: '',
    openRunLogs: vi.fn(async () => ({
      stdout: vi.fn(),
      stderr: vi.fn(),
      debugEvent: vi.fn(),
      close,
    })),
    getRunLogs: vi.fn(),
    getRunLogDownload: vi.fn(),
    pruneExpiredLogs: vi.fn(),
  } satisfies RunLogService;
  const { root, config, persistence, workspace, workspaceCwd, service, runners, runNextTimer } = await setup({
    daemonLogger,
    runLogService,
    configure: (config) => {
      config.server.runLogCloseTimeoutMs = 25;
    },
  });
  writeSkill(root);

  await service.createRun({
    client: config.clients[0]!,
    request: {
      profileId: 'report-docx',
      workspaceId: workspace.id,
      kind: 'generate',
      prompt: 'Write the report.',
      skillId: 'report-writer',
    },
  });
  await runScheduledStart(runNextTimer);
  await waitForRunnerCount(runners, 1);
  writeFileSync(path.join(workspaceCwd, 'output', 'report.docx'), 'docx');

  runners[0]!.complete({
    status: 'succeeded',
    exitCode: 0,
    signal: null,
    stdoutTail: '',
    stderrTail: '',
  });
  await flushAsync();

  expect(close).toHaveBeenCalledTimes(1);
  expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.status).toBe('running');

  runNextTimer();
  await vi.waitFor(async () => {
    expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.status).toBe('succeeded');
  });

  const detail = await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' });
  const events = detail?.messages[1]?.events as Array<{ type: string; code?: string }>;
  const eventTypes = events.map((event) => event.type);
  expect(eventTypes).toEqual(expect.arrayContaining(['artifact_finalized', 'warning', 'end']));
  expect(eventTypes.indexOf('artifact_finalized')).toBeLessThan(eventTypes.indexOf('warning'));
  expect(eventTypes.indexOf('warning')).toBeLessThan(eventTypes.indexOf('end'));
  expect(events).toContainEqual(expect.objectContaining({ type: 'warning', code: 'RUN_LOG_WRITE_TIMEOUT' }));
  expect(daemonLogger.warn).toHaveBeenCalledWith('run_log_write_timeout', {
    runId: 'run_1',
    timeoutMs: 25,
  });
});
```

- [x] **Step 2: Run the focused test and verify red**

Run:

```bash
set -a; source .env; set +a; pnpm --filter @lance-agent-runner/daemon exec vitest run tests/core/run-service.test.ts -t "run log close timeout"
```

Expected before implementation: test fails because no close timeout timer is scheduled and the run stays non-terminal.

- [x] **Step 3: Implement timer-backed close timeout**

In `apps/daemon/src/core/run-service.ts`, add:

```ts
class RunLogCloseTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super('Run log close timed out.');
    this.name = 'RunLogCloseTimeoutError';
  }
}

function isRunLogCloseTimeoutError(error: unknown): error is RunLogCloseTimeoutError {
  return error instanceof RunLogCloseTimeoutError;
}
```

Inside `createRunService()`, add:

```ts
async function closeRunLogHandle(state: RunState): Promise<void> {
  if (!state.logHandle) return;
  const timeoutMs = input.config.server.runLogCloseTimeoutMs;
  try {
    await withRunServiceTimeout(state.logHandle.close(), timeoutMs, () => new RunLogCloseTimeoutError(timeoutMs));
  } catch (error) {
    if (isRunLogCloseTimeoutError(error)) {
      daemonLogger.warn('run_log_write_timeout', {
        runId: state.runId,
        timeoutMs: error.timeoutMs,
      });
      emitRunEvent(state, {
        type: 'warning',
        code: 'RUN_LOG_WRITE_TIMEOUT',
        message: 'Run log write timed out.',
        details: { timeoutMs: error.timeoutMs },
      });
    } else {
      daemonLogger.warn('run_log_write_failed', {
        error,
        runId: state.runId,
      });
      emitRunEvent(state, {
        type: 'warning',
        code: 'RUN_LOG_WRITE_FAILED',
        message: 'Run log write failed.',
      });
    }
  } finally {
    state.logHandle = null;
  }
}

function withRunServiceTimeout<T>(promise: Promise<T>, timeoutMs: number, createError: () => Error): Promise<T> {
  if (timeoutMs < 0) {
    return promise;
  }

  let timeoutId: unknown = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = timer.setTimeout(() => {
      timeoutId = null;
      reject(createError());
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== null) {
      timer.clearTimeout(timeoutId);
      timeoutId = null;
    }
  });
}
```

Replace the existing `if (state.logHandle) { ... }` close block in `finishRun()` with:

```ts
await closeRunLogHandle(state);
```

- [x] **Step 4: Run timeout test and existing failure test**

Run:

```bash
set -a; source .env; set +a; pnpm --filter @lance-agent-runner/daemon exec vitest run tests/core/run-service.test.ts -t "run log close"
```

Expected: close failure and close timeout tests pass.

## Task 3: Terminal Event Ordering And Late Runner Events

- [x] **Step 1: Write close success and late-event regression tests**

Add tests in `apps/daemon/tests/core/run-service.test.ts`:

```ts
it('persists terminal end after successful run log close without a warning', async () => {
  const close = vi.fn(async () => {});
  const runLogService = {
    dataDir: '',
    openRunLogs: vi.fn(async () => ({
      stdout: vi.fn(),
      stderr: vi.fn(),
      debugEvent: vi.fn(),
      close,
    })),
    getRunLogs: vi.fn(),
    getRunLogDownload: vi.fn(),
    pruneExpiredLogs: vi.fn(),
  } satisfies RunLogService;
  const { config, persistence, workspace, service, runners, runNextTimer } = await setup({ runLogService });

  await service.createRun({
    client: config.clients[0]!,
    request: {
      profileId: 'report-docx',
      workspaceId: workspace.id,
      kind: 'revise',
      prompt: 'Run.',
      artifactRuleIds: [],
    },
  });
  await runScheduledStart(runNextTimer);
  await waitForRunnerCount(runners, 1);
  runners[0]!.complete({ status: 'succeeded', exitCode: 0, signal: null, stdoutTail: '', stderrTail: '' });

  await vi.waitFor(async () => {
    expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.status).toBe('succeeded');
  });

  const events = (await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.messages[1]?.events as Array<{ type: string }>;
  expect(close).toHaveBeenCalledTimes(1);
  expect(events.map((event) => event.type)).toContain('end');
  expect(events.map((event) => event.type)).not.toContain('warning');
});

it('ignores runner events emitted after terminal end is persisted', async () => {
  const { config, persistence, workspace, service, runners, runNextTimer } = await setup();
  await service.createRun({
    client: config.clients[0]!,
    request: {
      profileId: 'report-docx',
      workspaceId: workspace.id,
      kind: 'revise',
      prompt: 'Run.',
      artifactRuleIds: [],
    },
  });
  await runScheduledStart(runNextTimer);
  await waitForRunnerCount(runners, 1);
  runners[0]!.complete({ status: 'succeeded', exitCode: 0, signal: null, stdoutTail: '', stderrTail: '' });

  await vi.waitFor(async () => {
    expect((await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.run.status).toBe('succeeded');
  });
  runners[0]!.input.onEvent({ type: 'stderr', text: 'late output after terminal' });
  await flushAsync();

  const events = (await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' }))?.messages[1]?.events as Array<{ type: string; text?: string }>;
  expect(events.at(-1)).toMatchObject({ type: 'end' });
  expect(events).not.toContainEqual(expect.objectContaining({ type: 'stderr', text: 'late output after terminal' }));
});
```

- [x] **Step 2: Verify late-event test fails before implementation**

Run:

```bash
set -a; source .env; set +a; pnpm --filter @lance-agent-runner/daemon exec vitest run tests/core/run-service.test.ts -t "late runner events"
```

Expected before implementation: fails because `emitRunEvent()` currently appends after terminal.

- [x] **Step 3: Guard event emission after terminal**

In `emitRunEvent()`:

```ts
function emitRunEvent(state: RunState, event: RunEvent): BufferedRunEvent | null {
  if (state.terminal) {
    return null;
  }
  const record = { id: formatRunEventId(state.nextEventId++), event };
  // existing body
  return record;
}
```

No caller currently requires a non-null return value.

- [x] **Step 4: Run ordering tests**

Run:

```bash
set -a; source .env; set +a; pnpm --filter @lance-agent-runner/daemon exec vitest run tests/core/run-service.test.ts -t "terminal end|late runner events|run log close"
```

Expected: pass.

## Task 4: Canceled, Timeout, And Interrupted Coverage

- [x] **Step 1: Extend canceled test to assert close timeout does not change status**

Add a focused canceled test with a pending close and `runLogCloseTimeoutMs = 25`; after cancel, complete the runner as `canceled`, fire the timeout timer, and assert:

```ts
expect(detail?.run.status).toBe('canceled');
expect(detail?.messages[1]?.runStatus).toBe('canceled');
expect(events).toContainEqual(expect.objectContaining({ type: 'warning', code: 'RUN_LOG_WRITE_TIMEOUT' }));
expect(events.at(-1)).toMatchObject({ type: 'end', status: 'canceled' });
```

- [x] **Step 2: Extend timeout failed test to assert warning does not change errorCode**

Use a pending close and `runLogCloseTimeoutMs = 25`; trigger profile run timeout first, then trigger log close timeout. Assert:

```ts
expect(detail?.run).toMatchObject({ status: 'failed', errorCode: 'RUN_TIMEOUT' });
expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'RUN_TIMEOUT' }));
expect(events).toContainEqual(expect.objectContaining({ type: 'warning', code: 'RUN_LOG_WRITE_TIMEOUT' }));
expect(events.at(-1)).toMatchObject({ type: 'end', status: 'failed' });
```

- [x] **Step 3: Extend interrupted shutdown test to assert warning does not change errorCode**

Use a pending close and `runLogCloseTimeoutMs = 25`; start a run, call `shutdownActive({ graceMs: 0 })`, trigger log close timeout, and assert:

```ts
expect(detail?.run).toMatchObject({
  status: 'interrupted',
  errorCode: 'RUN_INTERRUPTED_BY_DAEMON_RESTART',
});
expect(events).toContainEqual(expect.objectContaining({ type: 'warning', code: 'RUN_LOG_WRITE_TIMEOUT' }));
expect(events.at(-1)).toMatchObject({ type: 'end', status: 'interrupted' });
```

- [x] **Step 4: Run focused terminal status tests**

Run:

```bash
set -a; source .env; set +a; pnpm --filter @lance-agent-runner/daemon exec vitest run tests/core/run-service.test.ts -t "canceled|RUN_TIMEOUT|interrupted|run log close timeout"
```

Expected: pass.

## Task 5: Docs, Checklist, And Verification

- [x] **Step 1: Update externally visible docs**

Update:

- `docs/api-reference.md`: mention `warning` run events may include `RUN_LOG_WRITE_FAILED` and `RUN_LOG_WRITE_TIMEOUT`; clients should ignore unknown warning codes.
- `docs/business-run-chat-integration-guide.md`: explain that terminal status remains authoritative even if a warning exists.
- `docs/business-agent-adapter-handoff.md`: recommend logging warning events for diagnostics but not treating them as task failure.

- [x] **Step 2: Update checklist**

In `docs/landing-test-roadmap-hardening/checklist.md`, mark completed runtime hardening rows only after tests pass.

- [x] **Step 3: Run verification**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon typecheck
pnpm --filter @lance-agent-runner/daemon exec vitest run tests/config/profiles.test.ts
set -a; source .env; set +a; pnpm --filter @lance-agent-runner/daemon exec vitest run tests/core/run-service.test.ts
pnpm build
```

- [x] **Step 4: Commit**

```bash
git add .claude-runner/config.local.json apps/daemon/src/config/profiles.ts apps/daemon/src/core/run-service.ts apps/daemon/tests/config/profiles.test.ts apps/daemon/tests/core/run-service.test.ts docs/api-reference.md docs/business-agent-adapter-handoff.md docs/business-run-chat-integration-guide.md docs/configuration-reference.md docs/landing-test-roadmap-hardening/checklist.md docs/landing-test-roadmap-hardening/runtime-reliability-hardening-plan.md
git commit -m "fix: bound terminal run log close"
```
