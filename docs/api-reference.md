# Claude Code Runner Daemon API Reference

本文是当前第一版落地测试候选版本的 HTTP/SSE API 文档，面向业务端 agent 适配。

## 基础约定

### Base URL

由部署配置决定，示例：

```text
http://127.0.0.1:17890
```

### Auth

除 `GET /api/health` 外，所有接口都需要 API key。

推荐：

```text
Authorization: Bearer <api-key>
```

也支持：

```text
X-API-Key: <api-key>
```

### Content Types

JSON 接口：

```text
Content-Type: application/json
```

上传接口：

```text
Content-Type: multipart/form-data
```

SSE 接口响应：

```text
Content-Type: text/event-stream
```

### 时间字段

所有时间字段均为 Unix epoch milliseconds，例如：

```json
1770000000000
```

### Persistence Backend

当前持久化迁移到 PostgreSQL 不改变 HTTP/SSE API 的请求或响应结构。业务端仍按本文件的 workspace、upload/prepare、generate/revise、poll/SSE、cancel、artifacts、logs 和 idempotency 流程调用。

daemon 的请求服务路径使用异步数据库和文件 IO。对调用方可见的主要影响是：

- run 进入 terminal 状态前会尽量 flush run logs，因此 `GET /api/runs/:runId/status` 看到 terminal 的时间可能比 Claude 子进程退出略晚。
- run log 写入失败不会改变 run 的 terminal status；daemon 会通过 `warning` RunEvent 暴露该降级事件。

### 错误响应

统一结构：

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Invalid request",
    "details": {}
  }
}
```

`details` 可能不存在。业务端不应依赖 `details` 的稳定字段作为核心业务逻辑。

错误码集合：

```text
BAD_REQUEST
UNAUTHORIZED
FORBIDDEN
NOT_FOUND
MODEL_NOT_ALLOWED
PROFILE_NOT_ALLOWED
SKILL_NOT_ALLOWED
COLLECTION_MODE_NOT_ALLOWED
REVIEW_BUNDLE_TOO_LARGE
SKILL_UNAVAILABLE
SKILL_STAGING_FAILED
PROMPT_COMPOSITION_FAILED
IDEMPOTENCY_KEY_CONFLICT
RUN_QUEUE_FULL
WORKSPACE_RUN_ACTIVE
RUN_NOT_CANCELABLE
RUN_TIMEOUT
RUN_INACTIVITY_TIMEOUT
ARTIFACT_REQUIRED_MISSING
ARTIFACT_SCAN_FAILED
RUN_INTERRUPTED_BY_DAEMON_RESTART
CLAUDE_AUTH_FAILED
CLAUDE_CLI_FAILED
INTERNAL_ERROR
PATH_NOT_ALLOWED
INVALID_PATH_SEGMENT
```

## GET /api/health

公开健康检查。

### Request

```http
GET /api/health
```

### Response 200

```json
{
  "ok": true
}
```

## GET /api/profiles

返回当前 client 可使用的 profile 公共信息。不会返回 `sandboxRoot`、`claudeConfigDir`、`claudeBin`、`skillRoots`、`allowedInputRoots`、env 或 API key。

### Request

```http
GET /api/profiles
Authorization: Bearer <api-key>
```

### Response 200

```json
{
  "profiles": [
    {
      "id": "report-docx",
      "allowedSkillIds": ["report-gen"],
      "artifactRules": [
        {
          "id": "report-docx",
          "pattern": "output/**/*.docx",
          "role": "primary",
          "required": true
        }
      ],
      "defaultArtifactRuleIds": ["report-docx"],
      "defaultModel": "sonnet",
      "allowedModels": ["sonnet"],
      "eventVisibility": "normal",
      "maxCollectionMode": "lite",
      "permissionMode": "bypassPermissions",
      "profileConcurrency": 1,
      "runTimeoutMs": 600000,
      "inactivityTimeoutMs": 120000,
      "cancelGraceMs": 5000
    }
  ]
}
```

### Response Fields

| Field | Type | Notes |
| --- | --- | --- |
| `profiles[].id` | string | `POST /api/workspaces` 和 `POST /api/runs` 使用的 `profileId`。 |
| `profiles[].allowedSkillIds` | string[] | `legacy + generate`、`business-context` run 和部分 `daemon-composed` run 可用的 `skillId`。 |
| `profiles[].artifactRules` | object[] | 可选择的 artifact rule。 |
| `profiles[].defaultArtifactRuleIds` | string[] | `POST /api/runs` 不传 `artifactRuleIds` 时使用。 |
| `profiles[].defaultModel` | string | 默认 Claude model。 |
| `profiles[].allowedModels` | string[] | `POST /api/runs.model` 必须命中。 |
| `profiles[].eventVisibility` | `quiet` / `normal` / `debug` | profile 允许的最大事件可见性。 |
| `profiles[].maxCollectionMode` | `lite` / `diagnostic` / `review` | profile 允许的最大采集模式。 |
| `profiles[].permissionMode` | `default` / `acceptEdits` / `bypassPermissions` | Claude Code permission mode，由 profile 控制。 |
| `profiles[].profileConcurrency` | number | 该 profile 的并发上限。 |
| `profiles[].runTimeoutMs` | number | 单 run 总运行超时。 |
| `profiles[].inactivityTimeoutMs` | number | Claude 无输出超时。 |
| `profiles[].cancelGraceMs` | number | cancel 后 SIGKILL fallback 等待时间。 |

## POST /api/workspaces

创建或复用 workspace。

同一 client、同一 profile、同一 `originId/userId/projectId` 会复用 workspace。不同 client 或不同 profile 会隔离。

### Request

```http
POST /api/workspaces
Authorization: Bearer <api-key>
Content-Type: application/json
```

```json
{
  "profileId": "report-docx",
  "workspace": {
    "originId": "lqbot",
    "userId": "user_123",
    "projectId": "report_456"
  },
  "metadata": {
    "businessProjectId": "report_456"
  }
}
```

### Request Fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `profileId` | string | yes | 必须是当前 client 可访问 profile。 |
| `workspace.originId` | string | yes | 安全路径片段，不能含 `/`、`\`、`.`、`..`、null byte。 |
| `workspace.userId` | string | yes | 同上。 |
| `workspace.projectId` | string | yes | 同上。 |
| `metadata` | object | no | 业务自定义 JSON，daemon 不解释。 |

### Response 200

```json
{
  "workspaceId": "ws_xxx",
  "workspaceKey": "lqbot/user_123/report_456"
}
```

### Common Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_PATH_SEGMENT` | workspace identity 含非法路径片段。 |
| 401 | `UNAUTHORIZED` | API key 缺失或错误。 |
| 403 | `PROFILE_NOT_ALLOWED` | client 不能使用该 profile。 |

