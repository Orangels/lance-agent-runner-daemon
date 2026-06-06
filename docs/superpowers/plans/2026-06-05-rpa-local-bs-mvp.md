# RPA Local B/S MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local B/S RPA MVP that supports RPA Web-managed Playwright codegen recording hardening and natural-language script generation, then verifies and reuses generated RPA flows locally.

**Architecture:** Keep `apps/daemon` as a generic Claude Code runner. Put RPA product workflow, executor, DSL validation, execution storage, import/export, and UI in `apps/rpa-local-web`. The daemon injects skills and profile constraints, persists generic conversations/snapshots/observability, and never understands RPA DSL or Playwright.

**Tech Stack:** TypeScript ESM, Express, SQLite, React/Vite, Vitest, Python/Playwright runtime invoked by the RPA Web backend, existing Claude Code daemon skills under `apps/daemon/skills`.

---

## Non-Negotiable Scope

The MVP final target includes all three named implementation slices below. The order is execution sequencing only; it does not reduce scope.

- `codegen 上传加固闭环`: RPA Web starts Playwright codegen, writes a single-file `flow.py` into RPA Web flow input storage, automatically uploads it to daemon workspace, runs `playwright-rpa-harden`, produces required artifacts, and verifies locally.
- `自然语言生成闭环`: collect natural-language requirements, ask confirmation questions, use `rpa-script-generate`, produce required artifacts, verify locally.
- `流程复用与执行闭环`: render runtime params from DSL, run verify/run, import/export `.rpa.zip`, collect execution artifacts and review material.

Use these names in follow-up plans and commits. Do not replace them with ambiguous “first phase / second phase” wording.

## Review Inputs

- `docs/daemon-conversation-context-design.md`
- `docs/business-skill-observability-design.md`
- `docs/rpa-local-bs-mvp-design.md`
- `docs/rpa-skill-observability-design.md`
- `apps/daemon/skills/playwright-rpa-harden/`
- `apps/daemon/skills/rpa-script-generate/`

## Latest Plan Review Adjustments

The implementation plan review found one P1: prompt/skill/context snapshot persistence and `collectionMode` permission caps must land with the first daemon prompt-context work, not in a later review-bundle slice. This plan resolves that by making the first daemon slice include the minimal snapshot tables, hash/size fields, collection mode validation, and permission cap checks. The later daemon observability slice now only contains full review bundle export, complete log download, feedback storage, and sanitizer polish.

Slice 1 review also found that `daemon-composed` requires `conversation_seq` and stable cross-run transcript ordering. Because RPA MVP uses `business-context` for codegen, natural-language generation, question-form follow-up, and verify-repair, `daemon-composed` was split into a separate generic daemon slice instead of the RPA-unblocking Slice 1a. That separate Slice 1b is now completed.

Latest product decision: `codegen 上传加固闭环` implements RPA Web-managed Playwright codegen recording directly. RPA Web starts the codegen child process, controls the output path, validates the generated single-file `flow.py`, then automatically uploads it to daemon. Manual `flow.py` upload is not the primary MVP path.

## Current Implementation Progress

Completed so far:

- Slice 1a `Daemon Business Context And Minimal Snapshot Guard` landed in commit `1d4b5b8`.
- Slice 1b `Daemon-Composed Conversation Context` landed in commit `2bb593e`.
- `RPA Workspace Package Skeleton` landed in commit `e75a5ef`.
- `RPA DSL And Artifact Contract` landed in commit `b39829d`.
- `RPA Execution Backend And Local Executor` landed in commit `30c49da`.
- `Minimal Runtime Verification UI` landed in commit `bcd71d4`.
- `Codegen 上传加固闭环` is implemented and CC reviewed.
- `Daemon Generic Review Bundle And Feedback` landed in commit `a60948a`.
- `RPA Observability Extension And Skill Review Loop` landed in commit `a60948a`, with manifest polish follow-ups documented in commit `9c1165a`.
- `自然语言生成闭环` is implemented and CC reviewed.

Current planned slice:

- `流程复用与执行闭环`.

## Implementation Dependency Map

```text
Daemon business-context + minimal snapshot/collection guard (completed)
  -> RPA Web can run multi-turn skill workflows without knowing skill bodies

Daemon-composed conversation context (completed generic daemon capability)
  -> It is available for non-RPA generic continuation, but RPA MVP still uses explicit business-context

RPA workspace skeleton (completed)
  -> Gives product code a home without touching apps/web

RPA DSL/artifact contract (completed)
  -> Codegen hardening and natural-language generation can share executor/UI/import/export

RPA backend executor + minimal verification UI
  -> Generated scripts can be verified without adding RPA semantics to daemon core

Codegen 上传加固闭环
  -> Fastest complete demonstration path, using RPA Web-managed Playwright codegen recording and automatic daemon upload

Generic review bundle + RPA observability extension
  -> Lets us improve both skills from real Claude Code logs and executor results

自然语言生成闭环
  -> Uses the same DSL/artifact/executor path, with AskQuestion/question-form and chrome-devtools-mcp exploration

流程复用与执行闭环
  -> Proves generated flows can be configured, exported, imported, and run again locally
```

## Daemon Run Call Contract For RPA Workflows

RPA Web uses `kind` to express business intent and `promptMode` to express how daemon receives context. RPA Web owns workflow state and business context packaging; daemon owns final prompt composition, skill injection, side files staging, run execution, and generic persistence.

