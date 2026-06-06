# RPA Codegen Hardening Loop Execution Plan

> **For Orangels:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan.

**Goal:** Build the first complete RPA script production loop for the local B/S MVP: start Playwright codegen from RPA Web, store the raw recording, send it to daemon with `playwright-rpa-harden`, handle question-form follow-ups, persist generated artifacts as a reusable flow, and hand the result to the existing verification UI.

**Status:** Implemented and CC reviewed.

**Architecture boundary:** RPA Web owns codegen, flow state, RPA business context, artifact download, and verification handoff. Daemon remains a generic Claude Code runner and only receives `business-context` plus `skillId`.

**Not in this slice:** natural language generation, `.rpa.zip` import/export UI, multi-file codegen projects, Browserless/SaaS execution, daemon-composed transcript assembly, or daemon core knowledge of RPA DSL/Playwright.

## Current State

Completed prerequisites:

- Daemon `business-context`, `collectionMode`, prompt/skill/context snapshots, and `revise + skillId` support are implemented.
- RPA DSL/artifact validation contract is implemented.
- RPA local executor backend is implemented.
- Minimal runtime verification UI is implemented and completed in commit `bcd71d4`.
- App tests follow `apps/<app>/tests/`; source directories remain source-only.

Existing code to reuse:

- `apps/rpa-local-web/src/server/daemon-client.ts`
  - `createWorkspace`
  - `createRun`
  - `cancelRun`
  - `uploadWorkspaceFile`
  - `listRunArtifacts`
  - `downloadArtifact`
  - `subscribeRunEvents`
- `apps/rpa-local-web/src/server/flow-store.ts`
  - final generated flow storage under `<storageRoot>/flows/<flowId>/`
  - allowed artifact names and safe path handling
- `apps/rpa-local-web/src/server/validators/artifact-validator.ts`
  - daemon artifact validation for `output/*`
- `apps/rpa-local-web/src/shared/artifacts.ts`
  - required artifacts:
    - `flow.dsl.json`
    - `flow.hardened.py`
    - `config.example.json`
    - `parameterization-report.md`
    - `hardening-report.md`
- `apps/rpa-local-web/src/components/RuntimeVerificationWorkspace.tsx`
  - reusable verification display after a flow is generated

## Contract Decisions

1. Raw codegen recording is not a final flow.
   - Store raw recordings under `<storageRoot>/codegen-sessions/<sessionId>/input/flow.py`.
   - Store hardened reusable flows under `<storageRoot>/flows/<flowId>/`.
   - The executor only runs the hardened `flow.hardened.py`.

2. MVP supports one raw recording file.
   - Required input file: `input/flow.py`.
   - Multi-file codegen projects are outside this slice.

3. Codegen command is configurable.
   - Default command: `playwright`
   - Default args: `["codegen"]`
   - RPA Web invokes:

```text
<command> <args...> --target python -o <sessionDir>/input/flow.py <targetUrl>
```

4. RPA Web never sends a final prompt body that includes `SKILL.md`.
   - It sends business context, current user-facing prompt, `skillId`, and stage metadata.
   - Daemon injects skill instructions, side files, profile constraints, and snapshots.

5. Codegen hardening creates a per-session daemon workspace.
   - Use `profileId` from RPA Web server config, normally `defaultProfileId`.
   - Create one daemon workspace per codegen session to avoid concurrent `input/flow.py` overwrites.
   - Workspace identity is derived by RPA Web:
     - `originId`: `rpa-local-web`
     - `userId`: `local-user`
     - `projectId`: `codegen_<flowId>_<sessionId>`
   - Store `workspaceId`, first `daemonRunId`, and returned `conversationId` on the codegen session.
   - Follow-up daemon runs reuse the same `workspaceId` and pass the same `conversationId` for grouping, while still carrying explicit `businessContext`.

6. Codegen hardening run uses:

```json
{
  "profileId": "rpa-local",
  "workspaceId": "ws_...",
  "kind": "generate",
  "promptMode": "business-context",
  "currentPrompt": "Harden the recorded Playwright codegen script at input/flow.py into the required RPA MVP artifacts.",
  "skillId": "playwright-rpa-harden",
  "collectionMode": "diagnostic",
  "eventVisibility": "normal",
  "businessContext": {
    "stage": "codegen-hardening",
    "codegenSessionId": "cg_...",
    "flowId": "demo_download_flow",
    "targetUrl": "https://example.com",
    "inputFiles": ["input/flow.py"],
    "recording": {
      "source": "playwright-codegen",
      "scriptPath": "input/flow.py"
    }
  }
}
```

