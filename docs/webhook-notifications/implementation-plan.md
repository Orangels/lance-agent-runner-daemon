# Webhook Notifications Implementation Plan

> **Status, 2026-06-15:** Implemented on the PostgreSQL persistence branch. Tasks 1-9 are complete and the plan is now an implementation confirmation record. Task 10 remains a verification checklist: automated daemon typecheck/build and targeted webhook tests have been run during implementation, while the optional local webhook receiver smoke test should be run when a real receiver is available.

> **Historical agent note:** This plan was originally written for agentic workers to execute task-by-task. Checkboxes below now reflect implementation status rather than open planning work.

**Goal:** Add durable, per-run optional webhook notifications for daemon run status changes so business backends can receive active callbacks while Poll, SSE, artifacts, and logs remain the source of truth and recovery paths.

**Architecture:** Store optional per-run webhook configuration at run creation time, create webhook delivery jobs from committed run status transitions using PostgreSQL outbox tables, and deliver callbacks from an asynchronous worker with timeout, retry, backoff, signing, SSRF guardrails, and audit history. Never block run creation, run execution, artifact finalization, terminal state persistence, Poll, or SSE on a remote webhook endpoint.

**Wake-up model:** Do not poll the outbox on a fixed interval. Delivery creation and retry scheduling use PostgreSQL `LISTEN/NOTIFY` to wake workers. Workers still claim rows with `FOR UPDATE SKIP LOCKED`, so `NOTIFY` is only a wake-up/scheduling signal, not task ownership. Startup and LISTEN reconnect perform recovery scans; future retries and stale `delivering` recovery use a local next-due timer. The dedicated LISTEN connection uses an application-level keepalive on that same physical connection so half-open connections are detected and recovered.

**Tech Stack:** TypeScript, Express, Zod, PostgreSQL, PostgreSQL `LISTEN/NOTIFY`, node-pg-migrate, Vitest, built-in `fetch`, Node `crypto`, Node `dns/promises`, Node `net`, existing daemon config/profile/client model.

---

## Scope

Implement webhook notification as a daemon-generic capability. The implementation must not mention or special-case gaclaw, RPA, lqBot, or any other business product. Business correlation belongs in caller-provided webhook metadata and existing run metadata.

The first implementation covers run status changes only:

- `queued`
- `running`
- `succeeded`
- `failed`
- `canceled`
- `interrupted`

The feature is optional per run. Existing callers that omit webhook configuration must see no request, response, queueing, persistence, Poll, SSE, artifact, or log behavior change.

If `server.webhooks.enabled` is `false`, callers must not be able to create webhook-backed runs. A `POST /api/runs` request that includes `webhook` while webhooks are disabled must return `400 BAD_REQUEST` and must not create `run_webhooks` or `webhook_deliveries` rows. This avoids accepting durable delivery jobs that no worker will process.

Runtime persistence is PostgreSQL-only. SQLite must not be treated as a supported runtime backend for this feature. Any SQLite references in this plan are historical implementation notes or migration-source context.

Do not add a public "webhook management" API in this slice. Delivery audit can be inspected through database records and daemon logs first. Public delivery query APIs can be designed later if needed.

## Non-Goals

- Do not replace polling or SSE.
- Do not deliver arbitrary business events.
- Do not implement inbound webhook receivers.
- Do not implement per-client webhook defaults or dynamic client administration.
- Do not add product-specific payload fields outside caller-supplied metadata.
- Do not guarantee exactly-once delivery to the business backend. Guarantee durable at-least-once attempts with stable delivery IDs so receivers can deduplicate.

## API Contract

Extend `POST /api/runs` with an optional `webhook` object.

```json
{
  "profileId": "report-docx",
  "workspaceId": "ws_xxx",
  "kind": "generate",
  "skillId": "report-gen",
  "prompt": "...",
  "model": "sonnet",
  "artifactRuleIds": ["report-docx"],
  "metadata": {
    "businessTaskId": "task_001",
    "origin": "gaclaw"
  },
  "idempotencyKey": "origin:task_001:1",
  "webhook": {
    "url": "http://192.168.88.20:8000/daemon/webhooks/runs",
    "secret": "whsec_business_shared_secret",
    "statuses": ["queued", "running", "succeeded", "failed", "canceled", "interrupted"],
    "metadata": {
      "businessTaskId": "task_001",
      "businessDocumentId": "doc_001"
    }
  }
}
```

Field semantics:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `webhook.url` | string | yes when `webhook` exists | Absolute callback URL. The default internal deployment allows `http:` / `https:` and `192.168.88.0/24`; operators can tighten this with `server.webhooks` for public-facing deployments. |
| `webhook.secret` | string | no | Shared signing secret. Stored as sensitive runtime data and never returned in API responses or logs. If omitted, callbacks are unsigned except for the stable delivery ID headers. |
| `webhook.statuses` | RunStatus[] | no | Statuses that should produce deliveries. Default is terminal statuses: `succeeded`, `failed`, `canceled`, `interrupted`. Callers that need full lifecycle callbacks must explicitly include `queued` and `running`. |
| `webhook.metadata` | object | no | Caller-owned correlation metadata copied into every webhook payload. This must not contain API keys, credentials, full prompts, or personal sensitive data. |

Create-run response stays compatible:

```json
{
  "runId": "run_xxx",
  "conversationId": "conv_xxx",
  "userMessageId": "msg_user_xxx",
  "assistantMessageId": "msg_assistant_xxx",
  "status": "queued",
  "idempotentReplay": false
}
```

Do not add webhook secrets or delivery internals to the create-run response.

### Idempotency Interaction

Existing `idempotencyKey` semantics remain unchanged:

- Same key and same fingerprint replays the existing run.
- Same key and different fingerprint returns `409 IDEMPOTENCY_KEY_CONFLICT`.
- Different key creates a new run.

Webhook fields are part of the idempotency fingerprint only when `request.webhook` exists. This prevents a caller from accidentally reusing the same business dispatch key while silently changing callback behavior, while preserving old caller compatibility. When `request.webhook` is omitted, the fingerprint input must remain byte-for-byte equivalent to the current implementation: do not add `webhook: null`, do not bump the fingerprint version, and do not otherwise change the object passed to `stableJsonHash`.

When a webhook secret participates in the fingerprint, include a hash of the secret rather than the raw secret value.

Replay behavior:

- If an idempotent replay returns an existing run, do not create a new run.
- Do not insert duplicate webhook config.
- Do not insert duplicate webhook delivery jobs.
- Return the existing run response with `idempotentReplay: true`.

## Webhook Payload

Send `POST` requests with `Content-Type: application/json`.

```json
{
  "schemaVersion": "daemon.webhook.run.v1",
  "eventId": "whd_xxx",
  "eventType": "run.status_changed",
  "createdAt": 1780000000000,
  "deliveryAttempt": 1,
  "run": {
    "id": "run_xxx",
    "workspaceId": "ws_xxx",
    "profileId": "report-docx",
    "clientId": "business-client",
    "kind": "generate",
    "skillId": "report-gen",
    "status": "succeeded",
    "queuedAt": 1780000000000,
    "startedAt": 1780000005000,
    "finishedAt": 1780000120000,
    "errorCode": null,
    "errorMessage": null,
    "idempotencyKey": "origin:task_001:1"
  },
  "artifacts": [
    {
      "id": "artifact_xxx",
      "ruleId": "report-docx",
      "role": "primary",
      "relativePath": "output/report.docx",
      "fileName": "report.docx",
      "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "size": 123456,
      "sha256": "..."
    }
  ],
  "metadata": {
    "businessTaskId": "task_001",
    "businessDocumentId": "doc_001"
  }
}
```

Payload rules:

- `eventId` is the stable webhook delivery ID. It must not change across retries.
- `deliveryAttempt` starts at 1 and increments when a worker claims the delivery for an attempt. It may skip numbers if the daemon crashes after claim but before sending the HTTP request. Receivers must not require consecutive values; they must deduplicate by `eventId`.
- In the extreme case where the daemon repeatedly crashes after claim but before sending HTTP, `maxAttempts` can be exhausted without the receiver ever seeing a callback. This is an accepted poison-loop protection tradeoff; Poll/SSE remain authoritative recovery paths.
- `artifacts` is populated for terminal statuses after artifact finalization. It is an empty array for `queued` and `running`.
- `errorCode` and `errorMessage` are included only from daemon run state. Do not include stack traces.
- `idempotencyKey` may be included because it is caller-provided dispatch metadata, but docs must warn it is stored and transmitted in plaintext and must not contain secrets.
- `metadata` is exactly the caller-provided `webhook.metadata` object, not `run.metadata`.

## Signing

When `webhook.secret` is present, send:

```text
X-Daemon-Webhook-Id: whd_xxx
X-Daemon-Webhook-Timestamp: 1780000000000
X-Daemon-Webhook-Signature: v1=<hex hmac sha256>
```

