# Business Agent Adapter Handoff

本文面向业务方 Codex / agent / 后端适配者，说明如何把业务系统接入 Claude Code Runner Daemon。

这是一份执行说明，不替代完整 API 文档。字段细节以 `docs/api-reference.md` 为准，业务流程背景见 `docs/business-run-chat-integration-guide.md`，本地演示台使用见 `docs/web-test-console-usage.md`。

## 目标

业务方需要实现三条路径：

1. 报告生成，优先使用 webhook：创建 run 时传入 webhook，由 daemon 主动通知状态变化，terminal 后下载最终报告。
2. 报告生成，订阅 SSE：实时展示 agent 过程，terminal 后对账并下载报告。
3. Chat 修改：在同一 workspace 上创建 revise run，修改已有报告并同步新产物。

除非业务端暂时没有可被 daemon 访问的 callback 服务，否则不要把高频轮询作为主要任务完成通知机制。`GET /api/runs/:runId/status` 应保留为兜底恢复、人工对账、webhook 异常后的补偿查询。

`apps/web` 只是测试台和流程示例。生产业务端应保存自己的业务 project / thread / message / artifact 状态，不要把 daemon 当成业务聊天数据库。

## 基础配置

业务方需要从部署方拿到：

```text
DAEMON_URL       例如 http://127.0.0.1:17890
DAEMON_API_KEY   由 daemon config 中 client.apiKeys 对应
PROFILE_ID       例如 report-docx
SKILL_ID         generate 使用，例如 report-gen
```

所有受保护接口都带：

```text
Authorization: Bearer <DAEMON_API_KEY>
```

不要把 API key 放到 query string。浏览器 SSE 不能用原生 `EventSource` 携带 Authorization header，推荐使用 `fetch + ReadableStream`，或由业务后端代理 SSE。

## 业务端需要保存的字段

项目维度建议保存：

```text
business_project_id
daemon_profile_id
daemon_workspace_id
daemon_workspace_key
latest_daemon_run_id
latest_primary_artifact_id
latest_primary_artifact_path
generation_status
last_error_code
last_error_message
created_at
updated_at
```

消息 / 操作维度建议保存：

```text
business_message_id
business_thread_id
daemon_workspace_id
daemon_run_id
run_kind              # generate | revise
user_prompt
assistant_content
run_status
artifact_ids_json
daemon_idempotency_key
webhook_event_ids_json     # 或使用单独 webhook_events 表保存已处理 eventId
created_at
updated_at
```

daemon 会持久化 `run_messages`，但它是 daemon 的 run 摘要和恢复数据。业务系统仍应保存自己的业务会话和展示状态。

## 接入顺序

### 1. 封装 API Client

先实现通用请求封装：

