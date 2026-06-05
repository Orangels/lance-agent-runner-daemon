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
SKILL_UNAVAILABLE
SKILL_STAGING_FAILED
PROMPT_COMPOSITION_FAILED
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
      "allowedSkillIds": ["report-writer"],
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
| `profiles[].allowedSkillIds` | string[] | `legacy + generate` 以及 MVP `business-context` run 可用的 `skillId`。 |
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
  "skillId": "report-writer",
  "prompt": "请基于 input/source.docx 生成报告，输出到 output/report.docx。",
  "model": "sonnet",
  "artifactRuleIds": ["report-docx"],
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
  "skillId": "report-writer",
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
| `eventVisibility` | `quiet` / `normal` / `debug` | no | 只能降低到 profile 可见性，不会超过 profile/client 权限。 |
| `metadata` | object | no | 业务自定义 JSON，daemon 不解释。 |

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

```json
{
  "runId": "run_xxx",
  "status": "queued",
  "conversationId": "conv_xxx",
  "userMessageId": "msg_user_xxx",
  "assistantMessageId": "msg_assistant_xxx"
}
```

### Common Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | schema 校验失败、promptMode 字段组合错误、workspace profile 不匹配、conversationId 不属于同一 workspace。 |
| 400 | `MODEL_NOT_ALLOWED` | model 不在 profile `allowedModels` 内。 |
| 400 | `SKILL_NOT_ALLOWED` | skill 不在 profile `allowedSkillIds` 内。 |
| 400 | `BAD_REQUEST` | artifact rule id 未知。 |
| 401 | `UNAUTHORIZED` | API key 缺失或错误。 |
| 403 | `PROFILE_NOT_ALLOWED` | client 不能使用该 profile。 |
| 403 | `COLLECTION_MODE_NOT_ALLOWED` | 请求的 `collectionMode` 超过 profile/client 权限。 |
| 404 | `NOT_FOUND` | workspace 不存在或不属于该 client。 |
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
      "skillId": "report-writer",
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
    "skillId": "report-writer",
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
    "skillId": "report-writer",
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
- MVP `business-context` run 必须传 `skillId`，包括 `revise`。

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
    "skillId": "report-writer",
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
