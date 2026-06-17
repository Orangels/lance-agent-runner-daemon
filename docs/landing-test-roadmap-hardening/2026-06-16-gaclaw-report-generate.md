# 2026-06-16 Gaclaw Report Generate Landing Test

This document records the first full business-side report-generation landing test observed after the PostgreSQL persistence and webhook notification work landed on the integration branch.

## Summary

- Result: passed.
- Business system: Gaclaw report-generation backend.
- Daemon profile: `report-docx`.
- Run kind: `generate`.
- Notification mode: webhook primary path, Poll fallback still active during the test.
- Final run status: `succeeded`.
- Primary artifact was scanned and persisted before webhook delivery.
- Terminal webhook was delivered successfully on the first attempt.

## Code And Startup Context

- Observed implementation branch: `codex/postgres-persistence-migration`.
- Merged PR containing the tested implementation: GitHub PR #4.
- Local `main` merge commit after the test: `a3a2fb54a3ee3406edf624b17e071d71b4154c53`.
- Daemon startup command used during the test:

```bash
env \
  CLAUDE_RUNNER_LQBOT_API_KEY=lancelocal-report \
  RPA_DAEMON_API_KEY=local-rpa-test-key \
  pnpm start:daemon:local
```

- Config file: `.claude-runner/config.local.json`.
- PostgreSQL database URL source: repo-root `.env` through `CLAUDE_RUNNER_DATABASE_URL`.
- Server bind address during test: `0.0.0.0`.

Note: the exact process commit was not captured before the daemon was stopped. The run was observed on the PostgreSQL/webhook integration branch and the implementation was subsequently merged in PR #4.

## Run Evidence

| Field | Value |
| --- | --- |
| client id | `lqbot` |
| profile id | `report-docx` |
| workspace id | `ws_aba0f09f825a4184a4f9195c2f6ae65e` |
| run id | `run_69cfe93436434e338a94822203a00459` |
| kind | `generate` |
| status | `succeeded` |
| idempotency key | `gaclaw:task_ee150198a5e042eeb0703ada88722804:1` |

## Timing

| Event | Epoch ms | Beijing time |
| --- | ---: | --- |
| created / queued | `1781577271910` | `2026-06-16 10:34:31.910` |
| started | `1781577271926` | `2026-06-16 10:34:31.926` |
| finished | `1781579821826` | `2026-06-16 11:17:01.826` |

- Total created-to-finished duration: 42 minutes 30 seconds.
- Queue wait: about 16 ms.
- Practical runtime duration: 42 minutes 30 seconds.

## Artifact Evidence

| Field | Value |
| --- | --- |
| artifact id | `artifact_40a074a433d649b6a8824787f06c270c` |
| rule id | `report-docx` |
| role | `primary` |
| relative path | `output/report.docx` |
| file name | `report.docx` |
| size | `353962` bytes |
| sha256 | `f16434d8b9d44598428fe494b7266b7039e9bfc597bbf6b4486cb50b35f4d1f4` |
| artifact created at | `1781579821803` |

Observed writer self-check output:

- Paragraph count: 84.
- Required chapters present: yes.
- Required topic summaries: 9.
- Red-head fixed-line-spacing risk: not present.
- Abnormally large `w:line` values: none.

## Webhook Evidence

| Field | Value |
| --- | --- |
| delivery id | `whd_f9a00f8d4da044309805f1349fde6ab2` |
| run status | `succeeded` |
| delivery status | `succeeded` |
| attempt count | `1` |
| delivered at | `1781579821947` |
| response status | `200` |
| error message | `null` |
| response body preview | `{"data":{"accepted":true,"duplicate":false}}` |

Attempt row:

| Field | Value |
| --- | --- |
| attempt id | `whda_c28bba93bb394f10834b87aae174a4b6` |
| attempt | `1` |
| duration | `97 ms` |
| success | `true` |
| response status | `200` |

Daemon log event observed:

```json
{
  "event": "webhook_delivery_finished",
  "attempt": 1,
  "deliveryId": "whd_f9a00f8d4da044309805f1349fde6ab2",
  "errorMessage": null,
  "responseStatus": 200,
  "runId": "run_69cfe93436434e338a94822203a00459",
  "success": true
}
```

## Operational Observations

- Business backend called:
  - `POST /api/workspaces`
  - `POST /api/workspaces/:workspaceId/files`
  - `POST /api/runs`
  - `GET /api/runs/:runId/status`
  - `GET /api/runs/:runId`
  - `GET /api/runs/:runId/artifacts`
- All observed daemon HTTP calls returned `200` or `202` as expected.
- `GET /api/runs/:runId/artifacts` returned `200` before terminal state but no artifact rows existed until daemon finish-time scan.
- After terminal state, the primary DOCX artifact was present and webhook delivery succeeded.
- `daemon-error.log` had no new error for this run during monitoring.
- Per-run `stderr.log` remained `0` bytes.
- After daemon shutdown, process scan found no residual daemon, monitor, run, task, or Claude runner process for this run.

## 2026-06-17 Current Branch Startup Smoke

Branch under test: `codex/landing-test-roadmap-hardening`.

Command:

```bash
pnpm start:daemon:local:test
```

Observed startup:

```text
claude runner daemon listening on 0.0.0.0:17890
```

Smoke requests:

```bash
curl -sS http://127.0.0.1:17890/api/health
curl -sS -H 'Authorization: Bearer lancelocal-report' http://127.0.0.1:17890/api/profiles
```

Observed result:

- `GET /api/health` returned `{"ok":true}`.
- `GET /api/profiles` returned the configured `report-docx` profile with `report-gen` skill access, `report-docx` and `report-any` artifact rules, default model `opus`, and `profileConcurrency: 1`.
- The daemon process was stopped after the smoke check.

## Landing-Test Coverage Status

Covered by this test:

- Workspace creation.
- Trusted multipart file upload through `POST /api/workspaces/:workspaceId/files`.
- Generate run creation with `idempotencyKey`.
- Poll fallback through `GET /api/runs/:runId/status`.
- Durable run detail through `GET /api/runs/:runId`.
- Artifact scan and persisted primary artifact.
- Webhook terminal notification.
- Business webhook receiver idempotency response.
- Post-run process cleanup.

Still required before declaring the first version production-ready:

- `POST /api/workspaces/:workspaceId/prepare` smoke test.
- SSE event stream smoke test.
- Cancel flow smoke test.
- Logs API smoke test.
- Successful `revise` run.
- Failed run with durable diagnostics.
- Daemon restart interruption behavior.
- Queue behavior under global, profile, and workspace concurrency limits.
- Explicit response audit for sandbox absolute paths and upload temp paths.
- Final `pnpm typecheck`, `pnpm build`, and `pnpm test` evidence on the tested production candidate commit.