Signature input:

```text
<timestamp>.<raw-json-body>
```

Use HMAC-SHA256 with `webhook.secret`. Business receivers should reject stale timestamps and deduplicate by `X-Daemon-Webhook-Id`.

Compute the signature over the exact raw JSON string sent on the wire after `deliveryAttempt` has been injected. Do not sign the persisted payload template before injection.

Do not log `webhook.secret`, signature values, raw payloads, prompts, API keys, or response bodies beyond a short redacted tail.

If no secret is configured, the delivery is unsigned. In that case the receiver still gets stable delivery ID headers for deduplication, but there is no wire-body integrity guarantee from the daemon.

## Security Model

Webhook URLs are attacker-controlled from the daemon's point of view. Validate and guard them before accepting the run request and before each delivery attempt.

Default behavior for this daemon's trusted internal deployment:

- Allow `http:` and `https:` so LAN business services can receive callbacks without public TLS.
- Reject username/password URL credentials.
- Reject fragments.
- Reject unsafe ports unless configured.
- Allow private network targets only when they are covered by configured private CIDR ranges or explicit allowed hosts. The default private CIDR range includes `192.168.88.0/24`.
- Reject loopback, link-local, multicast, and unspecified IP ranges unless explicitly allowed for local development.
- Resolve hostnames with `dns.lookup(..., { all: true })` and reject when no resolved address is allowed by the configured host/CIDR policy.
- Disable redirects by using `redirect: 'manual'`.
- Limit request body size by controlling the daemon-generated payload.
- Limit response body capture to a small tail, for example 4 KiB.
- Use request timeout with `AbortController`.

This first implementation is an SSRF guardrail for a trusted-caller deployment model, not a complete DNS-rebinding defense. The lookup-before-fetch approach still has a DNS rebinding / time-of-check-to-time-of-use window because `fetch(url)` resolves the host again. A future hardening pass can add IP pinning with a custom agent or equivalent connection control if the daemon is exposed to untrusted callback URLs.

Webhook security policy belongs in daemon config:

```json
{
  "server": {
    "webhooks": {
      "enabled": true,
      "allowInsecureHttp": true,
      "allowPrivateNetworks": true,
      "allowedPrivateCidrs": ["192.168.88.0/24"],
      "allowedHosts": [],
      "requestTimeoutMs": 5000,
      "maxAttempts": 8,
      "lockTimeoutMs": 30000,
      "initialBackoffMs": 1000,
      "maxBackoffMs": 300000,
      "listenReconnectBackoffMs": 1000,
      "listenKeepaliveMs": 15000,
      "listenKeepaliveTimeoutMs": 5000,
      "claimLimit": 5,
      "maxConcurrentDeliveries": 5,
      "stopGraceMs": 10000,
      "responseBodyPreviewBytes": 4096
    },
    "persistence": {
      "databaseUrl": "env:CLAUDE_RUNNER_DATABASE_URL",
      "poolMax": 10
    }
  }
}
```

Config defaults:

- `enabled`: `true`
- `allowInsecureHttp`: `true`
- `allowPrivateNetworks`: `true`
- `allowedPrivateCidrs`: `["192.168.88.0/24"]`
- `allowedHosts`: `[]`
- `requestTimeoutMs`: `5000`
- `maxAttempts`: `8`
- `lockTimeoutMs`: `30000`
- `initialBackoffMs`: `1000`
- `maxBackoffMs`: `300000`
- `listenReconnectBackoffMs`: `1000`
- `listenKeepaliveMs`: `15000`
- `listenKeepaliveTimeoutMs`: `5000`
- `claimLimit`: `5`
- `maxConcurrentDeliveries`: `5`
- `stopGraceMs`: `10000`
- `responseBodyPreviewBytes`: `4096`

`allowedPrivateCidrs` is the preferred way to allow trusted LAN ranges. `allowedHosts` is an allowlist exception for controlled internal hostnames or fixed IPs. If a host is listed, it may bypass private-network rejection but not path validation, timeout, redirect, or credential restrictions. Operators can set `allowInsecureHttp: false`, `allowPrivateNetworks: false`, and an empty `allowedPrivateCidrs` list for stricter public-facing deployments.

`listenReconnectBackoffMs` is only for reconnecting the dedicated PostgreSQL LISTEN connection after connection loss. It is not an outbox polling interval.

`listenKeepaliveMs` controls the application-level keepalive on the dedicated LISTEN connection. The worker must periodically run a lightweight query such as `SELECT 1` on the same physical PostgreSQL connection that executed `LISTEN daemon_webhook_delivery`. It must not borrow a connection from the normal `poolMax` pool for this check; a pool query can succeed while the listener connection is half-open. If the listener keepalive fails or times out, the worker must reconnect, re-subscribe, and run recovery. This is not an outbox polling interval and must not query `webhook_deliveries`.

`listenKeepaliveTimeoutMs` is the explicit timeout for one listener keepalive query. It must be less than or equal to `listenKeepaliveMs`. Without this timeout, a half-open TCP connection can leave `SELECT 1` waiting on OS-level TCP retry behavior for minutes, defeating the keepalive interval.

Keep `claimLimit` close to `maxConcurrentDeliveries`. The default `claimLimit: 5` and `maxConcurrentDeliveries: 5` intentionally bound the number of rows held in `delivering` but not yet being actively sent. The worst-case claimed-batch time, approximated as `ceil(claimLimit / maxConcurrentDeliveries) * (requestTimeoutMs + deliveryOverheadMs)`, must stay well below `lockTimeoutMs`; use at least a 3x safety margin in defaults and tests. `deliveryOverheadMs` is not a config key; it is only an implementation-margin concept for DNS, signing, database updates, response preview reads, and scheduler overhead. Automated config tests should use the conservative check `ceil(claimLimit / maxConcurrentDeliveries) * requestTimeoutMs <= lockTimeoutMs / 3`.

`server.persistence.poolMax` controls the normal PostgreSQL runtime pool. The webhook LISTEN worker uses one additional dedicated connection, so a daemon process with `poolMax: 10` and webhooks enabled can hold up to 11 PostgreSQL connections.

`stopGraceMs` bounds shutdown wait time for in-flight webhook deliveries. On shutdown, the worker should stop claiming new rows, wait up to this grace period for in-flight HTTP requests, abort remaining requests when possible, and rely on durable outbox recovery to retry unfinished deliveries on the next daemon startup.

## Data Model

Add a new PostgreSQL migration under `apps/daemon/src/db/postgres/migrations/`.

```sql
CREATE TABLE run_webhooks (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  url text NOT NULL,
  secret text,
  statuses_json text NOT NULL,
  metadata_json text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (run_id)
);

CREATE INDEX idx_run_webhooks_client_run
  ON run_webhooks (client_id, run_id);

CREATE TABLE webhook_deliveries (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  webhook_id text NOT NULL REFERENCES run_webhooks(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  event_type text NOT NULL,
  run_status text NOT NULL,
  delivery_status text NOT NULL,
  payload_json text NOT NULL,
  payload_sha256 text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at bigint NOT NULL,
  locked_at bigint,
  locked_by text,
  last_attempt_at bigint,
  delivered_at bigint,
  response_status integer,
  response_body_preview text,
  error_message text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (webhook_id, run_status)
);

CREATE INDEX idx_webhook_deliveries_due
  ON webhook_deliveries (delivery_status, next_attempt_at, created_at);

CREATE INDEX idx_webhook_deliveries_run
  ON webhook_deliveries (run_id, created_at);

CREATE TABLE webhook_delivery_attempts (
  id text PRIMARY KEY,
  delivery_id text NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  attempt integer NOT NULL,
  attempted_at bigint NOT NULL,
  duration_ms integer NOT NULL,
  success integer NOT NULL,
  response_status integer,
  response_body_preview text,
  error_message text,
  created_at bigint NOT NULL
);

CREATE INDEX idx_webhook_delivery_attempts_delivery
  ON webhook_delivery_attempts (delivery_id, attempt);
```

Notes:

- `run_webhooks.secret` is sensitive. It is stored because delivery occurs after the create-run request returns. This project does not currently have encryption-at-rest infrastructure. Document this clearly and never expose it through API responses or logs.
- `UNIQUE (webhook_id, run_status)` prevents duplicate status notifications for the same run webhook, including idempotent create-run replay and retry races.
- `payload_json` stores the stable payload template. The worker injects the current `deliveryAttempt` from the persisted attempt count immediately before signing and sending the HTTP request.
- `payload_sha256` supports audit without logging full payload content. It is the hash of the stable payload template, not the final wire body after `deliveryAttempt` injection.
- `delivery_status` values are `pending`, `delivering`, `succeeded`, `retrying`, and `abandoned`.
- `delivering` rows must be recoverable after daemon crash. Any row with `delivery_status = 'delivering'` and `locked_at < now - lockTimeoutMs` is stale and eligible for a later claim.

## Outbox Wake-Up Model

