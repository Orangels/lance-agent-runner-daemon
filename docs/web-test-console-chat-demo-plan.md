# Web Test Console Chat Demo Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local browser test console under `apps/web` that demonstrates the daemon generate and revise workflows for business-side integration.

**Architecture:** The web app is a thin demo client for the standalone daemon API. It keeps all business/demo state in the browser, calls the daemon with authenticated `fetch`, parses SSE with `fetch + ReadableStream`, renders a chat experience inspired by lanceDesign's chat pane, and does not add product-specific logic to the daemon.

**Tech Stack:** pnpm workspace, Vite, React, TypeScript, Vitest, Testing Library, browser `fetch`, browser `ReadableStream`, CSS modules or a single app stylesheet.

---

## Review Context

This plan is for review before implementation. Do not create web source files until the plan is approved.

Current repository shape:

```text
apps/
  daemon/
    src/
    skills/
docs/
package.json
pnpm-workspace.yaml
tsconfig.base.json
```

Target addition:

```text
apps/web/
  package.json
  tsconfig.json
  vite.config.ts
  vitest.config.ts
  index.html
  src/
```

Reference repository remains:

```text
/home/orangels/ls_dev/lanceDesign
```

Use lanceDesign for frontend rendering patterns only. Do not import lanceDesign private source and do not depend on `@lancedesign/*` packages.

## Scope

### In Scope

1. A local web test console that can connect to a running daemon.
2. A chat page/component for:
   - Generate with live SSE subscription.
   - Generate without SSE subscription, using polling/detail fetch.
   - Revise workflow, confirmed from the user's "recver" wording as daemon `kind: "revise"`.
3. Workspace bootstrap flow:
   - Load profiles.
   - Select profile/model/skill/artifact rules.
   - Create or reuse workspace.
   - Upload one or more files through `POST /api/workspaces/:workspaceId/files`.
4. Run lifecycle:
   - `POST /api/runs`.
   - `GET /api/runs/:runId/events` using authenticated fetch stream.
   - `GET /api/runs/:runId` for durable details.
   - `GET /api/runs/:runId/artifacts`.
   - Authenticated artifact download.
   - Cancel queued/running run.
5. Chat rendering inspired by lanceDesign:
   - Header with compact actions and status.
   - Scrollable message log.
   - Empty-state examples.
   - User bubbles aligned right.
   - Assistant flow aligned left with status/tool/artifact blocks.
   - Composer shell with file attachment, workflow mode selector, send/stop controls.

### Out of Scope

- Production auth UI.
- Persisting demo state to a backend.
- Business database integration.
- Multi-user permissions.
- Multi-skill run API changes.
- Daemon API contract changes.
- Native `EventSource` with query-string API keys.
- A full lanceDesign clone, preview iframe, comments system, design-system picker, MCP picker, feedback collection, or telemetry.
- Importing lanceDesign private code or CSS directly.

## Key Product Assumptions

- "recver flow" has been confirmed to mean daemon revise flow: `POST /api/runs` with `kind: "revise"` and no `skillId`.
- The first web version is a local demo and business adapter reference, not a production user portal.
- The page can require the operator to paste daemon base URL and API key.
- Demo state may live in React state and optionally localStorage for convenience.
- Generate without SSE still creates the same run. The difference is that the UI does not open `/events`; it polls `GET /api/runs/:runId` until terminal, then loads artifacts.
- Revise uses the same `workspaceId` as the generated report and relies on existing files/artifacts in the workspace.

## lanceDesign Frontend References

Use these files for behavior and visual structure:

```text
/home/orangels/ls_dev/lanceDesign/apps/web/src/components/ChatPane.tsx
/home/orangels/ls_dev/lanceDesign/apps/web/src/components/ChatComposer.tsx
/home/orangels/ls_dev/lanceDesign/apps/web/src/components/AssistantMessage.tsx
/home/orangels/ls_dev/lanceDesign/apps/web/src/components/ProjectView.tsx
/home/orangels/ls_dev/lanceDesign/apps/web/src/index.css
```

Relevant reference patterns:

- `ChatPane.tsx`
  - Empty state with starter prompts.
  - Scrollable `.chat-log`.
  - Day separators.
  - `UserMessage` rendering with right-aligned bubble and attachments.
  - `AssistantMessage` delegation for assistant event rendering.
  - Jump-to-latest affordance.
- `ChatComposer.tsx`
  - Composer shell.
  - Hidden file input.
  - Attachment chips.
  - Textarea with send/stop row.
  - Tool/settings button pattern.