- 自动拼接 `DAEMON_URL`。
- 自动加 `Authorization: Bearer <api-key>`。
- JSON 请求设置 `Content-Type: application/json`。
- multipart 上传不要手动设置 `Content-Type`，让运行时自动补 boundary。
- 统一解析错误结构：

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Invalid request",
    "details": {}
  }
}
```

业务逻辑只依赖 `error.code` 和 HTTP status，不依赖 `details` 的内部结构。

### 2. 查询 Profile

启动时或管理页调用：

```text
GET /api/profiles
```

业务方应读取并缓存：

- `profiles[].id`
- `profiles[].allowedSkillIds`
- `profiles[].artifactRules`
- `profiles[].defaultArtifactRuleIds`
- `profiles[].defaultModel`
- `profiles[].allowedModels`

`allowedSkillIds` 决定本 client/profile 可用哪些 `skillId`。`skillId` 是否必填取决于
`promptMode`：

| promptMode | generate | revise |
| --- | --- | --- |
| `legacy` | 必须传 `skillId` | 禁止传 `skillId` |
| `business-context` | 必须传 `skillId` | 必须传 `skillId` |
| `daemon-composed` | 必须传 `skillId` | 可选 `skillId` |

报告仿写的最小接入可以继续使用 `legacy`。如果业务后端已经维护报告参数、表单答案、上一轮
artifact 路径或阶段状态，并希望继续复用 `report-gen` skill 多轮更新同一报告，应使用
`business-context`。

### 3. 创建或复用 Workspace

业务项目第一次接入 daemon 时调用：

```text
POST /api/workspaces
```

请求：

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

响应：

```json
{
  "workspaceId": "ws_xxx",
  "workspaceKey": "lqbot/user_123/report_456"
}
```

业务端必须保存 `workspaceId`。后续 generate / revise 都只传 `workspaceId`，不要再把 `originId/userId/projectId` 内联到 `POST /api/runs`。

### 4. 准备输入文件

有两种方式。

如果业务系统和 daemon 共享文件系统，使用 prepare：

```text
POST /api/workspaces/:workspaceId/prepare
```

```json
{
  "files": [
    {
      "sourcePath": "/mnt/uploads/user_123/source.docx",
      "targetPath": "input/source.docx"
    }
  ]
}
```

如果业务系统和 daemon 不共享文件系统，推荐使用 upload：

```text
POST /api/workspaces/:workspaceId/files
Content-Type: multipart/form-data
```

字段：

```text
file        源文件，必须且只能有一个
targetPath  workspace 相对路径，例如 input/source.docx
```

多文件上传时，一次一个文件循环调用。不要上传到 `.claude-runner-skills/`，该目录受 daemon 保护。

### 5. 选择 Prompt Mode

业务端接 daemon 前先选清楚上下文模式：

- `legacy`：最简单的报告生成/修改路径。业务端只传 `prompt`，daemon 不接收业务上下文包。
- `business-context`：业务端维护流程状态、表单答案、artifact 路径或阶段信息，传
  `currentPrompt` + `businessContext`，daemon 注入 skill 和 side files 后组装最终 prompt。
- `daemon-composed`：daemon 根据同一 `conversationId` 的可见历史消息组装上下文，适合后续更通用 chat
  接入。

报告业务后端默认优先接 `legacy + generate + report-gen`。只有当业务端需要传结构化报告上下文，
或需要在 `revise` 中继续注入同一个业务 skill 时，再接 `business-context`。

## 推荐流程 A：Generate + Webhook

这是报告生成的默认推荐流程。适合业务端只关心“任务是否结束、报告是否生成”，不展示实时 agent 输出。

业务端应优先实现 webhook receiver，由 daemon 在 run 状态变化时主动 POST 业务端 callback。不要用高频轮询来判断任务是否完成；轮询只作为 webhook 失败、业务服务重启、人工排障或定时对账时的兜底。

流程：

```text
POST /api/runs
  -> 带 webhook
  -> 得到 runId 并保存 daemon_run_id

daemon worker POST webhook.url
  -> 业务端按 eventId 幂等去重
  -> 按 run.status 更新本地任务
  -> terminal + primary artifact 时保存 artifact id/path/hash

terminal 后如需下载文件：
  -> GET /api/runs/:runId/artifacts/:artifactId/download

兜底/对账：
  -> GET /api/runs/:runId/status
  -> GET /api/runs/:runId/artifacts
```

创建 run：

```json
{
  "profileId": "report-docx",
  "workspaceId": "ws_xxx",
  "kind": "generate",
  "skillId": "report-gen",
  "prompt": "请基于 input/source.docx 生成报告，输出到 output/report.docx。",
  "model": "sonnet",
  "artifactRuleIds": ["report-docx"],
  "idempotencyKey": "business:task_001:1",
  "metadata": {
    "businessMessageId": "msg_001"
  },
  "webhook": {
    "url": "http://192.168.88.20:8000/api/daemon/webhook",
    "secret": "shared-webhook-secret",
    "statuses": ["succeeded", "failed", "canceled", "interrupted"],
    "metadata": {
      "businessTaskId": "task_001",
      "businessMessageId": "msg_001"
    }
  }
}
```

Webhook 字段说明：

- `webhook.url` 必须是 daemon 可以访问到的业务端 callback。当前内部部署默认允许 `http` 和 `192.168.88.0/24` 内网地址，实际范围由 daemon `server.webhooks` 配置控制。
- `webhook.secret` 可选；传入后 daemon 会对 callback body 做 HMAC-SHA256 签名。业务端应校验签名和 timestamp。
- `webhook.statuses` 未传时默认通知 terminal 状态：`succeeded/failed/canceled/interrupted`。报告后台任务通常只需要 terminal 状态；如果业务 UI 要显示排队/运行过程，可显式加入 `queued/running`。
- `webhook.metadata` 会原样回传到 webhook payload，推荐放业务任务 id、消息 id、文档 id 等关联字段。不要放 API key、完整 prompt、用户隐私或大对象。
- `idempotencyKey` 建议业务端在派发前生成并持久化。同一次业务派发崩溃恢复时复用同一个 key；用户主动重试或新建任务时换新 key。

响应：

```json
{
  "runId": "run_xxx",
  "status": "queued"
}
```

业务端 webhook receiver 必须处理 daemon payload：

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
    "idempotencyKey": "business:task_001:1"
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
    "businessMessageId": "msg_001"
  }
}
```