7. Question-form continuation uses:

```json
{
  "profileId": "rpa-local",
  "workspaceId": "ws_...",
  "conversationId": "conv_...",
  "kind": "revise",
  "promptMode": "business-context",
  "currentPrompt": "Continue hardening the RPA flow after the user's question-form answers.",
  "skillId": "playwright-rpa-harden",
  "businessContext": {
    "stage": "codegen-hardening-follow-up",
    "previousRunId": "...",
    "artifactPaths": ["input/flow.py"],
    "formAnswers": {}
  }
}
```

8. Codegen session states:

```text
starting | recording | completed | hardening | needs_input | hardened | failed | cancelled
```

`idle` is only a UI state before a session exists.

Verification state is owned by the existing local executor UI. The codegen session hands off `flowId` after `hardened`; it does not persist executor lifecycle state.

9. Daemon event parsing stays in RPA Web.
   - `DaemonRunEventRecord.event` is treated as `unknown` at the client boundary.
   - RPA Web defines local type guards for `text_delta`, `artifact_finalized`, `end`, and `error`.
   - The workflow accumulates all `text_delta.delta` chunks into one assistant transcript buffer.
   - `<question-form>` is parsed from the accumulated transcript at terminal `end`, not from individual chunks.
   - Terminal handling order:
     1. If `end.status !== "succeeded"`, mark the session `failed`.
     2. Else if the accumulated transcript contains a complete `<question-form>...</question-form>`, persist the form and mark `needs_input`; do not validate artifacts yet.
     3. Else validate and persist artifacts, then mark `hardened` or `failed`.

## API Shape

Add RPA Web API routes:

```text
POST /api/rpa/codegen/sessions
GET  /api/rpa/codegen/sessions/:sessionId
POST /api/rpa/codegen/sessions/:sessionId/cancel
POST /api/rpa/codegen/sessions/:sessionId/question-form/answers
```

### Start Session

Request:

```json
{
  "targetUrl": "https://example.com",
  "flowId": "demo_download_flow",
  "flowName": "Demo download flow"
}
```

Response:

```json
{
  "sessionId": "cg_...",
  "flowId": "demo_download_flow",
  "status": "starting",
  "targetUrl": "https://example.com",
  "recording": {
    "inputPath": "input/flow.py"
  }
}
```

Validation:

- `targetUrl` must be `http:` or `https:`.
- `flowId` must match the current flow storage convention: `^[a-z][a-z0-9_]{1,63}$`.
- Existing final flow artifacts for the same `flowId` are not overwritten unless the API explicitly requests replacement. This slice should reject by default.

### Session Status

Response:

```json
{
  "sessionId": "cg_...",
  "flowId": "demo_download_flow",
  "status": "hardening",
  "targetUrl": "https://example.com",
  "daemonRunId": "run_...",
  "workspaceId": "ws_...",
  "conversationId": "conv_...",
  "logs": [],
  "questionForm": null,
  "artifacts": [],
  "error": null
}
```

Rules:

- Do not expose absolute sandbox paths.
- `logs` are short status/log lines suitable for UI display.
- Raw daemon text may be summarized/truncated for status responses; durable daemon snapshots remain in daemon.

### Cancel Session

Behavior:

- If codegen process is active, terminate it.
- If daemon run is active, call `cancelRun(runId)`.
- If verification has already started, use the existing execution cancel API from the verification UI; the codegen cancel route does not own executor lifecycle.
- If the session is already `hardened`, cancellation is idempotent and does not delete generated artifacts.
- Mark the session `cancelled` once all reachable work has been asked to stop.

### Submit Question Answers

Request:

```json
{
  "formId": "qf_...",
  "answers": {
    "dateRange": "2026-06"
  }
}
```

Behavior:

- Validate `formId` matches the current stored question form.
- Create a daemon `revise` run with the same `skillId`.
- Include `profileId`, `workspaceId`, `conversationId`, `currentPrompt`, previous run id, form answers, `input/flow.py`, current artifact summaries, `flowId`, and `codegenSessionId`.
- Resume daemon SSE tracking and artifact download.

## Implementation Tasks

### Task 1: Shared Types And Config

Files:

- `apps/rpa-local-web/src/shared/codegen-types.ts`
- `apps/rpa-local-web/src/shared/daemon-event-types.ts`
- `apps/rpa-local-web/src/server/config.ts`
- `apps/rpa-local-web/tests/server/config.test.ts`

Steps:

1. Define shared request/response/status types for codegen sessions.
2. Add server config:
   - `codegenCommand`
   - `codegenArgs`
   - optional `codegenStartTimeoutMs`
3. Read env:
   - `RPA_CODEGEN_COMMAND`
   - `RPA_CODEGEN_ARGS_JSON`
   - `RPA_CODEGEN_START_TIMEOUT_MS`
4. Default to `playwright` and `["codegen"]`.
5. Validate args JSON as a string array.
6. Define local daemon SSE event type guards for the RPA Web client boundary:
   - `isDaemonTextDeltaEvent`
   - `isDaemonArtifactFinalizedEvent`
   - `isDaemonEndEvent`
   - `isDaemonErrorEvent`
7. Keep daemon event parsing local to RPA Web; do not change daemon core event contracts for RPA.

Tests:

- Defaults are loaded.
- Env overrides are loaded.
- Invalid args JSON fails config validation with a structured message.
- Event type guards accept the known daemon event shapes and reject malformed `unknown` events.

### Task 2: Codegen Session Store

Files:

- `apps/rpa-local-web/src/server/codegen/codegen-session-store.ts`
- `apps/rpa-local-web/tests/server/codegen-session-store.test.ts`

Steps:

1. Create an in-memory session store for MVP.
2. Store session metadata, status, target URL, flow id, recording path, daemon workspace/run ids, question form, artifact summaries, and short logs.
3. Store daemon conversation grouping metadata after the first run is created:
   - `workspaceId`
   - `daemonRunId`
   - `conversationId`
4. Create safe path helpers for:
   - `<storageRoot>/codegen-sessions/<sessionId>/input/flow.py`
   - `<storageRoot>/flows/<flowId>/`
5. Ensure all public paths are workspace-relative or logical labels.
6. Enforce legal status transitions:
   - `starting -> recording`
   - `recording -> completed | failed | cancelled`
   - `completed -> hardening`
   - `hardening -> needs_input | hardened | failed | cancelled`
   - `needs_input -> hardening | cancelled`
   - `hardened -> hardened` for idempotent terminal reads/cancel requests

Tests:

- Safe flow/session ids are accepted.
- Unsafe ids and path traversal are rejected.
- Absolute paths are not returned in public session summaries.
- Illegal status transitions are rejected.
- Existing final flow artifacts for the same `flowId` are rejected by default before a new codegen session starts.

### Task 3: Playwright Codegen Runner

Files:

- `apps/rpa-local-web/src/server/codegen/playwright-codegen-runner.ts`
- `apps/rpa-local-web/tests/server/playwright-codegen-runner.test.ts`

Steps:

1. Spawn the configured codegen command with:

```text
<command> <args...> --target python -o <scriptPath> <targetUrl>
```

2. Pipe stdout/stderr into session logs with size limits.
3. On normal exit, verify `flow.py` exists and is non-empty.
4. On cancel, terminate the child process and mark the runner cancelled.
5. Redact absolute local paths from error messages before returning them to API/UI.
6. Use `spawn(command, args, { shell: false })`; never pass `targetUrl` through a shell string.

Tests:

- Fake command writes `flow.py` and exits 0.
- Non-zero exit produces failed result.
- Cancel terminates fake long-running command.
- Missing or empty `flow.py` is treated as failure.
- Public errors do not include absolute storage root.
- Command args are passed as an array with `shell: false`.
- `targetUrl` is validated before runner invocation.

### Task 4: Daemon Hardening Workflow

Files:

- `apps/rpa-local-web/src/server/workflows/codegen-hardening-workflow.ts`
- `apps/rpa-local-web/tests/server/codegen-hardening-workflow.test.ts`

Steps:

1. After codegen completes, create a daemon workspace for this codegen session.
   - `profileId` comes from RPA Web server config.
   - `originId = "rpa-local-web"`
   - `userId = "local-user"`
   - `projectId = "codegen_<flowId>_<sessionId>"`
   - Do not reuse a shared workspace for multiple concurrent codegen sessions.