- `AssistantMessage.tsx`
  - Assistant flow of text, status, thinking, tool, produced files, and footer.
  - Streaming waiting pill.
  - Completion footer with run duration/usage.
- `ProjectView.tsx`
  - Run lifecycle state updates.
  - Appending user and assistant messages.
  - Updating the active assistant message from streamed events.
- `index.css`
  - `.chat-header`, `.chat-log`, `.msg.user`, `.composer`, `.chat-empty`, `.chat-example`, `.assistant-completion-row`.

Port the interaction ideas and visual density. Do not copy product-specific code, analytics, comments, MCP, pet, deployment, or artifact preview logic.

## UX Design

### Page Layout

The first screen is the actual test console, not a landing page.

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Top Bar: Daemon URL · API Key status · Health · Profile selector    │
├───────────────────────────────┬─────────────────────────────────────┤
│ Setup Panel                   │ Chat Panel                          │
│ - Client connection           │ - Header/status/actions             │
│ - Profile/model/skill         │ - Message log                       │
│ - Workspace identity          │ - Composer                          │
│ - Input files                 │ - Artifact strip                    │
│ - Last run/debug summary      │                                     │
└───────────────────────────────┴─────────────────────────────────────┘
```

Use a restrained operational UI:

- Dense but readable controls.
- 6-8px border radius.
- Icons in buttons where useful.
- No marketing hero.
- No decorative gradient/orb background.
- Avoid a one-note purple/blue palette.

### Chat Header

Header content:

- Workspace key or "No workspace".
- Active workflow mode:
  - Generate + SSE
  - Generate + Poll
  - Revise
- Current run status pill:
  - idle
  - creating workspace
  - uploading
  - queued
  - running
  - succeeded
  - failed
  - canceled
  - interrupted
- Actions:
  - Refresh run detail
  - Cancel run when queued/running
  - Clear local chat

### Empty State

Use three starter examples:

1. Generate report with SSE.
2. Generate report without SSE.
3. Revise current report.

Clicking a starter fills the composer and selects the matching workflow mode.

### Message Model

The web app should define its own small `DemoChatMessage` model instead of reusing daemon DB message shapes directly:

```ts
type DemoChatRole = 'user' | 'assistant';

type DemoChatRunMode = 'generate-sse' | 'generate-poll' | 'revise';

