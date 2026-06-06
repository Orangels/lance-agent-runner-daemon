# RPA Runtime Verification UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first reusable RPA Web runtime verification workbench inside the existing `Executions` tab.

**Architecture:** Keep this slice inside `apps/rpa-local-web`. The UI manually accepts a `flowId`, reads the flow DSL from RPA Web storage, starts verify/run through the existing local executor APIs, subscribes to SSE, and renders status, steps, screenshot, logs, and artifacts. It does not start codegen, call natural-language generation, or add daemon-side RPA semantics.

**Tech Stack:** React 19, TypeScript ESM, Express 5, native `EventSource`, existing RPA DSL/executor contracts, Vitest, Testing Library.

---

## Scope Boundary

This slice includes:

- Embedded `Executions` tab workbench, not a standalone execution detail page.
- Manual `flowId` input for MVP verification before codegen/natural-language workflows are wired.
- Start/cancel execution controls for `verify` and `run`.
- Runtime defaults:
  - `verify`: `dryRun=true`, `headless=false`.
  - `run`: `dryRun=false`, `headless=true`.
- Flow DSL loading from RPA Web-owned flow storage so the UI can render steps.
- SSE event subscription for execution progress.
- Client-side SSE dedupe by event `sequence`, because browser `EventSource` can reconnect and the backend replays history.
- Current screenshot display using `/screenshots/current`.
- Logs and artifacts display using existing executor APIs.
- Component tests and API client tests.

This slice does not include:

- Playwright codegen recording UI.
- Natural-language script generation UI.
- Question-form handling.
- Execution history or standalone route such as `/executions/:executionId`.
- noVNC, remote browser control, or trace viewer.
- Full parameter form generation. The first UI accepts optional params as JSON text.
- Any RPA DSL or Playwright logic inside `apps/daemon`.

## Current Context

Completed prerequisites:

- RPA workspace skeleton exists.
- RPA DSL/artifact contract exists.
- RPA local executor backend exists with:
  - `POST /api/rpa/executions`
  - `GET /api/rpa/executions/:executionId`
  - `POST /api/rpa/executions/:executionId/cancel`
  - `GET /api/rpa/executions/:executionId/events`
  - `GET /api/rpa/executions/:executionId/logs`
  - `GET /api/rpa/executions/:executionId/screenshots/current`
  - `GET /api/rpa/executions/:executionId/artifacts`
  - `GET /api/rpa/executions/:executionId/artifacts/:artifactId/download`

Current gaps:

- Browser API client only covers health/config.
- Browser does not know execution event types.
- Browser has no route for reading a flow DSL by `flowId`.
- `Executions` tab is still skeleton placeholder content.
- Executor reads flows from `<storageRoot>/flows/<flowId>`, so any flow route must use the same flows root.

## UX Shape

The first UI is a dense workbench inside the existing app shell.

```text
Executions tab
┌────────────────────────────────────────────────────────────────────┐
│ flowId [case_query        ] mode [verify/run] dryRun headless Start │
├──────────────────────┬─────────────────────────┬───────────────────┤
│ Step list             │ Screenshot               │ Logs / Artifacts  │
│ - s1 open query       │ current screenshot        │ SSE events        │
│ - s2 input case       │ empty/error/loading state │ stdout/stderr     │
│ - s3 download         │ bbox highlight reserved   │ artifact links    │
└──────────────────────┴─────────────────────────┴───────────────────┘
```

Responsive behavior:

- Desktop: control bar, then a three-column grid.
- Tablet/mobile: stack step list, screenshot, logs/artifacts vertically.
- Text must not overflow controls; long flow ids and file names wrap or truncate inside their container.

## Data Flow

```text
User enters flowId
  -> UI calls GET /api/rpa/flows/:flowId
  -> UI renders DSL steps and params summary

User starts verify/run
  -> UI calls POST /api/rpa/executions
  -> UI receives executionId
  -> UI opens EventSource /api/rpa/executions/:executionId/events
  -> UI updates run status, step state, event list, and screenshot URL
  -> UI refreshes logs/artifacts after log/artifact/terminal events

User cancels
  -> UI calls POST /api/rpa/executions/:executionId/cancel
  -> UI leaves stream open until run.completed or shows cancellation error
```

## Event Handling Rules