| Scenario | kind | promptMode | skillId | businessContext essentials |
| --- | --- | --- | --- | --- |
| First natural-language generation | `generate` | `business-context` | `rpa-script-generate` | Original requirement, target URL, business constraints, stage metadata |
| First codegen hardening | `generate` | `business-context` | `playwright-rpa-harden` | codegen session id, `inputFiles: ["input/flow.py"]`, recording source, stage metadata |
| Continue same flow after `<question-form>` answers | `revise` | `business-context` | original `skillId` | `previousRunId`, artifact paths, `formAnswers`, stage metadata |
| Fix after verify failure | `revise` | `business-context` | `playwright-rpa-harden` or `rpa-script-generate` | execution failure, failed step, screenshot/log/trace paths, current DSL/script/config paths |

`revise` means “modify existing flow/artifacts”; it does not mean daemon guesses hidden context. Every revise run must receive explicit business context from RPA Web. Legacy `generate + skillId + prompt` remains compatibility-only and is not the RPA MVP main path.

---

## Slice: Daemon Business Context And Minimal Snapshot Guard (Completed)

**Purpose:** Add the generic daemon-native `business-context` support plus the minimal collection/snapshot security substrate required by every later RPA workflow. `daemon-composed` is deliberately deferred because it needs `conversation_seq` and stable cross-run transcript ordering.

**Status:** Completed in commit `1d4b5b8`.

Note: this slice originally left `daemon-composed` deferred. `daemon-composed` was then activated by the follow-up Slice 1b in commit `2bb593e`.

**Files likely touched:**

- Modify: `apps/daemon/src/http/validation.ts`
- Modify: `apps/daemon/src/core/run-types.ts`
- Modify: `apps/daemon/src/core/run-service.ts`
- Modify: `apps/daemon/src/core/prompt-composer.ts`
- Modify: `apps/daemon/src/core/skill-staging.ts`
- Create: `apps/daemon/src/core/snapshot-service.ts`
- Modify: `apps/daemon/src/config/profiles.ts`
- Modify: `apps/daemon/src/config/auth.ts`
- Modify: `apps/daemon/src/db/schema.ts`
- Modify: `apps/daemon/src/db/repositories.ts`
- Tests: `apps/daemon/src/http/__tests__/validation.test.ts`
- Tests: `apps/daemon/src/core/__tests__/run-service.test.ts`
- Tests: `apps/daemon/src/core/__tests__/prompt-composer.test.ts`
- Tests: `apps/daemon/src/core/__tests__/skill-staging.test.ts`
- Tests: `apps/daemon/src/db/__tests__/schema.test.ts`
- Tests: `apps/daemon/src/db/__tests__/repositories.test.ts`
- Docs: `docs/api-reference.md`
- Docs: `docs/business-run-chat-integration-guide.md`
- Docs: `docs/configuration-reference.md`

**Tasks:**

- [x] Extend create-run request types with `promptMode = legacy | business-context | daemon-composed`, `currentPrompt`, `businessContext`, `conversationId`, and `collectionMode = lite | diagnostic | review`.
- [x] Keep legacy behavior compatible: existing `prompt + generate + skillId` still works and stores user-visible prompt semantics in `runs.prompt`.
- [x] Change validation matrix so `business-context` requires `currentPrompt` and forbids raw `prompt`; `daemon-composed` is recognized but rejected as deferred until the generic daemon-composed slice.
- [x] Allow `revise + skillId` only for non-legacy `business-context`.
- [x] Add profile/client permission caps for `collectionMode`: `maxCollectionMode`, `canReadLogs`, `canReadDebugEvents`.
- [x] Reject disallowed collection mode requests with a structured error such as `COLLECTION_MODE_NOT_ALLOWED`; do not silently downgrade.
- [x] Add lightweight run fields for `prompt_mode`, `current_prompt`, `collection_mode`, snapshot hash/size/persisted flags, and business context hash.
- [x] Add `run_prompt_snapshots`, `run_skill_snapshots`, and `run_context_snapshots` tables in the same slice that first writes snapshot data.
- [x] Persist `business_context_hash` and create-time context snapshot before queue insertion so queued-then-canceled runs remain reviewable.
- [x] Persist prompt snapshot hash/size when a final prompt is actually composed; persist full prompt only when `collectionMode` permits it.
- [x] Capture skill snapshot metadata and side files manifest during skill staging; persist full skill snapshot only when `collectionMode` permits it.
- [x] Store only user/assistant-visible content in conversation messages; never store final prompt in `run_messages.content`.
- [x] Build final prompt inside daemon by injecting skill instructions, staged side file paths, profile-owned run constraints, and business context.
- [x] Validate explicit `conversationId` workspace ownership before queue insertion and return a structured 4xx on mismatch.
- [x] Preserve the current `skill.hasSideFiles` short-circuit so skills without side files are not staged unnecessarily.
- [x] Add tests proving RPA-like business context does not cause daemon core to interpret DSL or Playwright.
- [x] Add tests for the RPA call contract: first generation uses `generate + business-context`, follow-up/question-form and verify-failure repair use `revise + business-context + skillId` with explicit business context.
- [x] Add tests for cross-workspace `conversationId` rejection, queued cancellation context snapshot persistence, lite-mode hash-only context snapshots, and updated create-run response ids.

**Acceptance:**