## POST /api/workspaces/:workspaceId/prepare

从 daemon 本机可访问的 `allowedInputRoots` 复制文件到 workspace。

### Request

```http
POST /api/workspaces/ws_xxx/prepare
Authorization: Bearer <api-key>
Content-Type: application/json
```

```json
{
  "files": [
    {
      "sourcePath": "/mnt/lqbot/uploads/user_123/source.docx",
      "targetPath": "input/source.docx"
    }
  ]
}
```

### Request Fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `files` | array | yes | 至少 1 个文件。 |
| `files[].sourcePath` | string | yes | daemon 机器可访问的源文件路径，必须在 profile `allowedInputRoots` 内。 |
| `files[].targetPath` | string | yes | workspace 相对路径，不能绝对路径，不能含 `..`，不能指向 `.claude-runner-skills/`。 |

### Response 200

```json
{
  "workspaceId": "ws_xxx",
  "workspaceKey": "lqbot/user_123/report_456",
  "files": [
    {
      "targetPath": "input/source.docx",
      "size": 123456
    }
  ]
}
```

### Common Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `PATH_NOT_ALLOWED` | `sourcePath` 不在允许根下，或 `targetPath` 不安全。 |
| 401 | `UNAUTHORIZED` | API key 缺失或错误。 |
| 403 | `PROFILE_NOT_ALLOWED` | client 不能使用 workspace 所属 profile。 |
| 404 | `NOT_FOUND` | workspace 不存在或不属于该 client。 |
| 500 | `INTERNAL_ERROR` | 文件复制等内部错误，响应不会暴露绝对路径。 |

## POST /api/workspaces/:workspaceId/files

上传单个文件到 daemon 暂存区，再复制到 workspace。适用于业务系统和 daemon 没有共享文件系统的场景。

### Request

```http
POST /api/workspaces/ws_xxx/files
Authorization: Bearer <api-key>
Content-Type: multipart/form-data
```

Multipart fields:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `file` | file | yes | 必须且只能有一个文件字段，字段名必须是 `file`。 |
| `targetPath` | string | yes | workspace 相对路径，不能绝对路径，不能含 `..`，不能指向 `.claude-runner-skills/`。 |

### Response 200

```json
{
  "workspaceId": "ws_xxx",
  "workspaceKey": "lqbot/user_123/report_456",
  "file": {
    "targetPath": "input/source.docx",
    "size": 123456,
    "originalName": "source.docx",
    "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  }
}
```

### Common Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 缺少文件、重复文件字段、错误文件字段名或 multipart 字段非法。 |
| 400 | `PATH_NOT_ALLOWED` | `targetPath` 不安全或目标是目录。 |
| 401 | `UNAUTHORIZED` | API key 缺失或错误。 |
| 403 | `PROFILE_NOT_ALLOWED` | client 不能使用 workspace 所属 profile。 |
| 404 | `NOT_FOUND` | workspace 不存在或不属于该 client。 |
| 413 | `BAD_REQUEST` | 上传文件超过 `server.maxUploadBytesPerFile`。 |
| 500 | `INTERNAL_ERROR` | upload storage 或文件复制内部错误。 |

## POST /api/runs

创建 run。daemon 会先插入 durable `queued` 行，然后按队列调度执行。

### Request

```http
POST /api/runs
Authorization: Bearer <api-key>
Content-Type: application/json
```

Legacy generate 示例：

```json
{
  "profileId": "report-docx",
  "workspaceId": "ws_xxx",
  "kind": "generate",
  "skillId": "report-gen",
  "prompt": "请基于 input/source.docx 生成报告，输出到 output/report.docx。",
  "model": "sonnet",
  "artifactRuleIds": ["report-docx"],
  "idempotencyKey": "origin:business_task_001:1",
  "webhook": {
    "url": "http://192.168.88.20:8000/api/daemon/webhook",
    "secret": "shared-webhook-secret",
    "statuses": ["succeeded", "failed", "canceled", "interrupted"],
    "metadata": {
      "businessTaskId": "business_task_001"
    }
  },
  "eventVisibility": "normal",
  "metadata": {
    "businessMessageId": "msg_001"
  }
}
```

Legacy revise 示例：