- `run.started`: mark run running.
- `log`: append event line and schedule logs refresh.
- `step.started`: mark that step running.
- `step.screenshot`: refresh current screenshot URL and mark screenshot timestamp.
- `step.completed`: mark that step succeeded.
- `step.failed`: mark that step failed and set failed step id.
- `artifact.created`: append event, schedule artifacts refresh, refresh screenshot when role is `screenshot`.
- `run.completed`: mark terminal status, refresh status/logs/artifacts, close stream.

When a generated script does not emit step events yet, the step list stays pending and the run-level status/logs/artifacts still update.

In the current executor, fake/generated scripts only produce `run.started`, `log`, `artifact.created`, and `run.completed` unless the script itself emits step events in a later slice. `failedStepId` and step-specific states are therefore forward-compatible display paths in this UI slice, not proof that step events already exist.

The current screenshot endpoint returns the latest screenshot artifact. Because the executor currently emits `artifact.created` after the script exits, RPA Web screenshot refresh is usually post-run for MVP fake scripts; real-time visual feedback during verify comes from the headed browser window.

## Files

Create:

- `apps/rpa-local-web/src/server/routes/flows.ts`
  - Reads `flow.dsl.json` from RPA Web flow storage.
  - Validates the DSL.
  - Returns safe flow metadata and browser-safe DSL.
- `apps/rpa-local-web/src/components/RuntimeVerificationWorkspace.tsx`
  - Orchestrates flow loading, execution start/cancel, SSE subscription, and panel state.
- `apps/rpa-local-web/src/components/ExecutionControlBar.tsx`
  - Manual `flowId`, mode, dryRun/headless, params JSON, start/cancel controls.
- `apps/rpa-local-web/src/components/StepList.tsx`
  - DSL step rendering and event-derived status.
- `apps/rpa-local-web/src/components/ScreenshotPanel.tsx`
  - Current screenshot image, empty/loading/error states, bbox highlight placeholder.
- `apps/rpa-local-web/src/components/ExecutionLogPanel.tsx`
  - Event list and stdout/stderr text.
- `apps/rpa-local-web/src/components/ArtifactPanel.tsx`
  - Artifact list and download links.

Modify:

- `apps/rpa-local-web/src/shared/rpa-api-types.ts`
  - Add shared execution event types for browser use.
  - Add flow detail response type.
- `apps/rpa-local-web/src/server/executor/execution-types.ts`
  - Import or re-export shared execution event types instead of owning browser-invisible duplicates.
- `apps/rpa-local-web/src/server/flow-store.ts`
  - Add shared flow-root/path helpers used by both executor and flow routes.
- `apps/rpa-local-web/src/server/server.ts`
  - Register flow route with storage root.
- `apps/rpa-local-web/src/api/rpa-api-client.ts`
  - Add flow, execution, logs, artifacts, screenshot URL, and SSE helpers.
- `apps/rpa-local-web/src/components/AppShell.tsx`
  - Render `RuntimeVerificationWorkspace` for the `executions` section.
- `apps/rpa-local-web/src/styles.css`
  - Replace placeholder-specific UI in the executions tab with workbench styles while preserving existing skeleton for other tabs.

Tests:

- `apps/rpa-local-web/tests/server/routes/flows.test.ts`
- `apps/rpa-local-web/tests/api/rpa-api-client.test.ts`
- `apps/rpa-local-web/tests/components/RuntimeVerificationWorkspace.test.tsx`
- `apps/rpa-local-web/tests/components/ExecutionControlBar.test.tsx`
- `apps/rpa-local-web/tests/components/StepList.test.tsx`
- `apps/rpa-local-web/tests/components/ScreenshotPanel.test.tsx`
- `apps/rpa-local-web/tests/components/ExecutionLogPanel.test.tsx`
- `apps/rpa-local-web/tests/components/ArtifactPanel.test.tsx`
- Update `apps/rpa-local-web/tests/App.test.tsx`

## Task 1: Shared Browser Contracts

**Files:**

- Modify: `apps/rpa-local-web/src/shared/rpa-api-types.ts`
- Modify: `apps/rpa-local-web/src/server/executor/execution-types.ts`
- Test: `apps/rpa-local-web/tests/shared/dsl-schema.test.ts` if shared type exports need compile coverage only.

- [ ] **Step 1: Add shared execution event types**

Add `RpaExecutionEventType` and `RpaExecutionEvent` to `rpa-api-types.ts` with fields that exactly match the current server executor event shape: `type`, `executionId`, `timestamp`, optional `stepId`, optional `stream`, optional `message`, optional `artifactId`, optional `role`, optional `relativePath`, optional `status`, optional `exitCode`, and optional `sequence`.

