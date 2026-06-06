# Business Agent Adapter Handoff

本文面向业务方 Codex / agent / 后端适配者，说明如何把业务系统接入 Claude Code Runner Daemon。

这是一份执行说明，不替代完整 API 文档。字段细节以 `docs/api-reference.md` 为准，业务流程背景见 `docs/business-run-chat-integration-guide.md`，本地演示台使用见 `docs/web-test-console-usage.md`。

## 目标

业务方需要实现三条路径：

1. 报告生成，不订阅 SSE：创建 run，轮询状态，下载最终报告。
2. 报告生成，订阅 SSE：实时展示 agent 过程，terminal 后对账并下载报告。
3. Chat 修改：在同一 workspace 上创建 revise run，修改已有报告并同步新产物。

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

`allowedSkillIds` 决定 `kind=generate` 可传哪些 `skillId`。`revise` 禁止传 `skillId`。

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

## 推荐流程 A：Generate + Poll

这是报告生成的默认推荐流程。适合业务端只关心“任务是否结束、报告是否生成”，不展示实时 agent 输出。

流程：

```text
POST /api/runs
  -> 得到 runId

循环 GET /api/runs/:runId/status
  -> terminal = false 继续等
  -> terminal = true 停止轮询

GET /api/runs/:runId/artifacts
  -> 找 role=primary 的报告

GET /api/runs/:runId/artifacts/:artifactId/download
  -> 下载报告
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

轮询状态：

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

建议轮询间隔：

- 常规：2-5 秒。
- `queued` 可适当拉长。
- `terminal=true` 后停止轮询。

成功后获取 artifacts：

```text
GET /api/runs/run_xxx/artifacts
```

选择规则：

1. 优先取 `role = "primary"` 的 artifact。
2. 没有 primary 时，再考虑 `role = "supporting"`。
3. `role = "debug"` 只用于排查，不建议展示给普通用户。

下载：

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

创建 run 与 Poll 流程相同。拿到 `runId` 后订阅：

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
end                     run 终态
```

处理建议：

- 收到 `assistant_message_start`：开始一条新的 assistant 气泡。
- 收到 `text_delta`：追加到当前 assistant 气泡。
- 收到 `thinking_delta`：追加到当前 assistant thinking 区。
- 收到 `artifact_finalized`：记录 artifact id，但仍建议 terminal 后再 list artifacts 对账。
- 收到 `end`：关闭 SSE，然后调用：

```text
GET /api/runs/:runId
GET /api/runs/:runId/artifacts
```

`GET /api/runs/:runId` 是 durable detail，用于 terminal 对账、SSE 断线恢复、历史查看。不要把 SSE 当长期历史存储。

断线恢复：

```text
GET /api/runs/:runId/events?after=<lastEventId>
```

或请求头：

```text
Last-Event-ID: <lastEventId>
```

如果返回 `404`，说明内存事件流已过期或 daemon 重启，改用 `GET /api/runs/:runId` 恢复。

## 流程 C：Chat 修改 / Revise

Revise 用于同一个业务项目、同一个 workspace 上的后续修改。

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

- 禁止传 `skillId`。
- daemon 不接收业务 chat history 数组。
- 如果需要历史上下文，业务端把必要上下文总结进 `prompt`。
- 修改发生在同一个 workspace 文件状态上，Claude 可以看到已有 `input/`、`work/`、`output/` 文件。

Revise 后续可以走 SSE，也可以走 Poll。实时 chat UI 推荐 SSE；后台静默修改推荐 Poll。

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

## Web Test Console 对照

`apps/web` 是给业务方 Codex 看的参考实现：

| Web 操作 | 对应业务流程 |
| --- | --- |
| `Generate + SSE` | 创建 generate run，订阅 `/events`，实时渲染 agent 输出，terminal 后对账。 |
| `Generate + Poll` | 创建 generate run，只轮询 `/status`，terminal 后读取 artifacts。 |
| `Revise` | 同 workspace 创建 revise run，不传 `skillId`，修改已有报告。 |
| 文件选择 | 循环调用 `POST /api/workspaces/:workspaceId/files`。 |
| 下载按钮 | 调用 artifact download API。 |

Web demo 不做生产鉴权、不保存业务数据库、不代表最终业务 UI。

## 业务方不要做的事

- 不要高频轮询 `GET /api/runs/:runId`；高频轮询使用 `/status`。
- 不要把 SSE 当作长期历史存储。
- 不要在 `revise` 请求里传 `skillId`。
- 不要在 `generate` 请求里省略 `skillId`。
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
4. 能创建 `kind=generate` run，并保存 `runId`。
5. Poll 模式下只调用 `/status`，terminal 后再 list artifacts。
6. 能选择 `role=primary` artifact 并下载，中文文件名可用。
7. SSE 模式下能用 `fetch + ReadableStream` 读取 `event: agent`。
8. 能在 SSE `end` 后调用 run detail 做 durable 对账。
9. 能创建 `kind=revise` run，且不传 `skillId`。
10. 能处理失败 run 的 `errorCode/errorMessage`。
11. 能取消 queued/running run。
12. 业务数据库能从 `business_project_id` 追溯到 `workspaceId/runId/artifactId`。
