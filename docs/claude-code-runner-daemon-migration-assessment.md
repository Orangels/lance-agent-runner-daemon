# Claude Code Runner Daemon Migration Assessment

本文评估是否可以从 lanceDesign 当前 daemon 的 Claude Code CLI pipeline 中抽取一套通用 CLI agent 后端。

配套设计文档：

- `docs/claude-code-runner-daemon-design.md`

结论先行：

可以迁移，而且 lanceDesign 已经验证了最关键的执行链路：

```text
POST /api/runs
  -> 创建 run
  -> 后台 spawn Claude Code CLI
  -> 解析 stream-json
  -> 通过 /api/runs/:runId/events 推 SSE
  -> 支持 cancel / finish / Last-Event-ID replay
```

但不能把 lanceDesign 的 daemon 代码整体复制成通用服务。当前实现里混有大量 lanceDesign 产品语义，例如 design system、craft、critique、analytics、preview comments、live artifact MCP、project tabs、memory 等。迁移方式应该是“抽取重建”：复用成熟模块和行为语义，重写通用 daemon 的边界、持久化和配置。

第一版安全边界已经明确：只做 daemon 控制的目录隔离，不做 OS 级隔离、独立 uid、容器、seccomp/firejail 或 Claude Code permission hooks。因此第一版默认面向可信业务调用方、可信 profile 和受控部署环境，不把目录隔离描述成强安全 sandbox。

## 当前 lanceDesign 已验证的能力

### 1. run 创建与 SSE 订阅模式

相关文件：

- `apps/daemon/src/chat-routes.ts`
- `apps/daemon/src/runs.ts`
- `apps/web/src/providers/daemon.ts`

lanceDesign 当前主流程不是 `POST /api/chat` 直接返回 SSE，而是：

```text
web
  -> POST /api/runs
  <- 202 { runId }
  -> GET /api/runs/:runId/events
  <- SSE stream
```

`POST /api/chat` 仍存在，但更像兼容路径。新 daemon 应优先复用 `/api/runs` + `/events` 这条模式。

可迁移程度：高。

需要改造：

- route 请求体要从 lanceDesign 的 chat/design 字段改成通用字段。
- list/filter 要从 `projectId/conversationId` 改成 `workspaceId/originId/userId/projectId/status`。
- run 创建后需要写 SQLite `runs`，而不是只放内存 Map。

### 2. run service

相关文件：

- `apps/daemon/src/runs.ts`

当前 `createChatRunService` 提供：

- `create`
- `start`
- `get`
- `list`
- `stream`
- `cancel`
- `wait`
- `emit`
- `finish`
- `fail`
- `shutdownActive`

它还支持：

- 内存 `events[]` buffer。
- `Last-Event-ID` / `after` replay。
- terminal run TTL cleanup。
- child process cancel。
- graceful shutdown。

可迁移程度：高。

需要改造：

- `run` metadata 从 `projectId/conversationId/assistantMessageId` 改成 `workspaceId/profileId/clientId/kind/skillId`。
- 增加 SQLite run repository。
- 增加 queue/concurrency。
- 增加 daemon-side message accumulator hook。
- 增加 artifact scan hook。
- terminal run 仍可内存 TTL cleanup，但 SQLite 索引按保留策略清理。

### 3. Claude Code CLI adapter

相关文件：

- `apps/daemon/src/runtimes/defs/claude.ts`

当前 lanceDesign 使用：

```text
claude -p --output-format stream-json --verbose
```

并根据能力探测增加：

```text
--include-partial-messages
--add-dir
--model <model>
--permission-mode bypassPermissions
```

prompt 通过 stdin 传入，避免 Linux `spawn E2BIG` 和 Windows `ENAMETOOLONG`。

可迁移程度：很高。

新 daemon 应严格复用这些关键策略：

- prompt via stdin。
- `stream-json` 输出。
- `--verbose`。
- `--include-partial-messages` 能力探测。
- `--add-dir` 能力探测。
- profile `defaultModel` / `allowedModels`，run 请求传 `model` 时必须命中白名单。
- permission mode 由 profile 控制，第一版可以沿用 `bypassPermissions`，但要写入 profile schema。

### 4. Claude stream parser

相关文件：

- `apps/daemon/src/claude-stream.ts`

当前 parser 将 Claude Code `stream-json` JSONL 转成 UI-friendly events：

```text
status
text_delta
thinking_delta
thinking_start
tool_use
tool_result
usage
raw
```

并兼容：

- 新版本 `stream_event` partial messages。
- 旧版本只在最终 `assistant` wrapper 里给文本。
- partial tool_use input JSON 合并。
- tool_use 重复抑制。
- tool_result 提取。
- result usage / cost / duration 提取。

可迁移程度：很高。

新 daemon 可以直接复用该 parser，后续只需要在 event visibility policy 层决定哪些事件对外可见。