- `POST /api/runs` accepts legacy and `business-context` according to the matrix; `daemon-composed` is rejected as deferred.
- Existing tests for generate/revise continue to pass after compatibility updates.
- A test run with `promptMode: business-context` and `skillId: playwright-rpa-harden` composes a final prompt with skill content, but `run_messages` contains only the user-visible `currentPrompt`.
- A diagnostic run canceled while still queued keeps `businessContext` hash and full context snapshot; prompt/skill snapshots remain empty because no final prompt was sent to Claude Code.
- Snapshot tables exist before any code tries to persist prompt, skill, or context snapshots.
- Unauthorized `diagnostic` or `review` collection mode requests fail before a run is queued.
- `collectionMode` never controls SSE event verbosity; `eventVisibility` never controls prompt/skill/context persistence.
- `pnpm test:daemon` and `pnpm typecheck:daemon` pass.

**Suggested commit:** `Add daemon business context snapshot guard`

---

## Slice: Daemon-Composed Conversation Context (Completed)

**Purpose:** Add generic daemon-composed continuation after RPA-unblocking work is underway. This slice is not required by RPA MVP because RPA Web passes explicit `businessContext`.

**Status:** Completed in commit `2bb593e`.

**Tasks:**

- [x] Add `contextPolicy`.
- [x] Add `conversation_seq` to `run_messages`.
- [x] Allocate stable conversation-level sequence numbers for user messages, assistant placeholders, and additional assistant message segments.
- [x] Query conversation transcript by `conversation_seq`, not run-local `position`.
- [x] Implement daemon-composed prompt assembly with recent message count, per-message truncation, total-length cap, and generic warnings.
- [x] Add run-service integration tests proving cross-run transcript ordering is stable.

**Suggested commit:** `Add daemon composed conversation context`

---

## Slice: RPA Workspace Package Skeleton (Completed)

**Purpose:** Add `apps/rpa-local-web` as the local B/S RPA application without modifying `apps/web` into a product-specific UI.

**Status:** Completed in commit `e75a5ef`.

**Execution plan:** `docs/superpowers/plans/2026-06-05-rpa-local-web-skeleton.md`

**Files likely created:**

- Create: `apps/rpa-local-web/package.json`
- Create: `apps/rpa-local-web/tsconfig.json`
- Create: `apps/rpa-local-web/vite.config.ts`
- Create: `apps/rpa-local-web/src/main.tsx`
- Create: `apps/rpa-local-web/src/App.tsx`
- Create: `apps/rpa-local-web/src/styles.css`
- Create: `apps/rpa-local-web/src/server/index.ts`
- Create: `apps/rpa-local-web/src/server/daemon-client.ts`
- Create: `apps/rpa-local-web/src/shared/daemon-types.ts`
- Create: `apps/rpa-local-web/src/shared/rpa-api-types.ts`
- Modify: `package.json`
- Docs: `docs/rpa-local-bs-mvp-design.md` if command names change.

**Tasks:**

- [x] Create the new workspace package named `@lance-agent-runner/rpa-local-web`.
- [x] Add root scripts: `dev:rpa-local-web`, `build:rpa-local-web`, `test:rpa-local-web`, `typecheck:rpa-local-web`.
- [x] Implement a minimal backend server that serves the Vite app and exposes a local API namespace such as `/api/rpa/*`.
- [x] Implement a typed daemon client for workspace creation, file upload, run creation, run cancellation, SSE subscription, artifact listing, and artifact download.
- [x] Build an initial UI shell with tabs/sections for codegen hardening, natural-language generation, flows, executions, and settings.
- [x] Keep UI dense and operational; do not create a marketing landing page.

**Acceptance:**

- `pnpm --filter @lance-agent-runner/rpa-local-web typecheck` passes.
- `pnpm --filter @lance-agent-runner/rpa-local-web test` passes with smoke tests for the daemon client and basic UI rendering.
- The daemon client exposes `cancelRun(runId)` and tests its request path.
- Root `pnpm typecheck` and `pnpm build` include the new package or have explicit documented follow-up if root aggregation is intentionally deferred for a commit.

**Suggested commit:** `Add RPA local web workspace skeleton`

---

## Slice: RPA DSL And Artifact Contract (Completed)

**Purpose:** Freeze the MVP schema and artifact contract used by both script production modes, executor, import/export, and observability.

**Execution plan:** `docs/superpowers/plans/2026-06-06-rpa-dsl-artifact-contract.md`

**Status:** Completed in commit `b39829d`.

**Files likely created:**

- Create: `apps/rpa-local-web/src/shared/dsl-schema.ts`
- Create: `apps/rpa-local-web/src/shared/artifacts.ts`
- Create: `apps/rpa-local-web/src/server/flow-store.ts`
- Create: `apps/rpa-local-web/src/server/validators/dsl-validator.ts`
- Create: `apps/rpa-local-web/src/server/validators/artifact-validator.ts`
- Tests: `apps/rpa-local-web/src/server/validators/*.test.ts`

**Tasks:**

- [x] Define DSL v0.1 TypeScript types for `params`, `steps`, `target`, `wait`, `assert`, `write`, and `manual`.
- [x] Define required generation artifacts: `flow.dsl.json`, `flow.hardened.py`, `config.example.json`, `parameterization-report.md`, `hardening-report.md`.
- [x] Validate DSL before execution and before `.rpa.zip` import.
- [x] Validate daemon artifacts after generation/hardening before copying them into RPA flow storage.
- [x] Add readable validation errors suitable for UI display and `rpa-diagnostics.json`.
- [x] Add parameter form model derived from `flow.dsl.json.params`.

**Acceptance:**

- Invalid DSL cannot enter executor.
- Missing required artifacts produce clear errors and do not start verify/run.
- `params[].mask` is available to execution logs and RPA observability redaction logic.
- Tests cover valid minimal DSL, missing step fields, unsupported selector type, missing wait/assert warnings, and masked params.

