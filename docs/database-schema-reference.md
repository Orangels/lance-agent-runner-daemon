# Database Schema Reference

This document explains the daemon PostgreSQL tables used by the current runtime.
It is a human-readable companion to the PostgreSQL migrations in
`apps/daemon/src/db/postgres/migrations/`.

The daemon runtime persistence is PostgreSQL-only. SQLite is retained only as a
read-only migration source and historical backup format.

## Conventions

- All timestamp columns use Unix epoch milliseconds stored as `bigint`.
- Columns ending in `_json` store JSON encoded as `text`.
- Public API behavior is defined by `docs/api-reference.md`; database tables are
  internal daemon storage. Business systems may use read-only database inspection
  for troubleshooting, but should not build product logic directly on table
  internals.
- Most records are deleted by PostgreSQL foreign-key cascade when their parent
  workspace or run is deleted.

Useful timestamp conversion:

```sql
SELECT to_char(
  to_timestamp(created_at / 1000.0) AT TIME ZONE 'Asia/Shanghai',
  'YYYY-MM-DD HH24:MI:SS.MS'
) AS created_bj
FROM runs
LIMIT 1;
```

## Table Overview

| Table | Purpose |
| --- | --- |
| `workspaces` | Durable daemon workspace identity and business workspace key. |
| `conversations` | Conversation container for one or more runs in a workspace. |
| `runs` | Main execution record for generate, revise, chat, and other run kinds. |
| `run_messages` | Durable user/assistant messages, content, thinking text, and run events. |
| `artifacts` | Files scanned after a run, such as `output/report.docx`. |
| `run_logs` | Local file paths for stdout, stderr, and debug event logs. |
| `profile_snapshots` | Sanitized profile config captured at run creation time. |
| `run_prompt_snapshots` | Prompt snapshot/hash metadata for auditing. |
| `run_skill_snapshots` | Skill body/hash and side-file manifest captured for a run. |
| `run_context_snapshots` | Business context snapshot/hash metadata for auditing. |
| `run_feedback` | Caller feedback attached to a run. |
| `run_webhooks` | Per-run webhook target and subscription config. |
| `webhook_deliveries` | Durable webhook outbox jobs and latest delivery state. |
| `webhook_delivery_attempts` | Per-attempt audit rows for webhook delivery. |

## Relationships

```text
workspaces
  -> conversations
  -> runs
       -> run_messages
       -> artifacts
       -> run_logs
       -> profile_snapshots
       -> run_prompt_snapshots
       -> run_skill_snapshots
       -> run_context_snapshots
       -> run_feedback
       -> run_webhooks
            -> webhook_deliveries
                 -> webhook_delivery_attempts
```

Important cascade behavior:

- Deleting a `workspace` deletes its `runs`, messages, artifacts, logs, snapshots,
  feedback, and webhook rows.
- Deleting a `run` deletes its run-local child rows.
- Deleting a `run_webhook` deletes its delivery and attempt rows.

## `workspaces`

Durable identity for a daemon workspace. A workspace maps a business-side task
or project identity to a daemon sandbox directory.

Unique identity:

```text
UNIQUE(client_id, profile_id, workspace_key)
```

| Column | Meaning |
| --- | --- |
| `id` | Daemon workspace id, for example `ws_xxx`. |
| `profile_id` | Profile that owns the workspace, for example `report-docx`. |
| `client_id` | Authenticated daemon client id, for example `lqbot`. |
| `origin_id` | Legacy/source system identity dimension retained for compatibility. |
| `user_id` | Legacy/source user identity dimension retained for compatibility. |
| `project_id` | Legacy/source project identity dimension retained for compatibility. |
| `workspace_key` | Stable business workspace key, for example `gaclaw/u_admin/task_xxx`. |
| `status` | Workspace lifecycle status. Current active workspaces use `active`. |
| `metadata_json` | Caller-provided workspace metadata, or `NULL`. |
| `created_at` | Creation time, epoch milliseconds. |
| `updated_at` | Last update time, epoch milliseconds. |

