# Reference

This project implements a standalone Claude Code CLI runner daemon.

The design was extracted from the lanceDesign daemon pipeline, but this project should not copy lanceDesign product logic wholesale. Use lanceDesign as the reference implementation for the Claude Code CLI run pipeline only.

## Source Reference Repo

```text
/home/orangels/ls_dev/lanceDesign
```

## Design Docs

Local copies in this project:

```text
docs/claude-code-runner-daemon-design.md
docs/claude-code-runner-daemon-migration-assessment.md
docs/claude-code-runner-daemon-implementation-plan.md
docs/claude-code-runner-daemon-version-roadmap.md
```

Original docs in lanceDesign:

```text
/home/orangels/ls_dev/lanceDesign/docs/claude-code-runner-daemon-design.md
/home/orangels/ls_dev/lanceDesign/docs/claude-code-runner-daemon-migration-assessment.md
```

## Must-Read lanceDesign References

Core run service and SSE:

```text
/home/orangels/ls_dev/lanceDesign/apps/daemon/src/runs.ts
/home/orangels/ls_dev/lanceDesign/apps/daemon/src/chat-routes.ts
```

Key symbols:

```text
runs.ts: create/start/get/list/stream/cancel/shutdownActive/wait/emit/finish/fail/statusBody/isTerminal
chat-routes.ts: POST /api/runs -> 202 { runId }, GET /api/runs/:id/events
```

Claude Code CLI adapter and stream parser:

```text
/home/orangels/ls_dev/lanceDesign/apps/daemon/src/runtimes/defs/claude.ts
/home/orangels/ls_dev/lanceDesign/apps/daemon/src/claude-stream.ts
```

Claude Code spawn pipeline:

```text
/home/orangels/ls_dev/lanceDesign/apps/daemon/src/server.ts
```

Key symbols:

```text
startChatRun around server.ts:3409
createSseErrorPayload around server.ts:1802
createSseResponse around server.ts:2049
```

Focus on the `startChatRun` flow only:

```text
resolve cwd
compose prompt
stage active skill
build Claude args
spawn child process
prompt via stdin
stdout stream-json parser
stderr tail
inactivity watchdog
child close -> succeeded / failed / canceled
cancel / SIGTERM / SIGKILL handling
auth failure diagnosis
```

Skill registry and staging:

```text
/home/orangels/ls_dev/lanceDesign/apps/daemon/src/skills.ts
/home/orangels/ls_dev/lanceDesign/apps/daemon/src/cwd-aliases.ts
```

Key symbols:

```text
skills.ts: withSkillRootPreamble around line 388
cwd-aliases.ts: SKILLS_CWD_ALIAS='.lancedesign-skills', stageActiveSkill
```

SQLite and message persistence semantics:

```text
/home/orangels/ls_dev/lanceDesign/apps/daemon/src/db.ts
/home/orangels/ls_dev/lanceDesign/apps/daemon/src/project-routes.ts
```

Frontend message accumulation reference — rebuild on daemon side, do not copy as-is:

```text
/home/orangels/ls_dev/lanceDesign/apps/web/src/providers/daemon.ts
/home/orangels/ls_dev/lanceDesign/apps/web/src/components/ProjectView.tsx
/home/orangels/ls_dev/lanceDesign/apps/web/src/state/projects.ts
```

In lanceDesign this flow lives in the web client:

```text
consumeDaemonRun -> translateAgentEvent -> ProjectView text/events accumulator -> saveMessage
```

Key symbols:

```text
providers/daemon.ts: consumeDaemonRun around line 312, translateAgentEvent around line 522
state/projects.ts: saveMessage around line 290
ProjectView.tsx: message-level run event id and lastRunEventId handling around lines 1258 and 1657
```

The new daemon must move this into a daemon-side per-run accumulator. Persistence is triggered by the run lifecycle and Claude parser events, never by a frontend consuming SSE.

## Current Version Status

The original first-version phases are complete through queue/timeout/hardening:

```text
Phase 0a: API contract
Phase 0: profile/auth/workspace/SQLite
Phase 1: minimal Claude Code run + daemon-side message persistence
Phase 2: skill + artifact
Phase 3: queue + timeout + hardening
```

Phase 4 has also landed as a narrow input-ingestion extension:

```text
POST /api/workspaces/:workspaceId/files
```

The current repository should be treated as the first-version landing-test candidate. Later capabilities such as remote URL pull, S3/object-storage pull, metrics exposure, profile hot reload, artifact watcher previews, workspace retention, distributed queue, Claude Code native resume/fork, and OS-level isolation are tracked as later-version work in:

```text
docs/claude-code-runner-daemon-version-roadmap.md
```

Cross-service contract prototypes, required for Phase 0a contract freeze:

```text
/home/orangels/ls_dev/lanceDesign/packages/contracts/src/api/chat.ts
/home/orangels/ls_dev/lanceDesign/packages/contracts/src/sse/chat.ts
```

Env allowlist and runtime env references:

```text
/home/orangels/ls_dev/lanceDesign/apps/daemon/src/app-config.ts
/home/orangels/ls_dev/lanceDesign/apps/daemon/src/runtimes/env.ts
/home/orangels/ls_dev/lanceDesign/apps/daemon/src/runtimes/registry.ts
```

Claude diagnostics reference:

```text
/home/orangels/ls_dev/lanceDesign/apps/daemon/src/claude-diagnostics.ts
```

Only reuse the diagnostic classification ideas. Rewrite all lanceDesign-specific wording, settings references, and `LANCE_DESIGN_*` details.

## Migration Boundary

Directly reusable or lightly reusable:

```text
claude-stream.ts
cwd-aliases.ts
runtimes/defs/claude.ts
runs.ts
```

Notes:

```text
runs.ts still needs generic metadata, SQLite repository writes, queue integration, and daemon-side accumulator hooks.
runtimes/defs/claude.ts still needs profile-controlled permissionMode, defaultModel, and allowedModels handling.
cwd-aliases.ts should rename .lancedesign-skills to .claude-runner-skills and update log prefixes.
```

Reusable as a narrowed subset:

```text
skills.ts
server.ts createSseResponse / createSseErrorPayload
server.ts startChatRun spawn pipeline
claude-diagnostics.ts classification logic
```

Must build new, no direct lanceDesign equivalent:

```text
profile config
API-key auth and client isolation
workspace-service
SQLite persistence for workspaces / runs / run_messages
queue and concurrency
per-workspace serial execution
artifact rules and artifact scan
artifact download API
run_logs and profile_snapshots
```

Do not migrate lanceDesign product logic:

```text
design systems
craft
memory
critique theater
analytics
preview comments
deployments
tabs
routines / orbit
media tasks
live artifact MCP
external MCP settings
lancedesign tool token
local-client bundled runtime
```

## First-Version Contract Summary

Workspace flow:

```text
POST /api/workspaces
POST /api/workspaces/:workspaceId/prepare
POST /api/runs
```

`POST /api/runs` references `workspaceId`; it does not inline `originId/userId/projectId`.

`POST /api/runs` body:

```json
{
  "profileId": "report-docx",
  "workspaceId": "ws_123",
  "kind": "generate",
  "skillId": "report-writer",
  "prompt": "Generate the report from input files.",
  "model": "sonnet",
  "artifactRuleIds": ["report-docx"]
}
```

Run kind rules:

```text
kind=generate: skillId required; stage skill from profile.skillRoots; inject SKILL.md body.
kind=revise: skillId forbidden; return 400 BAD_REQUEST if supplied; no skill staging; prompt-only.
```

Core API endpoints:

```text
POST /api/workspaces
POST /api/workspaces/:workspaceId/prepare
POST /api/runs
GET  /api/runs
GET  /api/runs/:runId/events
GET  /api/runs/:runId
POST /api/runs/:runId/cancel
GET  /api/runs/:runId/artifacts
GET  /api/runs/:runId/artifacts/:artifactId/download
GET  /api/runs/:runId/logs
GET  /api/profiles
GET  /api/health
```

SSE and durable history boundary:

```text
/api/runs/:runId/events serves live and short reconnect replay from the in-memory buffer only.
After terminal TTL, durable history is run_messages.events_json via GET /api/runs/:runId.
First version adds no run_events table.
```

Persistence:

```text
workspaces
conversations
runs
run_messages
artifacts
run_logs
profile_snapshots
```

`workspaces`, `runs`, and `run_messages` are first-version foundations. Insert the `runs` queued row at run create time.

Run statuses:

```text
queued
running
succeeded
failed
canceled
interrupted
```

Daemon restart behavior:

```text
On startup, old queued/running runs are marked interrupted with RUN_INTERRUPTED_BY_DAEMON_RESTART.
Per-workspace serial eligibility is derived from non-terminal runs, so marking interrupted releases the workspace.
```

First-version error codes:

```text
MODEL_NOT_ALLOWED
RUN_QUEUE_FULL
ARTIFACT_REQUIRED_MISSING
RUN_INTERRUPTED_BY_DAEMON_RESTART
RUN_TIMEOUT
RUN_INACTIVITY_TIMEOUT
```

First-version security boundary:

```text
Directory isolation only.
No OS-level isolation, separate uid, container, seccomp/firejail, or Claude Code permission hooks.
This is for trusted callers, trusted profiles, and controlled deployments.
```

Important caveat:

```text
When permissionMode uses bypassPermissions and Claude Code can call Bash/Write/Edit, the child process has the daemon process user's file and network permissions. Directory path validation is not a strong sandbox.
```