type DemoChatMessage = {
  id: string;
  role: DemoChatRole;
  content: string;
  createdAt: number;
  runId?: string;
  runMode?: DemoChatRunMode;
  runStatus?: RunStatus;
  events?: DemoRunEvent[];
  artifacts?: PublicArtifact[];
  error?: {
    code?: string;
    message: string;
  };
};
```

Render mapping:

- User message: prompt text, uploaded file chips, workflow mode chip.
- Assistant message:
  - text deltas as prose.
  - `status` as compact pills.
  - `thinking_delta` in a collapsible/detail-style block.
  - `tool_use` and `tool_result` in compact tool cards.
  - `artifact_finalized` as artifact cards with download buttons.
  - `usage` in footer.
  - `error` and failed terminal states as red inline status.
  - `end` as completion footer.

### Composer

Controls:

- Workflow segmented control:
  - Generate + SSE
  - Generate + Poll
  - Revise
- Textarea.
- Attachment button for local files.
- Selected file chips with target paths.
- Model selector.
- Skill selector only enabled for generate modes.
- Artifact rule multi-select.
- Event visibility selector.
- Send button.
- Stop button while a run is active.

File behavior:

- Uploaded file `targetPath` defaults to `input/<filename>`.
- Allow editing targetPath before send.
- Upload occurs before `POST /api/runs`.
- The daemon `/files` endpoint accepts exactly one multipart `file` field per request. Multiple selected files must be uploaded sequentially as one request per file.
- Multipart upload requests must not set `Content-Type` manually. The browser must generate `multipart/form-data; boundary=...`; the web client should add only `Authorization` and let `fetch` set the body content type.
- For revise, file upload is optional; user can modify existing workspace artifacts without uploading a new file.
- Workspace identity fields should be validated client-side as safe path segments before calling the daemon: no `/`, `\`, `.`, `..`, or null byte.

## API Data Flow

### Shared Bootstrap

1. User enters base URL and API key.
2. `GET /api/health`.
3. `GET /api/profiles`.
4. User selects profile.
5. User fills workspace identity:

```json
{
  "originId": "demo",
  "userId": "user_001",
  "projectId": "report_demo_001"
}
```

6. On first send, call `POST /api/workspaces` and keep `workspaceId`.
7. Upload selected files through `POST /api/workspaces/:workspaceId/files`, one file per request. Each request sends exactly:
   - `file`: the selected browser `File`
   - `targetPath`: the workspace-relative destination

### Generate With SSE

1. Append user message.
2. Append empty assistant message with `runStatus: "queued"`.
3. Call `POST /api/runs`:

```json
{
  "profileId": "report-docx",
  "workspaceId": "ws_xxx",
  "kind": "generate",
  "skillId": "report-gen",
  "prompt": "...",
  "model": "opus",
  "artifactRuleIds": ["report-docx", "report-any"],
  "eventVisibility": "normal",
  "metadata": {
    "demoMode": "generate-sse"
  }
}
```

4. Open authenticated SSE via `fetch`.
5. Parse `event: agent` frames.
6. Apply each event to the active assistant message.
7. Treat `data.type === "end"` as the terminal marker. The SSE event name remains `agent`.
8. On terminal, close the stream, fetch run detail, fetch artifacts, reconcile assistant message.
9. If opening `/events` returns 404, or the SSE request fails before any terminal event, fall back to `GET /api/runs/:runId` and reconcile durable detail. This prevents short or already-finished runs from being rendered as client failures when the in-memory event stream has expired.

### Generate Without SSE

1. Append user message.
2. Append assistant message with status "queued".
3. Call the same `POST /api/runs`, but with metadata:

```json
{
  "demoMode": "generate-poll"
}
```

4. Do not call `/events`.
5. Poll `GET /api/runs/:runId` every 1000-1500 ms while status is `queued` or `running`.
6. Update assistant content from durable `messages`.
7. When terminal, stop polling and fetch artifacts.
8. Reconciliation must map daemon durable messages back onto the local user/assistant pair by `runId`. The daemon creates user and assistant draft messages when the run is created, so the web UI must not append those durable messages as additional chat bubbles.

This demonstrates daemon-side persistence even without an SSE consumer.

### Revise

1. Require an existing `workspaceId`.
2. Do not send `skillId`.
3. Use same workspace and selected artifact rules:

```json
{
  "profileId": "report-docx",
  "workspaceId": "ws_xxx",
  "kind": "revise",
  "prompt": "请修改 output/report.docx ...",
  "model": "opus",
  "artifactRuleIds": ["report-docx", "report-any"],
  "eventVisibility": "normal",
  "metadata": {
    "demoMode": "revise",
    "previousRunId": "run_previous"
  }
}
```

4. First version should use SSE for revise by default because it demonstrates the same chat streaming path.
5. If the selected workflow is revise and an earlier artifact exists, show a small "Current artifact" chip near the composer.

## Browser API Layer

### File Map

- `apps/web/src/api/types.ts`
  - API request/response TypeScript types copied from daemon docs in a minimal browser-local form.
- `apps/web/src/api/daemon-client.ts`
  - `DaemonClient` class or factory wrapping authenticated JSON/multipart/download requests.
  - JSON requests set `Content-Type: application/json`.
  - Multipart uploads do not set `Content-Type`; they add only `Authorization`.
  - `uploadWorkspaceFile()` uploads one file per call.
- `apps/web/src/api/sse-stream.ts`
  - Authenticated `fetch` stream reader.
  - SSE frame parser.
  - `AbortSignal` cancellation.
- `apps/web/src/api/download.ts`
  - Fetch artifact with auth.
  - Create object URL.
  - Trigger browser download.
- `apps/web/src/api/__tests__/daemon-client.test.ts`
  - JSON request construction and error decoding.
- `apps/web/src/api/__tests__/sse-stream.test.ts`
  - Multi-frame SSE parsing, split chunks, keepalive comments, `id` handling.

### API Rules

- Never put API key in query string.
- Always send:

```text
Authorization: Bearer <api-key>
```

- SSE must use `fetch`, not `EventSource`.
- Health requests do not require auth.
- `GET /api/profiles`, workspace, upload, run, artifact, log, and cancel requests require auth.
- Multipart uploads must use `FormData` with exactly one `file` field and one `targetPath` field. Multi-file selection loops over files and awaits each single-file upload.
- API error messages should render `error.code` and `error.message`, but should not expose stack traces.

## Chat State Layer

### File Map

- `apps/web/src/chat/chat-types.ts`
  - `DemoChatMessage`, `DemoRunEvent`, `WorkflowMode`, `RunStatus`.
- `apps/web/src/chat/run-event-reducer.ts`
  - Pure reducer that applies daemon run events to an assistant message.
- `apps/web/src/chat/run-polling.ts`
  - Polling loop for non-SSE generate mode.
- `apps/web/src/chat/__tests__/run-event-reducer.test.ts`
  - text delta aggregation.
  - artifact event attachment.
  - terminal status.
  - error event.
- `apps/web/src/chat/__tests__/run-polling.test.ts`
  - stops on terminal.
  - aborts cleanly.

### Reducer Behavior

- `text_delta`: append to `content`.
- `status`: append to `events`; update run status when label maps to a known status.
- `thinking_delta`: append to `events`, render separately.
- `tool_use` / `tool_result`: append to `events`.
- `artifact_finalized`: append to `events`; append artifact to `artifacts`.
- `usage`: append to `events`.
- `error`: set `error`; append event.
- `end`: set final `runStatus`; mark assistant ended.
- Durable detail reconciliation: update the local assistant message matching `runId` from the daemon assistant message. Do not append daemon-created user/assistant draft messages as new chat rows.

## React Component Plan

### File Map

- `apps/web/src/App.tsx`
  - Page shell, connection state, profile/workspace/run orchestration.
- `apps/web/src/components/ConnectionPanel.tsx`
  - Base URL, API key, health/profile loading.
- `apps/web/src/components/WorkspacePanel.tsx`
  - Profile, model, skill, artifact rules, workspace identity, selected files.
- `apps/web/src/components/ChatPanel.tsx`
  - Chat header, log, empty state, composer.
- `apps/web/src/components/UserMessage.tsx`
  - Right-aligned user bubble.
- `apps/web/src/components/AssistantMessage.tsx`
  - Assistant flow blocks.
- `apps/web/src/components/ChatComposer.tsx`
  - Textarea, workflow segmented control, file attach, model/skill/artifact controls, send/stop.
- `apps/web/src/components/ArtifactList.tsx`
  - Artifact cards and download buttons.
- `apps/web/src/components/StatusPill.tsx`
  - Shared compact status UI.
- `apps/web/src/styles.css`
  - Single web test console stylesheet.

### Component Boundaries

- `App.tsx` owns orchestration and side effects.
- `api/*` owns HTTP details.
- `chat/*` owns pure state transformations.
- `components/*` remain presentational except `ChatComposer` local draft/file state.
- No component imports daemon source directly.

## Styling Direction

Reference lanceDesign structure, not full styling.

Use:

- `.chat-header`
- `.chat-log`
- `.msg.user`
- `.msg.assistant`
- `.assistant-flow`
- `.composer`
- `.composer-shell`
- `.chat-empty`
- `.chat-example`

Design constraints:

- Avoid nested cards.
- Keep main app layout as full-height workspace.
- Use cards only for repeated items such as artifacts or starter examples.
- Buttons with icons for send, stop, attach, refresh, cancel, download.
- Text must fit in controls at desktop and mobile widths.
- Use restrained neutral surfaces with a small accent color; avoid a one-note blue/purple palette.

## Implementation Tasks

### Task 1: Scaffold Web Package

**Files:**

- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/styles.css`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

Steps:

- [ ] Add `apps/web` as a workspace package.
- [ ] Add React, Vite, Testing Library dependencies.
- [ ] Add root scripts:
  - `dev:web`
  - `build:web`
  - `test:web`
  - `typecheck:web`
- [ ] Keep root `dev` mapped to daemon unless explicitly changed later.
- [ ] Build a static shell with no daemon calls yet.
- [ ] Verify:

```bash
pnpm typecheck:web
pnpm build:web
pnpm test:web
```

### Task 2: Browser API Client

**Files:**

- Create: `apps/web/src/api/types.ts`
- Create: `apps/web/src/api/daemon-client.ts`
- Create: `apps/web/src/api/download.ts`
- Create: `apps/web/src/api/__tests__/daemon-client.test.ts`

Steps:

- [ ] Define minimal request/response types for profiles, workspaces, uploads, runs, artifacts, logs.
- [ ] Implement authenticated JSON request helper.
- [ ] Implement multipart upload helper.
  - It must send exactly one `file` field and one `targetPath` field.
  - It must not set `Content-Type` manually.
  - Multi-file upload is a caller-side loop over this helper.
- [ ] Implement authenticated artifact download helper.
- [ ] Add tests for headers, body encoding, error decoding, upload FormData shape, no manual multipart `Content-Type`, and download filename fallback.
- [ ] Verify:

```bash
pnpm test:web -- src/api/__tests__/daemon-client.test.ts
```

### Task 3: Authenticated SSE Parser

**Files:**

- Create: `apps/web/src/api/sse-stream.ts`
- Create: `apps/web/src/api/__tests__/sse-stream.test.ts`

Steps:

- [ ] Implement `streamRunEvents({ baseUrl, apiKey, runId, after, signal, onEvent })`.
- [ ] Use `fetch` with `Authorization`.
- [ ] Parse SSE fields `id`, `event`, `data`.
- [ ] Ignore keepalive comments.
- [ ] Only accept `event: agent`.
- [ ] Parse `data` as JSON run event.
- [ ] Preserve event id for replay display and reducer metadata.
- [ ] Treat `data.type === "end"` as terminal; do not expect an SSE event named `end`.
- [ ] Return structured stream errors so callers can fall back to durable run detail on 404 or early network failure.
- [ ] Add tests for split chunks, multiple frames, comments, malformed JSON, abort, and 404 fallback signaling.
- [ ] Verify:

```bash
pnpm test:web -- src/api/__tests__/sse-stream.test.ts
```

### Task 4: Chat State Reducer

**Files:**

- Create: `apps/web/src/chat/chat-types.ts`
- Create: `apps/web/src/chat/run-event-reducer.ts`
- Create: `apps/web/src/chat/run-polling.ts`
- Create: `apps/web/src/chat/__tests__/run-event-reducer.test.ts`
- Create: `apps/web/src/chat/__tests__/run-polling.test.ts`

Steps:

- [ ] Define local chat/run types.
- [ ] Implement event-to-message reducer.
- [ ] Implement durable detail-to-message reconciliation.
  - It must update the existing assistant message with the same `runId`.
  - It must ignore daemon-created durable user messages for chat-row creation.
  - It must not append a second assistant bubble for the same `runId`.
- [ ] Implement polling loop for generate-without-SSE.
- [ ] Add reducer tests for text, status, tool, artifact, error, end.
- [ ] Add polling tests for terminal stop, abort, and no duplicate durable message rows.
- [ ] Verify:

```bash
pnpm test:web -- src/chat/__tests__/run-event-reducer.test.ts src/chat/__tests__/run-polling.test.ts
```

### Task 5: Connection And Workspace Panels

**Files:**

- Create: `apps/web/src/components/ConnectionPanel.tsx`
- Create: `apps/web/src/components/WorkspacePanel.tsx`
- Modify: `apps/web/src/App.tsx`
- Create: `apps/web/src/components/__tests__/ConnectionPanel.test.tsx`
- Create: `apps/web/src/components/__tests__/WorkspacePanel.test.tsx`

Steps:

- [ ] Implement base URL and API key controls.
- [ ] Add health check.
- [ ] Add profile loading and selection.
- [ ] Add model, skill, artifact rule, and visibility controls from selected profile.
- [ ] Add workspace identity form.
  - Validate path segments before submit: reject `/`, `\`, `.`, `..`, and null byte.
- [ ] Add file picker with editable target paths.
- [ ] Add tests for profile selection, generate skill requirement UI, and revise skill disabled UI.
- [ ] Verify:

```bash
pnpm test:web -- src/components/__tests__/ConnectionPanel.test.tsx src/components/__tests__/WorkspacePanel.test.tsx
```

### Task 6: Chat Rendering Components

**Files:**

- Create: `apps/web/src/components/ChatPanel.tsx`
- Create: `apps/web/src/components/ChatComposer.tsx`
- Create: `apps/web/src/components/UserMessage.tsx`
- Create: `apps/web/src/components/AssistantMessage.tsx`
- Create: `apps/web/src/components/ArtifactList.tsx`
- Create: `apps/web/src/components/StatusPill.tsx`
- Modify: `apps/web/src/styles.css`
- Create: `apps/web/src/components/__tests__/ChatPanel.test.tsx`
- Create: `apps/web/src/components/__tests__/AssistantMessage.test.tsx`

Steps:

- [ ] Implement empty-state starter prompts.
- [ ] Implement user bubble rendering.
- [ ] Implement assistant text/status/tool/artifact/error/end rendering.
- [ ] Implement composer workflow mode, attach, send, stop controls.
- [ ] Implement artifact cards and download buttons.
- [ ] Add tests for empty state, message rendering, artifact rendering, and disabled controls.
- [ ] Verify:

```bash
pnpm test:web -- src/components/__tests__/ChatPanel.test.tsx src/components/__tests__/AssistantMessage.test.tsx
```

### Task 7: Wire Generate With SSE

**Files:**

- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/ChatPanel.tsx`
- Test: `apps/web/src/__tests__/generate-sse-flow.test.tsx`

Steps:

- [ ] On send, ensure workspace.
- [ ] Upload selected files.
- [ ] Create generate run with `kind: "generate"` and `skillId`.
- [ ] Open SSE stream.
- [ ] If SSE stream opening fails with 404, or fails before `data.type === "end"`, fetch run detail and reconcile instead of marking the run failed locally.
- [ ] Apply streamed events to assistant message.
- [ ] On terminal, fetch detail and artifacts.
- [ ] Implement cancel using `POST /api/runs/:runId/cancel`.
- [ ] Add integration-style component test with mocked fetch stream.
- [ ] Verify:

```bash
pnpm test:web -- src/__tests__/generate-sse-flow.test.tsx
```

### Task 8: Wire Generate Without SSE

**Files:**

- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/__tests__/generate-poll-flow.test.tsx`

Steps:

- [ ] Reuse workspace/upload/run creation path.
- [ ] Do not call `/events`.
- [ ] Poll `GET /api/runs/:runId`.
- [ ] Reconcile durable messages into the assistant message.
  - Do not append the daemon durable user/assistant draft messages as new chat bubbles.
- [ ] Fetch artifacts at terminal.
- [ ] Add test proving no `/events` request is made.
- [ ] Add test proving durable detail updates the existing assistant bubble for the run.
- [ ] Verify:

```bash
pnpm test:web -- src/__tests__/generate-poll-flow.test.tsx
```

### Task 9: Wire Revise Flow

**Files:**

- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/ChatComposer.tsx`
- Test: `apps/web/src/__tests__/revise-flow.test.tsx`

Steps:

- [ ] Require existing `workspaceId`.
- [ ] Disable and omit `skillId`.
- [ ] Create run with `kind: "revise"`.
- [ ] Include `previousRunId` metadata when available.
- [ ] Subscribe through SSE by default.
- [ ] Fetch updated artifacts at terminal.
- [ ] Add tests proving revise does not send `skillId`.
- [ ] Verify:

```bash
pnpm test:web -- src/__tests__/revise-flow.test.tsx
```

### Task 10: Documentation And Demo Script

**Files:**

- Create: `docs/web-test-console-usage.md`
- Modify: `AGENTS.md`
- Modify: `docs/business-run-chat-integration-guide.md`

Steps:

- [ ] Document how to start daemon and web console together.
- [ ] Document the three demo flows.
- [ ] Document expected business-side mapping from demo state to business DB.
- [ ] Document that SSE uses authenticated fetch, not EventSource.
- [ ] Add a short section linking the web console to the business adapter guide.
- [ ] Verify docs mention no production auth guarantee.

### Task 11: Final Verification

Run:

```bash
pnpm install --offline --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

Manual smoke:

1. Start daemon:

```bash
CLAUDE_RUNNER_LQBOT_API_KEY=local-test pnpm dev:daemon
```

2. Start web:

```bash
pnpm dev:web
```

3. In the browser:
   - Set daemon base URL.
   - Set API key.
   - Load profiles.
   - Create workspace.
   - Upload a `.docx`.
   - Run Generate + SSE.
   - Run Generate + Poll.
   - Run Revise.
   - Download an artifact.
   - Cancel a queued/running run if possible.

## Acceptance Criteria

- `apps/web` exists and is a separate pnpm workspace package.
- No daemon API contract changes are required.
- Generate + SSE works from the browser using authenticated fetch stream.
- Generate + Poll works without calling `/events`.
- Revise sends `kind: "revise"` and omits `skillId`.
- Uploaded files use `POST /api/workspaces/:workspaceId/files`.
- Artifacts are listed and downloadable with auth.
- Chat rendering follows lanceDesign's structural patterns while avoiding product-specific imports.
- API key is never placed in URL query strings.
- `pnpm typecheck`, `pnpm build`, and `pnpm test` pass from the root.

## Confirmed Naming

The user's "recver flow" is confirmed to mean daemon `revise` flow.
