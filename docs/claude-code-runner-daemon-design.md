# Claude Code Runner Daemon 设计草案

日期：2026-05-30

## 背景

我们希望从 lanceDesign 中抽取 Claude Code CLI 后台执行 pipeline 的经验，做成一个独立的通用服务。这个服务以后可以被 lqBot、lanceDesign 或其他 Python、Go、Rust、Node 项目调用。

这个 daemon 的核心不是纯批处理 runner，而是一个以 Claude Code CLI 为核心的 chat/run daemon。它既支持像 lanceDesign / Claude Code CLI 一样的实时 chat 体验，也支持只关心最终产物的批任务 run。

两种消费模式：

```text
实时 chat 模式
  业务端订阅 SSE
  前端展示完整 CLI 输出和对话过程
  体验接近 lanceDesign / Claude Code CLI

批任务 run 模式
  业务端不订阅 SSE
  只轮询或查询最终状态和产物
  但事后仍然可以打开 run 详情，查看这次 CLI 的完整执行过程
```

因此，SSE 只是实时消费通道，不是唯一持久化来源。新 daemon 后端需要自己保存 run 的执行记录，不能依赖前端消费 SSE 后再保存。

不同业务能力不写死在 daemon 里，而是通过指定 skill 或自然语言 prompt 实现。daemon 负责任务执行、事件解析、日志、产物识别、run 状态和执行记录。

## 已确认方向

### 1. 只做独立 daemon，不做 npm 核心库

复用边界是 HTTP/SSE 协议，而不是 Node package。

原因：

- 调用方语言不固定，可能是 Python、Go、Rust 或 Node。
- 跨语言项目直接依赖 npm 包意义不大。
- daemon 可以统一管理 Claude Code 登录态、配置目录、skill 权限和执行隔离。

目标形态：

```text
业务系统
  -> HTTP 创建 run
  -> SSE 订阅事件
  -> HTTP cancel/status/artifacts/logs
  -> Claude Code Runner Daemon
  -> spawn Claude Code CLI
  -> project workspace
```

### 2. 使用 TypeScript 实现 daemon

daemon 使用 TypeScript 实现，严格参考 lanceDesign 当前实现。

主要原因：

- lanceDesign 的 Claude Code CLI 调用、stream-json parser、run lifecycle、SSE 事件模型已经是 TypeScript。
- 可以最大程度抽取/改造现有实现，减少重写风险。
- Node 对 `spawn`、stdout/stderr stream、文件 watcher、HTTP/SSE 都比较合适。

### 3. 严格参考 lanceDesign，抽取优先，重写最少

实现原则：

```text
lanceDesign 当前行为是基准实现
新 daemon 先保持行为等价
再把业务耦合点参数化
最后做通用化整理
```

必须严格参考的 lanceDesign 文件包括：

- `apps/daemon/src/runtimes/defs/claude.ts`
- `apps/daemon/src/runtimes/registry.ts`
- `apps/daemon/src/claude-stream.ts`
- `apps/daemon/src/runs.ts`
- `apps/daemon/src/chat-routes.ts`
- `apps/daemon/src/server.ts` 中 `startChatRun` 相关逻辑
- `apps/daemon/src/project-routes.ts`
- `apps/daemon/src/cwd-aliases.ts`
- `apps/daemon/src/skills.ts`
- `apps/daemon/src/app-config.ts`
- `apps/daemon/src/runtimes/env.ts`
- `packages/contracts/src/api/chat.ts`
- `packages/contracts/src/sse/chat.ts`

不迁移的部分：

- design template 业务 UI
- `index.html` preview
- design system / craft 的产品特定逻辑
- Electron / desktop / sidecar
- lanceDesign web UI 结构
- 当前 project 表里的设计业务字段

## Profile 驱动模型

daemon 不默认继承用户全局 `~/.claude/skills`。不同业务通过 profile 隔离 Claude 配置目录、skill roots 和权限。

profile 配置由 daemon 启动时读取的配置文件提供。业务请求只选择已授权的 `profileId`，不能在单次请求中随意传 `CLAUDE_CONFIG_DIR`、`skillRoots` 或任意环境变量。

daemon config 分三层：

- `server`: daemon 自身监听、数据目录、全局并发和队列设置。
- `clients`: 调用方鉴权和 profile 授权。
- `profiles`: Claude Code 执行环境、workspace、skill、artifact、可见性和超时设置。

