# Claude Code Runner Daemon Version Roadmap

This document records the current release boundary after Phase 4 and keeps later-version ideas out of the first landing-test scope.

## Current Status

The daemon has completed the original first-version implementation path:

- Phase 0a: API contract freeze.
- Phase 0: profile, auth, workspace, and SQLite foundation.
- Phase 1: minimal Claude Code run with daemon-side message persistence.
- Phase 2: skill staging and artifact scan/download.
- Phase 3: queue, timeout, logs, and hardening.

Phase 4 has also landed as a narrow input-ingestion extension:

- `POST /api/workspaces/:workspaceId/files` accepts exactly one trusted multipart upload and copies it into a safe workspace-relative target.
- Upload temp files stay under daemon `server.dataDir/uploads/tmp`.
- Upload temp paths and sandbox absolute paths are not public API data.
- Remote URL pull and object-storage pull remain out of scope.

Therefore the current repository should be treated as the **first-version landing-test candidate**. It is ready for controlled integration testing in the intended trusted deployment model.

## Current Landing-Test Scope

Use this version to test the complete daemon flow:

1. Configure clients and profiles.
2. Create or get a workspace with `POST /api/workspaces`.
3. Prepare input files through either:
   - `POST /api/workspaces/:workspaceId/prepare` from daemon-accessible `allowedInputRoots`, or
   - `POST /api/workspaces/:workspaceId/files` for one uploaded file.
4. Create queued runs with `POST /api/runs`.
5. Observe live output through `GET /api/runs/:runId/events`.
6. Cancel runs with `POST /api/runs/:runId/cancel`.
7. Inspect durable run detail through `GET /api/runs/:runId`.
8. List and download artifacts through the artifact APIs.
9. Read authorized sanitized run logs through `GET /api/runs/:runId/logs`.
10. Validate daemon restart behavior marks old queued/running rows as `interrupted`.

The landing test should verify business integration and operational behavior, not untrusted multi-tenant security.

## Current Security Boundary

The current version still uses directory isolation only.

It does not provide:

- OS-level isolation.
- Separate uid execution.
- Containers.
- seccomp/firejail.
- Claude Code permission hooks.
- Strong sandbox guarantees for untrusted tenants.

Callers, profiles, and deployment environments remain trusted. If a profile uses `permissionMode: "bypassPermissions"`, the Claude Code child process has the daemon process user's file and network permissions.

## Later-Version Backlog

The following capabilities are intentionally deferred to later versions. Do not fold them into the current landing test without a separate plan, review, and commit series.

### Input Ingestion V2

- Remote URL pull.
- S3 or object-storage pull.
- Multi-file upload in one request.
- Upload manifests, durable upload ids, or an uploads SQLite table.
- Signed upload URLs.

### Workspace Lifecycle

- `DELETE /api/workspaces/:workspaceId`.
- Workspace archival.
- Workspace retention and cleanup jobs.
- Per-workspace storage quota enforcement.

### Artifact Realtime Preview

- Filesystem watcher.
- Running `artifact_candidate` events.
- Partial artifact preview before terminal artifact scan.

### Observability

- Metrics endpoint.
- `prom-client` instrumentation.
- Queue depth and per-profile concurrency metrics.
- External alerting integration.

### Runtime Configuration

- Profile hot reload.
- Dynamic client/profile administration.
- Config validation endpoint.

### Replay And Session Continuity

- Persistent `run_events` table.
- Restart-safe exact event-id replay from SQLite.
- Claude Code native resume, continue, or fork.
- Run retry API with first-class parent/child relationships.

### Queue Scale-Out

- Distributed queue across multiple daemon processes.
- Cross-process workspace locks.
- Durable scheduler leases.

### Stronger Security Boundary

- OS-level isolation.
- Separate execution users.
- Containerized runs.
- seccomp/firejail or equivalent process restrictions.
- Claude Code permission hooks.
- Stronger external authentication such as mTLS or JWT.

### Browser-Facing Access

- Browser direct CORS.
- Signed artifact download URLs.
- User-level browser auth.

### Product-Specific Integrations

- lanceDesign product logic.
- lqBot-specific business logic.
- craft, critique, analytics, preview, deployment, tabs, routines, media, or live artifact MCP behavior.

## Later-Version Gate

Any later-version capability should follow the same process used for Phase 0a through Phase 4:

1. Write a dedicated plan document under `docs/`.
2. Cross-check the plan against:
   - `AGENTS.md`
   - `REFERENCE.md`
   - `docs/claude-code-runner-daemon-design.md`
   - `docs/claude-code-runner-daemon-migration-assessment.md`
   - relevant files in `/home/orangels/ls_dev/lanceDesign`
3. Treat lanceDesign as reference only; do not import its private source.
4. Ask CC or another reviewer to review the plan before implementation.
5. Implement in small commits with tests.
6. Ask for implementation review before merging.

## Landing-Test Exit Criteria

Before declaring the first version production-ready for its trusted deployment environment, complete a landing-test pass that records:

- Example config used for the test environment.
- Smoke-test commands and responses for workspace prepare, upload, run create, SSE, cancel, artifacts, and logs.
- At least one successful `generate` run and one successful `revise` run.
- At least one failed run with durable diagnostics.
- Restart interruption behavior.
- Queue behavior under global, profile, and workspace concurrency limits.
- Confirmation that API responses do not expose sandbox absolute paths or upload temp paths.
- `pnpm typecheck`, `pnpm build`, and `pnpm test` results from the tested commit.