Receiver 处理顺序：

1. 校验 `schemaVersion === "daemon.webhook.run.v1"` 和 `eventType === "run.status_changed"`。
2. 如果配置了 `webhook.secret`，用 `<X-Daemon-Webhook-Timestamp>.<raw-json-body>` 校验 `X-Daemon-Webhook-Signature`。
3. 用 `eventId` 或 `X-Daemon-Webhook-Id` 做幂等去重；已经处理过的 event 直接返回 `2xx`。
4. 通过 `metadata.businessTaskId`、`run.id` 或 `run.idempotencyKey` 定位本地任务。
5. 先持久化 webhook event，再更新本地任务状态。
6. terminal 状态下优先保存 `role=primary` 或 `ruleId=report-docx` 的 artifact 摘要。
7. 成功落库后返回任意 `2xx`。临时不可用返回 `429/5xx`，daemon 会重试；签名失败返回 `401/403`，daemon 不会重试。

`deliveryAttempt` 只用于诊断，可能跳号，不能作为连续序列或业务状态机依据。业务端必须用 `eventId` 做幂等。

Webhook 不改变 `POST /api/runs` 响应结构，也不替代 artifacts 下载接口。terminal webhook 只携带 artifact 摘要；需要文件内容时仍调用：

```text
GET /api/runs/run_xxx/artifacts/artifact_xxx/download
```

## 兜底流程：Status Poll

```text
GET /api/runs/run_xxx/status
```

响应：

```json
{
  "run": {
    "id": "run_xxx",
    "status": "running",
    "errorCode": null,
    "errorMessage": null
  },
  "terminal": false
}
```

Status Poll 只用于以下场景：

- 业务端刚接入 webhook 前的临时验证。
- webhook receiver 维护、异常、超时或重启后的补偿查询。
- 定时对账任务检查长时间未完成的本地任务。
- 人工排障时查看 daemon 当前状态。

建议兜底轮询间隔：

- 常规兜底：10-30 秒。
- `queued` 可适当拉长。
- `terminal=true` 后立即停止轮询。

daemon 会在 terminal 状态写入前于 `server.runLogCloseTimeoutMs` 内尽量 flush 本次 run logs。极端慢盘或日志写入异常时，Claude 子进程结束到 `/status` 返回 `terminal=true` 之间可能有短暂尾延迟；该尾延迟上限由 `server.runLogCloseTimeoutMs` 控制，默认最多约 5 秒。如果日志 close 超时，daemon 会继续写入 terminal 状态并通过 `warning` RunEvent 暴露降级信息。业务端不需要改流程，只要继续轮询到 `terminal=true`。

如果 webhook payload 中没有期望的 primary artifact，或业务端需要对账，可以 list artifacts：

```text
GET /api/runs/run_xxx/artifacts
```

选择规则：

1. 优先取 `role = "primary"` 的 artifact。
2. 没有 primary 时，再考虑 `role = "supporting"`。
3. `role = "debug"` 只用于排查，不建议展示给普通用户。

下载仍使用：

```text
GET /api/runs/run_xxx/artifacts/artifact_xxx/download
```

响应头包含：

```text
Content-Disposition: attachment; filename="<ascii-fallback>"; filename*=UTF-8''<utf8-percent-encoded-fileName>
```

业务端应优先解析 `filename*`，再回退到 `filename`。

## 流程 B：Generate + SSE

适合需要实时展示 agent 过程的业务 UI。

创建 run 与 Webhook 流程相同，可以同时传 `webhook`。拿到 `runId` 后订阅 SSE：