**Suggested commit:** `Add RPA DSL and artifact validators`

---

## Slice: RPA Execution Backend And Local Executor (Completed)

**Purpose:** Implement `rpa-local-executor` as an internal backend module of `apps/rpa-local-web`, not a separate service.

**Execution plan:** `docs/superpowers/plans/2026-06-06-rpa-execution-backend-local-executor.md`

**Files likely created:**

- Create: `apps/rpa-local-web/src/server/executor/execution-types.ts`
- Create: `apps/rpa-local-web/src/server/executor/execution-store.ts`
- Create: `apps/rpa-local-web/src/server/executor/python-playwright-executor.ts`
- Create: `apps/rpa-local-web/src/server/executor/process-manager.ts`
- Create: `apps/rpa-local-web/src/server/executor/artifact-collector.ts`
- Create: `apps/rpa-local-web/src/server/executor/execution-events.ts`
- Create: `apps/rpa-local-web/src/server/routes/executions.ts`
- Tests: executor store/process/event tests.

**Tasks:**

- [x] Create per-flow and per-execution directories owned by RPA Web, separate from daemon workspace paths.
- [x] Implement `executionId`, `daemonRunId`, and `flowId` association.
- [x] Implement backend APIs: start verify/run, cancel, status, SSE events, logs, current screenshot, and execution artifact download.
- [x] Emit events around `run.started`, `log`, `artifact.created`, and `run.completed`; step event types remain reserved for generated scripts/UI integration.
- [x] Run Python script with `--mode verify|run`, optional `--dry-run`, and `--params run.params.json`.
- [x] Implement timeout, cancellation, stdout/stderr capture, and terminal status handling.
- [x] Store execution artifacts under RPA Web execution storage, not daemon `output/`.

**Acceptance:**

- A fake Python script can be started, streamed, cancelled, and inspected through RPA Web backend APIs.
- Execution records persist enough metadata for review: `daemonRunId`, `flowId`, params redacted summary, mode, headless, dryRun, status, failedStepId, and terminal errors; internal script/config paths are not exposed through API records.
- Executor APIs never expose daemon workspace absolute paths.
- Tests cover successful run, failed run, cancellation, and artifact collection.
- `.rpa.zip` export package download is intentionally deferred to the flow reuse/import-export slice.

**Implementation commit:** `30c49da`

**Verification:** `pnpm --filter @lance-agent-runner/rpa-local-web test`, `pnpm --filter @lance-agent-runner/rpa-local-web typecheck`, `pnpm --filter @lance-agent-runner/rpa-local-web build`, `pnpm typecheck`, `pnpm build`, and daemon boundary grep passed.

**CC review:** initial review found two P1 issues around SSE disconnect cleanup and route-level terminal streaming coverage. Both were fixed; second review reported no remaining P0/P1 and recommended commit.

**Suggested commit:** `Add RPA local executor backend`

---

## Slice: Minimal Runtime Verification UI (Completed)

**Purpose:** Provide the minimal verification display that codegen and natural-language loops depend on: step list, current log stream, current screenshot, and execution status.

**Status:** Completed in commit `bcd71d4`.

**Execution plan:** `docs/superpowers/plans/2026-06-06-rpa-runtime-verification-ui.md`

**Files likely touched:**

- Create/Modify: `apps/rpa-local-web/src/components/StepList.tsx`
- Create/Modify: `apps/rpa-local-web/src/components/ExecutionLogPanel.tsx`
- Create/Modify: `apps/rpa-local-web/src/components/ScreenshotPanel.tsx`
- Create/Modify: `apps/rpa-local-web/src/components/ArtifactPanel.tsx`
- Create/Modify: `apps/rpa-local-web/src/server/executor/*`

**Tasks:**

- [x] Render DSL step list with current step, status, duration, and error message.
- [x] Render current step screenshot and optional bbox/highlight metadata when present.
- [x] Stream execution logs and important events without requiring full page refresh.
- [x] Support verify mode defaults: headed browser, dry-run on, step confirmation/highlight on where available.
- [x] Support run mode defaults: headless by default, audit logs on, high-risk writes only if configured.
- [x] Keep trace/video optional according to collectionMode and RPA saving matrix.

**Acceptance:**

- User can visually follow verify execution using real browser plus RPA Web step/log/screenshot view.
- Daily run can be executed headless without real-time visual demo.
- Failed step links to log, screenshot reference, and DSL step id.
- Codegen and natural-language workflow slices can reuse this UI instead of inventing separate verification views.

**Verification:** targeted slice tests, full RPA web tests, RPA web typecheck/build, root `pnpm typecheck`, root `pnpm build`, daemon boundary grep, test-layout checks, and `git diff --check` passed. Full RPA web tests were run outside the sandbox because server tests require local port listening and child process I/O.

**CC review:** initial review found one P1 around missing `RuntimeVerificationWorkspace` reuse props (`flowId`, `onFlowIdChange`, `autoStartRequest`). The implementation was updated with controlled flow id support, auto-start by request id, component-level sequence dedupe, and tests. Directed re-review reported the P1 resolved, no new P0/P1, and approved commit.

**Suggested commit:** `Add minimal RPA verification UI`

---

## Slice: Codegen 上传加固闭环 (Completed)

**Purpose:** Deliver the fastest end-to-end script production path: RPA Web starts Playwright codegen, records user actions into a single-file `flow.py`, uploads that file to daemon, runs the hardening skill, validates artifacts, and verifies locally.

