# Business Run And Chat Integration Guide

本文面向业务端 agent / 后端适配者，说明如何把业务系统的“生成”和“对话式修改”接到 Claude Code Runner Daemon。

当前 daemon 是第一版落地测试候选版本。它提供通用 Claude Code CLI run 能力，不包含 lanceDesign 或 lqBot 的产品逻辑。业务端需要自己维护业务会话、用户权限、文件来源、业务数据库记录和前端展示状态。

本仓库同时提供本地浏览器测试台 `apps/web`，用于演示本文中的 generate、generate-without-SSE 和 revise 三条业务调用路径。启动和操作说明见 `docs/web-test-console-usage.md`。测试台只保存浏览器内存状态，不能替代业务端数据库。

## 核心模型

业务端不要把 daemon 当成聊天数据库。daemon 负责：

- 创建和复用 workspace。
- 把输入文件放进 workspace。
- 启动 Claude Code CLI run。
- 提供在线 SSE 事件。
- 持久化本次 run 的 user/assistant message 摘要。
- 扫描 artifact 并提供下载。
- 提供受控 run logs。

业务端负责：

- 用户鉴权和业务权限。
- 业务会话 / chat thread / project 记录。
- 将业务对象映射到 daemon workspace。
- 保存 `workspaceId`、`runId`、artifact 信息和业务状态。
- 决定何时创建 generate run，何时创建 revise run。
- 选择 `promptMode`，并提供 legacy `prompt` 或 `business-context` 模式下的
  `currentPrompt` / `businessContext`。
- 提供业务端 HTTP callback，优先使用 webhook 接收 daemon run 状态变化，校验 daemon 签名、幂等处理 webhook event，并把 run 状态写回业务数据库。

## 关键 ID 映射

建议业务端持久化以下映射：

```text
businessOriginId + businessUserId + businessProjectId
  -> daemon workspaceId
  -> many daemon runIds
  -> many daemon artifactIds
```

daemon 的 workspace identity 由三个安全路径片段组成：

```json
{
  "originId": "lqbot",
  "userId": "user_123",
  "projectId": "report_456"
}
```

这些字段会生成 `workspaceKey`：

```text
lqbot/user_123/report_456
```

同一个 client、同一个 profile、同一个 workspace identity 会复用同一个 daemon workspace。不同 client 或不同 profile 不会互相复用。

## 推荐业务表字段

业务端可以按自己的表结构落库，但建议至少保存：

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
daemon_idempotency_key
webhook_event_ids_json     # 或单独建表保存已处理 eventId
created_at
updated_at
```

如果业务端有 chat/thread 概念，建议每条用户消息关联：

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
created_at
updated_at
```

daemon 内部也会写 `run_messages`，但业务端仍应保存自己的业务消息和展示状态。

## 新建生成流程

用于第一次生成报告、文档、代码产物等。

### 1. 查询可用 profile

业务端启动时或配置页可调用：

```text
GET /api/profiles
```

选择业务要使用的 `profileId`，并读取：

- `allowedSkillIds`
- `artifactRules`
- `defaultArtifactRuleIds`
- `defaultModel`
- `allowedModels`

### 2. 创建或获取 workspace

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

业务端必须保存 `workspaceId`。后续所有 run 都引用这个 id。

### 3. 准备输入文件

有两种方式。

如果业务系统和 daemon 共享文件系统，使用 prepare：