Expected event type union:

```ts
export type RpaExecutionEventType =
  | 'run.started'
  | 'step.started'
  | 'step.screenshot'
  | 'step.completed'
  | 'step.failed'
  | 'artifact.created'
  | 'run.completed'
  | 'log';
```

- [ ] **Step 2: Add flow detail response**

Add:

```ts
import type { RpaDslDocument } from './dsl-schema.js';

export interface RpaValidationIssueSummary {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
}

export interface RpaFlowDetailResponse {
  flowId: string;
  title: string;
  source: RpaDslDocument['meta']['source'];
  dsl: RpaDslDocument;
  warnings: RpaValidationIssueSummary[];
}
```

Do not import server-only validator types into `shared/`.

- [ ] **Step 3: Make executor event types use shared types**

In `execution-types.ts`, import `RpaExecutionEvent`, `RpaExecutionEventType`, `RpaExecutionMode`, and `RpaExecutionStatus` from shared types, then re-export where server tests already import from executor types.

- [ ] **Step 4: Verify typecheck**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web typecheck
```

Expected: PASS.

## Task 2: Shared Flow Root And Flow Detail Route

**Files:**

- Modify: `apps/rpa-local-web/src/server/flow-store.ts`
- Modify: `apps/rpa-local-web/src/server/executor/python-playwright-executor.ts`
- Create: `apps/rpa-local-web/src/server/routes/flows.ts`
- Modify: `apps/rpa-local-web/src/server/server.ts`
- Test: `apps/rpa-local-web/tests/server/routes/flows.test.ts`
- Test: `apps/rpa-local-web/tests/server/flow-store.test.ts`

- [ ] **Step 1: Write failing flow root tests**

Add tests for:

- `resolveFlowsRoot(storageRoot)` returns `<storageRoot>/flows`.
- `resolveFlowArtifactPath(resolveFlowsRoot(storageRoot), flowId, 'flow.dsl.json')` resolves below `<storageRoot>/flows/<flowId>`.
- `resolveFlowArtifactPath(resolveFlowsRoot(storageRoot), flowId, 'flow.dsl.json')` does not double-join `flows/flows`.
- unsafe `flowId` and unsupported artifact names are rejected.

- [ ] **Step 2: Implement shared flow root helper**

In `flow-store.ts`, add:

```ts
export function resolveFlowsRoot(storageRoot: string): string {
  return path.join(path.resolve(storageRoot), 'flows');
}
```

Keep `resolveFlowArtifactPath(flowsRoot, flowId, artifactName)` signature semantics unchanged: its first argument is already the resolved flows root, not the storage root.

Update `createPythonPlaywrightExecutor` to call `resolveFlowsRoot(storageRoot)` instead of independently constructing `path.join(storageRoot, 'flows')`, then keep passing that `flowsRoot` into the existing `loadFlow` / `resolveRequiredArtifactPath` path.

- [ ] **Step 3: Write failing route tests**

Cover:

- `GET /api/rpa/flows/:flowId` returns `flowId`, title, source, DSL steps, and warnings.
- missing flow returns structured `FLOW_ARTIFACT_MISSING` or `FLOW_NOT_FOUND`.
- invalid `flowId` returns structured `INVALID_FLOW_ID`.
- response does not contain `storageRoot`.
- response does not expose `dsl.context.storage_state` as an absolute path; return `"[configured]"` or omit it.

- [ ] **Step 4: Implement `registerFlowRoutes`**

Route behavior:

- Compute `const flowsRoot = resolveFlowsRoot(storageRoot)`.
- Read `flow.dsl.json` via `resolveFlowArtifactPath(flowsRoot, flowId, 'flow.dsl.json')`.
- Parse JSON.
- Run `validateRpaDsl`.
- If validation has errors, return `400` with `DSL_INVALID`.
- If valid, return `RpaFlowDetailResponse`.
- Convert validator warnings to `RpaValidationIssueSummary`.
- Return a browser-safe DSL copy where `context.storage_state`, if present, is replaced with `"[configured]"`.
- For MVP, only `context.storage_state` has a guaranteed redaction rule. Other custom `context` keys are returned as-is and must not contain secrets until a broader context redaction policy is added.
- Sanitize error messages so `storageRoot` is never returned to the browser.

- [ ] **Step 5: Register route**

In `server.ts`, call:

```ts
registerFlowRoutes(app, { storageRoot: input.config.storageRoot });
```

before static/Vite middleware.

- [ ] **Step 6: Verify route tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/flow-store.test.ts tests/server/routes/flows.test.ts
```

