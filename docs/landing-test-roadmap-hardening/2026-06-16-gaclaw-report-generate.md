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

## 2026-06-17 API Smoke Coverage

Branch under test: `codex/landing-test-roadmap-hardening`.

Production-like local config smoke used:

```bash
pnpm start:daemon:local:test
```

### Workspace Prepare / SSE / Cancel / Logs

Evidence directory: `/tmp/landing-smoke-20260617-140953`.

| Field | Value |
| --- | --- |
| workspace id | `ws_e21a5985a0e14637b9dde78948a3662d` |
| workspace key | `landing_smoke/user_20260617/prepare_sse_cancel_20260617-140953` |
| prepared target | `input/prepared.txt` |
| prepared size | `118` bytes |
| run id | `run_da81e41652a343ecbecd7a531e4e4e8f` |
| create response status | `queued` |
| cancel HTTP status | `200` |
| final run status | `canceled` |
| terminal | `true` |
| last run event id | `3` |

SSE event stream returned:

```text
id: 1
event: agent
data: {"type":"status","label":"queued"}

id: 2
event: agent
data: {"type":"status","label":"running"}

id: 3
event: agent
data: {"type":"end","status":"canceled"}
```

`GET /api/runs/:runId/logs` returned `200` with stdout, stderr, and debug event log summaries available. The three log files were empty for this fast cancel smoke, which is expected.

The public JSON/SSE responses from health, workspace, prepare, create-run, status, detail, and SSE were scanned for:

```text
/data/sandboxes
uploads/tmp
/home/orangels/ls_dev
apps/daemon/uploads
```

Result: no matches.

### Controlled Fake Daemon Smoke

The following deterministic checks used a temporary daemon config on port `17891` with a temporary fake `claudeBin`. The fake runner was used only to make success, failure, and queue behavior repeatable without spending real model time. Runtime code, PostgreSQL persistence, HTTP routes, artifact scan, logs, queueing, and status transitions were the current branch implementation.

Evidence directories:

- `/tmp/landing-fake-20260617-141802/evidence-20260617-141932`
- `/tmp/landing-fake-20260617-141802/artifact-evidence-20260617-142109`

Successful generate with artifact:

| Field | Value |
| --- | --- |
| run id | `run_e99dceb258064f53b9cc5adb8f8c6b12` |
| final status | `succeeded` |
| primary artifact id | `artifact_bb8a6a8bb6b8443182a471dcc0dcf5b3` |
| relative path | `output/report.docx` |
| size | `36` bytes |
| sha256 | `ac8c9bad4c056dbb80656927648067c416bed8796a71017a18ec409d4a568169` |

Successful revise with artifact:

| Field | Value |
| --- | --- |
| run id | `run_162601290f0c4e7b98a1df68007e618d` |
| final status | `succeeded` |
| primary artifact id | `artifact_e2ecd79259734b32a2285f7c619e2c13` |
| relative path | `output/report.docx` |
| size | `36` bytes |
| sha256 | `ac8c9bad4c056dbb80656927648067c416bed8796a71017a18ec409d4a568169` |

Failed run with durable diagnostics:

| Field | Value |
| --- | --- |
| run id | `run_ea2fce04908e430f9e35a7cb367f5f62` |
| final status | `failed` |
| error code | `CLAUDE_CLI_FAILED` |
| error message | `Claude CLI failed.` |
| durable event types | `status`, `error`, `end` |
| stderr log size | `36` bytes |
| debug events log size | `173` bytes |

Queue behavior with `globalConcurrency = 1` and `profileConcurrency = 1`:

| Run | Status before cancel | Terminal before cancel |
| --- | --- | --- |
| `run_0771476fea92474cba5a9bc80da43dd8` | `running` | `false` |
| `run_a50e4795a514416dbd0baab57e94fdc8` | `queued` | `false` |
| `run_773930b7101540e0a26ac1d7ec6b0433` | `queued` | `false` |

All three cancel requests returned `200`, and all three runs reached terminal `canceled`.

The controlled fake daemon public JSON responses were scanned for:

```text
/tmp/landing-fake
/data/sandboxes
uploads/tmp
/home/orangels/ls_dev
```

Result: no matches.

### Restart Interruption Smoke

Evidence directory: `/tmp/landing-restart-20260617-142534/evidence`.

This check used a temporary daemon config on port `17892`, created a sleeping run, verified it was `running`, killed only that temporary daemon process with `SIGKILL`, restarted the daemon with the same config, and queried the run again.

| Field | Value |
| --- | --- |
| run id | `run_1fd11b7682644c758e27738d7f1fd0b1` |
| status before kill | `running` |
| status after restart | `interrupted` |
| error code after restart | `RUN_INTERRUPTED_BY_DAEMON_RESTART` |
| error message after restart | `Run interrupted by daemon restart` |
| terminal after restart | `true` |

During this smoke, an initial graceful shutdown attempt exposed a shutdown ordering bug where active-run message flush could race with PostgreSQL pool close. The implementation was updated so `shutdownActive()` cancels runners, waits for runner completion or grace timeout before terminal persistence, and lets shutdown own the interrupted terminal write. A follow-up review found the related in-flight `finishRun()` case; shutdown now waits for that existing terminal persistence and preserves its original terminal result. Both regressions are covered by `tests/core/run-service.test.ts`.

After all smoke checks, process scan found no residual daemon or fake runner process matching the temporary smoke commands.

## 2026-06-17 Final Verification

Commands run on `codex/landing-test-roadmap-hardening`:

```bash
pnpm typecheck
pnpm build
pnpm test
set -a; source .env; set +a; pnpm test:daemon:pg
```

Results:

- `pnpm typecheck`: passed.
- `pnpm build`: passed.
- `pnpm test`: passed.
  - daemon: 37 files passed, 19 skipped; 271 tests passed, 174 skipped.
  - web: 10 files passed; 40 tests passed.
  - rpa-local-web: 50 files passed; 252 tests passed.
- `pnpm test:daemon:pg`: passed.
  - daemon PG-gated suite: 56 files passed; 445 tests passed.

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
- Current branch startup smoke with `pnpm start:daemon:local:test`.
- `POST /api/workspaces/:workspaceId/prepare` smoke.
- SSE event stream smoke.
- Cancel flow smoke.
- Logs API smoke.
- Successful controlled `revise` run.
- Failed controlled run with durable diagnostics.
- Daemon restart interruption behavior.
- Queue behavior under global/profile concurrency limits.
- Response audit for sandbox absolute paths and upload temp paths.
- Final `pnpm typecheck`, `pnpm build`, `pnpm test`, and PostgreSQL-gated daemon test evidence.

Still required before declaring the first version production-ready:

- Real business-side `revise` landing test with a production skill prompt and business artifact.
- Higher-volume queue/concurrency soak if production traffic patterns require it.