```text
POST /api/workspaces/:workspaceId/prepare
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

如果业务系统和 daemon 不共享文件系统，使用 Phase 4 upload：

```text
POST /api/workspaces/:workspaceId/files
Content-Type: multipart/form-data
```

字段：

```text
file       源文件，必须且只能有一个
targetPath workspace 相对路径，例如 input/source.docx
```

业务端不要把文件放到 `.claude-runner-skills/`，该目录受保护。

### 4. 创建 generate run

```text
POST /api/runs
```

生产接入默认应同时传 `idempotencyKey` 和 `webhook`。`idempotencyKey` 用于业务 worker 崩溃恢复时安全重放同一次派发；`webhook` 用于让 daemon 主动通知业务端 run 状态变化。临时本地调试可以不传 `webhook`，但不要把 Poll 当成业务主路径。

请求：

```json
{
  "profileId": "report-docx",
  "workspaceId": "ws_xxx",
  "kind": "generate",
  "skillId": "report-gen",
  "prompt": "请基于 input/source.docx 生成一份正式报告，输出到 output/report.docx。",
  "model": "sonnet",
  "artifactRuleIds": ["report-docx"],
  "eventVisibility": "normal",
  "idempotencyKey": "gaclaw:task_001:1",
  "metadata": {
    "businessMessageId": "msg_001",
    "businessTaskId": "task_001"
  },
  "webhook": {
    "url": "http://192.168.88.20:8000/api/daemon/webhook",
    "secret": "shared-webhook-secret",
    "statuses": ["succeeded", "failed", "canceled", "interrupted"],
    "metadata": {
      "businessTaskId": "task_001"
    }
  }
}
```

响应：

```json
{
  "runId": "run_xxx",
  "status": "queued",
  "conversationId": "conv_xxx",
  "userMessageId": "msg_user_xxx",
  "assistantMessageId": "msg_assistant_xxx"
}
```

注意：

- legacy `generate` 必须传 `skillId`。
- `POST /api/runs` 只接受 `workspaceId`，不要内联 `originId/userId/projectId`。
- `model` 必须属于 profile 的 `allowedModels`。
- 不传 `artifactRuleIds` 时使用 profile 的 `defaultArtifactRuleIds`。
- run 创建后可能先排队，业务端要展示 `queued` 状态。
- daemon 会返回 `conversationId/userMessageId/assistantMessageId`，业务端可以保存它们用于后续多轮对齐。
- 同一次业务派发重试时复用同一个 `idempotencyKey`；用户主动重新生成或新建任务时换新 key。

### 5. 使用 webhook 接收状态通知

如果业务方只需要知道“任务何时结束、报告是否生成”，默认应使用 webhook，由 daemon 在 run 状态变化后主动通知业务端。不要把轮询作为主要任务完成通知机制；`GET /api/runs/:runId/status` 只保留为 webhook 异常、业务服务重启、定时对账或人工排障时的兜底。

Webhook-first 业务流程：

```text
业务后端创建本地 generation_task
  -> 保存 daemon_idempotency_key
  -> 创建/复用 daemon workspace
  -> 上传附件到 workspace input/
  -> POST /api/runs，带 webhook
  -> 保存 daemon_run_id

daemon 状态变化
  -> daemon 写入 webhook outbox
  -> daemon worker 异步 POST 业务端 webhook.url

业务端 webhook receiver
  -> 校验签名和 schema
  -> 用 eventId 幂等去重
  -> 用 metadata.businessTaskId / run.id / run.idempotencyKey 找到本地 task
  -> 按 run.status 更新本地 task
  -> terminal + primary artifact 时保存 artifact id/path/hash
  -> 返回 2xx

业务端兜底 worker
  -> 仅在 webhook 异常、业务服务重启或长时间未收到 terminal 通知时低频 Poll
  -> webhook 异常时继续通过 GET /api/runs/:runId/status 和 artifacts API 对账