`webhook_deliveries` is the durable outbox table. Workers must not poll it on a fixed interval.

Use one PostgreSQL notification channel:

```text
daemon_webhook_delivery
```

`NOTIFY` is emitted by application code in repository methods after delivery rows are inserted or rescheduled. Do not create a broad table trigger that fires for every update to `webhook_deliveries`; a trigger that fires on `succeeded` or `abandoned` updates would wake workers for terminal rows that cannot be claimed.

The notification payload must stay small and must never contain run payload data, webhook metadata, artifacts, prompts, response bodies, or secrets. Keep it to `deliveryId` and `nextAttemptAt` so it always stays safely below PostgreSQL's notification payload limit.

The `pg_notify` call must be executed inside the same PostgreSQL transaction as the outbox insert or retry reschedule update. PostgreSQL will deliver the notification only after the transaction commits; rollback must also roll back the notification. Do not insert or reschedule a row in one transaction and then send `NOTIFY` in a separate best-effort query.

Emit `NOTIFY daemon_webhook_delivery` only from these paths:

| Method | Row state after write | Payload | Why |
| --- | --- | --- | --- |
| `createWebhookDeliveryForRunStatus(...)` when insert wins | `delivery_status = 'pending'` | `{"deliveryId":"whd_xxx","nextAttemptAt":1780000000000}` | New outbox row exists. |
| `markWebhookDeliveryRetrying(...)` | `delivery_status = 'retrying'` | `{"deliveryId":"whd_xxx","nextAttemptAt":1780000060000}` | Workers schedule a future retry wake-up. |

Do not emit `NOTIFY` from:

| Method | Reason |
| --- | --- |
| `claimDueWebhookDeliveries(...)` claim update | Claiming increments `attempt_count` and moves the row to `delivering`, but the row is already owned by that worker. |
| `markWebhookDeliverySucceeded(...)` | Terminal success is not claimable. |
| `markWebhookDeliveryAbandoned(...)` | Terminal failure is not claimable. |

Workers treat notification payloads as hints:

- If `nextAttemptAt <= now`, call `drainDue()` immediately.
- If `nextAttemptAt > now`, schedule or move the local next-due timer to the earliest known `nextAttemptAt`.
- A notification payload is malformed if it is not valid JSON, is not an object, has a missing or non-string `deliveryId`, has a missing or non-finite numeric `nextAttemptAt`, or has a negative `nextAttemptAt`. If the payload is malformed, call `recoverDueAndScheduleNext()` once. Malformed notifications must not crash the worker.
- If notification handling throws, catch the error, log redacted diagnostics, and trigger reconnect/recovery if listener health is uncertain. A handler exception must not leave the listener in a half-alive state.

The local next-due timer is also responsible for stale `delivering` recovery. It must be scheduled from the earlier of:

- the nearest pending/retrying `next_attempt_at`;
- the nearest stale-recovery time for active `delivering` rows, computed as `locked_at + lockTimeoutMs`.

This avoids relying on unrelated future notifications to reclaim rows left in `delivering` after a worker crash.

If `getNextWebhookDeliveryDueAt({ lockTimeoutMs })` returns a timestamp at or before `now`, the worker should drain immediately. If that immediate drain claims zero rows because another worker already claimed the same due/stale rows, schedule the next wake-up with a small floor delay, for example `250ms`, before checking again. This prevents a past stale-recovery timestamp from causing a CPU busy loop during multi-worker races.

`NOTIFY` does not own work. Multiple workers can receive the same notification. Duplicate claim is prevented by the existing claim query using `FOR UPDATE SKIP LOCKED` and by the status transition to `delivering`.

At-least-once semantics remain: if a worker successfully POSTs to the business endpoint and crashes before marking the row `succeeded`, the stale `delivering` lock can be reclaimed and the same `eventId` can be delivered again. Business receivers must deduplicate by payload `eventId` or `X-Daemon-Webhook-Id`.

During rolling deployment, an old polling worker and a new `LISTEN/NOTIFY` worker may briefly coexist. This is safe as long as both claim through the same `FOR UPDATE SKIP LOCKED` transition; `NOTIFY` only wakes workers and never grants ownership.

### Liveness Without Fixed Sweep

This design intentionally avoids a fixed outbox sweep. Liveness comes from these paths working together:

- New pending rows and retry reschedules emit `NOTIFY` from the same transaction as the outbox write.
- Workers execute `LISTEN` before startup and reconnect recovery scans, so rows committed during those windows are either heard through `NOTIFY` or found by recovery.
- Every drain finishes by querying PostgreSQL's authoritative `getNextWebhookDeliveryDueAt({ lockTimeoutMs })` and scheduling the earliest pending/retrying retry or stale-delivering recovery.
- Future retry notifications can advance a local timer earlier, but cannot push an already earlier timer later.
- Stale `delivering` rows become due at `locked_at + lockTimeoutMs`, so crash-after-claim is recovered without unrelated future traffic.
- A half-open listener connection is detected by `listenKeepaliveMs` plus `listenKeepaliveTimeoutMs` on the listener connection itself; reconnect then re-subscribes and runs recovery.

With a healthy listener connection, PostgreSQL does not silently drop committed notifications for online listeners. If the listener connection is half-open, the expected worst-case additional delay before recovery is roughly `listenKeepaliveMs + listenKeepaliveTimeoutMs + listenReconnectBackoffMs + recovery duration`, using the defaults about 21 seconds plus query and delivery time. If the process is down, startup recovery provides the liveness path.

## Code Changes

### Types

Update `apps/daemon/src/core/run-types.ts`:

- Add `WebhookRunStatus = RunStatus`.
- Add `CreateRunWebhookRequest`.
- Add `WebhookDeliveryStatus`.
- Add `WebhookRunStatusChangedPayload`.
- Add optional `webhook?: CreateRunWebhookRequest` to `CreateRunRequest`.
- Add a pure payload builder in a shared core module, for example `apps/daemon/src/core/webhook-payload.ts`. Both `RunService` and PostgreSQL startup recovery must use this single builder so `payload_json` schema cannot drift between normal transitions and `markInterruptedRunsOnStartup(...)`.

Update demo/reference types without changing UI:

- `apps/web/src/api/types.ts`
- `apps/rpa-local-web/src/shared/daemon-types.ts`

The demos should understand the optional field but must not send it by default.

### Validation

Update `apps/daemon/src/http/validation.ts`:

- Add `webhookRequestSchema`.
- Validate URL shape with Zod for basic syntax only: valid absolute URL string and bounded length. Do not enforce protocol, host, IP range, private network, or allowed-host policy in Zod because those checks require daemon config such as `allowInsecureHttp`, `allowPrivateNetworks`, and `allowedHosts`.
- Validate status values against `runStatuses`.
- Default `statuses` later in service code, not in the raw request object, so the service can include the resolved default in the idempotency fingerprint.
- Limit `webhook.secret` to a bounded string length, for example 8 to 512 characters.
- Limit `webhook.metadata` to an object and document that deep size limits are handled by JSON byte-size checks in service code.

Add service-level validation helpers:

- `normalizeWebhookRequest`
- `assertWebhookUrlAllowed`
- `validateWebhookMetadataSize`
- `assertWebhooksEnabledForRequest`

Return `400 BAD_REQUEST` for malformed webhook config. Use a more specific daemon code only if the project already has a clear pattern; do not expand error codes unless tests and docs are updated.

If `config.server.webhooks.enabled` is `false` and `request.webhook` exists, reject the request with `400 BAD_REQUEST` before creating a run or webhook records. Include a stable, non-secret reason in the error body, for example `webhooks_disabled`, so callers can distinguish server-side webhook disablement from URL or schema validation failures. This hard rejection is intentional: accepting the run and silently ignoring the callback would hide an operational misconfiguration from the business backend.

### Config

Update `apps/daemon/src/config/profiles.ts`:

- Add `WebhookConfig`.
- Add `webhooks` under `ServerConfig`.
- Add strict Zod defaults. The entire `server.webhooks` object must be optional with an object-level default so existing config files and tests that omit `webhooks` continue to parse.
- Add a config-level refinement that requires `lockTimeoutMs > requestTimeoutMs`. The default values intentionally leave a larger gap (`30000` vs `5000`) because a delivery attempt includes DNS lookup, signing, database writes, and HTTP timeout. Implementers should keep `lockTimeoutMs` significantly larger than `requestTimeoutMs`, not merely one millisecond larger.
- Add config-level refinements that require `maxAttempts >= 1` and `listenKeepaliveTimeoutMs <= listenKeepaliveMs`.
- Keep `server.persistence.databaseUrl` resolution unchanged.

Update `docs/configuration-reference.md`, `config.example.json`, and `.claude-runner/config.local.json` after implementation so the documented internal deployment default is explicit: `allowInsecureHttp: true`, `allowPrivateNetworks: true`, and `allowedPrivateCidrs: ["192.168.88.0/24"]`. Public-facing deployments can tighten these values in their own config.