```text
GET /api/runs/:runId/events
Accept: text/event-stream
Authorization: Bearer <api-key>
```

SSE event name 固定为：

```text
event: agent
```

业务端应读取 `data.type`：

```text
status                  queued/running 等过程标签
assistant_message_start 新 assistant message 边界
text_delta              assistant 正文增量
thinking_delta          thinking 增量，normal 可见
tool_use                工具调用，normal 可见
artifact_finalized      artifact 已扫描落库
error                   run 错误
warning                 非终态降级事件，例如 RUN_LOG_WRITE_FAILED / RUN_LOG_WRITE_TIMEOUT
end                     run 终态
```

处理建议：

- 收到 `assistant_message_start`：开始一条新的 assistant 气泡。
- 收到 `text_delta`：追加到当前 assistant 气泡。
- 收到 `thinking_delta`：追加到当前 assistant thinking 区。
- 收到 `artifact_finalized`：记录 artifact id，但仍建议 terminal 后再 list artifacts 对账。
- 收到 `warning`：记录或忽略；不要把它当作 run failed。
- 收到 `end`：关闭 SSE，然后调用：

```text
GET /api/runs/:runId
GET /api/runs/:runId/artifacts
```

`GET /api/runs/:runId` 是 durable detail，用于 terminal 对账、SSE 断线恢复、历史查看。不要把 SSE 当长期历史存储。

SSE 客户端必须容忍未知 `data.type`。daemon 可能新增非终态事件类型；业务端应使用默认分支忽略或记录未知事件，而不是抛错中断整个流。

断线恢复：

```text
GET /api/runs/:runId/events?after=<lastEventId>
```

或请求头：

```text
Last-Event-ID: <lastEventId>
```

如果返回 `404`，说明内存事件流已过期或 daemon 重启，改用 `GET /api/runs/:runId` 恢复。

## 流程 C：Legacy Chat 修改 / Revise

Legacy revise 用于同一个业务项目、同一个 workspace 上的后续报告修改。

前置条件：

- 已有 `workspaceId`。
- workspace 内已有可修改文件，例如 `output/report.docx`。
- 如果用户上传新材料，先 upload/prepare 到 `input/` 或 `work/`。

创建 revise run：

```json
{
  "profileId": "report-docx",
  "workspaceId": "ws_xxx",
  "kind": "revise",
  "prompt": "请基于当前 output/report.docx 修改：把摘要压缩到 300 字以内，并根据 input/new-data.xlsx 更新数据表。",
  "artifactRuleIds": ["report-docx"],
  "metadata": {
    "businessMessageId": "msg_002",
    "previousRunId": "run_previous"
  }
}
```

Revise 规则：

- 这是 `promptMode` 默认为 `legacy` 的 revise，因此禁止传 `skillId`。
- daemon 不接收业务 chat history 数组。
- 如果需要历史上下文，业务端把必要上下文总结进 `prompt`。
- 修改发生在同一个 workspace 文件状态上，Claude 可以看到已有 `input/`、`work/`、`output/` 文件。

Revise 后续也优先使用 webhook 接收 terminal 通知。实时 chat UI 可同时订阅 SSE 展示过程；Poll 仍只作为 webhook/SSE 异常后的兜底对账。

## 流程 D：Business-context 报告多轮流程

报告业务后端如果已经维护结构化上下文，例如报告限定条件、表单答案、上一轮 artifact 路径、
业务消息 id 或阶段状态，可以使用 `business-context`。这条路径允许 `generate` 和 `revise`
都显式传 `report-gen`，由业务端传入结构化上下文包，daemon 负责注入 skill 和 side files 后组装最终 prompt。

适用场景：

- 业务后端把“报告范围、统计口径、机构/时间条件、模板/数据文件路径”作为结构化上下文保存。
- 业务 UI 有参数确认表单，用户回答后需要继续同一份报告生成。
- 后续修改不仅依赖一句 `prompt`，还需要显式传上一轮报告 artifact、业务消息 id 或表单答案。
- 需要 `collectionMode: "diagnostic"` 保存 prompt / business context snapshot，方便后台排查。

报告 business-context generate 示例：