```

`webhook` 字段应随第 4 步 `POST /api/runs` 一起提交。字段示例：

```json
{
  "url": "http://192.168.88.20:8000/api/daemon/webhook",
  "secret": "shared-webhook-secret",
  "statuses": ["succeeded", "failed", "canceled", "interrupted"],
  "metadata": {
    "businessTaskId": "task_001"
  }
}
```

说明：

- `webhook` 不改变 `POST /api/runs` 响应结构，业务端仍然拿 `runId/status/conversationId/userMessageId/assistantMessageId`。
- 默认未传 `statuses` 时只通知 terminal 状态：`succeeded/failed/canceled/interrupted`。
- 可以传内网 URL；当前 daemon 默认允许 `http` 和 `192.168.88.0/24`，实际允许范围由 `server.webhooks` 配置控制。
- daemon 会在新建 run 时校验 webhook URL 是否符合协议、端口、host 和内网 CIDR 策略；不符合会拒绝整个 create-run。daemon 不会在创建 run 前 POST 探测 webhook 是否可用。若同一 `idempotencyKey` 命中已有 run 且 fingerprint 一致，daemon 会直接返回旧 run，不会重新按当前 webhook URL 策略校验旧请求。URL 无法访问、超时、`429`、`5xx` 会异步重试；不可重试 `4xx` 或达到最大次数后标记 abandoned。
- `webhook.metadata` 稳定 JSON 后最多 16KiB。daemon 配置禁用 webhook 时，传 `webhook` 会返回 `400 BAD_REQUEST`，`details.reason` 为 `webhooks_disabled`。
- 业务端应继续保留 Poll/SSE 兜底能力，但正常后台任务完成通知应优先依赖 webhook，不要高频轮询 daemon。
- `deliveryAttempt` 是 daemon 的 claim attempt number，可能跳号，业务端不能把它当作连续序列；业务端必须用 `eventId` / `X-Daemon-Webhook-Id` 做幂等去重。
- 如果使用 `idempotencyKey`，webhook URL、statuses、metadata 和 secret hash 都参与幂等 fingerprint。同 key 但 webhook 参数不同会返回 `409 IDEMPOTENCY_KEY_CONFLICT`。

推荐 `webhook.metadata` 至少携带业务任务 id：

```json
{
  "businessTaskId": "task_001",
  "origin": "gaclaw"
}
```

`metadata` 会原样出现在 webhook payload 顶层 `metadata` 字段中。它只用于业务端定位自己的任务，不参与 daemon 的业务逻辑；不要放用户隐私、API key、完整 prompt 或大对象。

签名校验：

```text
X-Daemon-Webhook-Id: whd_xxx
X-Daemon-Webhook-Timestamp: 1780000000000
X-Daemon-Webhook-Signature: v1=<hex hmac sha256>
```

签名输入是 `<timestamp>.<raw-json-body>`，算法是 HMAC-SHA256，密钥是 `webhook.secret`。业务端应校验 timestamp 时效，并用 `X-Daemon-Webhook-Id` 做幂等去重。

业务端 receiver 需要适配 daemon 发送的 payload：

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
    "clientId": "lqbot",
    "kind": "generate",
    "skillId": "report-gen",
    "status": "succeeded",
    "queuedAt": 1780000000000,
    "startedAt": 1780000005000,
    "finishedAt": 1780000120000,
    "errorCode": null,
    "errorMessage": null,
    "idempotencyKey": "gaclaw:task_001:1"
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
    "origin": "gaclaw"
  }
}
```

字段处理建议：

| 字段 | 业务端用途 |
| --- | --- |
| `eventId` / `X-Daemon-Webhook-Id` | webhook event 幂等去重主键。重复收到同一个 id 时直接返回 `2xx`。 |
| `eventType` | 当前只处理 `run.status_changed`。未知类型不要更新任务状态。 |
| `deliveryAttempt` | 仅用于诊断，不保证连续，不用于业务状态机判断。 |
| `run.id` | 对应业务库保存的 `daemon_run_id`。 |
| `run.status` | 更新本地任务状态。terminal 状态是 `succeeded/failed/canceled/interrupted`。 |
| `run.errorCode` / `run.errorMessage` | 写入失败原因；不要当作完整日志。 |
| `run.idempotencyKey` | 可用于对账本地 `daemon_idempotency_key`。 |
| `artifacts` | terminal payload 的 artifact 摘要。报告生成一般选择 `role=primary` 或 `ruleId=report-docx`。 |
| `metadata.businessTaskId` | 推荐用于定位本地 `generation_task`。 |

业务端返回值要求：