Expected: PASS. If sandbox blocks local ports, rerun outside sandbox with approval.

## Task 3: Browser API Client

**Files:**

- Modify: `apps/rpa-local-web/src/api/rpa-api-client.ts`
- Test: `apps/rpa-local-web/tests/api/rpa-api-client.test.ts`

- [ ] **Step 1: Write failing API client tests**

Cover:

- `getFlow(flowId)` calls `/api/rpa/flows/:flowId`.
- `startExecution(request)` posts JSON to `/api/rpa/executions`.
- `cancelExecution(executionId)` posts to cancel endpoint.
- `getExecutionStatus`, `getExecutionLogs`, `getExecutionArtifacts` read expected endpoints.
- `getCurrentScreenshotUrl(executionId, cacheKey)` returns a browser-safe URL string.
- `subscribeExecutionEvents(executionId, handlers)` wires all known SSE event names and returns an unsubscribe function.
- duplicate events with the same `sequence` are ignored, including after a simulated reconnect.

- [ ] **Step 2: Extend `RpaApiClientOptions`**

Add optional `eventSourceFactory`:

```ts
export interface RpaEventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export interface RpaApiClientOptions {
  fetchImpl?: FetchLike;
  eventSourceFactory?: (url: string) => RpaEventSourceLike;
}
```

- [ ] **Step 3: Implement request helpers**

Add JSON request helper that supports methods and body:

```ts
private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T>
```

Keep error behavior simple: throw `Error("RPA API request failed: <status>")` for non-ok responses except existing daemon health diagnostic case.

- [ ] **Step 4: Implement SSE helper**

`subscribeExecutionEvents` should:

- register listeners for all `RpaExecutionEventType` values
- parse `event.data` as `RpaExecutionEvent`
- keep a per-subscription `Set<number>` of seen `sequence` values
- ignore events whose `sequence` has already been seen
- dispatch events whose `sequence` is `undefined`; do not add `undefined` to the dedupe set
- call `handlers.onEvent(event)`
- call `handlers.onError(error)` for JSON parse errors
- close the source when `run.completed` arrives
- return `() => source.close()`