```json
{
  "profileId": "report-docx",
  "workspaceId": "ws_xxx",
  "kind": "revise",
  "prompt": "请修改当前 output/report.docx，把摘要压缩到 300 字以内。",
  "artifactRuleIds": ["report-docx"],
  "eventVisibility": "normal",
  "metadata": {
    "businessMessageId": "msg_002",
    "previousRunId": "run_previous"
  }
}
```

Business-context 示例：

```json
{
  "profileId": "report-docx",
  "workspaceId": "ws_xxx",
  "conversationId": "conv_xxx",
  "kind": "revise",
  "promptMode": "business-context",
  "collectionMode": "diagnostic",
  "skillId": "report-gen",
  "currentPrompt": "用户已回答参数问题，请继续更新产物。",
  "businessContext": {
    "previousRunId": "run_previous",
    "artifactPaths": ["output/report.docx"],
    "formAnswers": {
      "dateRange": ["2026-06-01", "2026-06-05"]
    },
    "stage": "question-form-answers"
  },
  "artifactRuleIds": ["report-docx"]
}
```

### Request Fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `profileId` | string | yes | 必须是当前 client 可访问 profile。1-128 字符。 |
| `workspaceId` | string | yes | 必须是该 client 可访问 workspace。1-128 字符。 |
| `kind` | `generate` / `revise` | yes | 生成或修改。 |
| `promptMode` | `legacy` / `business-context` / `daemon-composed` | no | 默认 `legacy`。`business-context` 由业务端传入 opaque 上下文包；`daemon-composed` 由 daemon 读取同一 conversation 的可见历史消息后组装最终 prompt。 |
| `prompt` | string | legacy yes | legacy 模式本轮用户输入，1 到 200000 字符。`business-context` 和 `daemon-composed` 模式禁止传。 |
| `currentPrompt` | string | business-context / daemon-composed yes | business-context / daemon-composed 模式本轮用户输入，1 到 200000 字符。legacy 模式禁止传。 |
| `businessContext` | object | no | 业务上下文包，daemon 不解释具体语义；仅用于最终 prompt 组装和 run 级 snapshot。legacy / daemon-composed 模式禁止传。 |
| `contextPolicy` | object | no | 仅 `daemon-composed` 可传；控制 daemon 读取历史消息的 `recentMessages`、`maxMessageChars`、`maxTotalChars` 和是否输出通用 context warnings。 |
| `conversationId` | string | no | 复用已有 daemon conversation；如传入，必须属于同一 workspace。未传时继续使用该 workspace 的默认 conversation。 |
| `collectionMode` | `lite` / `diagnostic` / `review` | no | 默认 `lite`。控制 prompt / skill / business context snapshot 的全文是否落盘；受 profile `maxCollectionMode` 和 client 权限封顶。 |
| `skillId` | string | 见矩阵 | `legacy + generate` 必填；`legacy + revise` 禁止；`business-context` 必填；`daemon-composed + generate` 必填；`daemon-composed + revise` 可选。1-128 字符。 |
| `model` | string | no | 不传使用 profile `defaultModel`；传入时必须在 `allowedModels` 内。 |
| `artifactRuleIds` | string[] | no | 最多 32 个；不传使用 profile `defaultArtifactRuleIds`。 |
| `idempotencyKey` | string | no | 同一次业务派发的幂等 key，1-128 字符。同一 client/profile/workspace 下同 key + 相同 run 参数会返回旧 run；同 key + 不同 run 参数返回 `IDEMPOTENCY_KEY_CONFLICT`。用户主动 retry / 新任务必须换新 key。 |
| `eventVisibility` | `quiet` / `normal` / `debug` | no | 只能降低到 profile 可见性，不会超过 profile/client 权限。 |
| `metadata` | object | no | 业务自定义 JSON，daemon 不解释。 |
| `webhook` | object | no | 订阅 run 状态变化的 HTTP callback。只影响 webhook 通知，不改变 create run response、poll、SSE 或 artifacts API。 |
| `webhook.url` | string | webhook yes | callback URL，最多 2048 字符。默认内部部署允许 `http` / `https`，并允许 `192.168.88.0/24` 内网地址；实际允许范围由 `server.webhooks` 配置控制。 |
| `webhook.secret` | string | no | 8-512 字符。传入后 daemon 使用 HMAC-SHA256 签名 webhook 请求。明文存储，不能放 API key 或其他无关凭证。 |
| `webhook.statuses` | `RunStatus[]` | no | 要通知的 run 状态。未传时默认 `succeeded/failed/canceled/interrupted`。可包含 `queued` 和 `running`。 |
| `webhook.metadata` | object | no | 原样复制到 webhook payload 的 caller metadata，用于业务端关联本地任务。稳定 JSON 后最多 16KiB；不要放敏感 payload。 |

`idempotencyKey` 是 daemon 通用 dispatch key，不是业务任务 id 语义本身。该字段明文存储，业务端不要放 API key、凭证、个人敏感信息、完整 prompt 或其他敏感 payload。

如果同一个 `idempotencyKey` 搭配了不同 webhook 参数，例如不同 URL、statuses、metadata 或 secret，daemon 会返回 `409 IDEMPOTENCY_KEY_CONFLICT`。业务端主动 retry / 新派发应使用新的 `idempotencyKey`。

Webhook delivery 是异步 outbox，不阻塞 run 创建或执行。daemon 会在 create-run 阶段校验 webhook URL 是否符合 `server.webhooks` 的协议、host、端口和内网 CIDR 策略，但不会预先 POST 探测业务端接口是否可用。URL 无法访问、返回 429/5xx 或超时会按 daemon 配置重试；不可重试 4xx 或达到最大次数后会标记为 abandoned。业务端仍可以继续使用 Poll/SSE 作为兜底。

