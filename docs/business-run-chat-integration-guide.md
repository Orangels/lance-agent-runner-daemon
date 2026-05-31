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
- 组合面向 Claude 的业务 prompt。

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

请求：

```json
{
  "profileId": "report-docx",
  "workspaceId": "ws_xxx",
  "kind": "generate",
  "skillId": "report-writer",
  "prompt": "请基于 input/source.docx 生成一份正式报告，输出到 output/report.docx。",
  "model": "sonnet",
  "artifactRuleIds": ["report-docx"],
  "eventVisibility": "normal",
  "metadata": {
    "businessMessageId": "msg_001"
  }
}
```

响应：

```json
{
  "runId": "run_xxx",
  "status": "queued"
}
```

注意：

- `generate` 必须传 `skillId`。
- `POST /api/runs` 只接受 `workspaceId`，不要内联 `originId/userId/projectId`。
- `model` 必须属于 profile 的 `allowedModels`。
- 不传 `artifactRuleIds` 时使用 profile 的 `defaultArtifactRuleIds`。
- run 创建后可能先排队，业务端要展示 `queued` 状态。

### 5. 订阅 SSE

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
data: {"type":"end","status":"succeeded"}
```

业务端处理建议：

- `status/queued`：展示排队中。
- `status/running`：展示运行中。
- `assistant_message_start`：开始一段新的 assistant 消息；业务端如果要还原 daemon 的分段展示，应从此事件开始创建/切换当前 assistant 消息。
- `text_delta`：追加到当前 assistant 消息。
- `artifact_finalized`：记录 artifact id 和相对路径。
- `error`：记录错误码和消息。
- `end`：停止 SSE，随后调用 run detail 和 artifacts API 做最终对账。

SSE 只保证在线和短期断线 replay。长期事后查看必须使用 `GET /api/runs/:runId`。

### 6. 获取最终详情

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

`messages` 按 `position ASC` 返回。一个 run 通常有一条 user message，并可能有多条 assistant messages：

- 聊天 UI：按顺序渲染所有 assistant messages，不要假设只有一条 assistant。
- 需要完整 assistant 文本：按 `position ASC` 拼接所有 assistant `content`。
- 只需要最后一次 assistant 回复：取最后一条非空 assistant `content`。
- 报告生成结果：以 artifacts/download 为准，assistant `content` 只作为执行说明和过程摘要。

### 7. 获取 artifact 并下载

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

- `revise` 禁止传 `skillId`。
- daemon 不接收 `conversationId`。
- daemon 不接收业务 chat 历史数组。
- 如果需要引用历史对话，业务端应把必要上下文总结进 `prompt`。
- 修改发生在同一个 workspace 文件状态上，因此 Claude 能看到已有 `input/`、`output/`、`work/` 文件。

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
5. Generate run：创建 `kind=generate`，订阅 SSE，落库 run 状态。
6. Artifact sync：run terminal 后 list/download artifacts。
7. Revise run：同 workspace 创建 `kind=revise`，把业务 chat 修改映射为新 run。
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
- 不要在 revise 请求里传 `skillId`。
- 不要在 generate 请求里省略 `skillId`。