### Persistence Interfaces

Update `apps/daemon/src/db/types.ts` with:

- `RunWebhookRecord`
- `WebhookDeliveryRecord`
- `WebhookDeliveryAttemptRecord`
- `InsertRunWebhookInput`
- `CreateWebhookDeliveryForRunStatusInput`
- `ClaimWebhookDeliveriesInput`
- `MarkWebhookDeliverySucceededInput`
- `MarkWebhookDeliveryFailedInput`
- `WebhookDeliveryJobRecord extends WebhookDeliveryRecord` with `webhookUrl: string` and `webhookSecret: string | null`
- `ClaimWebhookDeliveriesResult` with `claimed: WebhookDeliveryJobRecord[]` and `abandonedIds: string[]`
- `RunnerPersistence` methods:
  - `insertRunWebhook(input): Promise<RunWebhookRecord>`
  - `createWebhookDeliveryForRunStatus(input): Promise<WebhookDeliveryRecord | null>`
  - `claimDueWebhookDeliveries(input): Promise<ClaimWebhookDeliveriesResult>`
  - `getNextWebhookDeliveryDueAt(input: { lockTimeoutMs: number }): Promise<number | null>`
  - `markWebhookDeliverySucceeded(input): Promise<WebhookDeliveryRecord>`
  - `markWebhookDeliveryRetrying(input): Promise<WebhookDeliveryRecord>`
  - `markWebhookDeliveryAbandoned(input): Promise<WebhookDeliveryRecord>`
  - `insertWebhookDeliveryAttempt(input): Promise<WebhookDeliveryAttemptRecord>`

Add PostgreSQL-specific notification support without exposing it through business HTTP APIs:

- Export a constant such as `webhookDeliveryNotifyChannel = 'daemon_webhook_delivery'`.
- Add a repository helper that sends `SELECT pg_notify($1, $2)` for webhook delivery hints.
- The helper must only be called by delivery insert/reschedule methods, never by succeeded/abandoned/claim methods.
- The helper must run on the same transaction client that inserted or rescheduled the outbox row. Rely on PostgreSQL semantics: notifications are delivered only after commit. Do not send notifications before the outbox row is durably committed, and do not send them later from a separate best-effort connection.

Prefer methods that can run inside `persistence.transaction(...)` so state transition and outbox insert commit together.

Runtime persistence is PostgreSQL-only. Do not add webhook tables or real webhook behavior to any SQLite source fixtures. The earlier temporary SQLite test facade has been removed; all real webhook outbox behavior belongs in PostgreSQL-gated tests.

### PostgreSQL Repository

Update `apps/daemon/src/db/postgres/repositories.ts`:

- Map webhook rows to records.
- Add a mapper for claim JSON results that accepts snake_case objects and accepts PostgreSQL `bigint` fields as either strings or numbers. Normal `RETURNING *` rows come from `node-postgres` with `bigint` columns as strings by default, but the claim SQL returns `json_agg(...)`, which `node-postgres` parses as JSON and can therefore contain millisecond timestamps as JavaScript numbers. Do not blindly reuse a mapper that only accepts string bigint fields.
- Serialize JSON through existing safe helpers.
- Use `INSERT ... ON CONFLICT (webhook_id, run_status) DO NOTHING RETURNING *` for delivery creation.
- Delivery IDs are generated by the daemon before insert. Generate the delivery id first, build `payload_json` with that same id as `eventId`, then insert the row. If `ON CONFLICT DO NOTHING` wins on another transaction, discard the newly built payload.
- After `createWebhookDeliveryForRunStatus(...)` inserts a new row, send `NOTIFY daemon_webhook_delivery` with `deliveryId` and `nextAttemptAt` on the same transaction client before commit. If `ON CONFLICT DO NOTHING` returns no row, do not notify.
- After `markWebhookDeliveryRetrying(...)` updates a row, send `NOTIFY daemon_webhook_delivery` with `deliveryId` and the new `nextAttemptAt` on the same transaction client before commit, even when that time is in the future. Live workers use this notification to schedule a local next-due timer.
- Do not notify from `claimDueWebhookDeliveries(...)`, `markWebhookDeliverySucceeded(...)`, or `markWebhookDeliveryAbandoned(...)`.
- Implement `getNextWebhookDeliveryDueAt({ lockTimeoutMs })` so it returns the nearest wake-up time across both retryable pending/retrying rows and stale `delivering` rows:

```sql
SELECT MIN(next_due_at) AS next_due_at
FROM (
  SELECT next_attempt_at AS next_due_at
  FROM webhook_deliveries
  WHERE delivery_status IN ('pending', 'retrying')

  UNION ALL

  SELECT locked_at + $1 AS next_due_at
  FROM webhook_deliveries
  WHERE delivery_status = 'delivering'
    AND locked_at IS NOT NULL
) due;
```

- Pass `$1` as `config.server.webhooks.lockTimeoutMs`. The query must not exclude future stale-recovery times; the worker needs the nearest future wake-up.
- In a healthy run, this query can return `locked_at + lockTimeoutMs` for a fresh `delivering` row, causing one future wake-up that claims zero rows if the HTTP attempt completes before then. This is expected and must not be "fixed" by filtering out future `delivering` rows; those future times are what make stale recovery work without a sweep.
- `getNextWebhookDeliveryDueAt(...)` is used only for startup/LISTEN reconnect recovery and for scheduling a local timer after a drain finds no immediately due rows.
- Use `FOR UPDATE SKIP LOCKED` when claiming due deliveries:

```sql
WITH exhausted AS (
  SELECT id
  FROM webhook_deliveries
  WHERE (
      (
        delivery_status IN ('pending', 'retrying')
        AND next_attempt_at <= $1
      )
      OR (
        delivery_status = 'delivering'
        AND locked_at IS NOT NULL
        AND locked_at < $2
      )
    )
    AND attempt_count >= $7
  FOR UPDATE SKIP LOCKED
),
abandoned AS (
  UPDATE webhook_deliveries d
  SET delivery_status = 'abandoned',
      updated_at = $6
  FROM exhausted
  WHERE d.id = exhausted.id
  RETURNING d.id
),
due AS (
  SELECT id
  FROM webhook_deliveries
  WHERE (
      (
        delivery_status IN ('pending', 'retrying')
        AND next_attempt_at <= $1
      )
      OR (
        delivery_status = 'delivering'
        AND locked_at IS NOT NULL
        AND locked_at < $2
      )
    )
    AND attempt_count < $7
  ORDER BY next_attempt_at ASC, created_at ASC
  LIMIT $3
  FOR UPDATE SKIP LOCKED
),
claimed AS (
  UPDATE webhook_deliveries d
  SET delivery_status = 'delivering',
      attempt_count = d.attempt_count + 1,
      locked_at = $4,
      locked_by = $5,
      last_attempt_at = $6,
      response_status = NULL,
      response_body_preview = NULL,
      error_message = NULL,
      updated_at = $6
  FROM due
  WHERE d.id = due.id
  RETURNING d.*
),
claimed_jobs AS (
  SELECT c.*, rw.url AS webhook_url, rw.secret AS webhook_secret
  FROM claimed c
  JOIN run_webhooks rw ON rw.id = c.webhook_id
)
SELECT
  COALESCE((SELECT json_agg(claimed_jobs) FROM claimed_jobs), '[]'::json) AS claimed,
  COALESCE((SELECT json_agg(abandoned.id) FROM abandoned), '[]'::json) AS abandoned_ids;
```