Webhook payload 示例：

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
    "idempotencyKey": "origin:business_task_001:1"
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
    "businessTaskId": "business_task_001"
  }
}
```

Webhook payload 字段：

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `schemaVersion` | string | yes | 当前为 `daemon.webhook.run.v1`。业务端应按版本解析，未知版本可拒绝或进入兼容分支。 |
| `eventId` | string | yes | webhook delivery id，同 `X-Daemon-Webhook-Id`。业务端必须用它做幂等去重。 |
| `eventType` | string | yes | 当前为 `run.status_changed`。 |
| `createdAt` | number | yes | daemon 创建该 webhook delivery 的毫秒时间戳。 |
| `deliveryAttempt` | number | yes | daemon claim attempt number，可能跳号，不能作为连续序列使用。 |
| `run.id` | string | yes | daemon run id。 |
| `run.workspaceId` | string | yes | daemon workspace id。 |
| `run.profileId` | string | yes | daemon profile id。 |
| `run.clientId` | string | yes | daemon client id。 |
| `run.kind` | `generate` / `revise` | yes | run 类型。 |
| `run.skillId` | string / null | yes | 本次 run 使用的 skill id。 |
| `run.status` | RunStatus | yes | `queued/running/succeeded/failed/canceled/interrupted`。 |
| `run.queuedAt` | number / null | yes | queued 时间。 |
| `run.startedAt` | number / null | yes | running 时间；queued 通知中通常为 null。 |
| `run.finishedAt` | number / null | yes | terminal 时间；非 terminal 通知中为 null。 |
| `run.errorCode` | string / null | yes | failed/canceled/interrupted 等异常终态的错误 code。 |
| `run.errorMessage` | string / null | yes | 错误摘要。业务端不要把它当作完整日志。 |
| `run.idempotencyKey` | string / null | yes | 创建 run 时传入的幂等 key。 |
| `artifacts` | array | yes | artifact 摘要。只有 terminal delivery 会携带最终扫描到的 artifacts；queued/running 通常为空数组。 |
| `artifacts[].id` | string | yes | artifact id，可用于下载接口。 |
| `artifacts[].ruleId` | string | yes | 匹配到的 artifact rule id。 |
| `artifacts[].role` | `primary` / `supporting` / `debug` | yes | artifact 角色。报告生成业务通常取 `role=primary` 或指定 `ruleId`。 |
| `artifacts[].relativePath` | string | yes | workspace 相对路径。不会暴露 sandbox 绝对路径。 |
| `artifacts[].fileName` | string | yes | 文件名。 |
| `artifacts[].mimeType` | string / null | yes | MIME 类型。 |
| `artifacts[].size` | number / null | yes | 文件大小。 |
| `artifacts[].sha256` | string / null | yes | 文件 hash，如果已计算。 |
| `metadata` | object / null | yes | 创建 run 时传入的 `webhook.metadata` 原样回传，用于业务端关联本地任务。 |

`deliveryAttempt` 是 daemon claim attempt number，不保证连续。daemon 如果在 claim 后、HTTP 发送前崩溃，业务端可能看到 `1, 2, 4` 这样的跳号；极端情况下也可能因为反复 crash-before-send 达到最大尝试次数而没有收到任何 callback。业务端只能用 `eventId` / `X-Daemon-Webhook-Id` 做幂等去重，不能依赖 `deliveryAttempt` 连续性。

如果配置了 `webhook.secret`，daemon 会发送：

```text
X-Daemon-Webhook-Id: whd_xxx
X-Daemon-Webhook-Timestamp: 1780000000000
X-Daemon-Webhook-Signature: v1=<hex hmac sha256>
```

签名输入为 `<timestamp>.<raw-json-body>`。

业务端 webhook 接收接口要求：

- 接收 `POST` JSON body。
- 成功处理并持久化后返回任意 `2xx`，daemon 即认为投递成功。
- 返回 `408/409/425/429/5xx` 或请求超时会触发 daemon 异步重试。
- 返回其他 `3xx/4xx` 会被视为不可重试失败；daemon 会记录 attempt，最终标记 delivery abandoned。
- daemon 使用 `redirect: manual`，不会跟随业务端返回的跳转。
- 如果校验签名失败，业务端建议返回 `401` 或 `403`；这类响应不会重试。
- 业务端应先按 `eventId` / `X-Daemon-Webhook-Id` 做幂等判断，再更新本地任务状态。

推荐业务端处理顺序：

1. 校验 `schemaVersion` 和 `eventType`。
2. 如果配置了 `webhook.secret`，用 `<timestamp>.<raw-json-body>` 校验 `X-Daemon-Webhook-Signature`。
3. 用 `eventId` 或 `X-Daemon-Webhook-Id` 做去重；已经处理过则直接返回 `2xx`。
4. 通过 `metadata.businessTaskId`、`run.id` 或 `run.idempotencyKey` 定位本地任务。
5. 写入本地 webhook event 记录，再更新本地任务状态。
6. 当 `run.status` 是 terminal 且存在 `role=primary` artifact 时，保存 `artifact.id/relativePath/sha256`；需要文件内容时继续调用 `GET /api/runs/:runId/artifacts/:artifactId/download` 下载。
7. 如果收到 `failed/canceled/interrupted`，保存 `run.errorCode/run.errorMessage`，并让业务端进入失败或可重试状态。

`kind × promptMode × skillId` 约束：

| kind | promptMode | Required input | `skillId` |
| --- | --- | --- | --- |
| `generate` | `legacy` | `prompt` | required |
| `revise` | `legacy` | `prompt` | forbidden |
| `generate` | `business-context` | `currentPrompt` | required |
| `revise` | `business-context` | `currentPrompt` | required |
| `generate` | `daemon-composed` | `currentPrompt` | required |
| `revise` | `daemon-composed` | `currentPrompt` | optional |

`daemon-composed` 只读取 `conversation / run_messages` 中用户可见的 `role + content`，不读取
prompt snapshot、skill snapshot、debug events、thinking content 或 tool/raw events。历史消息使用
conversation 级 `conversation_seq` 排序；`contextPolicy` 默认值为
`recentMessages = 20`、`maxMessageChars = 4000`、`maxTotalChars = 20000`、
`includeRunWarnings = true`。

### Response 202

首次创建新 run：

```json
{
  "runId": "run_xxx",
  "status": "queued",
  "conversationId": "conv_xxx",
  "userMessageId": "msg_user_xxx",
  "assistantMessageId": "msg_assistant_xxx"
}
```

同一 `idempotencyKey` 重试并命中旧 run：

```json
{
  "runId": "run_xxx",
  "status": "running",
  "conversationId": "conv_xxx",
  "userMessageId": "msg_user_xxx",
  "assistantMessageId": "msg_assistant_xxx",
  "idempotentReplay": true
}
```

replay 时不会重新入队或重新执行；`status` 是旧 run 当前状态，可能是
`queued/running/succeeded/failed/canceled/interrupted`。

### Common Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | schema 校验失败、promptMode 字段组合错误、workspace profile 不匹配、conversationId 不属于同一 workspace。 |
| 400 | `BAD_REQUEST` | `webhook` 在 daemon 配置中被禁用时会拒绝整个 create-run，错误 `details.reason` 为 `webhooks_disabled`；`webhook.metadata` 超过 16KiB 时 `details.reason` 为 `webhook_metadata_too_large`。 |
| 400 | `WEBHOOK_URL_NOT_ALLOWED` | `webhook.url` 不符合 daemon 的 webhook URL 策略，例如协议、端口、host 或内网 CIDR 不被允许。 |
| 400 | `MODEL_NOT_ALLOWED` | model 不在 profile `allowedModels` 内。 |
| 400 | `SKILL_NOT_ALLOWED` | skill 不在 profile `allowedSkillIds` 内。 |
| 400 | `BAD_REQUEST` | artifact rule id 未知。 |
| 401 | `UNAUTHORIZED` | API key 缺失或错误。 |
| 403 | `PROFILE_NOT_ALLOWED` | client 不能使用该 profile。 |
| 403 | `COLLECTION_MODE_NOT_ALLOWED` | 请求的 `collectionMode` 超过 profile/client 权限。 |
| 404 | `NOT_FOUND` | workspace 不存在或不属于该 client。 |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` | 同一个 `idempotencyKey` 已被同 client/profile/workspace 下不同 run 参数使用。 |
| 429 | `RUN_QUEUE_FULL` | 队列已满，未创建 run row。 |