Common query:

```sql
SELECT id, client_id, profile_id, workspace_key, status,
       to_char(to_timestamp(created_at / 1000.0) AT TIME ZONE 'Asia/Shanghai',
               'YYYY-MM-DD HH24:MI:SS.MS') AS created_bj
FROM workspaces
WHERE workspace_key LIKE 'gaclaw/%'
ORDER BY created_at DESC;
```

## `conversations`

Conversation-level grouping for messages. A generate run can create a new
conversation; revise/chat style flows can reuse one.

| Column | Meaning |
| --- | --- |
| `id` | Conversation id. |
| `workspace_id` | Parent workspace id. |
| `title` | Optional title. |
| `created_at` | Creation time, epoch milliseconds. |
| `updated_at` | Last update time, epoch milliseconds. |

## `runs`

Main execution table. Every `POST /api/runs` creates a queued row before the
runner starts.

Important indexes:

- `(workspace_id, created_at DESC)` for workspace run history.
- `(status, created_at DESC)` for status scans.
- Partial unique index on `(client_id, profile_id, workspace_id,
  idempotency_key)` when `idempotency_key IS NOT NULL`.

| Column | Meaning |
| --- | --- |
| `id` | Daemon run id, for example `run_xxx`. |
| `workspace_id` | Parent workspace id. |
| `profile_id` | Profile used by the run. |
| `client_id` | Authenticated daemon client id. |
| `kind` | Run kind, such as `generate`, `revise`, or `chat`. |
| `skill_id` | Skill id used by the run, for example `report-gen`; may be `NULL`. |
| `status` | `queued`, `running`, `succeeded`, `failed`, `canceled`, or `interrupted`. |
| `prompt` | Stored prompt field used by legacy mode. Prefer snapshots/hashes for auditing. |
| `prompt_mode` | Prompt mode, such as `legacy` or `business-context`. |
| `current_prompt` | Resolved prompt used for execution, when available. |
| `context_policy_json` | Context policy JSON supplied by the request, or `NULL`. |
| `collection_mode` | Persistence/detail level, such as `lite`, `diagnostic`, or `review`. |
| `prompt_snapshot_hash` | SHA-256 hash of the prompt snapshot. |
| `prompt_snapshot_char_count` | Prompt character count. |
| `prompt_snapshot_byte_count` | Prompt byte count. |
| `prompt_snapshot_persisted` | `1` when the full prompt snapshot was stored, `0` when only hash/counts were stored. |
| `business_context_hash` | SHA-256 hash of business context JSON, if supplied. |
| `artifact_rule_ids_json` | JSON array of artifact rule ids requested for the run. |
| `idempotency_key` | Optional caller-provided idempotency key for create-run replay. |
| `idempotency_fingerprint` | Hash/fingerprint of key create-run parameters. |
| `last_run_event_id` | Last persisted run event id, typically the terminal `end` event. |
| `queued_at` | Time when the run entered queued state. |
| `started_at` | Time when the runner started. |
| `finished_at` | Terminal time. |
| `exit_code` | Child process exit code, if available. |
| `signal` | Child process signal, if available. |
| `error_code` | Stable daemon error code for failed/interrupted runs. |
| `error_message` | Human-readable error message. |
| `usage_json` | Model/tool usage metadata, when available. |
| `metadata_json` | Caller-provided run metadata, or `NULL`. |
| `created_at` | Row creation time. |
| `updated_at` | Last update time. |

Common run lookup:

```sql
SELECT r.id, r.kind, r.status, r.error_code, r.error_message,
       w.workspace_key,
       to_char(to_timestamp(r.created_at / 1000.0) AT TIME ZONE 'Asia/Shanghai',
               'YYYY-MM-DD HH24:MI:SS.MS') AS created_bj,
       to_char(to_timestamp(r.started_at / 1000.0) AT TIME ZONE 'Asia/Shanghai',
               'YYYY-MM-DD HH24:MI:SS.MS') AS started_bj,
       to_char(to_timestamp(r.finished_at / 1000.0) AT TIME ZONE 'Asia/Shanghai',
               'YYYY-MM-DD HH24:MI:SS.MS') AS finished_bj
FROM runs r
JOIN workspaces w ON w.id = r.workspace_id
WHERE r.id = 'run_xxx';
```