- Compute `$2` as `now - config.server.webhooks.lockTimeoutMs`. This lets any crashed `delivering` row be reclaimed without a separate polling table.
- Pass `$7` as `config.server.webhooks.maxAttempts`.
- Capture `now` once per claim and derive all time parameters from it. `$1`, `$4`, and `$6` must come from the same captured timestamp value; do not call `Date.now()` separately for each parameter.
- The claim update must increment `attempt_count` atomically in the same `UPDATE` that moves the row to `delivering`. Do not use a separate post-claim `markAttempting` write for the counter. If a daemon crashes after claim but before issuing HTTP, the next claim will advance the counter again; `deliveryAttempt` can therefore skip numbers. This is intentional and prevents poison loops where a delivery is repeatedly claimed, crashes before recording an attempt, and never reaches `maxAttempts`.
- `claimDueWebhookDeliveries(...)` must not claim rows whose incremented `attempt_count` would exceed `maxAttempts`. Due or stale rows that have already reached `maxAttempts` must be marked `abandoned` in the same claim transaction so they do not remain forever in `pending`, `retrying`, or stale `delivering`.
- `claimDueWebhookDeliveries(...)` must return both claimed delivery jobs and abandoned delivery IDs. The worker logs abandoned IDs with redacted diagnostics so max-attempt exhaustion is observable without querying the database manually.
- The raw claim result includes `webhook_secret`. Never log the raw `claimed` array or any raw database row from this method; map it first and log only redacted identifiers and status metadata.
- The `exhausted` and `due` CTEs intentionally split rows with `attempt_count >= maxAttempts` and `attempt_count < maxAttempts`. Do not merge them into one writable CTE: the split avoids same-row double updates and PostgreSQL data-modifying CTE snapshot visibility traps.
- PostgreSQL executes data-modifying CTEs even when their returned rows are used only for the final `abandoned_ids` projection. Do not "optimize away" the `abandoned` CTE.
- Claiming a retrying row must clear `response_status`, `response_body_preview`, and `error_message` so a row in `delivering` does not display the previous attempt's result. Abandoning an exhausted row must not overwrite the last real `error_message`; the terminal `delivery_status = 'abandoned'` already represents exhaustion, while detailed failure causes remain in `webhook_delivery_attempts`.
- The `abandoned` CTE has no `LIMIT` in the first implementation, so one claim can mark all currently exhausted rows abandoned. This is acceptable for the initial deployment because it prevents permanent exhausted backlog; if operators see very large exhausted batches, add a bounded cleanup variant later.
- On startup and after LISTEN reconnect, call `recoverDueAndScheduleNext()`: reclaim due pending/retrying/stale delivering rows immediately, then query `getNextWebhookDeliveryDueAt({ lockTimeoutMs })` and schedule a local next-due timer if the next row is in the future.
- Make the PostgreSQL implementation of `markInterruptedRunsOnStartup(now)` update queued/running rows with `UPDATE ... RETURNING *`, create interrupted webhook deliveries for matching run webhook configs inside the same transaction, and still return the interrupted count to existing callers.
- `markInterruptedRunsOnStartup(...)` must use the shared `buildWebhookRunStatusPayload(...)` helper to construct `payload_json`; do not duplicate payload schema construction inside `repositories.ts`.
- Startup interrupted delivery insertion must also use `ON CONFLICT (webhook_id, run_status) DO NOTHING`, matching normal delivery creation.
- Keep the `markInterruptedRunsOnStartup(now): Promise<number>` interface signature unchanged. Do not add webhook tables to SQLite migration-source fixtures.

### Run Service

Update `apps/daemon/src/core/run-service.ts`:

- Add webhook subscription state to `RunState`, for example `webhook: { id: string; statuses: Set<RunStatus> } | null` or an equivalent structure. Transition-time decisions must read this in-memory field rather than querying persistence to discover whether a run has a webhook.
- Include normalized webhook config in the run idempotency fingerprint only when `request.webhook` exists. Omitted webhook must preserve the current fingerprint algorithm exactly.
- On new run creation:
  - Create run, conversation, messages, snapshots, and, only when `normalizedWebhook` exists, webhook config plus optional queued delivery inside one transaction.
  - The service-layer transaction can call the existing `createRunQueuedWithMessagesAndSnapshot(...)`; PostgreSQL client-backed transaction instances already run nested `transaction(...)` calls as direct `fn(this)` calls, so the writes join the same transaction without splitting that helper apart.
  - Do not call `insertRunWebhook` when `normalizedWebhook` is null.
  - Do not create webhook config or deliveries on idempotent replay.
- On `running` transition:
  - Replace the bare `updateRunStarted(...)` call with a service-layer `persistence.transaction(async tx => { ... })` that updates the run and creates a `running` delivery only if `state.webhook` exists and subscribes to `running`.
  - Do not query PostgreSQL to decide whether the run has a webhook during this transition.
  - Do not call any webhook persistence method when `state.webhook` is null.
  - Keep SSE/status event emission behavior unchanged.
- On terminal transition in `finishRun(...)`:
  - Preserve the existing order: artifacts first, log close/warning, `end` event, terminal flush, then durable terminal update.
  - When writing terminal state, use a service-layer `persistence.transaction(async tx => { ... })` around the existing `updateRunTerminal(...)` call and the webhook outbox insert.
  - Create the terminal webhook delivery only if `state.webhook` exists and subscribes to the final status.
  - Do not call any webhook persistence method when `state.webhook` is null.
  - Terminal webhook payload must include artifact summary produced by `finalizeArtifacts`.
  - The transaction boundary is `runs` terminal update plus webhook outbox insert. It does not include earlier artifact replacement or assistant-message terminal flush. That is acceptable because webhook delivery is keyed to durable run status and uses the already finalized artifact summary.
- On cancel, timeout, interrupt, and daemon shutdown:
  - Existing terminal statuses must produce webhook deliveries through the same `finishRun(...)` path.
- Do not call remote webhook URLs from `RunService`.

### Webhook Delivery Service

Create `apps/daemon/src/core/webhook-delivery-service.ts`.

Responsibilities:

- Maintain a dedicated PostgreSQL connection for `LISTEN daemon_webhook_delivery`. This must be an independent `pg.Client` created outside the normal runtime `poolMax` pool, not a long-lived checkout from that pool. With `poolMax: 10` and webhooks enabled, the daemon can therefore hold up to 11 PostgreSQL connections.
- Start without a fixed outbox polling interval. `start()` must establish the dedicated PostgreSQL connection, execute `LISTEN daemon_webhook_delivery`, and only then call `recoverDueAndScheduleNext()`. This ordering is required: scanning before LISTEN creates a race where rows committed between the scan and subscription are neither scanned nor notified to this worker.
- Run an application-level keepalive on the dedicated LISTEN connection every `listenKeepaliveMs`. Use a lightweight query such as `SELECT 1` on the same physical listener connection, not on the normal PostgreSQL pool. Wrap each keepalive query with `listenKeepaliveTimeoutMs`. If the listener keepalive fails, times out, or indicates the connection is unhealthy, tear down listener state, reconnect after `listenReconnectBackoffMs`, re-subscribe, and run recovery.
- Every reconnect path must repeat the startup ordering: connect the dedicated client, execute `LISTEN daemon_webhook_delivery`, and only then call `recoverDueAndScheduleNext()`. Never run the recovery scan before re-subscribing; otherwise a row committed between scan and LISTEN can be missed in an otherwise idle system.
- On every notification, parse `deliveryId` and `nextAttemptAt` as a hint. If due, drain immediately; if future, schedule the local next-due timer.
- The local next-due timer must be min-merged. Once a timer exists for `T1`, a later notification for `T2 > T1` must not push the timer later. Notifications may advance the timer earlier, but must not delay already-known due work.
- On LISTEN connection error/end, clear listener state, reconnect after `listenReconnectBackoffMs`, execute `LISTEN daemon_webhook_delivery`, and then run `recoverDueAndScheduleNext()`.
- Claim due deliveries from PostgreSQL only when woken by startup recovery, LISTEN reconnect recovery, a NOTIFY hint, listener keepalive recovery, or the local next-due timer.
- Reclaim stale `delivering` rows using `lockTimeoutMs` so crash-after-claim does not permanently lose callbacks.
- Deliver with bounded concurrency.
- Sign payloads when a secret exists.
- Enforce SSRF checks before each attempt.
- Use `fetch` with `AbortController` timeout and `redirect: 'manual'`.
- Treat 2xx as success.
- Retry network errors, timeout, `408`, `409`, `425`, `429`, and 5xx with exponential backoff and jitter.
- Abandon non-retryable 3xx and 4xx responses after recording the attempt.
- Abandon retryable deliveries after `maxAttempts`.
- Treat the `attempt_count` returned by `claimDueWebhookDeliveries(...)` as the delivery attempt number. Claiming has already incremented and persisted it before the HTTP request starts. Do not add a separate post-claim counter increment.
- Insert one `webhook_delivery_attempts` row per attempt.
- If an attempt fails and the claimed `attempt_count` is greater than or equal to `maxAttempts`, call `markWebhookDeliveryAbandoned(...)` directly with the real error details from that attempt. Do not mark it `retrying`, do not emit another retry `NOTIFY`, and do not rely on the next claim to abandon it. This worker-abandon path is different from SQL exhausted-abandon: SQL exhausted-abandon preserves existing `error_message`, while worker-abandon records the just-observed HTTP/network failure.
- When `claimDueWebhookDeliveries(...)` returns `abandonedIds`, log a redacted warning or metric for those IDs. Do not issue HTTP requests for them and do not insert attempt audit rows for claim-only abandoned rows.
- Never throw uncaught errors from the worker loop. Log through `DaemonLogger`.
- Log only redacted delivery diagnostics: delivery id, run id, status code, payload hash, retry timing, and bounded response/error previews. Never log webhook secret, signature, raw payload, HMAC input, prompts, API keys, or authorization headers.
- After each drain, query `getNextWebhookDeliveryDueAt({ lockTimeoutMs })` and schedule the local next-due timer when the next pending/retrying delivery or stale-delivering recovery time is in the future.
- If the next due time is at or before `now`, drain immediately. When that immediate drain claims zero rows, use a small minimum delay such as `250ms` before rechecking so worker races do not spin the event loop.
- If a drain claims exactly `claimLimit` rows, immediately drain again after the current batch finishes because more due rows may remain. This is not periodic polling; it is continuation of already-due work.
- `drainDue()` must be worker-level single-flight. If NOTIFY, timer, startup recovery, reconnect recovery, and keepalive recovery overlap, only one drain loop may claim work at a time. Additional wake-ups should set a `drainAgain` flag; after the active drain finishes, the worker runs one more drain if the flag was set.
- `claimLimit` continuation must run inside the same single-flight ownership. Do not release the active-drain flag and then reacquire it for continuation work; that opens a race where another wake-up can start a parallel drain.
- `stop()` must set a stopping flag that is checked by the initial drain entrypoint, by `drainAgain`, and by `claimLimit` continuation. After `stop()` begins, the worker must not claim new rows. It may only wait for or abort deliveries that were already in flight.
- `maxConcurrentDeliveries` must be a worker-level limiter shared by all wake-up sources, not a new per-drain concurrency pool. Overlapping wake-ups must not multiply the configured concurrency.