### 5. skill registry 与 active skill staging

相关文件：

- `apps/daemon/src/skills.ts`
- `apps/daemon/src/cwd-aliases.ts`

lanceDesign 当前不是完全依赖用户级 Claude Code skill。它会：

- 扫描 daemon 配置的 skill roots。
- 读取 `SKILL.md`。
- 解析 frontmatter。
- 把 active skill body 编入 prompt。
- 将 active skill 复制到项目 cwd 下 `.lancedesign-skills/<skill>/`。
- 使用 copy 而不是 symlink，避免 agent 写回原始 skill 资源。
- prompt preamble 中同时提供 cwd-relative path 和 absolute fallback path。
- 通过 `--add-dir` 补充绝对路径访问能力。

可迁移程度：中高。

需要改造：

- `.lancedesign-skills` 改成通用目录名，例如 `.claude-runner-skills`。
- `skills.ts` 中大量 `lancedesign.*` frontmatter、mode、surface、preview、design-system 字段不适合直接保留。
- 新 daemon 只需要通用 skill 字段：

```text
id
name
description
body
dir
source
metadata_json
```

- profile 控制 `skillRoots` 和 `allowedSkillIds`。
- `kind=generate` 才处理 `skillId`。
- `kind=revise` 禁止传 `skillId`，不 stage skill，不注入 skill body。

### 6. spawn / stdout parser / close handler 主链

相关文件：

- `apps/daemon/src/server.ts`

当前 `startChatRun` 已经验证：

- resolve agent binary。
- build args。
- spawn child process。
- stdin 写 prompt。
- stdout parser。
- stderr tail。
- inactivity watchdog。
- auth failure diagnosis。
- child close 后基于 `exitCode`、`signal`、`stderrTail`、`stdoutTail` 做失败诊断。
- process close -> status mapping。
- cancel / SIGTERM / SIGKILL fallback。

可迁移程度：中。

不能整体搬 `startChatRun`，因为它混入了大量 lanceDesign 产品逻辑。

应该抽取其中的通用主链：

```text
resolveClaudeBinary
buildClaudeArgs
composePrompt
spawnProcess
writePromptToStdin
attachClaudeStreamParser
attachStderrTail
attachInactivityWatchdog
mapExitToRunStatus
diagnoseCliFailure
finishRun
```

注意：lanceDesign 的 empty-output guard 对 Claude Code 路径实际不是完整保护，不能当作可直接迁移的 Claude 能力。新 daemon 生成类任务的空结果兜底优先由 required artifact 缺失策略承担，错误码建议 `ARTIFACT_REQUIRED_MISSING`。`diagnoseClaudeCliFailure` 只能复用判别思路，文案和 `LANCE_DESIGN_*` / Settings / LanceRouter 相关内容必须重写成通用 error code 和 machine-readable details。

需要剥离的 lanceDesign 专有能力：

- design system。
- craft。
- memory。
- critique theater。
- analytics。
- live artifact MCP。
- external MCP settings。
- preview comment attachment。
- project tabs / linked dirs。
- local-client bundled runtime。
- lancedesign tool token。
- orbit/routine。

## 文档设计中新增但 lanceDesign 没有完整提供的能力

### 1. Profile config

lanceDesign 当前是 app config + env 模式，不是多业务 profile daemon。

新 daemon 需要自己实现：

```text
server config
client/API key config
profile config
profile-level sandboxRoot
profile-level claudeConfigDir
profile-level skillRoots
profile-level allowedInputRoots
profile-level artifactRules
profile-level concurrency
profile-level eventVisibility
```

这是通用服务边界，不能从 lanceDesign 直接复制。

### 2. Workspace service

lanceDesign 当前 project cwd 来自：

```text
.lancedesign/projects/<projectId>
```

或导入项目的 `metadata.baseDir`。

新 daemon 需要：

```text
sandboxRoot/originId/userId/projectId
```

并提供：

```text
POST /api/workspaces
POST /api/workspaces/:workspaceId/prepare
```

业务端不直接拿 sandbox 绝对路径。业务端传 daemon 可访问的 `sourcePath`，daemon 校验 `allowedInputRoots` 后 copy 到 workspace。

### 3. SQLite persistence

lanceDesign 当前：

- `/api/runs` 事件主要在内存 Map。
- SQLite 没有独立 `run_events`。
- `messages.events_json` 主要由 web 前端消费 SSE 后保存。
- daemon 只做 terminal status reconciliation。

新 daemon 需要后端自己保存：

```text
workspaces
conversations
runs
run_messages
artifacts
run_logs
profile_snapshots
```

其中最重要的是：

- 复用 lanceDesign `messages` 语义。
- 不保存原始每个 SSE chunk。
- 保存翻译/合并后的 `run_messages.content + events_json`。
- 保存动作由 daemon-side accumulator 触发，而不是前端。