**Status:** Implemented and CC reviewed.

**Execution plan:** `docs/superpowers/plans/2026-06-06-rpa-codegen-hardening-loop.md`

**Files likely touched:**

- Create: `apps/rpa-local-web/src/server/codegen/codegen-types.ts`
- Create: `apps/rpa-local-web/src/server/codegen/codegen-session-store.ts`
- Create: `apps/rpa-local-web/src/server/codegen/playwright-codegen-runner.ts`
- Create: `apps/rpa-local-web/src/server/routes/codegen.ts`
- Modify/Create RPA Web server workflow files under `apps/rpa-local-web/src/server/workflows/`
- Modify/Create RPA Web UI components under `apps/rpa-local-web/src/components/`
- Reuse: `apps/daemon/skills/playwright-rpa-harden/`
- Tests: codegen runner/session store, workflow, and UI tests.

**Tasks:**

- [x] Add UI for target URL, flow name, start recording, cancel recording, and recording status.
- [x] Implement RPA Web backend codegen sessions with states: `starting | recording | completed | hardening | needs_input | hardened | failed | cancelled`; `idle` is UI-only before a session exists.
- [x] Start Playwright codegen from the RPA Web backend, not daemon core, using a command shaped like `playwright codegen --target python -o <flowInputDir>/flow.py <targetUrl>`.
- [x] Store codegen output in an RPA Web-owned flow input directory; do not write directly into daemon workspace and do not expose daemon absolute paths.
- [x] Treat the codegen session as completed when the Playwright codegen child process exits successfully.
- [x] Support cancel by terminating the codegen child process and marking the session `cancelled`.
- [x] On successful exit, verify `<flowInputDir>/flow.py` exists, is non-empty, and is the only supported codegen script input for MVP.
- [x] Automatically upload the generated `flow.py` to daemon workspace as `input/flow.py` using daemon file upload API.
- [x] Create a per-session daemon workspace, then create daemon run with `profileId`, `workspaceId`, `currentPrompt`, `kind: generate`, `skillId: playwright-rpa-harden`, and `promptMode: business-context`, using business context that includes codegen session id, `inputFiles: ["input/flow.py"]`, recording source, and stage metadata; legacy `generate + skillId + prompt` remains a compatibility fallback, not the final multi-turn workflow.
- [x] Subscribe to daemon SSE and show user-visible assistant output and artifact progress.
- [x] If Claude Code outputs `<question-form>`, persist the form id/version/questions, render it, and submit answers into a follow-up run.
- [x] For follow-up runs, create `kind: revise`, `skillId: playwright-rpa-harden`, `promptMode: business-context`; RPA Web must pass `profileId`, `workspaceId`, `conversationId`, `currentPrompt`, form answers, previous daemon run id, previous artifact paths, and stage metadata through the request and `businessContext`; it must not rely on daemon implicit history or read SKILL.md.
- [x] Download required artifacts from daemon artifact API into RPA Web flow storage.
- [x] Validate artifacts and DSL.
- [x] Render `parameterization-report.md`, `hardening-report.md`, DSL steps, and generated script preview.
- [x] Start verify using the local executor and display steps/logs/screenshots through the minimal runtime verification UI.

**Deferred follow-up:**

- If verify fails and the user chooses Claude Code repair, create `kind: revise`, `skillId: playwright-rpa-harden`, `promptMode: business-context`, with execution failure, failed step id, screenshot/log/trace paths, and current DSL/script/config paths.
- Use a temporary local mock page if the final demo target page is not chosen yet.

**Acceptance:**

- User can start Playwright codegen from RPA Web, record actions in a headed browser, close/finish recording, and receive all five required hardened artifacts without manually uploading `flow.py`.
- RPA Web knows the generated `flow.py` path because it created the flow input directory and passed `-o <flowInputDir>/flow.py` to Playwright codegen.
- Cancelling a codegen session terminates the child process and does not create a daemon hardening run.
- Question-form follow-up runs carry enough business context to continue parameterization/hardening without RPA Web composing the final prompt.
- Verify uses RPA Web-owned copies of artifacts, not daemon workspace paths.
- Codegen path supports only single-file `flow.py`; multi-file codegen package is explicitly rejected with a clear message.
- A local mock page can be used to complete the codegen demo before the final demo page is chosen.

**Verification:** `pnpm --filter @lance-agent-runner/rpa-local-web test`, `pnpm typecheck`, `pnpm build`, and `git diff --check` passed. Full RPA web tests were run outside the sandbox because server tests require local port listening and child process I/O.

**CC review:** initial review found P1 issues around partial flow directory cleanup, artifact download response handling, and cancelled-session error state. These were fixed; targeted re-review reported all P1 items resolved, no new P0/P1, daemon/RPA boundary clean, and recommended commit.

**Suggested commit:** `Implement RPA Web managed codegen hardening loop`

---

## Slice: Daemon Generic Review Bundle And Feedback (Completed)

**Purpose:** Add full generic skill review-bundle capabilities after the first RPA loop has produced real run/execution material. This slice remains business-agnostic.

**Status:** Implemented and CC reviewed.

**Execution plan:** `docs/superpowers/plans/2026-06-06-daemon-generic-review-bundle-feedback.md`

**Files likely touched:**