Keep `claimLimit` close enough to `maxConcurrentDeliveries` that one claimed batch can be processed well inside `lockTimeoutMs`, including during multi-daemon reconnect or startup recovery. Use this invariant:

```text
ceil(claimLimit / maxConcurrentDeliveries) * (requestTimeoutMs + deliveryOverheadMs)
  <= lockTimeoutMs / 3
```

With the default `claimLimit: 5`, `maxConcurrentDeliveries: 5`, `requestTimeoutMs: 5000`, and `lockTimeoutMs: 30000`, the request-timeout portion is comfortably inside the 3x safety target: `ceil(5 / 5) * 5000 = 5000`, leaving roughly another 5000ms for DNS, signing, database updates, response preview reads, and scheduler overhead before reaching `lockTimeoutMs / 3`. If operators increase `claimLimit`, expect slow receivers, or run many daemon workers, they should increase `lockTimeoutMs` or `maxConcurrentDeliveries`. This limit bounds claimed-but-not-yet-sent rows when multiple daemon workers recover at the same time.

Use independent random IDs for `webhook_delivery_attempts.id`. Do not derive attempt row IDs from `deliveryId` and `attemptCount`; crash/retry races can create skipped or repeated attempt-count expectations.

`payload_sha256` is only for auditing the stable payload template persisted in `webhook_deliveries.payload_json`. It is not a hash of the final wire body after `deliveryAttempt` is injected. Wire body integrity is covered by the HMAC signature when `webhook.secret` is configured.

Expose a test-friendly interface:

```ts
export interface WebhookDeliveryService {
  start(): void;
  stop(): Promise<void>;
  drainDue(): Promise<number>;
  recoverDueAndScheduleNext(): Promise<void>;
}
```

`drainDue()` claims and processes currently due work. Its returned number is the count of claimed rows that were moved to `delivering` and are eligible for HTTP delivery; it does not include `abandonedIds` returned by the claim query. Continuation and floor-delay logic must use this claimed count. `recoverDueAndScheduleNext()` drains due/stale work and schedules the nearest future retry. They are used by tests and can also be useful in future maintenance scripts.

The service factory should receive both `persistence` for ordinary repository operations and `databaseUrl` (or an injected listener-client factory in tests) for the independent LISTEN `pg.Client`. It must not derive the listener by checking out a client from the runtime pool.

### Server Wiring

Update `apps/daemon/src/index.ts`:

- Create the webhook delivery service after persistence is initialized.
- Start it only when `config.server.webhooks.enabled` is true.
- Stop it during shutdown before `persistence.close()`.
- Include it in `ServerContext` for tests.
- Pass `config.server.persistence.databaseUrl` or an equivalent listener-client factory into the webhook delivery service so the listener connection is independent from the normal runtime pool.

Startup order:

1. Assert PG schema.
2. Create persistence.
3. Mark interrupted runs on startup, including interrupted webhook delivery jobs.
4. Create services.
5. Start webhook delivery service.
6. Create app.

`markInterruptedRunsOnStartup(...)` runs before the webhook worker has executed `LISTEN`. Any `NOTIFY` emitted while creating interrupted delivery rows during this step may not be heard by this process. This is expected: once the worker starts, it must LISTEN first and then run recovery, which will find these durable interrupted delivery rows.

Shutdown order:

1. Stop accepting HTTP.
2. Shutdown active runs.
3. Stop webhook delivery service.
4. Close persistence.
5. Flush daemon logger.

If `shutdownActiveRuns()` creates `interrupted` webhook deliveries during shutdown, those deliveries are durable but do not have to be sent before process exit. `stop()` should prevent new claims, wait up to `stopGraceMs` for already in-flight deliveries, abort remaining HTTP requests when possible, and then allow shutdown to continue. It should not block daemon shutdown indefinitely on remote webhook endpoints. The next daemon startup recovery will deliver any pending or stale interrupted notifications.

## TDD Tasks

### Task 1: Request Types And Validation

- [x] Add webhook request types to `apps/daemon/src/core/run-types.ts`.
- [x] Add validation tests in `tests/http/validation.test.ts`:
  - [x] accepts a valid webhook object.
  - [x] accepts omitted `statuses`.
  - [x] rejects empty `url`.
  - [x] rejects non-array `statuses`.
  - [x] rejects unknown status.
  - [x] rejects overlong secret.
  - [x] rejects unknown fields due strict schema.
- [x] Update `apps/daemon/src/http/validation.ts`.
- [x] Run `pnpm --filter @lance-agent-runner/daemon test -- tests/http/validation.test.ts`.

Expected red first: strict schema rejects `webhook`.

### Task 2: Config Model

- [x] Add `WebhookConfig` to `apps/daemon/src/config/profiles.ts`.
- [x] Add config parser tests in the existing config test file:
  - [x] existing configs that omit `server.webhooks` still parse because the whole object has a default.
  - [x] default webhook config is applied.
  - [x] explicit webhook config is parsed.
  - [x] invalid timeout/concurrency values are rejected.
  - [x] `lockTimeoutMs` must be greater than `requestTimeoutMs`.
  - [x] `lockTimeoutMs` materially exceeds the default `requestTimeoutMs` in default config.
  - [x] `allowedHosts` accepts non-empty host strings.
  - [x] `listenReconnectBackoffMs` is parsed and is not treated as a polling interval.
  - [x] `listenKeepaliveMs` is parsed and is not treated as a polling interval.
  - [x] `listenKeepaliveTimeoutMs` is parsed and must be less than or equal to `listenKeepaliveMs`.
  - [x] `stopGraceMs` is parsed and bounds shutdown wait.
  - [x] `maxAttempts` must be at least `1`.
  - [x] default `claimLimit` stays close to `maxConcurrentDeliveries`.
  - [x] default `claimLimit`, `maxConcurrentDeliveries`, `requestTimeoutMs`, and `lockTimeoutMs` satisfy the conservative 3x claimed-batch safety invariant: `ceil(claimLimit / maxConcurrentDeliveries) * requestTimeoutMs <= lockTimeoutMs / 3`.
- [x] Update configuration docs after implementation, not before tests pass.
- [x] Run the relevant config test file.

Expected red first: parser rejects `server.webhooks`, or existing config tests fail if the object-level default is missing.

### Task 3: PostgreSQL Schema And Repository