第一版不新增独立 `run_events` 表。

第一版中 `workspaces`、`runs`、`run_messages` 是地基，不能放到后续阶段。run create 时必须 INSERT `runs` queued 行，否则批任务事后查看、任务列表和 daemon 重启后标记 `interrupted` 都无法成立。

`GET /api/runs/:runId/events` 只承诺在线运行和短期断线重连 replay，数据源是内存 run event buffer。terminal run 内存 TTL 过期后，不保证继续按 `Last-Event-ID` 精确 replay；长期事后查看以 `GET /api/runs/:runId` / run detail 的 `run_messages.events_json` 为准。

### 4. Artifact rules and downloads

lanceDesign 有设计产物和文件系统 watcher，但没有通用 artifact rules。当前 lanceDesign 的 produced files 更接近前端 run 前后刷新文件列表后做 diff；新 daemon 第一版不依赖 watcher。

新 daemon 需要：

- profile 固定 `artifactRules`。
- request 只传 `artifactRuleIds`。
- run 结束后按 artifactRules glob scan 扫描 artifact。
- 记录到 `artifacts` 表。
- 提供 artifact list/download API。
- 下载不暴露 sandbox 绝对路径。

### 5. Queue and concurrency

lanceDesign 当前 run service 可以同时启动多个 run，但没有通用队列和 profile concurrency。

新 daemon 第一版需要：

```text
globalConcurrency
profileConcurrency
per-workspace serial lock
maxQueueSize
queued/running/succeeded/failed/canceled/interrupted
```

这是新实现。

### 6. Auth and client isolation

lanceDesign 当前不是多业务共享 daemon。

新 daemon 需要 API key 鉴权：

- 每个 API key 绑定 client。
- client 允许访问哪些 profile。
- run/workspace 查询按 client 过滤。
- 管理员 key 才能跨 client 查询。

## 可迁移模块清单

### 建议直接迁移或轻改

```text
apps/daemon/src/runs.ts
apps/daemon/src/claude-stream.ts
apps/daemon/src/runtimes/defs/claude.ts
apps/daemon/src/cwd-aliases.ts
```

轻改方向：

- 去掉 `projectId/conversationId/assistantMessageId` 等产品字段。
- `.lancedesign-skills` 改成 `.claude-runner-skills`。
- `claudeAgentDef` 保留 Claude Code 核心参数，去掉和多 agent registry 强绑定的部分。

### 建议抽取通用子集

```text
apps/daemon/src/skills.ts
apps/daemon/src/server.ts:createSseResponse
apps/daemon/src/server.ts:createSseErrorPayload
apps/daemon/src/server.ts:startChatRun
apps/daemon/src/claude-diagnostics.ts
```

其中 `startChatRun` 只能抽通用 spawn 主链，不能整段复制。

`claude-diagnostics.ts` 只能抽取认证失败、模型不可用、stderr/stdout tail 分类等判别思路；所有 lanceDesign 品牌文案、Settings 指引和 `LANCE_DESIGN_*` 字段必须重写。

### 不建议迁移

```text
design system / craft prompt 组合
critique theater
analytics
preview comments
deployments
tabs
routines / orbit
media tasks
live artifact MCP
local-client bundled runtime
```

这些能力属于 lanceDesign 产品，不属于第一版通用 CLI daemon。

## 建议的新代码边界

第一版新 daemon 建议拆成：

```text
src/http/runs-routes.ts
src/http/workspaces-routes.ts
src/http/artifacts-routes.ts
src/http/profiles-routes.ts

src/core/run-service.ts
src/core/cli-runner.ts
src/core/claude-adapter.ts
src/core/claude-stream.ts
src/core/skill-registry.ts
src/core/skill-staging.ts
src/core/message-accumulator.ts
src/core/artifact-scanner.ts
src/core/workspace-service.ts

src/db/schema.ts
src/db/repositories.ts

src/config/profiles.ts
src/config/auth.ts
```

核心依赖方向：

```text
routes
  -> services
  -> db repositories
  -> core runner modules
```

`core` 不应该依赖 Express。`db` 不应该依赖 HTTP。`claude-adapter` 不应该知道业务字段。

## 推荐迁移顺序

### Phase 0a: API contract 定稿

在写实现前先把跨服务契约固定：

- 采用两接口 workspace 模型：`POST /api/workspaces` 创建或获取 workspace，返回 `workspaceId`；`POST /api/workspaces/:workspaceId/prepare` copy 输入文件。
- `POST /api/runs` 只引用 `workspaceId`，不再内联 `originId/userId/projectId`。
- `POST /api/workspaces` 接收 `profileId` 和 `originId/userId/projectId`。
- 补齐结构化错误码：`MODEL_NOT_ALLOWED`、`RUN_QUEUE_FULL`、`ARTIFACT_REQUIRED_MISSING`、`RUN_INTERRUPTED_BY_DAEMON_RESTART`。
- 固定 workspace 目录骨架：`input/`、`output/`、`work/`、`.claude-runner-skills/`。
- 固定 run_messages flush 策略：约 500ms 节流 UPDATE，terminal 前强制 flush，daemon 崩溃后保留最后一次成功写入的半成品消息。