## GET /api/runs

列出当前 client 可访问 runs。

### Request

```http
GET /api/runs?workspaceKey=lqbot/user_123/report_456
Authorization: Bearer <api-key>
```

当前支持 query：

| Query | Type | Notes |
| --- | --- | --- |
| `originId` | string | 按 workspace origin 过滤。 |
| `userId` | string | 按 workspace user 过滤。 |
| `projectId` | string | 按 workspace project 过滤。 |
| `workspaceKey` | string | 精确匹配 `originId/userId/projectId`。 |
| `workspacePrefix` | string | 前缀匹配 workspaceKey。 |
| `status` | RunStatus | `queued/running/succeeded/failed/canceled/interrupted`。 |

注意：当前 schema 不包含 `workspaceId` query。业务端若需要单 run 详情，使用 `GET /api/runs/:runId`。

### Response 200

```json
{
  "runs": [
    {
      "id": "run_xxx",
      "workspaceId": "ws_xxx",
      "profileId": "report-docx",
      "kind": "generate",
      "skillId": "report-gen",
      "status": "succeeded",
      "lastRunEventId": "5",
      "queuedAt": 1770000000000,
      "startedAt": 1770000001000,
      "finishedAt": 1770000010000,
      "createdAt": 1770000000000,
      "updatedAt": 1770000010000
    }
  ]
}
```

## GET /api/runs/:runId

获取 run durable detail。用于 terminal 对账、SSE 断线恢复、历史查看。

### Request

```http
GET /api/runs/run_xxx
Authorization: Bearer <api-key>
```

### Response 200