完整示例：

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 17890,
    "dataDir": "/srv/claude-runner/data",
    "globalConcurrency": 4,
    "maxQueueSize": 100
  },
  "clients": [
    {
      "id": "lqbot",
      "apiKey": "env:CLAUDE_RUNNER_LQBOT_API_KEY",
      "allowedProfileIds": ["report-docx"],
      "canReadDebugEvents": false,
      "canReadLogs": true
    }
  ],
  "profiles": [
    {
      "id": "report-docx",
      "sandboxRoot": "/srv/claude-runner/sandboxes",
      "claudeConfigDir": "/srv/claude-runner/profiles/report-docx/claude",
      "claudeBin": "claude",
      "skillRoots": [
        "/srv/claude-runner/skills/common",
        "/srv/claude-runner/skills/report"
      ],
      "allowedInputRoots": [
        "/mnt/lqbot/uploads",
        "/srv/claude-runner/inbox"
      ],
      "allowedSkillIds": [
        "report-writer",
        "report-reviser"
      ],
      "artifactRules": [
        {
          "id": "report-docx",
          "pattern": "output/**/*.docx",
          "role": "primary",
          "required": true
        },
        {
          "id": "report-xlsx",
          "pattern": "output/**/*.xlsx",
          "role": "supporting",
          "required": false
        }
      ],
      "defaultArtifactRuleIds": ["report-docx"],
      "permissionMode": "bypassPermissions",
      "defaultModel": "sonnet",
      "allowedModels": ["sonnet", "opus", "claude-sonnet-4-5"],
      "eventVisibility": "quiet",
      "profileConcurrency": 2,
      "runTimeoutMs": 1800000,
      "inactivityTimeoutMs": 600000,
      "cancelGraceMs": 3000,
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.anthropic.com"
      }
    }
  ]
}
```

启动方式：

```bash
claude-runner-daemon --config /srv/claude-runner/config.json
```

配置约束：

- `server.dataDir` 是 daemon 自己的运行数据目录，用于 SQLite、日志、artifact 元数据等。
- `profile.sandboxRoot` 是该 profile 的 workspace 根目录，daemon 只在其下创建/解析 workspace cwd。
- `profile.claudeConfigDir` 是该 profile 的 Claude Code 配置目录，会注入为 `CLAUDE_CONFIG_DIR`。
- `profile.claudeBin` 默认是 `claude`，可用于指定兼容 Claude Code CLI 的二进制。
- `profile.skillRoots` 只由 daemon config 定义，请求不能覆盖。
- `profile.allowedSkillIds` 是该 profile 可运行 skill 的白名单。
- `profile.allowedInputRoots` 是 `POST /api/workspaces/:workspaceId/prepare` 可读取源文件的白名单。
- `profile.artifactRules` 是可用产物识别规则，请求只能传 `artifactRuleIds` 从中选择。
- `profile.defaultArtifactRuleIds` 是请求未指定 `artifactRuleIds` 时使用的默认规则。
- `profile.permissionMode` 第一版默认可使用 `bypassPermissions`，但只能由 profile 配置决定。
- `profile.defaultModel` 是请求未指定 `model` 时使用的 Claude Code 模型。
- `profile.allowedModels` 是该 profile 允许请求覆盖的模型白名单；请求传 `model` 时必须命中该列表。
- `profile.eventVisibility` 是该 profile 的最高可见性级别，请求只能降低，不能提高。
- `profile.profileConcurrency` 限制该 profile 同时运行的任务数。
- `profile.runTimeoutMs` 限制 run 总时长。
- `profile.inactivityTimeoutMs` 参考 lanceDesign inactivity watchdog，限制无输出卡住时间。
- `profile.cancelGraceMs` 控制 cancel 后 SIGTERM 到 SIGKILL 的等待时间。
- `profile.env` 只允许 allowlist 中的环境变量，不能任意注入。

第一版 env allowlist 建议：

```text
ANTHROPIC_BASE_URL
ANTHROPIC_API_KEY
DISABLE_TELEMETRY
DO_NOT_TRACK
DISABLE_AUTOUPDATER
DISABLE_ERROR_REPORTING
DISABLE_BUG_COMMAND
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
```

`CLAUDE_CONFIG_DIR` 和 `CLAUDE_BIN` 不放在 `env` 里，分别使用 `claudeConfigDir` 和 `claudeBin` 显式字段。

`profile_snapshots` 落库时必须脱敏，不能保存 `ANTHROPIC_API_KEY`、token、cookie、OAuth bearer、Claude 登录态文件内容，或任何从 `claudeConfigDir` 解析出的凭证。

## 第一版安全边界

第一版只做 daemon 控制的目录隔离，不做 OS 级隔离、独立 uid、容器、seccomp/firejail 或 Claude Code permission hooks。

目录隔离包括：

- daemon 只接受 `originId/userId/projectId` 这类安全路径片段，不接受外部绝对 `cwd`。
- daemon 自己把 workspace 解析到 profile `sandboxRoot` 下。
- daemon 校验 `sourcePath` 必须位于 profile `allowedInputRoots` 下，再 copy 到 sandbox workspace。
- daemon 不向业务端或前端暴露 sandbox 绝对路径。
- skill roots、Claude config、env、artifact rules 都只能由 profile config 控制，请求不能覆盖。

边界说明：

- 这种目录隔离不是强安全 sandbox。
- 当 `permissionMode` 使用 `bypassPermissions` 且 Claude Code 可调用 Bash/Write/Edit 时，子进程理论上具备 daemon 进程用户的文件和网络访问能力。
- 第一版默认面向可信业务调用方、可信 profile 和受控部署环境，不作为不可信多租户执行平台。
- 如果后续要服务不可信租户或开放公网多业务接入，需要再引入 OS 级隔离、独立运行用户、容器、权限 hooks 或更严格的 Claude Code permission 模式。

## Workspace / CWD 解析

API 不接受外部传入绝对 `cwd`。

调用方可能和 daemon 不在同一台服务器，因此业务方只传 workspace 的相对定位信息，daemon 根据 profile 的 `sandboxRoot` 拼接真实 cwd。daemon 不向业务端暴露 sandbox workspace 的真实路径。

第一版采用两步模型：

```text
POST /api/workspaces
  -> 创建或获取 workspace，返回 workspaceId

POST /api/workspaces/:workspaceId/prepare
  -> 把业务端提供的源文件 copy 到该 workspace

POST /api/runs
  -> 通过 workspaceId 引用已存在 workspace