```json
{
  "profileId": "report-docx",
  "workspaceId": "ws_xxx",
  "kind": "generate",
  "promptMode": "business-context",
  "collectionMode": "diagnostic",
  "skillId": "report-gen",
  "currentPrompt": "请根据已上传的模板和数据生成正式报告。",
  "businessContext": {
    "stage": "initial-generate",
    "templatePath": "input/template.docx",
    "dataPath": "input/data.xlsx",
    "reportScope": "2025年8月 临高县公安局",
    "requestedOutputPath": "output/report.docx"
  },
  "artifactRuleIds": ["report-docx"]
}
```

报告 business-context revise 示例：

```json
{
  "profileId": "report-docx",
  "workspaceId": "ws_xxx",
  "conversationId": "conv_xxx",
  "kind": "revise",
  "promptMode": "business-context",
  "collectionMode": "diagnostic",
  "skillId": "report-gen",
  "currentPrompt": "用户已确认补充参数，请继续更新报告。",
  "businessContext": {
    "stage": "question-form-answers",
    "previousRunId": "run_previous",
    "artifactPaths": ["output/report.docx"],
    "formAnswers": {
      "reportScope": "2025年8月 临高县公安局",
      "summaryLength": "300字以内"
    }
  },
  "artifactRuleIds": ["report-docx"]
}
```

业务端负责解释 `businessContext` 的业务语义；daemon 只做通用校验、skill 注入、prompt 组装、
运行和 artifact 扫描。

## Run Detail 消费规则

完整详情接口：

```text
GET /api/runs/:runId
```

返回：

- `run`
- `messages`

`messages` 按 `position ASC` 排序。一个 run 通常包含：

- 一条 user message。
- 一条或多条 assistant messages。

业务端不要假设一个 run 只有一条 assistant message。

消费建议：

- 聊天 UI：按顺序渲染所有 assistant messages。
- 需要完整 assistant 文本：按 `position ASC` 拼接所有 assistant `content`。
- 只需要最后一次 assistant 回复：取最后一条非空 assistant `content`。
- 报告生成结果：以 artifacts/download 为准，assistant `content` 只作为过程摘要。
- `thinkingContent` 只在允许可见性下返回；没有 thinking 时为空字符串。
- `messages[].events` 与 SSE 使用同一类 RunEvent 结构，可能包含 `warning` 或后续新增事件类型；解析时也要容忍未知 `type`。

## 取消

用户点击停止时调用：

```text
POST /api/runs/:runId/cancel
```

响应：

```json
{
  "ok": true
}
```

取消后业务端应停止本地 SSE/poll，并调用 `GET /api/runs/:runId/status` 或 `GET /api/runs/:runId` 做最终对账。

## 错误处理

业务端至少处理这些错误码：

| Code | 建议处理 |
| --- | --- |
| `UNAUTHORIZED` | API key 错误，报警给运维或配置页。 |
| `PROFILE_NOT_ALLOWED` | 当前 client 不能使用该 profile。 |
| `NOT_FOUND` | workspace/run/artifact 不存在或不属于当前 client。 |
| `MODEL_NOT_ALLOWED` | 选择 profile 允许的 model。 |
| `SKILL_NOT_ALLOWED` | 选择 profile 允许的 skill。 |
| `SKILL_UNAVAILABLE` | 部署配置允许但 skill 文件不可用，交给运维。 |
| `RUN_QUEUE_FULL` | 稍后重试或提示系统繁忙。 |
| `WORKSPACE_RUN_ACTIVE` | 同 workspace 已有运行中任务，等待或提示用户。 |
| `RUN_NOT_CANCELABLE` | run 已结束或 finishing。 |
| `RUN_TIMEOUT` | 总运行超时，允许用户重试。 |
| `RUN_INACTIVITY_TIMEOUT` | Claude 长时间无输出，允许用户重试。 |
| `ARTIFACT_REQUIRED_MISSING` | 任务结束但必需报告没生成，标记业务失败。 |
| `ARTIFACT_SCAN_FAILED` | artifact 扫描失败，标记业务失败并通知运维。 |
| `RUN_INTERRUPTED_BY_DAEMON_RESTART` | daemon 重启/关闭中断，允许用户重试。 |
| `CLAUDE_AUTH_FAILED` | Claude Code 未登录或认证失效，通知运维。 |
| `CLAUDE_CLI_FAILED` | Claude CLI 启动或执行失败，查看 logs。 |
| `PATH_NOT_ALLOWED` / `INVALID_PATH_SEGMENT` | 修正业务传入路径或 workspace identity。 |