- 成功处理并落库后返回任意 `2xx`，daemon 认为投递成功。
- 临时不可用可以返回 `429` 或 `5xx`，daemon 会按配置重试。
- 签名失败建议返回 `401` 或 `403`，daemon 不会重试这类不可重试错误。
- 不要在业务端还没落库时提前返回 `2xx`；否则 daemon 会认为该通知已成功投递。

业务端收到 terminal webhook 后的 artifact 处理：

```text
payload.artifacts 找 role=primary 或 ruleId=report-docx
  -> 保存 artifact.id / relativePath / sha256 到业务库
  -> 如需文件内容，调用：
     GET /api/runs/:runId/artifacts/:artifactId/download
```

如果 webhook payload 中没有期望的 primary artifact，业务端仍可用原流程兜底：

```text
GET /api/runs/:runId/artifacts
  -> 找 primary artifact
  -> GET /api/runs/:runId/artifacts/:artifactId/download
```

### 5a. 兜底状态查询

`GET /api/runs/:runId/status` 不返回 `messages/events/content/thinkingContent`，适合兜底对账。业务端不要用它替代 webhook 做主要任务完成通知。

兜底流程：

```text
GET /api/runs/:runId/status
  -> status = queued/running 继续等待 webhook 或低频补偿
  -> terminal = true 停止兜底查询

GET /api/runs/:runId/artifacts
  -> 找 role=primary 的报告

GET /api/runs/:runId/artifacts/:artifactId/download
  -> 下载报告
```

建议兜底查询间隔为 10-30 秒，`queued` 可适当拉长。daemon 会在 terminal 状态写入前于 `server.runLogCloseTimeoutMs` 内尽量 flush 本次 run logs，因此 Claude 子进程实际结束到 `/status` 返回 `terminal=true` 之间可能有很短尾延迟。若日志 close 超时，daemon 会继续写入 terminal 状态并通过 `warning` RunEvent 暴露降级信息。

### 6. 订阅 SSE

```text
GET /api/runs/:runId/events
```

业务端可以实时消费 `event: agent`：

```text
id: 1
event: agent
data: {"type":"status","label":"queued"}

id: 2
event: agent
data: {"type":"status","label":"running"}

id: 3
event: agent
data: {"type":"text_delta","delta":"..."}

id: 4
event: agent
data: {"type":"artifact_finalized","artifact":{"id":"artifact_xxx","runId":"run_xxx","ruleId":"report-docx","role":"primary","relativePath":"output/report.docx","fileName":"report.docx","mimeType":"application/vnd.openxmlformats-officedocument.wordprocessingml.document","size":123456,"mtime":1770000000000,"sha256":"..."}}

id: 5
event: agent
data: {"type":"warning","code":"RUN_LOG_WRITE_TIMEOUT","message":"Run log write timed out.","details":{"timeoutMs":5000}}

id: 6
event: agent
data: {"type":"end","status":"succeeded"}
```

业务端处理建议：

- `status/queued`：展示排队中。
- `status/running`：展示运行中。
- `assistant_message_start`：开始一段新的 assistant 消息；业务端如果要还原 daemon 的分段展示，应从此事件开始创建/切换当前 assistant 消息。
- `text_delta`：追加到当前 assistant 消息。
- `artifact_finalized`：记录 artifact id 和相对路径。
- `error`：记录错误码和消息。
- `warning`：记录非终态降级事件，或直接忽略；不要把它当作 run failed。
- `end`：停止 SSE，随后调用 run detail 和 artifacts API 做最终对账。

业务端必须容忍未知 `data.type`，并保留默认分支忽略或记录未知事件。RunEvent 类型可能随 daemon 能力扩展而增加。

SSE 只保证在线和短期断线 replay。长期事后查看必须使用 `GET /api/runs/:runId`。

### 7. 获取最终详情

run 结束后调用：

```text
GET /api/runs/:runId
```

业务端用它做最终落库：

- `run.status`
- `run.errorCode`
- `run.errorMessage`
- `run.usage`
- `messages[].content`
- `messages[].thinkingContent`
- `messages[].events`