## `run_messages`

Durable message and event history for a run.

Typical layout for one run:

- position `0`: user message.
- position `1`: assistant message accumulated from the runner.

| Column | Meaning |
| --- | --- |
| `id` | Message id. |
| `workspace_id` | Parent workspace id. |
| `conversation_id` | Conversation id; may become `NULL` if conversation is deleted. |
| `run_id` | Parent run id. |
| `role` | Message role, usually `user` or `assistant`. |
| `content` | Message content. |
| `thinking_content` | Hidden/review thinking content when persisted; empty string by default. |
| `events_json` | Durable run events for this message, including status, artifacts, warnings, and terminal `end`. |
| `attachments_json` | Attachments metadata, if any. |
| `produced_files_json` | Produced-file metadata, if any. |
| `run_status` | Message-level run status, usually set on assistant terminal message. |
| `last_run_event_id` | Last event id represented by this message. |
| `started_at` | Message/start time. |
| `ended_at` | Message terminal time. |
| `position` | Message order within the run. |
| `conversation_seq` | Message order within the conversation. |
| `created_at` | Row creation time. |
| `updated_at` | Last update time. |

Common event inspection:

```sql
SELECT id, role, position, run_status, last_run_event_id, events_json
FROM run_messages
WHERE run_id = 'run_xxx'
ORDER BY position;
```

## `artifacts`

Files discovered by terminal artifact scanning. For report generation, the
primary DOCX usually appears as `role = 'primary'` and
`rule_id = 'report-docx'`.

| Column | Meaning |
| --- | --- |
| `id` | Artifact id, for example `artifact_xxx`. |
| `run_id` | Parent run id. |
| `workspace_id` | Parent workspace id. |
| `rule_id` | Artifact rule id that matched the file. |
| `role` | Artifact role, usually `primary` or `supporting`. |
| `relative_path` | Workspace-relative file path, for example `output/report.docx`. |
| `file_name` | File basename. |
| `mime_type` | Detected MIME type, if available. |
| `size` | File size in bytes. |
| `mtime` | File modification time, epoch milliseconds. |
| `sha256` | File SHA-256 hash, if computed. |
| `metadata_json` | Reserved artifact metadata, or `NULL`. |
| `created_at` | Artifact row creation time. |

Common artifact lookup:

```sql
SELECT id, run_id, rule_id, role, relative_path, file_name, size, sha256
FROM artifacts
WHERE run_id = 'run_xxx'
ORDER BY role, created_at;
```

## `run_logs`

Pointers to local run log files. The API reads these files through daemon logic;
the database stores paths only.

| Column | Meaning |
| --- | --- |
| `run_id` | Parent run id and primary key. |
| `stdout_log_path` | Local stdout log path. |
| `stderr_log_path` | Local stderr log path. |
| `debug_events_log_path` | Local debug-events NDJSON path. |
| `created_at` | Row creation time. |

## Snapshot Tables

Snapshot tables preserve the execution context needed for audit, debugging, and
reproducibility without requiring the mutable runtime config or skill files to
remain unchanged.

### `profile_snapshots`

| Column | Meaning |
| --- | --- |
| `run_id` | Parent run id and primary key. |
| `profile_json` | Sanitized profile snapshot captured at run creation. |
| `created_at` | Row creation time. |

### `run_prompt_snapshots`

| Column | Meaning |
| --- | --- |
| `run_id` | Parent run id and primary key. |
| `prompt_snapshot` | Full prompt snapshot when persistence policy allows it; otherwise `NULL`. |
| `prompt_snapshot_hash` | SHA-256 hash of the prompt. |
| `char_count` | Prompt character count. |
| `byte_count` | Prompt UTF-8 byte count. |
| `persisted` | `1` if full prompt text is stored, `0` if only metadata/hash is stored. |
| `created_at` | Row creation time. |