- [ ] **Step 5: Verify API client tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/api/rpa-api-client.test.ts
```

Expected: PASS.

## Task 4: Runtime UI State And Panels

**Files:**

- Create: `apps/rpa-local-web/src/components/RuntimeVerificationWorkspace.tsx`
- Create: `apps/rpa-local-web/src/components/ExecutionControlBar.tsx`
- Create: `apps/rpa-local-web/src/components/StepList.tsx`
- Create: `apps/rpa-local-web/src/components/ScreenshotPanel.tsx`
- Create: `apps/rpa-local-web/src/components/ExecutionLogPanel.tsx`
- Create: `apps/rpa-local-web/src/components/ArtifactPanel.tsx`
- Tests under `apps/rpa-local-web/tests/components/`

- [ ] **Step 1: Write component tests for step status derivation**

`StepList` should show:

- step id and name
- pending state before events
- running after `step.started`
- succeeded after `step.completed`
- failed after `step.failed`
- failed step message when present

- [ ] **Step 2: Implement `StepList`**

Input props:

```ts
interface StepListProps {
  steps: RpaDslStep[];
  events: RpaExecutionEvent[];
  failedStepId?: string;
}
```

No backend calls inside this component.

- [ ] **Step 3: Write component tests for screenshot panel**

Cover:

- empty state before execution
- loading/error text
- renders image with cache-busted URL after screenshot is available
- renders optional bbox placeholder when metadata exists later; first version may show no bbox.

- [ ] **Step 4: Implement `ScreenshotPanel`**

Input props:

```ts
interface ScreenshotPanelProps {
  imageUrl?: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  errorMessage?: string;
}
```

- [ ] **Step 5: Write component tests for artifacts**

Cover screenshot/download/trace/video/log roles and download links.

- [ ] **Step 6: Implement `ArtifactPanel`**

Use links shaped like:

```text
/api/rpa/executions/:executionId/artifacts/:artifactId/download
```

Do not expose local absolute paths.

- [ ] **Step 7: Implement `ExecutionLogPanel`**

Display:

- event timeline with timestamp, type, step id, message
- stdout text area
- stderr text area

Keep max visible event list to the newest 200 events to avoid an oversized DOM in long runs.

- [ ] **Step 8: Write `ExecutionLogPanel` tests**

Cover:

- stdout/stderr rendering
- event timeline rendering
- newest-200 truncation when more than 200 events are passed

- [ ] **Step 9: Write `ExecutionControlBar` tests**

Cover:

- default `flowId` is `case_query`
- verify mode defaults to `dryRun=true`, `headless=false`
- run mode defaults to `dryRun=false`, `headless=true`
- invalid params JSON disables start and shows an inline error
- cancel button is disabled when there is no active execution

- [ ] **Step 10: Implement `ExecutionControlBar`**

Behavior:

- `flowId` text input defaults to `case_query`.
- mode segmented/radio control: `verify` / `run`.
- changing mode updates defaults:
  - verify -> dryRun checked, headless unchecked
  - run -> dryRun unchecked, headless checked
- params textarea defaults to `{}`.
- invalid JSON disables start and shows inline error.
- start/cancel buttons use icon+text and have disabled states.

## Task 5: Runtime Workspace Integration

**Files:**

- Modify: `apps/rpa-local-web/src/components/RuntimeVerificationWorkspace.tsx`
- Modify: `apps/rpa-local-web/src/components/AppShell.tsx`
- Modify: `apps/rpa-local-web/src/styles.css`
- Test: `apps/rpa-local-web/tests/components/RuntimeVerificationWorkspace.test.tsx`
- Test: `apps/rpa-local-web/tests/App.test.tsx`

- [ ] **Step 1: Write workspace interaction tests**

Use a fake `RpaApiClient` or injected client prop to cover:

- entering `flowId` and clicking load renders DSL steps
- start verify calls `startExecution` with `mode: 'verify'`, `dryRun: true`, `headless: false`
- receiving SSE `log`, `artifact.created`, and `run.completed` updates event/log/artifact panels
- cancel calls `cancelExecution`
- controlled `flowId` prop updates the visible flow id and load target
- changing `autoStartRequest.requestId` starts verify/run once for that request

- [ ] **Step 2: Define workspace reuse props**

`RuntimeVerificationWorkspace` should expose a reuse seam for later codegen/natural-language slices:

```ts
export interface RuntimeVerificationAutoStartRequest {
  requestId: string;
  flowId: string;
  mode: RpaExecutionMode;
  daemonRunId?: string;
  params?: Record<string, string | number | boolean | null>;
}

export interface RuntimeVerificationWorkspaceProps {
  initialFlowId?: string;
  flowId?: string;
  onFlowIdChange?: (flowId: string) => void;
  autoStartRequest?: RuntimeVerificationAutoStartRequest;
  client?: RpaApiClient;
}
```

Manual usage passes no controlled props. Future codegen/natural-language workflows can pass `flowId` and `autoStartRequest` instead of forking the workspace.

- [ ] **Step 3: Implement `RuntimeVerificationWorkspace`**

State:

- `flowId`
- loaded flow detail
- params JSON text
- current execution id
- status
- events
- logs
- artifacts
- screenshot URL/cache key
- busy/error states
- last handled `autoStartRequest.requestId`

Important behavior:

- Load flow before start; if flow is not loaded or does not match current `flowId`, load it first.
- On start, reset previous run events/logs/artifacts/screenshot.
- Open SSE after `startExecution`.
- Ignore duplicate events by `sequence` if any duplicate reaches the component despite API client dedupe.
- Refresh logs on `log` and terminal events.
- Refresh artifacts on `artifact.created` and terminal events.
- Refresh screenshot on `step.screenshot`, screenshot artifact, and terminal events.
- Close EventSource on unmount and before starting a new execution.
- When `autoStartRequest.requestId` changes, load that request's flow and start once.

- [ ] **Step 4: Render workspace in `Executions` tab**

In `AppShell`, keep placeholder grid for other tabs. When `activeSection.id === 'executions'`, render `RuntimeVerificationWorkspace`.

- [ ] **Step 5: Add responsive CSS**

Add classes:

- `.runtime-workbench`
- `.execution-control-bar`
- `.runtime-grid`
- `.step-list`
- `.screenshot-panel`
- `.execution-log-panel`
- `.artifact-panel`

Design constraints:

- No nested cards inside cards.
- Cards/panels use radius <= 8px.
- Dense operational UI; no marketing hero.
- No single-hue purple/blue gradient theme.
- Long logs and file names wrap or scroll inside fixed containers.

- [ ] **Step 6: Verify app tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web test
pnpm --filter @lance-agent-runner/rpa-local-web typecheck
pnpm --filter @lance-agent-runner/rpa-local-web build
```

