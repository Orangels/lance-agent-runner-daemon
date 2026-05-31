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
SKILL_UNAVAILABLE
SKILL_STAGING_FAILED
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
| `profiles[].allowedSkillIds` | string[] | `kind=generate` 可用的 `skillId`。 |
| `profiles[].artifactRules` | object[] | 可选择的 artifact rule。 |
| `profiles[].defaultArtifactRuleIds` | string[] | `POST /api/runs` 不传 `artifactRuleIds` 时使用。 |
| `profiles[].defaultModel` | string | 默认 Claude model。 |
| `profiles[].allowedModels` | string[] | `POST /api/runs.model` 必须命中。 |
| `profiles[].eventVisibility` | `quiet` / `normal` / `debug` | profile 允许的最大事件可见性。 |
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

Generate 示例：

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

Revise 示例：

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

### Request Fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `profileId` | string | yes | 必须是当前 client 可访问 profile。1-128 字符。 |
| `workspaceId` | string | yes | 必须是该 client 可访问 workspace。1-128 字符。 |
| `kind` | `generate` / `revise` | yes | 生成或修改。 |
| `prompt` | string | yes | 1 到 200000 字符。 |
| `skillId` | string | generate yes, revise no | `generate` 必须传；`revise` 禁止传。1-128 字符。 |
| `model` | string | no | 不传使用 profile `defaultModel`；传入时必须在 `allowedModels` 内。 |
| `artifactRuleIds` | string[] | no | 最多 32 个；不传使用 profile `defaultArtifactRuleIds`。 |
| `eventVisibility` | `quiet` / `normal` / `debug` | no | 只能降低到 profile 可见性，不会超过 profile/client 权限。 |
| `metadata` | object | no | 业务自定义 JSON，daemon 不解释。 |

### Response 202

```json
{
  "runId": "run_xxx",
  "status": "queued"
}
```

### Common Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | schema 校验失败、`generate` 缺少 `skillId`、`revise` 携带 `skillId`、workspace profile 不匹配。 |
| 400 | `MODEL_NOT_ALLOWED` | model 不在 profile `allowedModels` 内。 |
| 400 | `SKILL_NOT_ALLOWED` | skill 不在 profile `allowedSkillIds` 内。 |
| 400 | `BAD_REQUEST` | artifact rule id 未知。 |
| 401 | `UNAUTHORIZED` | API key 缺失或错误。 |
| 403 | `PROFILE_NOT_ALLOWED` | client 不能使用该 profile。 |
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
- `content` 是 assistant 聚合文本，不保证包含所有 tool/debug 信息。
- terminal 后长期查看应以该接口为准，不以 SSE 为准。

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
{ type: 'tool_result'; toolUseId: unknown; content: string; isError: boolean }
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
Content-Disposition: attachment; filename="<fileName>"
```

### Common Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | API key 缺失或错误。 |
| 403 | `PROFILE_NOT_ALLOWED` | client 不能使用 run 所属 profile。 |
| 404 | `NOT_FOUND` | run/artifact 不存在、不属于该 client，或文件已不存在。 |

## GET /api/runs/:runId/logs

读取受控 run logs 摘要。只有 `client.canReadLogs=true` 的 client 可以调用。

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

- `generate` 必须传 `skillId`。
- `revise` 禁止传 `skillId`。

## PublicArtifact

```ts
interface PublicArtifact {
  id: string;
  runId: string;
  workspaceId: string;
  ruleId: string;
  role: string;
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