```

创建 workspace 请求示例：

```json
{
  "profileId": "report-docx",
  "workspace": {
    "originId": "lqbot",
    "userId": "user_1",
    "projectId": "project_123"
  }
}
```

返回示例：

```json
{
  "workspaceId": "ws_123",
  "workspaceKey": "lqbot/user_1/project_123"
}
```

daemon 内部解析：

```text
profile.sandboxRoot / originId / userId / projectId
```

例如：

```text
/srv/claude-runner/sandboxes/lqbot/user_1/project_123
```

安全约束：

- `originId`、`userId`、`projectId` 都必须是单个安全路径片段。
- 禁止 `/`、`\`、空字符串、`.`、`..`、null byte。
- resolve 后的真实路径必须仍在 `sandboxRoot` 内。
- 不接受请求方传入的绝对路径。
- 不把解析后的 sandbox absolute path 返回给业务端或前端。

## 输入文件准备

第一版由 daemon 负责把业务端提供的源文件复制到 sandbox workspace。

业务端不需要知道 sandbox 真实路径，也不直接写入 sandbox。业务端只把源文件真实地址交给 daemon。源文件可以位于 daemon 本机可访问路径、共享挂载目录，或后续 upload API 暂存目录。daemon 校验源文件路径后，将文件复制到当前 workspace 的 `input/` 或请求指定的安全相对路径下。

建议提供独立准备接口：

```text
POST /api/workspaces/:workspaceId/prepare
```

请求示例：

```json
{
  "files": [
    {
      "sourcePath": "/mnt/lqbot/uploads/user_1/source.docx",
      "targetPath": "input/source.docx"
    },
    {
      "sourcePath": "/mnt/lqbot/uploads/user_1/data.xlsx",
      "targetPath": "input/data.xlsx"
    }
  ]
}
```

返回示例：

```json
{
  "workspaceId": "ws_123",
  "workspaceKey": "lqbot/user_1/project_123",
  "files": [
    {
      "targetPath": "input/source.docx",
      "size": 123456
    },
    {
      "targetPath": "input/data.xlsx",
      "size": 45678
    }
  ]
}
```

安全约束：

- `sourcePath` 必须是 daemon 所在机器可访问的真实路径。
- `sourcePath` 必须落在 profile 配置的 `allowedInputRoots` 内。
- `targetPath` 必须是 workspace 内的相对路径。
- `targetPath` 禁止绝对路径、`..`、null byte 和危险路径片段。
- daemon copy 时创建目标父目录，但不能覆盖受保护目录，例如 `.claude-runner-skills/`。
- 普通用户和浏览器前端不接触 `sourcePath` 或 sandbox absolute path；这些只在受信任业务后端和 daemon 间流转。

后续如果需要跨服务器且没有共享挂载，可以增加 upload API。upload API 的本质也是先把文件上传到 daemon 可访问的暂存区，再由 daemon 复制进 sandbox workspace。

## Skill 处理方式

新 daemon 按 run kind 决定是否处理 `skillId`。

### Generate run

`kind: "generate"` 是 skill-driven run，用于明确的结构化生成任务。

请求必须包含 `skillId`：

```json
{
  "profileId": "report-docx",
  "workspaceId": "ws_123",
  "kind": "generate",
  "skillId": "report-writer",
  "prompt": "根据 input/source.docx 和 input/data.xlsx 生成报告",
  "artifactRuleIds": ["report-docx"],
  "metadata": {
    "businessMessageId": "msg_001"
  }
}
```

generate run 沿用 lanceDesign 的三段式 skill 处理：

```text
1. daemon registry 从 profile.skillRoots 里解析指定 skill
2. daemon 把选中的 SKILL.md body 拼进 prompt
3. daemon 把 active skill side files 拷贝到 cwd，再 spawn Claude Code
```

重点行为：

- `skillId` 必须在 profile 的 `allowedSkillIds` 内。
- 只从 profile 的 `skillRoots` 查找 skill。
- 不默认暴露用户全局 skill。
- 如果 skill 有 `assets/`、`references/`、`scripts/` 等 side files，daemon 拷贝 active skill 到 workspace 内。
- 拷贝路径建议使用 `.claude-runner-skills/<skill-folder>/`。
- 不使用 symlink，避免 agent 写回原始 skill。
- skill prompt 中应包含 staged skill 相对路径和绝对 fallback 路径，参考 lanceDesign `withSkillRootPreamble()`。

### Revise run

`kind: "revise"` 是 prompt-driven run，用于同一个 workspace 中的自然语言继续修改。

请求禁止包含 `skillId`：

```json
{
  "profileId": "report-docx",
  "workspaceId": "ws_123",
  "kind": "revise",
  "prompt": "把第三章改得更像模板 A，并输出一个新版本",
  "artifactRuleIds": ["report-docx"],
  "metadata": {
    "businessMessageId": "msg_123",
    "parentRunId": "run_001"
  }
}
```

revise run 行为：

- 不要求 `skillId`。
- 不允许传 `skillId`；如果传入，返回 `400 BAD_REQUEST`。
- 不解析 active skill。
- 不 stage skill。
- 不把任何 `SKILL.md` body 拼入 prompt。
- 只基于同一个 workspace 的文件状态、artifact 摘要、历史 run 摘要、用户当前 prompt 和 Claude Code CLI 自身能力执行。

revise run 只拼接通用 runner 上下文，不拼接业务 instructions。通用上下文可以包含：

- workspace 文件列表
- 最近 artifact 列表
- 最近 run 状态摘要
- 当前用户 prompt

这样可以支持类似 lanceDesign 的“任务完成后继续在同一个 project 中自然语言修改”，但不依赖 Claude Code 原生 session resume/fork，也不把报告业务绑定进 daemon。

## Claude Code CLI 行为

第一版尽量保持与 lanceDesign Claude adapter 等价。

默认 CLI 行为：

```text
claude -p --output-format stream-json --verbose
```

保留行为：

- prompt 通过 stdin 写入，避免 argv 长度限制。
- 能力探测 `--include-partial-messages`。
- 能力探测 `--add-dir`。
- 支持 `--model`；未传时使用 profile `defaultModel`，传入时必须命中 profile `allowedModels`。
- profile 控制 `permissionMode`，默认可与 lanceDesign 一致使用 `bypassPermissions`。
- 使用 profile 的 `claudeConfigDir` 注入 `CLAUDE_CONFIG_DIR`。
- `spawn` cwd 使用 daemon 解析后的 workspace 目录。
- stdout 使用 Claude stream-json parser。
- stderr 进入 run 日志和失败诊断。
- Claude stream parser 不负责判断大多数 CLI 失败；失败诊断主要在 child close 后基于 `exitCode`、`signal`、`stderrTail`、`stdoutTail` 和受控 env 做映射。

## Run 生命周期

daemon 提供一等 run 模型。

状态：

```text
queued
running
succeeded
failed
canceled
interrupted
```

结束判断：

- 用户 cancel：`canceled`
- child close code 为 `0`：`succeeded`
- child close code 非 `0`：`failed`
- spawn 失败、认证失败、超时、required artifact 缺失等情况进入 `failed`
- daemon 重启时发现旧的 `queued` / `running` run，标记为 `interrupted`

cancel 行为：

- API 标记 run cancelRequested。
- 尝试终止 child process。
- 需要保留 SIGTERM/SIGKILL fallback。

## 事件模型

daemon 内部完整保留 Claude events。

内部事件包括：

- `start`
- `status`
- `text_delta`
- `thinking_delta`
- `tool_use`
- `tool_result`
- `usage`
- `file_changed`
- `artifact_finalized`
- `error`
- `end`
- `raw`

对外事件可根据 profile 的 `eventVisibility` 过滤。

建议 visibility：

```text
quiet  - 隐藏 thinking/tool_use/tool_result，只显示阶段、文本摘要、产物和错误
normal - 隐藏 tool_result，保留部分 tool_use/text
debug  - 输出完整事件
```

单次 run 可以请求更少的可见性，但不能越权请求比 profile 默认更高的 debug 能力。

第一版 artifact 事件以 run 结束后的 artifactRules glob scan 为准。运行中的 `artifact_candidate` watcher 不是第一版必需能力，后续如果需要实时产物预览再添加。

## Run Message Accumulator

新 daemon 复用 lanceDesign 的 message persistence 语义，但保存逻辑从前端移动到 daemon 后端。

lanceDesign 当前逻辑：

```text
daemon SSE
  -> web consumeDaemonRun()
  -> translateAgentEvent()
  -> ProjectView text buffer / events accumulator
  -> saveMessage()
  -> SQLite messages.content / events_json / run_id / run_status / last_run_event_id
```

新 daemon 逻辑：

```text
Claude parser event
  -> runs.emit()
  -> run message accumulator
  -> SQLite run_messages.content / events_json / run_id / run_status / last_run_event_id
  -> 同时推给在线 SSE subscribers