### `run_skill_snapshots`

| Column | Meaning |
| --- | --- |
| `run_id` | Parent run id and primary key. |
| `skill_id` | Skill id used by the run. |
| `skill_name` | Skill display name. |
| `skill_description` | Skill description. |
| `skill_body_hash` | SHA-256 hash of the skill body. |
| `skill_body` | Full skill body when persistence policy allows it; otherwise `NULL`. |
| `side_files_manifest_json` | JSON manifest of staged side files. |
| `persisted` | `1` if full skill body is stored, `0` if only metadata/hash is stored. |
| `created_at` | Row creation time. |

### `run_context_snapshots`

| Column | Meaning |
| --- | --- |
| `run_id` | Parent run id and primary key. |
| `business_context_json` | Full business context when persistence policy allows it; otherwise `NULL`. |
| `business_context_hash` | SHA-256 hash of business context JSON. |
| `persisted` | `1` if full context is stored, `0` if only hash is stored. |
| `created_at` | Row creation time. |

## `run_feedback`

Feedback submitted by callers after or during a run.

| Column | Meaning |
| --- | --- |
| `id` | Feedback id. |
| `run_id` | Parent run id. |
| `client_id` | Client that submitted the feedback. |
| `category` | Feedback category. |
| `message` | Feedback text. |
| `metadata_json` | Optional caller metadata. |
| `created_at` | Row creation time. |

## `run_webhooks`

Per-run webhook subscription created from `POST /api/runs` when the request
includes `webhook`.

Only one webhook config is stored per run:

```text
UNIQUE(run_id)
```

| Column | Meaning |
| --- | --- |
| `id` | Webhook config id. |
| `run_id` | Parent run id. |
| `client_id` | Client that owns the webhook. |
| `url` | Callback URL. |
| `secret` | Optional HMAC secret. Stored so retries and recovery can sign callbacks. |
| `statuses_json` | JSON array of statuses subscribed by the caller. |
| `metadata_json` | Caller-provided webhook metadata echoed in payloads. |
| `created_at` | Row creation time. |
| `updated_at` | Last update time. |

## `webhook_deliveries`

Durable webhook outbox. Each row represents one status notification for one run
webhook. Workers claim due rows with PostgreSQL row locks and update delivery
state after each attempt.

Only one delivery exists per webhook/status pair:

```text
UNIQUE(webhook_id, run_status)
```

| Column | Meaning |
| --- | --- |
| `id` | Delivery id, for example `whd_xxx`. |
| `run_id` | Parent run id. |
| `webhook_id` | Parent run webhook config id. |
| `client_id` | Client that owns the delivery. |
| `event_type` | Payload event type, currently run status notification. |
| `run_status` | Run status represented by this delivery. |
| `delivery_status` | `pending`, `delivering`, `succeeded`, `retrying`, or `abandoned`. |
| `payload_json` | Stable webhook payload JSON without per-attempt transport metadata. |
| `payload_sha256` | SHA-256 hash of `payload_json` for audit. |
| `attempt_count` | Number of attempts already claimed/sent. |
| `next_attempt_at` | Earliest time this row may be claimed. |
| `locked_at` | Time a worker claimed the row, or `NULL`. |
| `locked_by` | Worker id that claimed the row, or `NULL`. |
| `last_attempt_at` | Last attempt time. |
| `delivered_at` | Successful delivery time. |
| `response_status` | Last HTTP response status, if any. |
| `response_body_preview` | Bounded preview of the last response body. |
| `error_message` | Last delivery error. |
| `created_at` | Row creation time. |
| `updated_at` | Last update time. |

Common webhook delivery lookup:

```sql
SELECT id, run_id, run_status, delivery_status, attempt_count,
       response_status, error_message,
       to_char(to_timestamp(created_at / 1000.0) AT TIME ZONE 'Asia/Shanghai',
               'YYYY-MM-DD HH24:MI:SS.MS') AS created_bj,
       to_char(to_timestamp(delivered_at / 1000.0) AT TIME ZONE 'Asia/Shanghai',
               'YYYY-MM-DD HH24:MI:SS.MS') AS delivered_bj
FROM webhook_deliveries
WHERE run_id = 'run_xxx'
ORDER BY created_at;
```