`messages[].events` 与 SSE 使用同一类 RunEvent 结构，也可能包含 `warning` 或后续新增事件类型。业务端解析 run detail 时也应容忍未知 event type。

`messages` 按 `position ASC` 返回。一个 run 通常有一条 user message，并可能有多条 assistant messages：

- 聊天 UI：按顺序渲染所有 assistant messages，不要假设只有一条 assistant。
- 需要完整 assistant 文本：按 `position ASC` 拼接所有 assistant `content`。
- 只需要最后一次 assistant 回复：取最后一条非空 assistant `content`。
- 报告生成结果：以 artifacts/download 为准，assistant `content` 只作为执行说明和过程摘要。

### 8. 获取 artifact 并下载

```text
GET /api/runs/:runId/artifacts
GET /api/runs/:runId/artifacts/:artifactId/download
```

业务端一般保存：

- `artifact.id`
- `artifact.ruleId`
- `artifact.role`
- `artifact.relativePath`
- `artifact.fileName`
- `artifact.mimeType`
- `artifact.size`
- `artifact.sha256`

下载建议由业务后端代理给前端，不建议浏览器直接访问 daemon。

## Chat 修改 / Revise 流程

“chat 修改”不是 daemon 内置的产品聊天。推荐业务端把用户后续自然语言修改映射为同一个 workspace 上的 `revise` run。

### 何时使用 revise

使用 `revise` 的典型场景：

- 用户已生成一个报告，现在要求“把摘要改短一点”。
- 用户要求“根据刚上传的新资料补充第三章”。
- 用户要求“保留当前文档结构，只修改结论部分”。
- 用户连续多轮修改同一个业务项目。

### Revise 前置条件

业务端需要已有：

- `workspaceId`
- 上一次成功或失败的 `runId`，用于业务侧展示上下文。
- workspace 中已有可修改的文件，例如 `output/report.docx`。

如果用户提供了新附件，先调用 prepare/upload 把新附件放入 `input/` 或 `work/`。

### 创建 revise run

```text
POST /api/runs
```

请求：

```json
{
  "profileId": "report-docx",
  "workspaceId": "ws_xxx",
  "kind": "revise",
  "prompt": "请基于当前 output/report.docx 修改：把摘要压缩到 300 字以内，并根据 input/new-data.xlsx 更新数据表。",
  "artifactRuleIds": ["report-docx"],
  "eventVisibility": "normal",
  "metadata": {
    "businessMessageId": "msg_002",
    "previousRunId": "run_previous"
  }
}
```

注意：

- legacy `revise` 不接收 `skillId`；如果要继续同一个业务 skill 流程，使用
  `promptMode: "business-context"` 并显式传 `skillId`。
- daemon 可以接收 `conversationId`；如传入，必须属于同一 workspace。
- daemon 不接收业务 chat 历史数组。
- 如果需要引用历史对话，业务端应把必要上下文总结进 `prompt`。
- 修改发生在同一个 workspace 文件状态上，因此 Claude 能看到已有 `input/`、`output/`、`work/` 文件。

## Business-context 模式

`business-context` 适合业务端已经维护对话历史、表单答案、artifact 路径或阶段状态，但不希望自己拼最终 prompt 的场景。

业务端传：

- `promptMode: "business-context"`
- `currentPrompt`: 本轮用户可见输入或表单答案摘要。
- `businessContext`: 结构化业务上下文包，daemon 不解释具体语义。
- `skillId`: MVP 中必填，`generate` 和 `revise` 都可携带。
- `conversationId`: 可选，用于复用 daemon conversation。

daemon 做：

- 把 `currentPrompt` 写入用户可见的 `run_messages`。
- 按 `collectionMode` 保存 business context hash/full snapshot。
- 在执行前注入 skill instructions、side files manifest 和 profile 约束，生成最终 prompt。
- 按 `collectionMode` 保存最终 prompt / skill snapshot。

示例：