```json
{
  "run": {
    "id": "run_xxx",
    "workspaceId": "ws_xxx",
    "profileId": "report-docx",
    "kind": "generate",
    "skillId": "report-gen",
    "status": "succeeded",
    "lastRunEventId": "5",
    "queuedAt": 1770000000000,
    "startedAt": 1770000001000,
    "finishedAt": 1770000010000,
    "createdAt": 1770000000000,
    "updatedAt": 1770000010000,
    "exitCode": 0,
    "signal": null,
    "errorCode": null,
    "errorMessage": null,
    "usage": {
      "input_tokens": 1000,
      "output_tokens": 500
    },
    "metadata": {
      "businessMessageId": "msg_001"
    }
  },
  "messages": [
    {
      "id": "msg_user",
      "role": "user",
      "content": "请基于 input/source.docx 生成报告，输出到 output/report.docx。",
      "thinkingContent": "",
      "events": null,
      "runStatus": null,
      "lastRunEventId": null,
      "startedAt": null,
      "endedAt": null,
      "position": 0,
      "createdAt": 1770000000000,
      "updatedAt": 1770000000000
    },
    {
      "id": "msg_assistant",
      "role": "assistant",
      "content": "已生成报告。",
      "thinkingContent": "用户需要生成报告，我需要读取模板和数据后产出 docx。",
      "events": [
        {
          "type": "text_delta",
          "delta": "已生成报告。"
        },
        {
          "type": "artifact_finalized",
          "artifact": {
            "id": "artifact_xxx",
            "runId": "run_xxx",
            "ruleId": "report-docx",
            "role": "primary",
            "relativePath": "output/report.docx",
            "fileName": "report.docx",
            "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "size": 123456,
            "mtime": 1770000009000,
            "sha256": "..."
          }
        },
        {
          "type": "end",
          "status": "succeeded"
        }
      ],
      "runStatus": "succeeded",
      "lastRunEventId": "5",
      "startedAt": 1770000001000,
      "endedAt": 1770000010000,
      "position": 1,
      "createdAt": 1770000000000,
      "updatedAt": 1770000010000
    }
  ]
}
```

### Notes

- `messages[].events` 会按 event visibility 过滤。
- 一个 run 会包含一条 user message，并可能包含多条 assistant messages。daemon 会按 Claude Code 的 assistant message 边界分段保存，而不是把整个 run 的所有 assistant 文本压成一条消息。
- `content` 是单条 assistant message 的正文文本，不保证包含所有 tool/debug 信息。
- `thinkingContent` 是单条 assistant message 的聚合 thinking 文本；没有 thinking 时为空字符串。`quiet` visibility 下返回空字符串，避免绕过 events visibility。
- terminal 后长期查看应以该接口为准，不以 SSE 为准。

### Common Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | API key 缺失或错误。 |
| 403 | `PROFILE_NOT_ALLOWED` | client 不能使用 run 所属 profile。 |
| 404 | `NOT_FOUND` | run 不存在或不属于该 client。 |

## GET /api/runs/:runId/status

获取轻量 run 状态。用于业务端高频轮询任务是否结束，不返回 `messages`、`events`、`content` 或 `thinkingContent`。

### Request

```http
GET /api/runs/run_xxx/status
Authorization: Bearer <api-key>
```

### Response 200

```json
{
  "run": {
    "id": "run_xxx",
    "workspaceId": "ws_xxx",
    "profileId": "report-docx",
    "kind": "generate",
    "skillId": "report-gen",
    "status": "running",
    "queuedAt": 1770000000000,
    "startedAt": 1770000001000,
    "finishedAt": null,
    "createdAt": 1770000000000,
    "updatedAt": 1770000003000,
    "errorCode": null,
    "errorMessage": null
  },
  "terminal": false
}
```

`terminal` 在 `status` 为 `succeeded`、`failed`、`canceled`、`interrupted` 时为 `true`。报告生成场景推荐先轮询该接口，`terminal: true` 后再调用 artifacts API。

terminal 状态表示 daemon 已完成 durable run 状态更新。由于 daemon 会在 terminal 前 flush 本次 run logs，慢盘或日志写入异常可能让 terminal 可见时间略晚；业务端应继续按轮询间隔等待，不需要改变调用方式。

### Common Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | API key 缺失或错误。 |
| 403 | `PROFILE_NOT_ALLOWED` | client 不能使用 run 所属 profile。 |
| 404 | `NOT_FOUND` | run 不存在或不属于该 client。 |

## GET /api/runs/:runId/events

订阅 run SSE 事件。只保证在线和短期断线 replay。

### Request

```http
GET /api/runs/run_xxx/events
Authorization: Bearer <api-key>
Accept: text/event-stream
```

Replay 方式二选一：

```http
Last-Event-ID: 3
```

或：

```text
GET /api/runs/run_xxx/events?after=3
```

### Response 200

Headers:

```text
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

Event format:

```text
id: 4
event: agent
data: {"type":"text_delta","delta":"..."}
```

Keepalive comment:

```text
: keepalive
```

### RunEvent Types

`quiet` 可见：

```ts
{ type: 'status'; label: string; model?: unknown; sessionId?: unknown; ttftMs?: number }
{ type: 'text_delta'; delta: string }
{ type: 'usage'; usage: unknown; costUsd: unknown; durationMs: unknown; stopReason: unknown }
{ type: 'error'; message: string; code?: string; details?: unknown }
{ type: 'warning'; message: string; code?: string; details?: unknown }
{ type: 'artifact_finalized'; artifact: PublicArtifactWithoutWorkspaceId }
{ type: 'end'; status?: RunStatus }
```

`normal` 额外可见：

```ts
{ type: 'thinking_start' }
{ type: 'thinking_delta'; delta: string }
{ type: 'tool_use'; id: unknown; name: unknown; input: unknown }
```

`debug` 额外可见：

```ts
{ type: 'stderr'; text: string }
{ type: 'raw'; line: string }
```

可见性规则：

- profile 有默认/上限 `eventVisibility`。
- 请求 `eventVisibility` 只能降低可见性，不能超过 profile。
- client 没有 `canReadDebugEvents=true` 时，即使请求 debug 也最多得到 normal。
- `stderr/raw` 会截断并脱敏。
- `tool_result` 会保存在内部 `events_json` 和 debug log 中，但不会通过 SSE 或 run detail 的 `messages[].events` 返回。
- `warning` 表示非终态的运行降级，不等同于 run failed。当前可能出现的 code 包括 `RUN_LOG_WRITE_FAILED`，表示 run log 写入/关闭失败；业务端应记录或忽略，不应把它当作 terminal failure。
- 业务端 SSE 和 run detail 解析必须容忍未知 `type`。新增 RunEvent 类型不应导致客户端解析失败。

### Common Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | API key 缺失或错误。 |
| 403 | `PROFILE_NOT_ALLOWED` | client 不能使用 run 所属 profile。 |
| 404 | `NOT_FOUND` | run 不存在、不可访问，或内存 event stream 已过期。 |

当 event stream 过期但 run 已完成时，改用 `GET /api/runs/:runId`。

## POST /api/runs/:runId/cancel

取消 queued/running run。

### Request

```http
POST /api/runs/run_xxx/cancel
Authorization: Bearer <api-key>
```

### Response 200

```json
{
  "ok": true
}
```

### Common Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | API key 缺失或错误。 |
| 403 | `PROFILE_NOT_ALLOWED` | client 不能使用 run 所属 profile。 |
| 404 | `NOT_FOUND` | run 不存在或不属于该 client。 |
| 409 | `RUN_NOT_CANCELABLE` | run 已 terminal 或正在 finishing。 |

## GET /api/runs/:runId/artifacts

列出 run 的 artifact。

### Request

```http
GET /api/runs/run_xxx/artifacts
Authorization: Bearer <api-key>
```

### Response 200

```json
{
  "artifacts": [
    {
      "id": "artifact_xxx",
      "runId": "run_xxx",
      "workspaceId": "ws_xxx",
      "ruleId": "report-docx",
      "role": "primary",
      "relativePath": "output/report.docx",
      "fileName": "report.docx",
      "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "size": 123456,
      "mtime": 1770000009000,
      "sha256": "..."
    }
  ]
}
```

### Common Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | API key 缺失或错误。 |
| 403 | `PROFILE_NOT_ALLOWED` | client 不能使用 run 所属 profile。 |
| 404 | `NOT_FOUND` | run 不存在或不属于该 client。 |

## GET /api/runs/:runId/artifacts/:artifactId/download

下载 artifact 文件。

### Request

```http
GET /api/runs/run_xxx/artifacts/artifact_xxx/download
Authorization: Bearer <api-key>
```

### Response 200

返回文件流。

Headers:

```text
Content-Type: <artifact.mimeType or application/octet-stream>
Content-Length: <artifact size if known>
Content-Disposition: attachment; filename="<ascii-fallback>"; filename*=UTF-8''<utf8-percent-encoded-fileName>
```

中文等非 ASCII 文件名通过 RFC 5987 `filename*` 返回；业务端应优先解析 `filename*`，再回退到 `filename`。

### Common Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | API key 缺失或错误。 |
| 403 | `PROFILE_NOT_ALLOWED` | client 不能使用 run 所属 profile。 |
| 404 | `NOT_FOUND` | run/artifact 不存在、不属于该 client，或文件已不存在。 |

## GET /api/runs/:runId/logs

读取受控 run logs 摘要。只有 `client.canReadLogs=true` 的 client 可以调用。

这些是 run 级 Claude Code CLI 诊断日志，不是 daemon 服务级日志。daemon 服务级日志写在本地 `server.dataDir/logs/daemon.log` 和 `server.dataDir/logs/daemon-error.log`，不通过 HTTP API 暴露。

正常 terminal run 会在 terminal 状态写入前 flush 已排队的 stdout、stderr 和 debug event logs。取消、超时或 daemon shutdown 这类终止路径仍应把 logs 视为 best-effort 诊断材料；业务结果判断以 run status、errorCode/errorMessage 和 artifacts 为准。

### Request

```http
GET /api/runs/run_xxx/logs
Authorization: Bearer <api-key>
```

### Response 200

```json
{
  "runId": "run_xxx",
  "logs": {
    "stdout": {
      "available": true,
      "size": 1234,
      "tail": "..."
    },
    "stderr": {
      "available": true,
      "size": 456,
      "tail": "..."
    },
    "debugEvents": {
      "available": true,
      "size": 789,
      "tail": "{\"type\":\"status\",\"label\":\"running\"}\n"
    }
  }
}
```

### Response Fields

| Field | Type | Notes |
| --- | --- | --- |
| `logs.*.available` | boolean | log 文件是否存在且可读。 |
| `logs.*.size` | number | log 文件字节数。 |
| `logs.*.tail` | string | 最多返回末尾 16KiB 内容，已脱敏。 |

### Common Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | API key 缺失或错误。 |
| 403 | `FORBIDDEN` | client 没有 `canReadLogs`。 |
| 404 | `NOT_FOUND` | run 不存在或不属于该 client。 |

## GET /api/runs/:runId/logs/:kind/download

下载完整 run log 文件。`:kind` 支持：

```text
stdout
stderr
debug-events
```

`stdout` 和 `stderr` 需要 `client.canReadLogs=true`。`debug-events` 需要
`client.canReadDebugEvents=true`。

### Request

```http
GET /api/runs/run_xxx/logs/stdout/download
Authorization: Bearer <api-key>
```

### Response 200

返回文件流。

Headers:

```text
Content-Type: text/plain; charset=utf-8
Content-Length: <log size>
Content-Disposition: attachment; filename="stdout.log"; filename*=UTF-8''stdout.log
```

### Common Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | API key 缺失或错误。 |
| 403 | `FORBIDDEN` | client 没有所需日志或 debug 权限。 |
| 404 | `NOT_FOUND` | run/log 不存在、不属于该 client，或文件已不存在。 |

## GET /api/runs/:runId/review-bundle/download

导出通用业务 skill review bundle。bundle 是 on-demand 生成，不包含 RPA 专属诊断；业务扩展内容通过 `extensions/` hook 后续追加。

调用方必须具备 `client.canReadLogs=true`。如果调用方同时具备
`client.canReadDebugEvents=true`，bundle 会包含 debug-only 文件，例如
`logs/debug-events.ndjson` 和 `messages.debug.json`；否则这些文件会被省略。

### Request

```http
GET /api/runs/run_xxx/review-bundle/download
Authorization: Bearer <api-key>
```

### Response 200

返回 ZIP 文件流。

Headers:

```text
Content-Type: application/zip
Content-Length: <bundle size>
Content-Disposition: attachment; filename="run_run_xxx_review_bundle.zip"; filename*=UTF-8''run_run_xxx_review_bundle.zip
```

### Common Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | API key 缺失或错误。 |
| 403 | `FORBIDDEN` | client 没有 `canReadLogs`。 |
| 404 | `NOT_FOUND` | run 不存在或不属于该 client。 |
| 413 | `REVIEW_BUNDLE_TOO_LARGE` | bundle 超过 `server.maxReviewBundleBytes`。 |

## GET /api/runs/:runId/feedback

读取某个 run 的通用反馈记录。feedback category 是 opaque string，daemon 只保存，不解释业务含义。

### Request

```http
GET /api/runs/run_xxx/feedback
Authorization: Bearer <api-key>
```

### Response 200

```json
{
  "feedback": [
    {
      "id": "feedback_xxx",
      "runId": "run_xxx",
      "clientId": "lqbot",
      "category": "skill",
      "message": "这里应该先询问用户参数。",
      "metadata": {
        "artifactPath": "output/result.json"
      },
      "createdAt": 1760000000000
    }
  ]
}
```

### Common Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | API key 缺失或错误。 |
| 404 | `NOT_FOUND` | run 不存在或不属于该 client。 |

## POST /api/runs/:runId/feedback

新增某个 run 的通用反馈记录。`message` 和 `metadata` 会经过通用脱敏。

### Request

```http
POST /api/runs/run_xxx/feedback
Authorization: Bearer <api-key>
Content-Type: application/json