Expected: PASS. If server tests hit sandbox port/subprocess restrictions, rerun outside sandbox with approval.

## Task 6: Slice Regression And Main Plan Update

**Files:**

- Modify: `docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md`
- Modify: `docs/superpowers/plans/2026-06-06-rpa-runtime-verification-ui.md`

- [ ] **Step 1: Run layout and boundary checks**

Run:

```bash
find apps -path '*/src/*' -type f \( -name '*.test.ts' -o -name '*.test.tsx' \)
find apps -path '*/src/test' -type d
find apps -type d -name __tests__
rg -n "RpaExecution|flow\\.dsl|Playwright|screenshots/current|run\\.params" apps/daemon/src
git diff --check
```

Expected:

- First three commands print no test-layout violations.
- Daemon grep prints no RPA matches.
- `git diff --check` passes.

- [ ] **Step 2: Run full verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: PASS. If root tests hit sandbox limitations, rerun outside sandbox with approval.

- [ ] **Step 3: Update MVP progress**

After implementation and CC review:

- mark `Minimal Runtime Verification UI` completed in `2026-06-05-rpa-local-bs-mvp.md`
- add implementation commit hash
- record verification commands
- record CC review result

- [ ] **Step 4: Commit**

Suggested commit:

```bash
git commit -m "Add minimal RPA verification UI"
```

## Acceptance Checklist

- [ ] `Executions` tab renders the runtime verification workbench.
- [ ] User can manually enter a `flowId` and load DSL steps.
- [ ] User can start verify with headed + dry-run defaults.
- [ ] User can start run with headless defaults.
- [ ] User can cancel an active execution.
- [ ] SSE updates run status, event list, logs, artifacts, and current screenshot.
- [ ] Failed step id is visible when execution status includes one.
- [ ] UI handles generated scripts that emit no step events yet.
- [ ] No browser response exposes RPA storage absolute paths.
- [ ] No daemon code imports or interprets RPA DSL/execution concepts.
- [ ] Codegen and natural-language slices can reuse the workspace components.
- [ ] Runtime workspace exposes controlled `flowId` and `autoStartRequest` props for later workflow integration.
- [ ] SSE events are deduped by `sequence`.

## CC Review Prompt After Implementation

```text
请 review 当前工作树中 Minimal Runtime Verification UI 切片的实现。

任务目标：
- 在 apps/rpa-local-web 的 Executions tab 内嵌运行验证工作台。
- 允许手动输入 flowId，读取 RPA Web storage 中的 flow.dsl.json，并显示步骤。
- 通过现有 executor API 启动 verify/run、取消、订阅 SSE、读取日志、截图和 artifacts。
- verify 默认 dryRun=true/headless=false；run 默认 dryRun=false/headless=true。
- 不实现 codegen、自然语言生成、question-form、history/detail page、trace viewer。
- 不把任何 RPA DSL/Playwright/execution 逻辑放进 apps/daemon。

重点检查：
1. UI 是否真正复用 executor API，而不是 mock 或绕过后端。
2. flow detail route 是否只读 RPA Web-owned storage，且不泄露 storageRoot 绝对路径。
3. flow detail route 是否和 executor 共用 `<storageRoot>/flows/<flowId>` 目录约定。
4. SSE 订阅是否能关闭，避免组件 unmount 或重复 start 时泄漏 EventSource。
5. SSE/EventSource 重连或历史回放时是否按 `sequence` 去重。
6. step/log/screenshot/artifact 状态派生是否能处理没有 step events 的脚本。
7. TypeScript shared types 是否边界合理，shared 不应依赖 server-only modules。
8. RuntimeVerificationWorkspace 是否暴露受控 flowId / autoStartRequest 复用接缝。
9. verify/run 默认值是否符合设计。
10. tests 是否覆盖 API client、flow route、workspace interaction、ControlBar、LogPanel 和主要 panels。
11. 是否有任何 daemon core 污染。

请输出：
- P0/P1 findings first with file/line references.
- P2 suggestions if any.
- Final verdict: can commit / needs changes.
```