```

保存内容不是原始 SSE chunk，而是翻译、合并后的 message 数据：

- `text_delta` 合并到 assistant `content`，并按 buffer 策略合并为较少 text events。
- `tool_use`、`tool_result`、`usage`、`status` 等保存为结构化 events。
- 大型 `tool_result`、`raw`、完整 stdout/stderr 的持久化策略后续再定，可优先写 JSONL/debug log。
- run 详情页读取 `run_messages` 和 `events_json`，可以在没有实时 SSE 消费者的情况下回放这次 CLI 执行过程。
- `events_json` 建议保存 daemon 内部全量翻译事件；对外 SSE 和 run detail 返回时再按 client/profile 的 `eventVisibility` 过滤，避免 quiet client 事后看到 debug 事件。

### 触发时机

accumulator 不由 SSE 触发，而由 run 生命周期和 Claude parser event 触发：

```text
run created
  -> 初始化 user message 和 assistant message draft

run started
  -> 标记 assistant runStatus=running / startedAt

每个 Claude parser event
  -> consume(event)
  -> 更新 assistant content/events
  -> 按 500ms 左右节流保存

run ended / failed / canceled / interrupted
  -> flush text buffer
  -> 保存最终 content/events_json/runStatus/endedAt
  -> dispose accumulator
```

因此，即使业务端不订阅 SSE，daemon 也会保存 run 的完整执行记录。

第一版中 batch run 和 chat run 都采用 user message + assistant message draft 模型。业务端不传 `conversationId` 时，daemon 为每个 workspace 创建或复用一条默认 conversation，并把本次 run 的 user/assistant message 归入该默认线程。

### 并发隔离

accumulator 必须是每个 run 一个独立实例，挂在对应 run 上，不能做成全局单例。

```text
run_001.accumulator
run_002.accumulator
run_003.accumulator
```

每个 accumulator 只维护自己的状态：

```text
runId
workspaceId
userMessageId
assistantMessageId
assistantContent
events
textBuffer
lastEventId
saveTimer
```

实现约束：

- `startRun(run)` 时创建 accumulator。
- Claude parser callback 通过闭包绑定当前 run。
- `child stdout -> parser -> accumulator.consume()` 的链路必须只引用当前 run。
- 数据库写入必须带 `runId` / `messageId` 条件。
- 每个 accumulator 自己维护节流保存 timer。
- run 结束后必须 flush、清理 timer、dispose，并释放引用。
- 禁止全局 `currentRun`、共享 `events` 数组或共享 text buffer。

这样多个 run 并发时：

```text
child A stdout -> parser A -> accumulator A
child B stdout -> parser B -> accumulator B
child C stdout -> parser C -> accumulator C
```

不会造成数据污染。

## Artifact 识别

daemon 不懂报告、设计或其他业务概念，只按规则识别产物。

artifact rule 由 profile 管理。业务请求不能传任意 glob，只能选择 profile 已允许的规则。

profile 示例：

```json
{
  "artifactRules": [
    {
      "id": "report-docx",
      "pattern": "output/**/*.docx",
      "role": "primary"
    },
    {
      "id": "report-xlsx",
      "pattern": "output/**/*.xlsx",
      "role": "supporting"
    }
  ],
  "defaultArtifactRuleIds": ["report-docx"]
}
```

请求示例：

```json
{
  "artifactRuleIds": ["report-docx"]
}
```

- 请求不传 `artifactRuleIds` 时，使用 profile 的 `defaultArtifactRuleIds`。
- 请求传 `artifactRuleIds` 时，所有 id 都必须存在于 profile 的 `artifactRules`。
- daemon 不接受请求方传入任意 `pattern`，避免扫描 sandbox 外目录或扩大产物范围。
- run 结束时根据规则确定最终 artifact。
- 第一版不要求文件 watcher 产生运行中的 artifact candidate；run 结束后按 artifactRules glob scan 是权威 artifact 识别流程。

## 持久化

daemon 自己保存 run/event/artifact/log。

原因：

- 调用方语言和系统不同，不能要求每个业务方都实现同样的 run/event 存储。
- 业务系统可以只保存自己的业务 ID 和 daemon 返回的 `runId`。
- daemon 可以提供统一的短期断线恢复、诊断和统计接口。
- lanceDesign 当前 `/api/runs` 的 run service 和 SSE replay 主要是内存态：`runs.ts` 使用 `Map` 保存 run 和 `events[]`，支持 `Last-Event-ID`/`after` 从内存事件中重放，terminal 后按 TTL 清理。
- lanceDesign SQLite 里没有独立的 `run_events` 表。它在 `messages` 表中保存 `run_id`、`run_status`、`last_run_event_id`、`events_json` 等字段；这些是产品聊天消息持久化的一部分，主要由 web 端累积 assistant message events 后通过 message 保存接口写入。
- 新 daemon 应严格参考 lanceDesign 的 run service / SSE / `Last-Event-ID` 行为，但 `workspaces`、`runs`、`run_messages` 是第一版地基，必须在 create/run 生命周期中由 daemon 后端写入 SQLite。
- `GET /api/runs/:runId/events` 只承诺在线运行和短期断线重连 replay；terminal run 内存 buffer 过期后，不保证继续提供精确 `Last-Event-ID` replay。长期事后查看以 `GET /api/runs/:runId` / run detail 返回的 `run_messages.events_json` 为准。

建议 runtime 目录：

```text
.claude-runner/
  runner.sqlite
  logs/
  runs/
  artifacts/
```

### SQLite 表设计

第一版不完全复用 lanceDesign 的 SQLite 表结构，而是复用它的持久化语义：

- lanceDesign 的 `projects` 语义对应新 daemon 的 `workspaces`。
- lanceDesign 的 `messages.content + events_json + run_id + run_status + last_run_event_id` 语义对应新 daemon 的 `run_messages`。
- lanceDesign 的 `/api/runs` 内存 run service 对应新 daemon 的 `runs` 表和内存 run buffer。
- lanceDesign 的文件/产物追踪语义对应新 daemon 的 `artifacts`。
- lanceDesign 的 raw/debug 输出不进 `messages.events_json`，新 daemon 也优先放到受控 log 文件和 `run_logs` 索引。

不建议直接复用 lanceDesign 的产品业务表：

```text
tabs
deployments
preview_comments
templates
routines
routine_runs
```

这些表分别服务于设计项目 tab、预览部署、HTML 评论、模板资产和定时任务，不属于通用 Claude Code CLI daemon 的第一版核心。

#### workspaces

对应 lanceDesign 的 `projects`，但改成通用 sandbox workspace。

复用字段语义：

```text
id
metadata_json
created_at
updated_at
```

扩展字段：

```text
profile_id
client_id
origin_id
user_id
project_id
workspace_key
status
```

建议 schema：

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  origin_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_workspaces_identity
  ON workspaces(origin_id, user_id, project_id);

CREATE UNIQUE INDEX idx_workspaces_client_profile_key
  ON workspaces(client_id, profile_id, workspace_key);
```

#### conversations