```json
{
  "profileId": "report-docx",
  "workspaceId": "ws_xxx",
  "conversationId": "conv_xxx",
  "kind": "revise",
  "promptMode": "business-context",
  "collectionMode": "diagnostic",
  "skillId": "report-gen",
  "currentPrompt": "用户已确认参数，请继续更新产物。",
  "businessContext": {
    "previousRunId": "run_previous",
    "artifactPaths": ["output/report.docx"],
    "formAnswers": {
      "unit": "test-unit"
    },
    "stage": "question-form-answers"
  },
  "artifactRuleIds": ["report-docx"]
}
```

`collectionMode` 默认 `lite`。请求 `diagnostic` 或 `review` 时，必须同时满足 profile `maxCollectionMode` 和 client 权限，否则 daemon 在入队前返回 `403 COLLECTION_MODE_NOT_ALLOWED`。

### 报告业务 business-context 示例

如果报告业务后端只需要“上传模板/数据 -> 生成报告 -> 下载报告”，legacy generate 已经足够。
当业务端已经维护报告参数、表单答案、上一轮 artifact 路径或阶段状态时，使用
`business-context` 会更稳：业务端传结构化上下文，daemon 负责注入 `report-gen` skill 并组装最终 prompt。

首次生成：

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

表单答案继续：

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

基于新数据修改：

```json
{
  "profileId": "report-docx",
  "workspaceId": "ws_xxx",
  "conversationId": "conv_xxx",
  "kind": "revise",
  "promptMode": "business-context",
  "collectionMode": "diagnostic",
  "skillId": "report-gen",
  "currentPrompt": "请基于新上传的数据文件更新现有报告。",
  "businessContext": {
    "stage": "revise-with-new-data",
    "previousRunId": "run_previous",
    "artifactPaths": ["output/report.docx"],
    "newInputFiles": ["input/new-data.xlsx"],
    "reportScope": "2025年8月 临高县公安局"
  },
  "artifactRuleIds": ["report-docx"]
}
```

这些报告业务字段对 daemon 是 opaque business context。业务后端负责解释阶段、表单答案和 artifact
语义；daemon 只负责通用运行、skill 注入和 artifact 扫描。

### Chat UI 状态建议

业务端可以把一次 revise 当成一条 assistant 回复：

```text
用户消息 created
  -> POST /api/runs 得到 runId
  -> assistant 消息状态 queued
  -> SSE running/text_delta 更新 assistant 草稿
  -> SSE end 后 GET /api/runs/:runId 对账
  -> GET /api/runs/:runId/artifacts 更新产物
  -> assistant 消息状态 succeeded/failed/canceled
```

如果 SSE 断开：

1. 先用 `Last-Event-ID` 或 `?after=<lastEventId>` 重连。
2. 如果返回 `404 Run event stream not found`，说明内存事件已过期或进程重启，改用 `GET /api/runs/:runId` 做事后恢复。

## 取消流程

业务端在用户点击停止时调用：

```text
POST /api/runs/:runId/cancel
```

响应：

```json
{
  "ok": true
}
```

取消 queued run：不会再启动 Claude。  
取消 running run：daemon 会请求子进程退出，并在必要时走 SIGKILL fallback。

如果 run 已经 terminal，返回 `409 RUN_NOT_CANCELABLE`。

## 状态机

daemon run 状态：

```text
queued -> running -> succeeded
queued -> running -> failed
queued -> canceled
running -> canceled
queued/running -> interrupted
```

业务端建议状态映射：

```text
queued       排队中
running      生成/修改中
succeeded    成功，可读取 artifacts
failed       失败，展示 errorCode/errorMessage，可读取 run detail/logs
canceled     用户取消
interrupted  daemon 重启或关闭中断，建议允许用户重新发起 run
```

`warning` RunEvent 不属于状态机，不会把 run status 改为 `failed`。例如 `RUN_LOG_WRITE_FAILED` / `RUN_LOG_WRITE_TIMEOUT` 只表示日志诊断材料写入或 close 降级。失败判断以 `run.status`、`run.errorCode` 和 `run.errorMessage` 为准。