- Modify: `apps/daemon/src/core/run-log-service.ts`
- Modify: `apps/daemon/src/core/log-sanitizer.ts`
- Modify: `apps/daemon/src/core/artifact-service.ts`
- Modify: `apps/daemon/src/http/logs-routes.ts`
- Create: `apps/daemon/src/core/review-bundle-service.ts`
- Modify: `apps/daemon/src/db/schema.ts`
- Modify: `apps/daemon/src/db/repositories.ts`
- Tests: daemon core/http/db tests around complete logs, review bundle export, feedback, redaction, permissions.
- Docs: `docs/api-reference.md`
- Docs: `docs/configuration-reference.md`

**Tasks:**

- [x] Add complete log download or review bundle export with correct permissions.
- [x] Add generic `review-summary.md`, `diagnostics.json`, `large-files-manifest.json`, and manifest extension hook.
- [x] Add generic feedback storage where daemon stores but does not interpret business categories.
- [x] Add sanitizer coverage for tokens, cookies, secrets, storage state, local absolute paths, and sensitive config fields.
- [x] Keep production default lightweight: `collectionMode: lite` should not persist full prompt/skill/debug events by default.

**Acceptance:**

- Review bundle export includes generic files and supports an `extensions/` hook without daemon knowing RPA internals.
- Complete stdout/stderr download requires `canReadLogs`; raw debug events or tool results require `canReadDebugEvents`.
- Generic feedback categories can be stored and queried without daemon interpreting RPA categories.
- `pnpm test:daemon` and `pnpm typecheck:daemon` pass.

**Verification:** daemon targeted tests, `pnpm --filter @lance-agent-runner/daemon test`, `pnpm typecheck`, `pnpm build`, and `git diff --check` passed. HTTP route tests were run outside the sandbox because they listen on local ports.

**CC review:** initial review found two P1 issues around shared `Content-Disposition` safety and `diagnostics.size.byteCount`. Both were fixed; follow-up review reported the P1 items resolved, no new P0/P1, and approved final verification plus commit.

**Suggested commit:** `Add generic review bundle and feedback`

---

## Slice: RPA Observability Extension And Skill Review Loop (Completed)

**Purpose:** Attach RPA-specific execution diagnostics to the generic review bundle so the two RPA skills can be improved from real runs.

**Execution plan:** `docs/superpowers/plans/2026-06-06-rpa-observability-extension-skill-review-loop.md`

**Files likely created/touched:**

- Create: `apps/rpa-local-web/src/server/observability/rpa-diagnostics.ts`
- Create: `apps/rpa-local-web/src/server/observability/rpa-summary.ts`
- Create: `apps/rpa-local-web/src/server/observability/rpa-redaction.ts`
- Modify: RPA Web backend bundle/export path.
- Possibly modify daemon generic review bundle service only through its extension hook.

**Tasks:**

- [x] Generate `extensions/rpa/rpa-summary.md` for AI-first review.
- [x] Generate `extensions/rpa/rpa-diagnostics.json` with bounded lists and omitted counts.
- [x] Generate `dsl-validation.json` and `artifact-validation.json`.
- [x] Attach execution records by `executionId`, `daemonRunId`, and `flowId`.
- [x] Apply RPA redaction rules for `params[].mask`, common ID/phone patterns, execution logs, and feedback text.
- [x] Treat screenshots, trace, video, and downloads as large/high-sensitive files referenced by path/hash unless explicitly exported in review mode.
- [x] Record RPA feedback categories: `dsl`, `selector`, `wait`, `assert`, `parameterization`, `write-risk`, `manual-step`, `executor`.

**Acceptance:**

- Review bundle contains generic materials plus `extensions/rpa/` without daemon core understanding DSL.
- Bundle summary is small enough for AI review and points to raw files only as needed.
- `collectionMode` controls persistence/export of RPA materials; `eventVisibility` does not.
- No secrets or storage state are exported by default.

**Verification:**