如果新 daemon 保留 chat 体验，建议保留 `conversations` 概念。它可以直接参考 lanceDesign 的 `conversations` 表，但归属从 `project_id` 改为 `workspace_id`。

建议 schema：

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_conversations_workspace
  ON conversations(workspace_id, updated_at DESC);
```

第一版保留 `conversation_id`，但不要求业务端理解 conversation。业务端不传 `conversationId` 时，daemon 自动为 workspace 创建或复用默认 conversation；batch run 也会产生 user message 和 assistant message，便于后续 run detail 和 revise 对话复用同一套消息语义。

#### runs

lanceDesign 当前没有 SQLite `runs` 表，`/api/runs` 主要存在于内存 Map。新 daemon 为了支持批任务、任务列表、状态查询、重启后诊断，需要新增 `runs`。第一版必须在 run create 时立即 INSERT `queued` 行，不能等 terminal 时才落库。

建议 schema：

```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  skill_id TEXT,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  artifact_rule_ids_json TEXT,
  last_run_event_id TEXT,
  queued_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  exit_code INTEGER,
  signal TEXT,
  error_code TEXT,
  error_message TEXT,
  usage_json TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_runs_workspace_created
  ON runs(workspace_id, created_at DESC);

CREATE INDEX idx_runs_status_created
  ON runs(status, created_at DESC);
```

字段说明：

- `kind`: `generate` / `revise`。
- `skill_id`: 只允许 `kind=generate` 使用；`kind=revise` 不接受 `skillId`。
- `last_run_event_id`: 对齐 lanceDesign SSE `Last-Event-ID` 语义。
- `metadata_json`: 只存 daemon 需要透传和排查的信息，不绑定具体业务逻辑。
- `status`: 使用 `queued`、`running`、`succeeded`、`failed`、`canceled`、`interrupted`。其中 `interrupted` 用于 daemon 重启、进程丢失等非用户 cancel 的中断。

#### run_messages

这是最需要复用 lanceDesign 语义的表。lanceDesign 的 `messages` 保存的是前端翻译/合并后的聊天消息和 agent events，不是每个原始 SSE chunk。新 daemon 也保存翻译/合并后的 `content + events_json`，区别是保存动作由 daemon 后端 accumulator 触发，而不是依赖前端消费 SSE。

复用 lanceDesign `messages` 字段语义：

```text
id
role
content
events_json
attachments_json
produced_files_json
started_at
ended_at
created_at
run_id
run_status
last_run_event_id
```

扩展字段：

```text
workspace_id
conversation_id
position
updated_at
```

建议 schema：

```sql
CREATE TABLE run_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  conversation_id TEXT,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  events_json TEXT,
  attachments_json TEXT,
  produced_files_json TEXT,
  run_status TEXT,
  last_run_event_id TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE SET NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX idx_run_messages_run
  ON run_messages(run_id, position);

CREATE INDEX idx_run_messages_conversation
  ON run_messages(conversation_id, position);
```

保存策略：

- run 创建时初始化 user message 和 assistant draft。
- Claude parser 事件进入 per-run accumulator。
- accumulator 合并 `text_delta`、`thinking_delta`、`tool_use`、`tool_result` 等可展示事件。
- 后端按节流策略保存 `content` 和 `events_json`。
- run 完成、失败或取消时强制 flush。
- 每个 run 独立维护 accumulator、timer、message id，避免不同 run 之间数据污染。

#### artifacts

新 daemon 需要把最终报告、辅助文件、debug 文件等产物变成可查询、可下载的记录。这里不能复用 lanceDesign `deployments`，因为它是预览部署表。

建议 schema：

```sql
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  role TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  size INTEGER,
  mtime INTEGER,
  sha256 TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_artifacts_run
  ON artifacts(run_id, role);
```

约束：

- 只保存 workspace 内相对路径，不保存也不暴露 sandbox 绝对路径。
- 下载接口通过 daemon 代理读取文件。
- artifact 由 profile 中的 `artifactRules` 决定，业务请求只能传 `artifactRuleIds`。

#### run_logs

用于排查 Claude Code CLI 的 stdout/stderr/debug 输出，尤其是批任务模式没有实时 SSE 消费者时。

建议 schema：

```sql
CREATE TABLE run_logs (
  run_id TEXT PRIMARY KEY,
  stdout_log_path TEXT,
  stderr_log_path TEXT,
  debug_events_log_path TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);
```

路径应是 daemon 受控数据目录下的相对路径或内部路径，不通过业务 API 暴露真实 sandbox cwd。

#### profile_snapshots

为了后续排查“某次 run 当时用了哪个 profile / skillRoot / artifactRule / Claude 配置”，建议记录 profile 快照。该表是新 daemon 新增，不来自 lanceDesign。

建议 schema：

```sql
CREATE TABLE profile_snapshots (
  run_id TEXT PRIMARY KEY,
  profile_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);
```

注意：快照要按本文 Profile 驱动模型中的脱敏规则处理，不能保存 `ANTHROPIC_API_KEY`、token、cookie、OAuth bearer、Claude 登录态文件内容，或任何从 `claudeConfigDir` 解析出的凭证。

#### 暂不新增 run_events 表

第一版暂不新增独立 `run_events` 表。

原因：

- lanceDesign 的 SQLite 也没有独立 `run_events`。
- lanceDesign 的 SSE replay 来自内存 run buffer。
- lanceDesign 的长期展示数据在 `messages.events_json` 中。
- 新 daemon 复用这套 message persistence 语义即可满足实时 chat 和批任务事后查看。

后续如果发现 `events_json` 不适合承载完整 run 详情，或者需要重启后按 event id 精确续接，再增加：

```sql
CREATE TABLE run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);
```

即使后续增加 `run_events`，也不应该无脑保存每个 `text_delta` / `thinking_delta` / 大型 `tool_result` chunk；需要先定义压缩、采样、归档或 JSONL log 策略。

## 对外 API 草案

第一版采用 HTTP + SSE，参考 lanceDesign。

```text
POST /api/workspaces
POST /api/workspaces/:workspaceId/prepare
POST /api/runs
GET  /api/runs
GET  /api/runs/:runId/events
GET  /api/runs/:runId
POST /api/runs/:runId/cancel
GET  /api/runs/:runId/artifacts
GET  /api/runs/:runId/artifacts/:artifactId/download
GET  /api/runs/:runId/logs
GET  /api/profiles
GET  /api/health
```

lqBot 集成方式：

```text
lqBot backend
  -> POST /api/workspaces
  -> POST /api/workspaces/:workspaceId/prepare
  -> POST /api/runs
  -> 订阅 /api/runs/:runId/events
  -> GET /api/runs?originId=lqbot&userId=user_1 查询任务列表
  -> GET /api/runs/:runId/artifacts 查询产物
  -> GET /api/runs/:runId/artifacts/:artifactId/download 代理下载
  -> 按自己的 WebSocket 协议转发给前端
  -> 前端隐藏 tool 细节，只显示报告生成进度和最终 docx