### Phase 0: profile / auth / workspace / SQLite 地基

目标：

```text
可信部署环境内的目录隔离
API key 鉴权
profile 读取
workspace 创建和 prepare
SQLite 基础表
```

实现：

- config/profiles：读取 `server`、`clients`、`profiles`，包含 `defaultModel`、`allowedModels`、`permissionMode`。
- config/auth：API key -> client -> allowed profiles。
- workspace-service：`sandboxRoot + originId/userId/projectId` 安全解析，不暴露绝对 cwd。
- workspace-service：创建 workspace 目录骨架，prepare 时校验 `allowedInputRoots` 和安全相对 `targetPath`。
- db/schema + repositories：`workspaces`、`conversations`、`runs`、`run_messages` 先落地。
- run create 时立即 INSERT `runs` queued 行。
- daemon 启动时扫描旧 `queued/running` run 并标记为 `interrupted`，释放 per-workspace 串行资格。

这一阶段不做 OS 级隔离、独立 uid、容器或 permission hooks，只把目录隔离边界写清楚。

### Phase 1: 最小 Claude Code run + daemon-side message persistence

目标：

```text
POST /api/runs
GET /api/runs/:id/events
POST /api/runs/:id/cancel
```

实现：

- profile 读取。
- workspace cwd 解析。
- Claude args。
- spawn。
- stream-json parser。
- SSE。
- cancel。
- in-memory run event buffer。
- SQLite run 状态更新。
- per-run message accumulator。
- `GET /api/runs/:id` run detail。

这一阶段基本复用 lanceDesign 的成熟主链。

### Phase 2: skill and artifact

实现：

- profile `skillRoots`。
- `allowedSkillIds`。
- `kind=generate` skill staging。
- `kind=revise` prompt-only。
- artifact rules。
- artifact scan。
- artifact download。

### Phase 3: queue / timeout / hardening

实现：

- global/profile concurrency。
- per-workspace 串行。
- queue。
- timeout。
- structured error code。
- log retention。

## 当前是否可以开始实现

可以。

但实现前需要接受下面这个边界：

```text
不是迁移 lanceDesign 整个 daemon。
而是迁移 lanceDesign 已验证的 Claude Code CLI pipeline，
并在新 daemon 中重建通用服务边界。
```

成熟度判断：

```text
Claude CLI spawn / stream / cancel / SSE: 80% 可复用
skill staging / skill scan: 70% 可复用
run API 形态: 60% 可复用
message persistence: 语义可复用，代码需要新写
SQLite schema: 需要新写，且第一版必须包含 workspaces/runs/run_messages 地基
profile / auth / workspace prepare / artifacts: 需要新写
```

最大风险不是 Claude Code CLI，而是产品逻辑剥离：

- 不要把 `startChatRun` 整段搬过去。
- 不要把 lanceDesign 的 design/craft/critique/analytics 语义带进通用 daemon。
- 不要让业务端直接拿 sandbox 绝对路径。
- 不要依赖前端消费 SSE 后再保存 message。

## 给 Claude Code review 的建议问题

让 Claude Code review `docs/claude-code-runner-daemon-design.md` 和本文时，建议重点检查：

1. 设计文档和迁移评估是否一致。
2. workspace 契约是否已经统一为 `POST /api/workspaces` 创建/获取 workspace、`POST /api/workspaces/:workspaceId/prepare` 准备文件、`POST /api/runs` 只引用 `workspaceId`。
3. SQLite 表设计是否足够支持实时 chat、批任务 run、事后 run detail、artifact 下载。
4. 第一版不做独立 `run_events` 表是否合理。
5. `kind=generate` / `kind=revise` 的 skill 处理规则是否清晰。
6. 第一版只做目录隔离、不做 OS 级隔离的边界是否已经写清楚，是否避免误称为强 sandbox。
7. 哪些 lanceDesign 代码可以直接迁移，哪些必须重写。
8. 是否遗漏了 lanceDesign Claude Code CLI pipeline 中必须保留的异常处理，例如 stdin EPIPE、stderr tail、inactivity timeout、auth failure diagnosis、cancel SIGTERM/SIGKILL。
9. required artifact 缺失作为 Claude 生成类任务空结果兜底是否足够，错误码和 run 状态是否清晰。
10. 是否存在过度设计，第一版可以删除或延后。
11. 是否可以基于这两份文档直接生成 implementation plan。