- `pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/observability tests/server/routes/review.test.ts`
- `pnpm --filter @lance-agent-runner/rpa-local-web test`
- `pnpm --filter @lance-agent-runner/rpa-local-web typecheck`
- `pnpm --filter @lance-agent-runner/rpa-local-web build`
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`
- `rg -n "RPA|Playwright|DSL|selector|screenshot|trace|video|executionId|flowId" apps/daemon/src`

**CC review summary:** Opus review found no P0/P1 and confirmed daemon/RPA boundaries. P2-1 short masked-param over-redaction was fixed in this slice; P2-2 manifest logical path parsing and P2-3 largeFiles completeness can be handled later.

**Deferred manifest polish:** After the natural-language generation loop is completed, or before the first real skill-review bundle is used to tune the RPA skills, revisit two bundle-manifest details: derive `dslPath` / `scriptPath` from actual daemon bundle entries instead of treating them only as logical convention paths, and record every execution artifact in `largeFiles` with an accurate `included` flag even when `includeSensitiveFiles=true` inlines the file body.

**Suggested commit:** `Add RPA observability extension`

---

## Slice: 自然语言生成闭环 (Completed)

**Purpose:** Add natural-language script generation using `rpa-script-generate`, confirmation forms, and chrome-devtools-mcp exploration through the RPA profile.

**Execution plan:** `docs/superpowers/plans/2026-06-06-rpa-natural-language-generation-loop.md`

**Status:** Implemented and CC reviewed. Initial CC review found one P1 around natural-language failure transitions; the fix added legal `needs_input/generated -> failed` transitions and regression coverage. CC second review confirmed the P1 was resolved and found no new P0/P1.

**Files likely touched:**

- Modify/Create workflow files under `apps/rpa-local-web/src/server/workflows/`
- Modify/Create confirmation form parser and UI components.
- Reuse: `apps/daemon/skills/rpa-script-generate/`
- Modify: daemon profile/config docs or local example config for `rpa-local`.
- Tests: question-form parser, workflow context packaging, daemon run request shape.

**Tasks:**

- [x] Add UI for natural-language target description, target URL, business constraints, and safety notes.
- [x] Create the first daemon run with `kind: generate`, `skillId: rpa-script-generate`, and `promptMode: business-context`, using business context that includes original requirement, target URL, business constraints, and stage metadata.
- [x] Create confirmation/revision runs with `kind: revise`, `skillId: rpa-script-generate`, and `promptMode: business-context` where the legality matrix permits it; include `previousRunId`, artifact paths, `formAnswers`, and stage metadata.
- [x] Pass business context package: original requirement, current prompt, form answers, previous run/artifact paths, exploration notes path, and stage metadata.
- [x] Parse `<question-form version="rpa-question-form.v0.1">` from assistant output.
- [x] Render `radio`, `checkbox`, `select`, `text`, and `textarea` only.
- [x] Submit form answers as ordinary user-visible conversation content and business context for the next run.
- [x] Ensure chrome-devtools-mcp is profile-provided through Claude Code config, not daemon core.
- [x] Download and validate the same required artifacts as codegen.
- [x] Reuse the same verify/executor path.
- [x] If verify fails and the user chooses Claude Code repair, create `kind: revise`, `skillId: rpa-script-generate`, `promptMode: business-context`, with execution failure, failed step id, screenshot/log/trace paths, and current DSL/script/config paths.

**Acceptance:**

- User can describe a low-risk no-login demo flow, answer confirmation forms, and get the same five required artifacts.
- The natural-language path never requires RPA Web to know or concatenate SKILL.md content.
- Unknown page branches or high-risk write actions produce a question form instead of guessed business logic.
- Production execution uses `flow.hardened.py`; chrome-devtools-mcp is exploration-only.

**Suggested commit:** `Implement natural language RPA generation loop`

**Verification:**

- `pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/workflows/question-form-parser.test.ts tests/server/workflows/daemon-run-consumer.test.ts tests/server/workflows/generation-artifact-service.test.ts tests/server/nl-session-store.test.ts tests/server/natural-language-generation-workflow.test.ts tests/server/codegen-hardening-workflow.test.ts tests/components/codegen-workspace.test.tsx`
- `pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/server/routes/natural-language.test.ts tests/server/server.test.ts`
- `pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run tests/components/NaturalLanguageWorkspace.test.tsx tests/components/RuntimeVerificationWorkspace.test.tsx tests/App.test.tsx`
- `pnpm --filter @lance-agent-runner/rpa-local-web typecheck`
- `pnpm --filter @lance-agent-runner/rpa-local-web test`
- `pnpm --filter @lance-agent-runner/rpa-local-web build`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test`
- `git diff --check`
- Daemon boundary grep for RPA/Playwright/DSL/executor/chrome-devtools terms returned no matches under `apps/daemon/src`.

**CC Review Summary:**

- First opus review: no P0; one P1 on failure transitions from `needs_input` / `generated`; boundary verdict passed.
- Fix: added legal failed transitions, regression tests, duplicate final-flow rejection, and storageRoot redaction for repair failure evidence.
- Second opus review: prior P1 resolved, no new P0/P1, proceed to commit.

---

## Slice: 流程复用与执行闭环 (Completed)

**Purpose:** Prove generated flows are reusable across users/machines through parameter forms and `.rpa.zip` import/export.

**Execution plan:** `docs/superpowers/plans/2026-06-06-rpa-flow-reuse-execution-loop.md`

**Status:** Implemented and CC reviewed.

**Files created:**

- Create: `apps/rpa-local-web/src/server/packages/rpa-package.ts`
- Create: `apps/rpa-local-web/src/server/packages/manifest-schema.ts`
- Create: `apps/rpa-local-web/src/server/routes/packages.ts`
- Create: `apps/rpa-local-web/src/server/zip/uncompressed-zip.ts`
- Create: `apps/rpa-local-web/src/shared/runtime-params.ts`
- Create: `apps/rpa-local-web/src/components/RuntimeParamsForm.tsx`
- Create: `apps/rpa-local-web/src/components/FlowAssetsWorkspace.tsx`
- Tests: package import/export and parameter form tests.

**Tasks:**

- [x] Render runtime parameter form directly from `flow.dsl.json.params`.
- [x] Save user runtime values to `run.params.json` per execution.
- [x] Validate required params and type constraints before starting executor.
- [x] Export `.rpa.zip` containing `manifest.json`, `flow.dsl.json`, `flow.hardened.py`, `config.example.json`, `parameterization-report.md`, and `hardening-report.md`.
- [x] Do not export secrets, storage state, cookies, tokens, CA/USB-Key files, trace/video by default.
- [x] Import `.rpa.zip`, validate manifest and DSL, require local config/params confirmation before verify/run.
- [x] Preserve flow identity and show imported package provenance.

**Acceptance:**

- A flow produced by one local session can be exported and imported into another local session without carrying secrets.
- Imported flow cannot run until required params/config are supplied.
- Export manifest records schema versions, artifact hashes, generatedAt, source mode, and required params summary.

**Validation:**