```

## 任务查询

daemon 支持业务端按 workspace identity 查询任务状态，但不理解这些字段的业务含义。

workspace 创建时的 identity：

```json
{
  "workspace": {
    "originId": "lqbot",
    "userId": "user_1",
    "projectId": "project_123"
  }
}
```

daemon 存储为可索引字段：

```text
client_id
profile_id
origin_id
user_id
project_id
workspace_key
status
```

查询示例：

```text
GET /api/runs?originId=lqbot
GET /api/runs?originId=lqbot&userId=user_1
GET /api/runs?originId=lqbot&userId=user_1&projectId=project_123
GET /api/runs?originId=lqbot&status=running
GET /api/runs?workspaceKey=lqbot/user_1/project_123
GET /api/runs?workspacePrefix=lqbot/user_1
```

权限约束：

- 普通业务 API key 只能查询该 client 授权 profiles 下的 run。
- lqBot API key 默认只查询 lqBot 相关 workspace / profile。
- 管理员 API key 才能跨 client 查询所有任务。
- 业务前端不直接调用 runner daemon，由业务后端代理查询并做用户权限过滤。

职责划分：

- runner daemon 负责执行状态、事件、产物、日志和可索引 workspace identity。
- 业务后端负责用户权限、任务标题、模板名、报告业务状态等业务字段。
- 业务前端展示“进行中任务”“排队中任务”“已完成任务”“失败任务”等页面。

## 产物下载

daemon 不暴露 sandbox 真实路径，只暴露 artifact 元数据和受控下载接口。

artifact 返回示例：

```json
{
  "id": "artifact_123",
  "runId": "run_456",
  "ruleId": "report-docx",
  "role": "primary",
  "relativePath": "output/report.docx",
  "size": 123456,
  "mtime": 1770000000000,
  "sha256": "..."
}
```

下载 API：

```text
GET /api/runs/:runId/artifacts
GET /api/runs/:runId/artifacts/:artifactId/download
```

第一版推荐业务后端代理下载：

```text
browser
  -> lqBot backend
  -> runner daemon /api/runs/:runId/artifacts/:artifactId/download
  -> lqBot backend stream response
  -> browser
```

原因：

- runner daemon 只信任业务后端 API key。
- 业务后端可以做自己的用户权限校验。
- 普通浏览器用户不接触 runner daemon 地址、API key 或 sandbox 路径。
- 不需要第一版实现浏览器直连 daemon 的 CORS、临时签名 URL 和用户级鉴权。

下载行为：

- artifact 必须属于指定 `runId`。
- 当前 client 必须有权限访问该 run。
- 文件路径由 daemon 根据 artifact 的 `relativePath` 和内部 sandbox cwd 解析。
- 解析后的路径必须仍在 workspace 内。
- 使用 stream 返回文件，避免大文件读入内存。
- 设置合适的 `Content-Type` 和 `Content-Disposition`。
- 不在响应中返回 sandbox absolute path。

## 并发与队列

第一版建议 daemon 内置简单队列。

配置项：

- `globalConcurrency`
- `profileConcurrency`
- per-workspace 串行锁
- run 排队上限

行为：

- `globalConcurrency` 限制整个 daemon 同时运行的 Claude Code 任务数。
- `profileConcurrency` 限制同一个 profile 同时运行的 Claude Code 任务数。
- 同一个 `workspaceId` 第一版只允许一个 `running` run；后续 generate/revise 会进入队列，避免两个 Claude 进程同时写同一个 workspace。
- 未超过限制时，`POST /api/runs` 创建 run 后可以直接进入 `running`。
- 超过并发限制但队列未满时，`POST /api/runs` 仍返回 `runId`，run 状态为 `queued`。
- 前面的 run 结束后，daemon 自动从队列中取下一个 eligible run 进入 `running`。
- 队列满时才拒绝创建 run，返回 `429 RUN_QUEUE_FULL`。
- 这样 lqBot 前端可以稳定显示“排队中”，而不是用户点击生成后直接失败。

## lqBot 预期使用方式

lqBot 不再把报告生成强绑定到聊天 agent SDK。

建议流程：

```text
用户选择模板 / 上传资料 / 点击生成
  -> lqBot 完成用户上传和业务侧权限校验
  -> lqBot 调用 /api/workspaces 创建或获取 workspaceId
  -> lqBot 把 daemon 可访问的源文件真实地址传给 /api/workspaces/:workspaceId/prepare
  -> daemon copy 源文件到 sandbox workspace
  -> lqBot 调用 /api/runs，并传入 workspaceId 创建 run
  -> daemon 调用 report skill 生成 docx
  -> daemon 识别 output/**/*.docx
  -> lqBot 保存 runId 和 artifact 信息
  -> 用户继续自然语言修改报告时，继续对同一个 workspace 创建新的 run