2. Upload raw script to daemon workspace as `input/flow.py`.
3. Create daemon run:
   - `profileId`
   - `workspaceId`
   - `kind: generate`
   - `promptMode: business-context`
   - `currentPrompt`
   - `skillId: playwright-rpa-harden`
   - `collectionMode: diagnostic`
   - `eventVisibility: normal`
   - `businessContext.stage = "codegen-hardening"`
   - no raw `prompt` field
4. Track daemon SSE:
   - narrow `unknown` events with the local type guards
   - append all `text_delta.delta` chunks to a short assistant transcript buffer
   - record `artifact_finalized` summaries
   - wait for terminal `end` before parsing `<question-form>`
   - if `end.status !== "succeeded"`, mark `failed`
   - if `end.status === "succeeded"` and the accumulated transcript has a complete `<question-form>`, persist it and move session to `needs_input`
   - otherwise download and validate required artifacts
5. Download only daemon artifacts with relative paths matching `output/<allowedName>`.
6. Persist required artifacts into `<storageRoot>/flows/<flowId>/`.
7. Validate the final flow artifacts using the existing artifact validator.
8. Mark the session `hardened`.
9. Implement answer submission:
   - create daemon `revise` run
   - include `profileId`, `workspaceId`, `conversationId`, and `currentPrompt`
   - reuse the same `skillId`
   - include previous run id, form answers, stage metadata, and artifact/input paths in business context
   - do not rely on daemon implicit history
   - continue SSE tracking and final artifact persistence

Tests:

- Start hardening creates a per-session daemon workspace and uploads `input/flow.py`.
- Create-run request includes `profileId`, `workspaceId`, `currentPrompt`, `promptMode: "business-context"`, `skillId`, and no raw `prompt`.
- Successful daemon run downloads all required artifacts and writes final flow files.
- Artifact outside `output/*` is ignored/rejected.
- Missing required artifact fails the session.
- Artifacts present but invalid DSL fails the session.
- `end.status === "failed"` fails the session.
- `end.status === "succeeded"` plus complete question-form moves session to `needs_input` without artifact validation.
- Question-form split across multiple `text_delta` chunks is parsed after terminal `end`.
- Submit answers creates a `revise + business-context + skillId` run with `profileId`, `workspaceId`, `conversationId`, and `currentPrompt`.
- A second question-form after answer submission supports `needs_input -> hardening -> needs_input`.
- Daemon run cancellation is called when the session is cancelled during hardening.
- Disk `flow.py` upload through `uploadWorkspaceFile` is covered with a Node-side `Blob`/`File` compatible test.

### Task 5: RPA Web Routes And Client

Files:

- `apps/rpa-local-web/src/server/routes/codegen.ts`
- `apps/rpa-local-web/src/server/server.ts`
- `apps/rpa-local-web/src/api/rpa-api-client.ts`
- `apps/rpa-local-web/tests/server/codegen-routes.test.ts`
- `apps/rpa-local-web/tests/api/rpa-api-client.test.ts`

Steps:

1. Register the four codegen routes under `/api/rpa/codegen`.
2. Start sessions by creating a store entry, launching codegen, and then starting hardening when recording exits successfully.
3. Make session status polling return the public summary.
4. Wire cancellation through codegen runner, daemon client, and session store.
5. Wire question-form answers through the hardening workflow.
6. Add browser client helpers:
   - `startCodegenSession`
   - `getCodegenSession`
   - `cancelCodegenSession`
   - `submitCodegenQuestionAnswers`

Tests:

- Route validation returns structured 400 for invalid URL/flow id.
- Start route rejects an existing final flow by default.
- Start route returns session summary.
- Status route hides absolute paths.
- Cancel route is idempotent.
- Answer route rejects mismatched form id.
- Client helpers call the expected endpoints.

### Task 6: Codegen UI

Files:

- `apps/rpa-local-web/src/components/CodegenWorkspace.tsx`
- `apps/rpa-local-web/src/components/QuestionForm.tsx`
- `apps/rpa-local-web/src/components/DaemonHardeningPanel.tsx`
- `apps/rpa-local-web/src/AppShell.tsx`
- `apps/rpa-local-web/src/styles.css`
- `apps/rpa-local-web/tests/components/codegen-workspace.test.tsx`

Steps:

1. Replace the placeholder codegen tab with an actual workspace.
2. Add a compact form:
   - target URL
   - flow id
   - optional flow name
   - start recording button
   - cancel button