## Queue 与并发

daemon 会按配置控制：

- 全局并发：`server.globalConcurrency`
- profile 并发：`profile.profileConcurrency`
- 同 workspace 串行：同一个 workspace 同一时间只允许一个 run 写文件
- 队列上限：`server.maxQueueSize`

业务端收到 `202 { runId, status: "queued" }` 后，不应该假设马上运行。以 SSE 的 `status/running` 或 run detail 的 `startedAt` 为准。

如果队列满，`POST /api/runs` 返回：

```json
{
  "error": {
    "code": "RUN_QUEUE_FULL",
    "message": "Run queue is full"
  }
}
```

## Error Handling 建议

所有错误统一为：

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Invalid request",
    "details": {}
  }
}
```

业务端至少应处理：

- `UNAUTHORIZED`：API key 缺失或错误。
- `PROFILE_NOT_ALLOWED`：业务 client 没有 profile 权限。
- `NOT_FOUND`：workspace/run/artifact 不存在，或不属于该 client。
- `MODEL_NOT_ALLOWED`：请求模型不在 profile 允许列表。
- `SKILL_NOT_ALLOWED`：请求 skill 不在 profile 允许列表。
- `SKILL_UNAVAILABLE`：skill 配置允许，但文件不可用。
- `SKILL_STAGING_FAILED`：skill side files staging 失败。
- `RUN_QUEUE_FULL`：队列满，业务端可稍后重试。
- `RUN_NOT_CANCELABLE`：run 已不可取消。
- `RUN_TIMEOUT`：总运行时间超时。
- `RUN_INACTIVITY_TIMEOUT`：Claude 长时间无输出。
- `ARTIFACT_REQUIRED_MISSING`：必需产物未生成。
- `ARTIFACT_SCAN_FAILED`：artifact scan 失败。
- `RUN_INTERRUPTED_BY_DAEMON_RESTART`：daemon 重启或关闭导致中断。
- `CLAUDE_AUTH_FAILED`：Claude Code 鉴权失败。
- `CLAUDE_CLI_FAILED`：Claude CLI 启动或执行失败。
- `PATH_NOT_ALLOWED`：路径非法或越界。
- `INVALID_PATH_SEGMENT`：workspace identity 片段非法。

## 推荐适配顺序

业务方 agent 可以按这个顺序实现：

1. API client：封装 baseUrl、auth header、JSON error 解析。
2. Profile sync：调用 `GET /api/profiles`，选择业务 profile/skill/artifact rule。
3. Workspace mapping：创建或复用 workspace，并把 `workspaceId` 保存到业务项目。
4. File ingestion：先支持 upload，若部署有共享挂载再支持 prepare。
5. Generate run：根据业务选择 legacy 或 `business-context`，创建 `kind=generate`，订阅 SSE，落库 run 状态。
6. Artifact sync：run terminal 后 list/download artifacts。
7. Revise run：同 workspace 创建 `kind=revise`。legacy revise 不传 `skillId`；`business-context`
   revise 必须显式传 `skillId`。
8. Cancel：支持用户停止 queued/running run。
9. Recovery：SSE 断线后重连；重连失败则用 run detail 恢复。
10. Diagnostics：授权 client 接入 logs，用于后台排查，不直接暴露给普通用户。

## 业务端不要做的事

- 不要让前端或用户直接传 sandbox 绝对路径。
- 不要在 `POST /api/runs` 中传 `originId/userId/projectId`。
- 不要试图覆盖 `claudeConfigDir`、`claudeBin`、`skillRoots`、`allowedInputRoots`、`permissionMode`。
- 不要把 daemon 的目录隔离当作强 sandbox。
- 不要把 upload temp path、sandboxRoot、allowedInputRoots 暴露给用户。
- 不要依赖 SSE 作为长期历史存储。
- 不要在 legacy revise 请求里传 `skillId`。
- 不要在 `business-context` 请求里省略 `skillId`。