```

## 后续还需要讨论的问题

1. `eventVisibility` 的具体过滤规则和 quiet/normal/debug 的字段级清单。
2. `allowedInputRoots` 的配置粒度和 `sourcePath` 校验细节。
3. 第二版是否需要 daemon upload API、远程 URL 拉取或对象存储拉取。
4. 是否支持 profile 热更新，第一版暂定启动时读取 config 文件。
5. 是否长期保持独立 run 模型，还是后续引入 Claude Code 原生 resume/fork。
6. 后续如需服务不可信租户，选择哪种 OS 级隔离或 permission hook 方案。

## lanceDesign 复用边界

本项目的实现原则是：能直接照搬 lanceDesign 的地方直接照搬；只在产品语义、跨服务边界和权限模型不同的地方做改造。

### 可以直接照搬

以下能力应尽量从 lanceDesign 迁移现有实现，保持行为等价：

- Claude Code CLI adapter：参考 `apps/daemon/src/runtimes/defs/claude.ts`。
- agent binary detection、fallback bin、capability probing。
- `claude -p --output-format stream-json --verbose` 参数构造。
- prompt via stdin。
- `--include-partial-messages` 能力探测。
- `--add-dir` 能力探测。
- `--model` 支持。
- `--permission-mode` 参数构造。
- Claude stdout stream-json parser：参考 `apps/daemon/src/claude-stream.ts`。
- 内部事件类型：`text_delta`、`thinking_delta`、`tool_use`、`tool_result`、`usage`、`raw`。
- child process spawn、stdout/stderr pipe、stdin error 处理。
- child close code 到 run terminal status 的映射。
- cancel 时 SIGTERM/SIGKILL fallback。
- stderr tail / stdout tail 诊断。
- Claude auth diagnostics：参考 `apps/daemon/src/claude-diagnostics.ts`。
- inactivity watchdog，避免 CLI 长时间无输出挂死。
- skill registry 的 `SKILL.md` frontmatter/body 解析：参考 `apps/daemon/src/skills.ts`。
- active skill side files staging：参考 `apps/daemon/src/cwd-aliases.ts`。
- staged skill 使用 copy 而不是 symlink。
- staged skill prompt preamble，告诉 agent 优先使用 cwd-relative skill root。
- HTTP + SSE 的 run event 基础模型：参考 `apps/daemon/src/chat-routes.ts` 和 `apps/daemon/src/runs.ts`。
- `Last-Event-ID` / `after` 的 SSE replay 行为：参考 `apps/daemon/src/runs.ts`。
- runtime data dir 模型和 SQLite 本地持久化方式。
- path traversal 防护思路。
- env allowlist 思路：参考 `apps/daemon/src/app-config.ts`。

这些能力是 runner 的核心执行链路，不应该重新发明一遍。

### 需要改造借鉴

以下能力可以参考 lanceDesign，但不能原样照搬：

- `POST /api/runs` 请求体：lanceDesign 是 chat/design 语义，新 daemon 改为 `profileId`、`workspace`、`skillId`、`prompt`、`artifactRuleIds`。
- run event contract：lanceDesign 事件里带有 chat/project/design 字段，新 daemon 需要定义通用 `RunEvent`。
- skill roots：lanceDesign 使用 app-level built-in/user roots，新 daemon 使用 profile-level roots。
- Claude env 配置：lanceDesign 面向单应用设置，新 daemon 改为 profile-controlled env。
- project cwd：lanceDesign 使用 projectId/baseDir，新 daemon 使用 `sandboxRoot + workspace segments`。
- artifact 识别：lanceDesign 面向设计产物，新 daemon 使用 profile artifact rules。
- 文件列表：保留 run 前后的 workspace 文件列表/扫描思路；第一版 artifact 识别以 run 结束后的 artifactRules glob scan 为准，watcher 后续再考虑。
- 错误提示：lanceDesign 文案面向设计用户，新 daemon 输出通用错误码和机器可读 details。
- 统计事件：lanceDesign 绑定自己的 analytics，新 daemon 只保存 run usage/cost/duration，不接产品 analytics。
- run/event 持久化策略：lanceDesign 的 `/api/runs` 事件主要保存在内存中，SQLite 持久化发生在产品消息层。新 daemon 第一版复用 message persistence 语义，不新增独立 `run_events` 表；后续只有在需要精确事件回放或重启续接时再讨论增加。

### 需要新决定的设计点与建议

下面是 lanceDesign 没有直接提供、需要新 daemon 自己定义的跨服务边界。当前先记录建议方案，后续讨论确认。

#### 1. 通用 API contract

建议：

- 第一版使用 HTTP + SSE。
- `POST /api/runs` 只接收任务参数，不接收绝对路径、任意 env、任意 skill root。
- `GET /api/runs/:runId/events` 支持 SSE。
- `GET /api/runs/:runId` 返回 run status 和摘要。
- `POST /api/runs/:runId/cancel` 取消任务。
- `GET /api/runs/:runId/artifacts` 返回产物列表。
- `GET /api/runs/:runId/logs` 返回可授权查看的日志摘要或下载地址；只有 client `canReadLogs=true` 才能访问。

建议请求体：

```json
{
  "profileId": "report-docx",
  "workspaceId": "ws_123",
  "kind": "generate",
  "skillId": "report-writer",
  "prompt": "根据资料生成报告",
  "model": "sonnet",
  "artifactRuleIds": ["report-docx"]
}
```

校验失败示例：

- 请求传入的 `model` 不在 profile `allowedModels` 内，返回 `400 MODEL_NOT_ALLOWED`。
- 请求 `kind=revise` 但携带 `skillId`，返回 `400 BAD_REQUEST`。

#### 2. 通用 RunEvent contract

建议：

- 内部保存全量 Claude events。
- run service / SSE / `Last-Event-ID` 逻辑严格参考 lanceDesign。
- 与 lanceDesign 保持一致的是：实时 SSE replay 先按内存 run event buffer 设计。
- `GET /api/runs/:runId/events` 只承诺在线运行和短期断线重连；内存 buffer TTL 过期后不保证精确 `Last-Event-ID` replay。
- 长期事后查看走 `GET /api/runs/:runId` / run detail，读取 SQLite `runs`、`run_messages`、`artifacts`、`run_logs`。
- 第一版不新增独立 `run_events` 表；第一原则是不要无脑把每个 Claude chunk 写入 SQLite。
- 对外暴露统一 wrapper：

```json
{
  "id": 42,
  "runId": "run_...",
  "type": "text_delta",
  "createdAt": 1770000000000,
  "data": {}
}
```

- `id` 使用 run 内单调递增序号，方便断线恢复。
- SSE event name 可以直接使用 `type`。
- 支持 `Last-Event-ID` 从指定 event id 后继续推送。
- 对外事件经过 profile `eventVisibility` 过滤。

#### 3. Profile config schema

建议采用上文“Profile 驱动模型”中的完整 daemon config schema。

核心决策：

- 配置分为 `server`、`clients`、`profiles` 三层。
- 第一版启动时读取 config 文件。
- 第一版不做 profile 热更新。
- `server` 控制监听地址、`dataDir`、`globalConcurrency` 和 `maxQueueSize`。
- `clients` 控制 API key、可用 profile、debug event 和 logs 权限。
- `profiles` 控制 `sandboxRoot`、`claudeConfigDir`、`claudeBin`、`skillRoots`、`allowedInputRoots`、`allowedSkillIds`、`artifactRules`、`defaultModel`、`allowedModels`、并发、超时、事件可见性和受控 env。
- 不允许 run 请求覆盖 `claudeConfigDir`、`claudeBin`、`skillRoots`、`allowedInputRoots`、`permissionMode`。
- run 请求可以传 `model`，但必须命中 profile `allowedModels`；未传时使用 `defaultModel`。
- `env` 必须按 allowlist 校验。
- `CLAUDE_CONFIG_DIR` 和 `CLAUDE_BIN` 使用显式字段，不放在 `env` 里。

#### 4. 跨服务鉴权

建议：

- 第一版使用 API key。
- daemon config 中配置 calling clients。
- 每个 client 绑定允许使用的 profile 列表。

示例：

```json
{
  "clients": [
    {
      "id": "lqbot",
      "apiKey": "env:CLAUDE_RUNNER_LQBOT_API_KEY",
      "allowedProfileIds": ["report-docx"]
    }
  ]
}
```

建议请求头：

```text
Authorization: Bearer <api-key>
```

后续如需更强边界，再考虑 mTLS 或 JWT。

#### 5. Workspace 文件同步

建议第一版不暴露 sandbox 路径给业务端，也不要求业务端直接写入 sandbox。

第一版约定：

- 业务系统负责接收用户上传、完成业务侧权限校验。
- 业务系统把 daemon 可访问的源文件真实地址传给 daemon。
- daemon 校验源文件是否位于 profile 的 `allowedInputRoots` 内。
- daemon 自己 copy 源文件到 sandbox workspace。
- daemon 只在 sandbox workspace 内执行和监听。

建议第一版提供：

```text
POST /api/workspaces
POST /api/workspaces/:workspaceId/prepare
```

`POST /api/workspaces` 接收 `profileId` 和 `originId/userId/projectId`，创建或获取 workspace，返回 `workspaceId`。

`POST /api/workspaces/:workspaceId/prepare` 接收 `sourcePath -> targetPath` 映射。`sourcePath` 是 daemon 可访问的本机路径或共享挂载路径；`targetPath` 是 sandbox workspace 内的安全相对路径，例如 `input/source.docx`。

如果调用方和 daemon 不在同一服务器，业务系统需要先通过共享存储、对象存储同步器、rsync、内部文件服务，或后续 upload API，让源文件出现在 daemon 可访问的 `allowedInputRoots` 下。daemon 仍然只从 `allowedInputRoots` copy 到 sandbox，不读取任意外部路径。

第二版再考虑：

- `POST /api/workspaces/:id/files` 上传文件到 daemon 暂存区
- 远程 URL 拉取
- S3/object storage pull

#### 6. SQLite schema

第一版 SQLite schema 采用本文“持久化 / SQLite 表设计”章节中的设计：

```text
workspaces
conversations
runs
run_messages
artifacts
run_logs
profile_snapshots
```

核心取舍：

- 复用 lanceDesign 的 message persistence 语义，而不是原样复用全部产品表。
- `run_messages.events_json` 保存翻译/合并后的可展示 agent events。
- `runs`、`artifacts`、`run_logs` 是新 daemon 为任务查询、产物下载和执行诊断新增的表。
- `workspaces`、`runs`、`run_messages` 是第一版地基，run create 时必须落库 `runs` queued 行。
- 第一版暂不新增独立 `run_events` 表。
- SSE 连接第一版仍参考 lanceDesign，从内存 buffer 按 `Last-Event-ID` / `after` 做在线/短期 replay。
- terminal run 可以从内存 Map 中按 TTL 清理；SQLite 中的 run/artifact/log 索引按数据保留策略清理。
- daemon 重启后不恢复已经退出的 child process；重启前处于 `queued` 或 `running` 的 run 应标记为 `interrupted`，错误码建议 `RUN_INTERRUPTED_BY_DAEMON_RESTART`。

#### 7. Artifact 缺失策略

建议：

- artifact rule 支持 `required` 字段。
- required artifact 缺失时，即使 Claude exit code 为 `0`，run 也标记为 `failed`，错误码建议 `ARTIFACT_REQUIRED_MISSING`。
- 非 required artifact 缺失只记录 warning。
- artifact 缺失失败时仍然要 flush `run_messages`，便于业务端查看 Claude 当次完整执行过程；`artifacts` 表可以为空或只包含已命中的非 required artifact。

示例：

```json
{
  "id": "report-docx",
  "pattern": "output/**/*.docx",
  "role": "primary",
  "required": true
}
```

#### 8. Event visibility

建议：

- profile 默认 `eventVisibility`。
- run 请求只能降低可见性，不能提高可见性。
- 内部始终保存完整事件。

建议等级：

```text
quiet  - 只暴露 start/status/text summary/artifact/error/end
normal - 暴露 text_delta/tool_use/artifact/error/end，隐藏 tool_result 和 raw
debug  - 暴露完整事件
```

#### 9. 超时与 watchdog

建议：

- 第一版保留 lanceDesign inactivity watchdog。
- profile 可配置：
  - `runTimeoutMs`
  - `inactivityTimeoutMs`
  - `cancelGraceMs`
- 超时后标记 `failed`，错误码为 `RUN_TIMEOUT` 或 `RUN_INACTIVITY_TIMEOUT`。

#### 10. Workspace 生命周期与目录约定

第一版 workspace 是长期可复用的 project sandbox，支持 generate 后继续 revise。

目录约定：

```text
<workspace>/
  input/       # daemon prepare copy 进来的用户资料
  output/      # skill 默认产物目录，artifactRules 默认从 workspace 根解析
  work/        # skill 可选中间文件目录
  .claude-runner-skills/