## `webhook_delivery_attempts`

Audit table for each webhook HTTP attempt.

| Column | Meaning |
| --- | --- |
| `id` | Attempt id, for example `whda_xxx`. |
| `delivery_id` | Parent delivery id. |
| `attempt` | Attempt number. |
| `attempted_at` | Attempt start time. |
| `duration_ms` | HTTP attempt duration in milliseconds. |
| `success` | `1` if the attempt was successful, `0` otherwise. |
| `response_status` | HTTP response status, if any. |
| `response_body_preview` | Bounded response preview. |
| `error_message` | Attempt error message. |
| `created_at` | Row creation time. |

## Common Troubleshooting Queries

### Recent Business Runs

```sql
SELECT r.id AS run_id, r.status, r.kind, w.workspace_key,
       a.id AS artifact_id, a.relative_path, a.size,
       d.delivery_status, d.response_status,
       to_char(to_timestamp(r.created_at / 1000.0) AT TIME ZONE 'Asia/Shanghai',
               'YYYY-MM-DD HH24:MI:SS.MS') AS created_bj,
       to_char(to_timestamp(r.finished_at / 1000.0) AT TIME ZONE 'Asia/Shanghai',
               'YYYY-MM-DD HH24:MI:SS.MS') AS finished_bj
FROM runs r
JOIN workspaces w ON w.id = r.workspace_id
LEFT JOIN artifacts a ON a.run_id = r.id AND a.role = 'primary'
LEFT JOIN webhook_deliveries d ON d.run_id = r.id AND d.run_status = r.status
ORDER BY r.created_at DESC
LIMIT 20;
```

### Runs Still Queued Or Running

```sql
SELECT r.id, r.status, w.workspace_key,
       now() - to_timestamp(COALESCE(r.started_at, r.queued_at, r.created_at) / 1000.0) AS age,
       r.error_code, r.error_message
FROM runs r
JOIN workspaces w ON w.id = r.workspace_id
WHERE r.status IN ('queued', 'running')
ORDER BY r.created_at;
```

### Artifact Check For A Workspace

```sql
SELECT r.id AS run_id, r.status,
       a.id AS artifact_id, a.rule_id, a.role, a.relative_path, a.size, a.sha256
FROM workspaces w
JOIN runs r ON r.workspace_id = w.id
LEFT JOIN artifacts a ON a.run_id = r.id
WHERE w.workspace_key = 'gaclaw/u_admin/task_xxx'
ORDER BY r.created_at, a.created_at;
```

### Webhook Attempts For A Run

```sql
SELECT d.id AS delivery_id, d.run_status, d.delivery_status,
       a.attempt, a.success, a.response_status, a.duration_ms,
       a.error_message, a.response_body_preview,
       to_char(to_timestamp(a.attempted_at / 1000.0) AT TIME ZONE 'Asia/Shanghai',
               'YYYY-MM-DD HH24:MI:SS.MS') AS attempted_bj
FROM webhook_deliveries d
LEFT JOIN webhook_delivery_attempts a ON a.delivery_id = d.id
WHERE d.run_id = 'run_xxx'
ORDER BY d.created_at, a.attempt;
```

## Business Integration Notes

- Business backends should treat HTTP APIs, webhook payloads, artifacts API, and
  logs API as the supported integration surface.
- Direct database reads are useful for daemon operator troubleshooting, but
  business services should not depend on table internals for normal execution.
- `workspaces.workspace_key`, `runs.id`, `runs.status`, `artifacts`, and webhook
  delivery tables are the most useful read-only inspection points during
  integration.
- Sensitive payloads may be intentionally omitted from snapshot tables depending
  on persistence policy. When `persisted = 0`, use hashes and counts for audit
  rather than expecting full prompt, skill, or business-context text.