失败 run 仍可能有 logs 或部分 artifacts。业务后台可以调用：

```text
GET /api/runs/:runId/logs
```

该接口仅 `client.canReadLogs=true` 时可用，不建议暴露给普通用户。

`RUN_LOG_WRITE_FAILED` / `RUN_LOG_WRITE_TIMEOUT` 这类 warning 只表示日志诊断材料写入或 close 降级，不代表报告生成本身失败。业务端判断任务成功/失败仍以 run status、errorCode/errorMessage 和 artifacts 为准。

## Web Test Console 对照

`apps/web` 是给业务方 Codex 看的参考实现：

| Web 操作 | 对应业务流程 |
| --- | --- |
| `Generate + SSE` | 创建 generate run，订阅 `/events`，实时渲染 agent 输出，terminal 后对账。 |
| `Generate + Poll` | 历史/兜底参考：创建 generate run，轮询 `/status`，terminal 后读取 artifacts。生产业务端应优先使用 webhook。 |
| `Revise` | legacy revise：同 workspace 创建 revise run，不传 `skillId`，修改已有报告。 |
| 文件选择 | 循环调用 `POST /api/workspaces/:workspaceId/files`。 |
| 下载按钮 | 调用 artifact download API。 |

Web demo 不做生产鉴权、不保存业务数据库、不代表最终业务 UI。它当前包含 Poll/SSE 示例是为了便于本地调试和对账，不表示业务生产接入应高频轮询状态。

## 业务方不要做的事

- 不要把轮询作为主要任务完成通知机制；优先使用 webhook。`GET /api/runs/:runId/status` 只用于兜底恢复、对账和排障。
- 不要高频轮询 `GET /api/runs/:runId`；完整 detail 接口只用于 terminal 对账、历史查看或诊断。
- 不要把 SSE 当作长期历史存储。
- 不要在 `legacy revise` 请求里传 `skillId`。
- 不要在 `business-context` 请求里省略 `skillId`。
- 不要把复杂报告业务状态塞进 legacy `prompt` 后再要求 daemon 推断流程阶段；这种情况使用
  `business-context`。
- 不要在 `POST /api/runs` 中传 `originId/userId/projectId`。
- 不要让用户或前端传 sandbox 绝对路径。
- 不要试图覆盖 `claudeConfigDir`、`claudeBin`、`skillRoots`、`allowedInputRoots`、`permissionMode`。
- 不要把 daemon 的目录隔离描述成强 sandbox。
- 不要把 `debug` artifacts 或 run logs 默认暴露给普通用户。

## 业务方 Agent 验收清单

业务方适配完成后，至少验证：

1. 能 `GET /api/profiles` 并选择正确 profile / skill。
2. 能创建 workspace，并把 `workspaceId` 保存到业务项目。
3. 能上传一个输入文件到 `input/`。
4. 能创建 `kind=generate` run，传入 `webhook` 和 `idempotencyKey`，并保存 `runId`。
5. Webhook receiver 能校验签名、按 `eventId` 幂等去重，并把 terminal 状态写回业务数据库。
6. Terminal webhook 后能选择 `role=primary` artifact 并下载，中文文件名可用。
7. Status Poll 只作为兜底：调用 `/status` 对账，terminal 后再 list artifacts。
8. SSE 模式下能用 `fetch + ReadableStream` 读取 `event: agent`，并容忍未知事件类型。
9. 能在 SSE `end` 后调用 run detail 做 durable 对账。
10. 能创建 legacy `kind=revise` run，且不传 `skillId`，并同样优先用 webhook 接收 terminal 通知。
11. 如果接入多轮报告业务 skill，能创建 `business-context revise` run，且显式传 `report-gen`。
12. 能处理失败 run 的 `errorCode/errorMessage`。
13. 能取消 queued/running run。
14. 业务数据库能从 `business_project_id` 追溯到 `workspaceId/runId/artifactId/webhookEventId`。
