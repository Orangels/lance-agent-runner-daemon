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

The current run-create contract also includes generic daemon-side idempotent dispatch:

- `POST /api/runs` accepts optional `idempotencyKey`.
- The key is scoped by `client_id`, `profile_id`, and `workspace_id`.
- Replaying the same key with the same resolved run parameters returns the existing run id and does not enqueue or execute another run.
- Reusing the same key with different run parameters returns `IDEMPOTENCY_KEY_CONFLICT`.
- The key is a generic dispatch key, not a business-specific task id, and should not contain secrets, PII, full prompts, or other sensitive payload.

Therefore the current repository should be treated as the **first-version landing-test candidate**. It is ready for controlled integration testing in the intended trusted deployment model.

## Current Landing-Test Scope

Use this version to test the complete daemon flow:

1. Configure clients and profiles.
2. Create or get a workspace with `POST /api/workspaces`.
3. Prepare input files through either:
   - `POST /api/workspaces/:workspaceId/prepare` from daemon-accessible `allowedInputRoots`, or
   - `POST /api/workspaces/:workspaceId/files` for one uploaded file.
4. Create queued runs with `POST /api/runs`, including idempotent replay with `idempotencyKey`.
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

### Runtime Reliability Hardening

- Define and harden terminal log semantics for canceled, timed-out, and interrupted runs, including whether child-process tail output after cancel must be awaited before closing run logs.
- Add a bounded timeout or equivalent guard around run log close so terminal status updates and SSE `end` delivery cannot wait indefinitely on slow storage.

### Webhook Notifications

- Implemented on the PostgreSQL persistence branch. Confirmation record: `docs/webhook-notifications/implementation-plan.md`.
- `POST /api/runs` accepts per-run webhook target, statuses, signing secret, and caller metadata.
- Webhook delivery is triggered from durable daemon run state transitions, not by daemon-side status polling.
- Run webhook config is stored with the run, and delivery jobs are written to PostgreSQL outbox tables when subscribed statuses are committed.
- Delivery uses a background worker with PostgreSQL `LISTEN/NOTIFY`, `FOR UPDATE SKIP LOCKED` claims, timeout, retry/backoff, bounded response previews, attempt audit rows, and stale `delivering` recovery.
- Payload schema is daemon-owned (`daemon.webhook.run.v1`) and includes run id, workspace id, profile id, kind, status, timestamps, error summary, artifact summary when available, idempotency key, stable event id, and caller-provided webhook metadata.
- Normal `queued/running` notifications are supported when subscribed; terminal states `succeeded/failed/canceled/interrupted` are the default subscription.
- Restart recovery marks old queued/running rows `interrupted` and creates matching interrupted webhook deliveries when the run had webhook config.
- Delivery remains daemon-generic and client-scoped; product-specific correlation stays in caller-provided metadata.
- Security guardrails include URL policy validation, allowed hosts/private CIDRs, redirect blocking, request timeout, signing, secret redaction, and no raw payload/secret logging.
- Polling, SSE, artifacts, and logs remain authoritative recovery paths. Business backends should prefer webhook for normal completion notification and retain low-frequency Poll for recovery, reconciliation, and troubleshooting.

Future hardening candidates:

- Public webhook delivery inspection APIs.
- Optional per-client webhook defaults or dynamic administration.
- Stronger DNS-rebinding protection through IP pinning or equivalent connection control.
- Operational metrics for delivery latency, retry rate, abandoned deliveries, and listener reconnects.

### Runtime Configuration

- Profile hot reload.
- Dynamic client/profile administration.
- Config validation endpoint.

### Replay And Session Continuity

- Persistent `run_events` table.
- Restart-safe exact event-id replay from durable storage.
- Claude Code native resume, continue, or fork.
- Run retry API with first-class parent/child relationships.

### Persistence Backend V2

- Migrate the daemon's current SQLite persistence layer to PostgreSQL. This is being implemented as a PostgreSQL-only runtime migration, not a dual-backend mode.
- Keep repository/service boundaries generic so HTTP and core run semantics do not depend on the selected database engine.
- Define a migration path for existing SQLite data, including workspaces, conversations, runs, run messages, artifacts, run logs, snapshots, feedback, and idempotency fields.
- Preserve run-create idempotency guarantees with PostgreSQL unique constraints or equivalent transactional behavior.
- Revisit startup interruption handling, queue consistency, and transaction isolation under PostgreSQL.
- Add deployment configuration, local development setup, migration tooling, backup/restore notes, and rollback guidance.
- Keep request-serving daemon database and filesystem operations asynchronous; offline migration tools may keep synchronous helpers where they do not block the daemon runtime.
- Preserve SQLite only as a read-only migration source and historical backup after cutover.
- Remove remaining SQLite-backed unit-test fixtures, schema/repository test references, and `createSqliteRunnerPersistence` usages after the PostgreSQL runtime cutover is fully validated, so the automated test suite no longer relies on the legacy backend.

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