- `pnpm --filter @lance-agent-runner/rpa-local-web test`
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`
- Daemon boundary grep for RPA/Playwright/DSL/executor/chrome-devtools terms returned no matches under `apps/daemon/src`.

**CC Review Summary:**

- First opus review: no P0; one P1 on duplicate auto-start verify after successful verify.
- Fix: replaced render-time `Date.now()` request id with click-time nonce, unmounted runtime workspace before flow reload, and added a regression assertion that verify starts once.
- Second opus review: prior P1 resolved, no new P0/P1, proceed to commit.

**Suggested commit:** `Add RPA flow import export and runtime params`

---

## Slice: Demo Flow And Compatibility Gate

**Purpose:** Lock a low-risk demo scenario and verify the MVP works on the intended local B/S deployment shape.

**Execution plan:** `docs/superpowers/plans/2026-06-06-rpa-demo-flow-compatibility-gate.md`

**Files created:**

- Create: `docs/rpa-local-web-demo-runbook.md`
- Create: `docs/rpa-local-web-compatibility-checklist.md`
- Create: `docs/rpa-local-web-demo-results-template.md`
- Create: `apps/rpa-local-web/demo/prompts/google-images-codegen-handoff.md`
- Create: `apps/rpa-local-web/demo/prompts/weather-natural-language-request.md`
- Create: `apps/rpa-local-web/public/demo/mock-rpa-target.html`

**Tasks:**

- [ ] Lock two no-login, no-real-write demo flows: Google Images through codegen hardening and weather.com.cn through natural-language generation.
- [ ] Ensure the two demos cover params, navigation, input/click, wait/assert, screenshot/log, image download artifact, and weather extraction artifact.
- [ ] Add a local runbook for daemon + RPA Web startup and both demo flows.
- [ ] Add compatibility checklist for Node, Python, Playwright browser install, headed mode, screenshots, trace, downloads, and local Chrome path override.
- [ ] Add demo prompt fixtures for Google Images codegen handoff and weather.com.cn natural-language request.
- [ ] Add local fallback mock page for repeatable product-chain verification when external sites are blocked.
- [ ] Add demo results template for execution IDs, artifact paths, blockers, and final decision.
- [ ] Verify codegen hardening path and natural-language path both reach local verify.

**Acceptance:**

- Local operator can run `pnpm dev:daemon` and `pnpm dev:rpa-local-web` or documented equivalents.
- Demo requires no login, captcha, CA/USB-Key, or real write operation.
- Both script production modes produce required artifacts and complete verify.
- `pnpm typecheck`, `pnpm build`, and relevant package tests pass before declaring MVP ready for demo.

**Suggested commit:** `Document and validate RPA MVP demo flow`

---

## Cross-Cutting Rules For Implementation

- Do not move RPA DSL, Playwright execution, screenshot/trace logic, or RPA routes into `apps/daemon/src/core`.
- Do not let RPA Web read SKILL.md bodies or compose final Claude Code prompt.
- Do not expose daemon workspace absolute paths to RPA executor APIs or frontend responses.
- Use daemon artifact download APIs to copy generated files into RPA Web flow storage.
- Keep generated/execution runtime files out of git.
- Keep `apps/web` as the generic runner console; do not turn it into the RPA product UI.
- Keep RPA skill edits small during implementation; use real run review bundles to improve them after the first end-to-end tests.

## Review Checkpoints

Run CC review after these checkpoints, not after every tiny commit:

- After daemon generic context plus minimal snapshot/collection guard is implemented.
- After RPA Web backend/executor APIs and minimal verification UI are implemented.
- After `codegen 上传加固闭环` works end to end with RPA Web-managed Playwright codegen recording.
- After generic review bundle plus RPA observability extension is implemented.
- After `自然语言生成闭环` works end to end.
- Before final MVP demo hardening.

## Verification Commands

Minimum verification after each slice:

```bash
pnpm typecheck
pnpm test
```

When RPA Web is added, also run targeted commands:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web typecheck
pnpm --filter @lance-agent-runner/rpa-local-web test
pnpm --filter @lance-agent-runner/rpa-local-web build
```

Before declaring the MVP demo ready:

```bash
pnpm typecheck
pnpm build
pnpm test
```

## Recently Completed UI Cleanup

- RPA Web topbar and Settings now read `GET /api/rpa/config` and `GET /api/rpa/daemon/health`; keep future UI improvements in `apps/rpa-local-web` and do not add RPA-specific health semantics to `apps/daemon`.

## Known Follow-Ups

- Add generic daemon profile support for explicit MCP config files, e.g. `profiles[].mcpConfigPaths`, and pass them to Claude Code as `--mcp-config <file>`. This is needed so `rpa-local` can reliably load `chrome-devtools-mcp` in daemon-launched non-interactive `claude -p` runs instead of depending on the system default interactive Claude Code session.
- Add an RPA profile-owned `mcp.chrome-devtools.json` with fixed `chrome-devtools-mcp` version, disabled usage statistics/update checks/performance CrUX, explicit Chrome/Chromium executable or browser URL, dedicated user data dir, and required display environment.
- Add a preflight check that runs with the same `CLAUDE_CONFIG_DIR`, `PATH`, `DISPLAY`, `cwd`, and `--mcp-config` that daemon will use, then reports whether `chrome-devtools-mcp` connected and exposed tools. If unavailable, RPA Web should show a clear degraded state and let the workflow either fail fast or use the documented WebFetch/curl fallback.

## Open Questions To Confirm During Implementation, Not Before Coding

- Exact demo target page or local mock flow.
- Exact browser binary strategy on the first国产系统 test machine.
- Whether trace/video are enabled for the demo by default or only in review export.
- Exact `.rpa.zip` manifest version once import/export code starts.
- Whether multi-file codegen packages or manual `flow.py` upload fallback are worth adding after RPA Web-managed single-file codegen succeeds.