- [x] Add migration `apps/daemon/src/db/postgres/migrations/20260615T000000_create_webhook_notifications.ts`.
- [x] Include `down(pgm)` in the migration and drop tables in dependency order: `webhook_delivery_attempts`, then `webhook_deliveries`, then `run_webhooks`.
- [x] Add records and repository inputs to `apps/daemon/src/db/types.ts`.
- [x] Implement row mapping and repository methods in `apps/daemon/src/db/postgres/repositories.ts`.
- [x] Earlier migration step only: if the legacy SQLite test facade still implemented `RunnerPersistence`, add minimal webhook method stubs there for type compatibility only. The facade has since been removed.
- [x] Add PG-gated tests in `tests/db/postgres-repositories.test.ts`:
  - [x] inserts webhook config for a run.
  - [x] creates a queued delivery only once for the same webhook/status.
  - [x] claims due deliveries with `FOR UPDATE SKIP LOCKED` semantics.
  - [x] reclaims stale `delivering` deliveries when `locked_at < now - lockTimeoutMs`.
  - [x] does not reclaim fresh `delivering` deliveries.
  - [x] increments `attempt_count` atomically in `claimDueWebhookDeliveries(...)` when a row is moved to `delivering`.
  - [x] stale recovery increments `attempt_count` again and may create skipped `deliveryAttempt` values after crash-before-send.
  - [x] due or stale rows that already reached `maxAttempts` are marked `abandoned` during claim, returned in `abandonedIds`, and are not returned for HTTP delivery.
  - [x] claimed delivery jobs include `webhookUrl` and `webhookSecret` from `run_webhooks`.
  - [x] claim result mapping handles `json_agg` rows where `bigint` fields arrive as JavaScript numbers instead of strings.
  - [x] claim clears `response_status`, `response_body_preview`, and `error_message` when moving a row to `delivering`.
  - [x] claim uses one captured `now` value for due comparison, stale-lock cutoff, lock timestamp, and `last_attempt_at`.
  - [x] marks success and records delivered timestamp.
  - [x] marks retry with next attempt and error preview.
  - [x] abandons after max attempts without overwriting the last real `error_message`.
  - [x] worker-driven abandon after the final real HTTP/network failure stores that attempt's actual error details.
  - [x] inserts attempt audit rows.
  - [x] sends `NOTIFY daemon_webhook_delivery` when a new delivery insert wins.
  - [x] sends delivery insert `NOTIFY` on the same transaction client as the insert and only after commit reaches listeners.
  - [x] does not notify when delivery insert is skipped by `ON CONFLICT DO NOTHING`.
  - [x] sends `NOTIFY daemon_webhook_delivery` when a retrying row is rescheduled, including future `nextAttemptAt`.
  - [x] sends retry `NOTIFY` on the same transaction client as the retry update and rolls it back if the transaction rolls back.
  - [x] does not notify from claim, succeeded, or abandoned updates.
  - [x] returns the nearest future pending/retrying `next_attempt_at` from `getNextWebhookDeliveryDueAt({ lockTimeoutMs })`.
  - [x] returns the nearest stale-delivering recovery time from `getNextWebhookDeliveryDueAt({ lockTimeoutMs })`.
  - [x] startup interrupted update creates interrupted delivery rows with payloads built by the shared payload builder.
  - [x] startup interrupted delivery insertion uses conflict-safe semantics and does not duplicate interrupted deliveries.
- [x] Add or update a typecheck-facing test/compile path so adding webhook methods to `RunnerPersistence` does not break persistence implementations.
- [x] Run `pnpm --filter @lance-agent-runner/daemon test -- tests/db/postgres-repositories.test.ts` with `CLAUDE_RUNNER_TEST_PG_URL`.

Expected red first: new tables and methods do not exist.

### Task 4: Run Service Outbox Creation

- [x] Keep existing run-service tests focused on non-webhook behavior unless webhook is explicitly requested. They should continue to pass without creating webhook deliveries.
- [x] Add guard regression coverage proving no webhook persistence method is called when no webhook was requested.
- [x] Add PG-backed run-service or API-flow webhook tests using the existing PostgreSQL harness:
  - [x] create run with terminal-only webhook stores config but no queued delivery by default.
  - [x] create run with `queued` subscription creates exactly one queued delivery.
  - [x] idempotent replay does not create duplicate webhook config or delivery.
  - [x] `running` transition creates a running delivery when subscribed.
  - [x] terminal success creates a delivery with artifact summary.
  - [x] cancel/fail/interrupted terminal transitions create terminal deliveries.
  - [x] webhook fields participate in idempotency conflict detection.
- [x] Add a regression test that omitting `webhook` preserves the current idempotency fingerprint. A run created before this change and replayed without webhook must not fail with `IDEMPOTENCY_KEY_CONFLICT`.
- [x] Add a regression test that webhook secret contributes only as a hash in the fingerprint input.
- [x] Add a regression test that transition decisions use `RunState` webhook subscription data and do not query persistence to discover webhook config.
- [x] Add tests for the shared payload builder so queued/running/terminal/startup-interrupted payloads share one schema source.
- [x] Update create-run normalization and fingerprint code.
- [x] Insert webhook config inside the same create-run transaction as run creation.
- [x] Insert status delivery rows through repository outbox helpers.
- [x] Keep remote HTTP delivery out of run-service tests and run-service implementation.
- [x] Run the new PG-backed webhook test file with `CLAUDE_RUNNER_TEST_PG_URL`.
- [x] Run `pnpm --filter @lance-agent-runner/daemon test -- tests/core/run-service.test.ts` to prove old non-webhook tests still pass.

Expected red first: webhook fields are ignored and no outbox rows are created.

### Task 5: Delivery Worker

- [x] Create `apps/daemon/src/core/webhook-url-policy.ts`.
- [x] Create `apps/daemon/src/core/webhook-signing.ts`.
- [x] Create `apps/daemon/src/core/webhook-delivery-service.ts`.
- [x] Add unit tests:
  - [x] signs payload with `X-Daemon-Webhook-*` headers.
  - [x] unsigned payload omits signature header but still sends delivery id and timestamp.
  - [x] rejects unsafe URLs before fetch.
  - [x] documents and tests the supported guardrails without claiming complete DNS-rebinding protection.
  - [x] does not follow redirects.
  - [x] marks 2xx as succeeded.
  - [x] retries timeout, network errors, `429`, and 5xx.
  - [x] abandons non-retryable 4xx.
  - [x] abandons after `maxAttempts`.
  - [x] on a retryable failure where claimed `attempt_count >= maxAttempts`, marks the delivery abandoned directly instead of marking it retrying.
  - [x] uses the `attempt_count` returned by claim as `deliveryAttempt` and does not perform a separate post-claim counter increment.
  - [x] injects `deliveryAttempt` into the final body before signing and sending.
  - [x] signs the exact raw JSON body sent on the wire after `deliveryAttempt` injection.
  - [x] reclaims stale `delivering` deliveries through claim or startup recovery.
  - [x] records attempt audit for success and failure.
  - [x] `stop()` waits for in-flight deliveries but prevents new claims.
  - [x] logs redacted diagnostics only.
  - [x] starts a dedicated PostgreSQL LISTEN connection and subscribes to `daemon_webhook_delivery`.
  - [x] uses an independent `pg.Client` for the listener, not a long-lived checkout from the normal `poolMax` pool.
  - [x] establishes LISTEN before running startup recovery so no insert can fall between scan and subscription.
  - [x] does not run fixed-interval polling when idle.
  - [x] runs `listenKeepaliveMs` health checks on the listener connection without querying `webhook_deliveries`.
  - [x] keepalive query timeout is bounded by `listenKeepaliveTimeoutMs`; a hung keepalive tears down listener state, reconnects, re-LISTENs, and runs recovery.
  - [x] proves keepalive runs on the physical listener connection, not by borrowing from the normal `poolMax` pool.
  - [x] reconnects and runs recovery when listener keepalive fails.
  - [x] every reconnect path executes `LISTEN daemon_webhook_delivery` before recovery so no insert can fall between reconnect scan and subscription.
  - [x] drains immediately when a notification has `nextAttemptAt <= now`.
  - [x] schedules a local next-due timer when a notification has `nextAttemptAt > now`.
  - [x] min-merges next-due timers: an existing earlier timer is not delayed by a later `nextAttemptAt`.
  - [x] schedules a local next-due timer for stale `delivering` recovery based on `locked_at + lockTimeoutMs`.
  - [x] drains immediately when `getNextWebhookDeliveryDueAt({ lockTimeoutMs }) <= now`.
  - [x] `drainDue()` returns the claimed HTTP-delivery count only; when `claimed.length === 0` and `abandonedIds.length > 0`, continuation/floor-delay logic treats it as zero claimed work.
  - [x] applies a minimum recheck delay, for example `250ms`, when a past-due drain claims zero rows.
  - [x] malformed notifications trigger one recovery scan and do not crash the worker.
  - [x] treats invalid JSON, non-object payload, missing `deliveryId`, non-string `deliveryId`, missing `nextAttemptAt`, non-finite `nextAttemptAt`, and negative `nextAttemptAt` as malformed.
  - [x] notification handler exceptions are caught and cause redacted logging plus recovery or reconnect.
  - [x] startup recovery drains due/stale work and schedules the nearest future retry.
  - [x] LISTEN reconnect runs recovery and schedules the nearest future retry.
  - [x] overlapping wake-ups are single-flight: concurrent NOTIFY/timer/recovery calls coalesce and do not create parallel drain loops.
  - [x] `claimLimit` continuation runs under the same single-flight drain and does not release/reacquire the active-drain flag between batches.
  - [x] `stop()` prevents new claims from direct drain entrypoints, queued `drainAgain`, and `claimLimit` continuation.
  - [x] `maxConcurrentDeliveries` is enforced as one worker-level limiter across all wake-up sources.
  - [x] overlapping wake-ups do not move more than `claimLimit` rows to `delivering` before the active drain finishes.
  - [x] multiple workers awakened by the same notification do not duplicate claim because claim uses `FOR UPDATE SKIP LOCKED`.
  - [x] PG-gated: two real worker instances using separate PostgreSQL connections call `drainDue()` concurrently against the same due rows; assert each delivery is claimed once and no duplicate attempt audit rows are created.
  - [x] PG-gated: concurrent workers do not duplicate `abandonedIds` when exhausted rows are cleaned up with `FOR UPDATE SKIP LOCKED`.
  - [x] attempt audit rows use independent random IDs rather than ids derived from attempt count.
