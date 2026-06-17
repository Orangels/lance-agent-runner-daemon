# Landing Test And Runtime Hardening Checklist

> Branch: `codex/landing-test-roadmap-hardening`

## Goal

Use this branch to close the first-version landing-test loop after the PostgreSQL and webhook merge, then clean up the remaining runtime/test risks before the daemon is treated as production-ready for the trusted deployment model.

## Scope

- Record the real business landing test evidence.
- Update roadmap status so completed PostgreSQL and webhook work is no longer presented as future backlog.
- Remove or rework remaining SQLite-backed runtime test fixtures now that PostgreSQL is the only runtime persistence backend.
- Harden terminal run-log behavior so terminal status and SSE completion are not blocked indefinitely by log close or slow storage.

## Checklist

### 1. Landing-Test Record

- [x] Create a dedicated landing-test evidence document under `docs/landing-test-roadmap-hardening/`.
- [x] Record the completed Gaclaw report-generation test:
  - [x] daemon branch/commit used.
  - [x] command/config used to start daemon.
  - [x] workspace id.
  - [x] run id.
  - [x] task start/end timestamps and total duration.
  - [x] artifact id, role, path, size, and sha256.
  - [x] webhook delivery id, attempt count, response status, and response preview.
  - [x] confirmation that daemon error log and runner stderr had no errors.
  - [x] confirmation that no daemon/runner/monitoring process remained after shutdown.
- [x] Add missing landing-test items still required by the roadmap:
  - [ ] `workspace prepare`.
  - [ ] SSE event stream.
  - [ ] cancel flow.
  - [ ] logs API.
  - [ ] at least one successful `revise` run.
  - [ ] at least one failed run with durable diagnostics.
  - [ ] daemon restart interruption behavior.
  - [ ] queue behavior under global/profile/workspace concurrency limits.
  - [ ] response check that no sandbox absolute paths or upload temp paths are exposed.
  - [ ] final `pnpm typecheck`, `pnpm build`, and `pnpm test` evidence.

### 2. Roadmap Status Update

- [x] Update `docs/claude-code-runner-daemon-version-roadmap.md`.
- [x] Mark PostgreSQL runtime persistence as completed on `main`.
- [x] Mark webhook notifications as completed on `main`.
- [x] Keep remaining PostgreSQL work as follow-up cleanup:
  - [x] CI PostgreSQL test gate.
  - [x] SQLite test fixture removal.
  - [x] backup/restore and operator runbook validation.
- [x] Move completed webhook implementation details out of future backlog wording.
- [x] Keep true future webhook work listed as hardening candidates:
  - [x] delivery inspection APIs.
  - [x] default webhook administration.
  - [x] stronger DNS rebinding protection.
  - [x] delivery metrics.

### 3. SQLite Test Residual Cleanup

- [x] Create implementation plan: `docs/landing-test-roadmap-hardening/sqlite-test-residual-cleanup-plan.md`.
- [x] Inventory remaining SQLite references:
  - [x] `createSqliteRunnerPersistence`.
  - [x] SQLite schema/repository tests.
  - [x] SQLite-backed service or HTTP tests.
  - [x] docs that still describe SQLite as runtime persistence.
- [x] Decide which SQLite references must stay for offline migration tooling tests.
- [x] Replace runtime/service/HTTP test persistence with PostgreSQL-backed helpers where feasible.
- [x] Remove SQLite runtime fixture helpers that are no longer needed.
- [x] Keep migration tests explicitly scoped as SQLite-source to PostgreSQL-target tests.
- [x] Run focused tests after each cleanup slice.
- [x] Run final daemon test suite with `CLAUDE_RUNNER_TEST_PG_URL` configured.

### 4. Runtime Reliability Hardening

- [x] Write or update a short implementation plan before code changes:
  - [x] `docs/landing-test-roadmap-hardening/runtime-reliability-hardening-plan.md`.
- [x] Define terminal log semantics for:
  - [x] `canceled`.
  - [x] `failed` from timeout.
  - [x] `interrupted` on daemon shutdown/restart.
- [x] Add a bounded timeout around run-log close/finalization so terminal status persistence and SSE `end` cannot wait indefinitely.
- [x] Ensure close timeout emits a durable warning event without changing the terminal run status.
- [x] Ensure post-cancel child-process tail output behavior is explicit and tested for terminal event/replay safety; late log writes are best-effort diagnostics and must not block terminal persistence.
- [x] Add regression tests for:
  - [x] close success.
  - [x] close failure.
  - [x] close timeout.
  - [x] canceled run terminal behavior.
  - [x] interrupted run startup recovery.
- [x] Update API/config/operations docs if any externally visible warning or timing behavior changes.
- [ ] Follow-up after landing-test smoke: decide whether `shutdownActive()` should finalize active runs in parallel. Current shutdown finalization is serial, so a worst-case slow log close can add up to `activeRunCount * server.runLogCloseTimeoutMs`. This was not changed in the current patch because parallelizing shutdown changes multi-run termination ordering and should be designed and stress-tested separately.

## Suggested Commit Order

1. `docs: record landing test evidence`
2. `docs: update daemon roadmap status`
3. `test: remove sqlite runtime persistence fixtures`
4. `fix: bound terminal run log close`
5. `docs: finalize landing test hardening notes`

## Verification

- [x] `pnpm typecheck`
- [x] `pnpm build`
- [x] `pnpm test:daemon`
- [x] PostgreSQL-gated daemon tests with `CLAUDE_RUNNER_TEST_PG_URL`.
- [ ] Manual smoke test for daemon startup with `pnpm start:daemon:local:test`.