3. Show session state:
   - recording status
   - hardening daemon run id
   - short logs
   - generated artifacts
   - error state
4. Render `<question-form>` when the workflow requires user input.
5. After `hardened`, show:
   - generated DSL link/summary
   - report links/summaries
   - "verify" action that passes `flowId` into the existing runtime verification workspace.
6. Keep the UI operational and dense rather than landing-page style.
7. Do not show instructional copy that explains obvious UI behavior.

Question types for this slice:

- `text`
- `textarea`
- `radio`
- `checkbox`
- `select`

Tests:

- Start button calls API with target URL and flow id.
- Polling updates status.
- Needs-input status renders the question form.
- Submitting answers calls the answer API.
- Hardened status enables verification handoff.
- Error/cancel states render without layout breakage.

### Task 7: Verification And Documentation

Files:

- `docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md`
- `docs/rpa-local-bs-mvp-design.md`
- relevant tests under `apps/rpa-local-web/tests/`

Steps:

1. Mark this slice completed in the master plan after implementation and review.
2. Add a short design note that codegen MVP uses RPA Web managed Playwright codegen rather than user upload.
3. Run verification:

```bash
pnpm typecheck
pnpm build
pnpm test:rpa-local-web
```

4. Run focused daemon tests only if daemon client/request contract changes require it.
5. Request CC review with current diff and test output.
6. Fix P0/P1 review findings before commit.

## TDD Order

1. Write tests for config and session store.
2. Implement config and session store.
3. Write runner tests with a fake command.
4. Implement runner.
5. Write workflow tests with a fake daemon client.
6. Implement workflow.
7. Write route/client tests.
8. Implement routes/client.
9. Write component tests.
10. Implement UI.
11. Run full verification.
12. Request CC review.

## Parallel Work Guidance

Safe parallel groups:

- Group A: config + session store.
- Group B: codegen runner with fake command.
- Group C: UI component shell and client helper tests, after shared types exist.

Sequential dependencies:

- Hardening workflow depends on session store and daemon client contract.
- Routes depend on runner/workflow/store.
- Final UI verification handoff depends on codegen API shape.

## Acceptance Criteria

- User can start Playwright codegen from RPA Web.
- RPA Web records a single `input/flow.py` without requiring manual upload.
- RPA Web sends `input/flow.py` to daemon with `playwright-rpa-harden`.
- Daemon run uses `business-context`, not a business-composed final prompt.
- If Claude emits `<question-form>`, RPA Web renders it and continues with `revise + skillId`.
- Required artifacts are downloaded from daemon `output/*` and saved as a final flow.
- Final flow can be opened by the existing verification UI.
- Public APIs do not expose absolute local paths.
- Tests cover success, cancel, hardening failure, question-form follow-up, and artifact validation.
- `pnpm typecheck`, `pnpm build`, and `pnpm test:rpa-local-web` pass.

## CC Review Prompt

```text
任务背景：
我们正在实现 RPA 本地 B/S MVP。已完成 daemon 通用 business-context 能力、DSL/artifact contract、local executor backend、Minimal Runtime Verification UI。下一个切片是 Codegen 上传加固闭环：RPA Web 启动 Playwright codegen，保存 raw flow.py，交给 daemon 的 playwright-rpa-harden skill 加固，处理 question-form 续跑，下载 output artifacts，并交给 verification UI。

本轮 review 的目标：
只 review docs/superpowers/plans/2026-06-06-rpa-codegen-hardening-loop.md 这个执行计划是否可进入实现。重点检查 API/状态机/daemon 边界/question-form/artifact 落盘/测试范围是否合理。不要重新讨论 RPA MVP 总体架构，除非发现本计划和已确认边界冲突。

已确认边界：
- daemon 是通用 Claude Code runner，不理解 RPA DSL 或 Playwright。
- RPA Web 负责 codegen、业务上下文组织、artifact 下载和 verification handoff。
- daemon 负责 skill 注入、side files staging、最终 prompt 组装和执行。
- codegen MVP 采用 RPA Web 管理 Playwright codegen，不再要求用户手动上传 raw flow.py。
- raw codegen recording 存在 codegen-sessions 下；只有 hardened artifacts 才进入 flows/<flowId>/。

请输出：
1. 是否可以进入实现。
2. P0/P1 风险清单。
3. 必须调整的 API、状态机或任务顺序。
4. 缺失的关键测试。
5. 可后置的 P2 建议。
```