```

行为：

- `POST /api/workspaces` 创建或获取 workspace 时，daemon 创建基础目录骨架。
- `POST /api/workspaces/:workspaceId/prepare` 默认把资料放到 `input/`，也允许请求指定安全相对 `targetPath`。
- artifact glob pattern 以 workspace 根目录为基准解析，例如 `output/**/*.docx`。
- daemon 不自动删除 active workspace；第一版由业务端决定什么时候归档或清理。
- 后续可以增加 `DELETE /api/workspaces/:workspaceId` 或 retention policy；第一版先记录 `status` 和 `updated_at`，为后续清理留接口。

#### 11. run_messages flush 策略

第一版采用 daemon-side streaming accumulator：

- run create 时插入 user message 和 assistant draft。
- run started 时更新 assistant `run_status=running` 和 `started_at`。
- Claude parser event 到达后更新内存 accumulator，并按约 500ms 节流 UPDATE `run_messages.content/events_json/last_run_event_id`。
- run terminal、artifact 缺失失败、cancel 或 interrupted 标记前必须强制 flush。
- daemon 崩溃时，SQLite 中可能只有最后一次节流成功的半成品 `events_json`；重启后旧 `queued/running` run 标记为 `interrupted`，已有半成品 message 保留用于诊断。

per-workspace 串行锁不单独建持久锁表。运行资格由 `runs` 表中同 workspace 的非 terminal run 推导；daemon 重启时把旧 `queued/running` 标记为 `interrupted` 后，锁自然释放。

#### 12. Retry / resume / fork

建议：

- 第一版与 lanceDesign 当前 Claude Code CLI pipeline 保持一致：每次 run 都是独立的 Claude Code CLI 进程。
- 第一版不使用 Claude Code 原生 session resume、continue 或 fork。
- 连续修改通过同一个 workspace 的文件状态、artifact 历史和业务系统拼接的 prompt 实现。
- run 失败后的重试也是创建一个新的 run，并复用同一个 workspace。
- 后续只有在明确需要 Claude Code 原生会话能力时，再讨论是否保存 Claude session id 并支持 resume/fork。