{
  "category": "skill",
  "message": "这里应该先询问用户参数。",
  "metadata": {
    "artifactPath": "output/result.json"
  }
}
```

### Response 201

```json
{
  "feedback": {
    "id": "feedback_xxx",
    "runId": "run_xxx",
    "clientId": "lqbot",
    "category": "skill",
    "message": "这里应该先询问用户参数。",
    "metadata": {
      "artifactPath": "output/result.json"
    },
    "createdAt": 1760000000000
  }
}
```

### Common Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 请求体校验失败。 |
| 401 | `UNAUTHORIZED` | API key 缺失或错误。 |
| 404 | `NOT_FOUND` | run 不存在或不属于该 client。 |

## RunStatus

```text
queued
running
succeeded
failed
canceled
interrupted
```

## EventVisibility

```text
quiet
normal
debug
```

## RunKind

```text
generate
revise
```

规则：

- `legacy + generate` 必须传 `skillId`。
- `legacy + revise` 禁止传 `skillId`。
- `business-context` run 必须传 `skillId`，包括 `revise`。

## PublicArtifact

```ts
interface PublicArtifact {
  id: string;
  runId: string;
  workspaceId: string;
  ruleId: string;
  role: "primary" | "supporting" | "debug";
  relativePath: string;
  fileName: string;
  mimeType: string | null;
  size: number | null;
  mtime: number | null;
  sha256: string | null;
}
```

## cURL Examples

### Create Workspace

```bash
curl -s -X POST "$DAEMON_URL/api/workspaces" \
  -H "Authorization: Bearer $DAEMON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "profileId": "report-docx",
    "workspace": {
      "originId": "lqbot",
      "userId": "user_123",
      "projectId": "report_456"
    }
  }'
```

### Upload File

```bash
curl -s -X POST "$DAEMON_URL/api/workspaces/$WORKSPACE_ID/files" \
  -H "Authorization: Bearer $DAEMON_API_KEY" \
  -F "targetPath=input/source.docx" \
  -F "file=@./source.docx"
```

### Create Generate Run

```bash
curl -s -X POST "$DAEMON_URL/api/runs" \
  -H "Authorization: Bearer $DAEMON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "profileId": "report-docx",
    "workspaceId": "'"$WORKSPACE_ID"'",
    "kind": "generate",
    "skillId": "report-gen",
    "prompt": "请基于 input/source.docx 生成报告，输出到 output/report.docx。",
    "artifactRuleIds": ["report-docx"]
  }'
```

### Subscribe SSE

```bash
curl -N "$DAEMON_URL/api/runs/$RUN_ID/events" \
  -H "Authorization: Bearer $DAEMON_API_KEY" \
  -H "Accept: text/event-stream"
```

### Create Revise Run

```bash
curl -s -X POST "$DAEMON_URL/api/runs" \
  -H "Authorization: Bearer $DAEMON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "profileId": "report-docx",
    "workspaceId": "'"$WORKSPACE_ID"'",
    "kind": "revise",
    "prompt": "请修改当前 output/report.docx，把摘要压缩到 300 字以内。",
    "artifactRuleIds": ["report-docx"]
  }'
```

### Download Artifact

```bash
curl -L "$DAEMON_URL/api/runs/$RUN_ID/artifacts/$ARTIFACT_ID/download" \
  -H "Authorization: Bearer $DAEMON_API_KEY" \
  -o report.docx
```