- [x] Use fake `fetch`, fake clock, and fake timers in tests.
- [x] Run the new worker test file.

Expected red first: no worker exists.

### Task 6: Server Wiring And Shutdown

- [x] Add `webhookDeliveryService` to `ServerContext`.
- [x] Start the worker when enabled.
- [x] Stop the worker during shutdown before closing persistence.
- [x] Add tests in `tests/index.test.ts`:
  - [x] context starts worker when enabled.
  - [x] context does not start worker when disabled.
  - [x] configs that omit `server.webhooks` still create context successfully.
  - [x] worker performs startup recovery once when enabled.
  - [x] shutdown stops worker before persistence closes.
  - [x] startup interrupted rows create delivery jobs through persistence.
  - [x] worker timers do not leak after shutdown.
  - [x] `stop()` waits only up to `stopGraceMs` for in-flight deliveries before aborting and continuing shutdown.
  - [x] interrupted deliveries created during shutdown are durable and may be delivered by next startup recovery rather than blocking shutdown.
- [x] Run `pnpm --filter @lance-agent-runner/daemon test -- tests/index.test.ts`.

Expected red first: context has no worker.

### Task 7: HTTP Flow Integration

- [x] Add or extend API flow tests:
  - [x] `POST /api/runs` accepts webhook and returns the existing response shape.
  - [x] `GET /api/runs/:runId/status` stays unchanged.
  - [x] SSE stays unchanged.
  - [x] terminal run creates a webhook delivery row.
  - [x] create-run without webhook creates no webhook rows.
  - [x] idempotent replay with webhook does not create duplicate delivery rows.
  - [x] idempotent replay without webhook keeps the old response semantics.
  - [x] when `server.webhooks.enabled` is false, `POST /api/runs` with `webhook` returns `400 BAD_REQUEST` and creates no run, webhook, or delivery rows.
  - [x] the disabled-webhook error body includes a stable reason such as `webhooks_disabled`.
- [x] Verify auth/client scoping still follows the run's authenticated client.
- [x] Run the relevant HTTP route/API flow test.

Expected red first: validation rejects webhook and no delivery rows exist.

### Task 8: Demo Type Synchronization

- [x] Update `apps/web/src/api/types.ts` with optional webhook request types.
- [x] Update `apps/rpa-local-web/src/shared/daemon-types.ts` with optional webhook request types.
- [x] Do not modify UI or make demos send webhooks by default.
- [x] Run:
  - [x] `pnpm typecheck:web`
  - [x] `pnpm typecheck:rpa-local-web`

Expected red first only if types are used before implementation. These checks mainly prevent drift.

### Task 9: Documentation

- [x] Update `docs/api-reference.md`:
  - [x] `POST /api/runs` request field table.
  - [x] webhook payload schema.
  - [x] signing headers.
  - [x] retry and at-least-once semantics.
  - [x] security warnings and secret storage warning.
  - [x] business receiver idempotency expectation using `eventId`.
  - [x] warning that `deliveryAttempt` is a claim attempt number, can skip values, and must not be used as a consecutive sequence.
- [x] Update `docs/business-run-chat-integration-guide.md`:
  - [x] Webhook is the recommended business completion-notification path.
  - [x] Poll remains a low-frequency fallback for recovery, reconciliation, and troubleshooting.
  - [x] Business still must be able to recover by polling when webhook delivery is unavailable.
  - [x] Receiver must deduplicate by `eventId`.
  - [x] Receiver must not rely on `deliveryAttempt` being consecutive; repeated crash-before-send can even exhaust attempts before a callback is observed, so polling remains required for recovery.
- [x] Update `docs/business-agent-adapter-handoff.md` if it describes daemon invocation fields.
- [x] Update `docs/configuration-reference.md` with `server.webhooks`.
- [x] Update `docs/claude-code-runner-daemon-version-roadmap.md` to mark webhook notifications as implemented.

### Task 10: Full Verification

- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm build`.
- [ ] Run `pnpm test:daemon`.
- [ ] Run PG-gated tests with `CLAUDE_RUNNER_TEST_PG_URL`.
- [ ] Start local daemon with PG-backed config.
- [ ] Manually create a run with a local webhook receiver only if local config explicitly allows localhost HTTP.
- [ ] Verify:
  - [ ] create-run response unchanged.
  - [ ] status polling unchanged.
  - [ ] SSE unchanged.
  - [ ] terminal artifacts unchanged.
  - [ ] webhook delivery row succeeds.
  - [ ] receiver sees signed payload.
  - [ ] retry works when receiver returns 500.

## Risks And Review Focus

- SSRF protection is the highest-risk area. Review DNS resolution, IP range checks, redirects, and allowlist semantics carefully. This slice provides guardrails, not complete DNS-rebinding protection.
- Idempotency fingerprint changes must not break old callers. Omitted webhook must produce the same behavior as today.
- Runtime persistence remains PostgreSQL-only. Do not add webhook schema or real webhook behavior to SQLite migration-source fixtures.
- Stale `delivering` rows must be reclaimable after daemon crash or forced process termination.
- Stale `delivering` rows must have a scheduled recovery wake-up through `locked_at + lockTimeoutMs`; do not rely on unrelated future notifications.
- The worker must LISTEN before startup recovery scans, otherwise a delivery committed between scan and subscription can be missed.
- The worker must also LISTEN before every reconnect recovery scan, otherwise a delivery committed between reconnect scan and re-subscription can be missed in an idle system.
- The LISTEN connection must have application-level keepalive on the physical listener connection itself so half-open TCP connections do not silently stall webhook delivery.
- The LISTEN keepalive query must have an explicit timeout; otherwise half-open TCP behavior can delay recovery far beyond `listenKeepaliveMs`.
- The LISTEN connection must be an independent PostgreSQL client outside the normal runtime pool; otherwise the `poolMax + 1` connection budget is false and listener health checks can be misleading.
- Delivery insert/reschedule notifications must use `pg_notify` inside the same PostgreSQL transaction as the outbox write, never a separate best-effort query after commit.
- Past-due stale-recovery timestamps must not create a busy loop when another worker wins the claim race.
- Claim sizing must preserve the 3x safety invariant between claimed-batch processing time and `lockTimeoutMs`, especially if deployments run multiple daemon workers.
- Claiming a delivery must increment `attempt_count` atomically so crash-before-send cannot create infinite retry loops. `deliveryAttempt` can skip numbers and receivers must not depend on consecutive values.
- Repeated crash-before-send can exhaust webhook attempts before the receiver sees any callback. This is acceptable poison-loop protection because Poll/SSE/artifacts remain authoritative.
- Claim result mapping must handle `json_agg` bigint values arriving as JavaScript numbers while ordinary `RETURNING *` bigint values may arrive as strings.
- Raw claim results include `webhook_secret`; never log raw claim rows or unredacted delivery job objects.
- Claiming must clear stale response/error fields when moving a row back to `delivering`; abandoned rows should preserve the last real failure details in attempt audit rows and avoid overwriting them with generic exhaustion text.
- Worker-driven abandon after a real final attempt should store that attempt's actual error; SQL exhausted-abandon should preserve existing error fields.
- Worker retry logic and SQL claim logic must use the same `maxAttempts` boundary.
- Worker drains must be single-flight inside each daemon process; overlapping wake-ups must coalesce rather than multiply `claimLimit` and `maxConcurrentDeliveries`.
- `drainDue()` must return claimed HTTP-delivery count only, not `claimed.length + abandonedIds.length`.
- Shutdown must disable direct drains, `drainAgain`, and `claimLimit` continuation before waiting for in-flight deliveries.
- Disabled webhooks must reject webhook-bearing create-run requests instead of storing undeliverable jobs.
- Shutdown must be bounded by `stopGraceMs`; durable outbox recovery handles unfinished deliveries after restart.
- Do not block run terminal persistence on remote callbacks.
- Do not insert duplicate deliveries on idempotent replay.
- Restart recovery must create interrupted deliveries for old queued/running runs that had webhook config.
- Payload must not include prompt content, API keys, secrets, stack traces, absolute sandbox paths, or raw logs.
- Worker retries are at-least-once. Business receivers must deduplicate by `eventId`.
- Webhook secret is stored in the daemon database. Treat it as sensitive operational data.
- Existing Poll/SSE/artifacts/logs remain authoritative even if webhook delivery is delayed, retried, or abandoned.

## Commit Plan

Use small commits:

1. `test: cover webhook run-create validation`
2. `feat: add webhook config and postgres outbox schema`
3. `feat: enqueue webhook deliveries from run transitions`
4. `feat: add async webhook delivery worker`
5. `test: cover webhook api flow and restart recovery`
6. `docs: document webhook notifications`

Keep each commit buildable when practical. If a red test commit is not desired on the shared branch, squash red/green pairs before review.
