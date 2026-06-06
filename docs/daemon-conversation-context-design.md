# Daemon 原生会话与 Prompt Context 设计

日期：2026-06-05

## 背景

当前 daemon 已经具备 run 执行、SSE 事件、SQLite 持久化、`conversations` / `run_messages` 表和 skill 注入能力。现有 `/api/runs` 不允许调用方显式传入 `conversationId`；后端会按 workspace 复用一条默认 conversation，把 run 创建时的 user / assistant message 归入该默认线程。

RPA 本地 B/S MVP 需要多轮确认、表单提问、脚本生成、脚本加固和后续修订，因此需要补齐 daemon 的通用原生会话能力。但 daemon 仍然必须保持通用 agent runner 定位，不能理解 RPA DSL、Playwright、页面截图、trace 等业务语义。

本设计采用以下边界：

```text
业务层决定本轮提供哪些业务上下文。
daemon 负责保存会话、注入 skill instructions、注入 side files 路径和 profile 中已有的运行约束、生成最终 prompt、执行 run、保存 prompt snapshot hash/必要快照、做通用安全兜底和审计。
```

一个重要原则是：业务层不需要、也不应该知道 skill 的具体内容。业务层最多传入 `skillId`、用户/assistant 对话、业务上下文引用和当前用户输入；最终发给 Claude Code 的 prompt 由 daemon 在每次 run 启动前统一拼接。

## 与 lanceDesign 的关系

lanceDesign 当前做法：

- Web 侧维护聊天历史。
- Web 侧把历史消息折叠成 transcript。
- Web 侧对单条历史消息做 `12_000` 字符截断。
- Web 侧根据历史 run 事件生成 context warning。
- Web 侧单独提取最新用户输入 `currentPrompt`。
- daemon 接收已经拼好的 `message`，启动 agent，返回流式事件。
- daemon 侧另有 prompt budget 保护，主要防止 argv-bound CLI 或 Windows 命令行长度爆掉。

新 daemon 方案保留业务层的上下文选择自由度，但不要求业务层拼最终 prompt。新增 daemon-native 能力：

- daemon 保存和复用 `conversationId`。
- daemon 保存 user/assistant message 与 run 的对应关系。
- daemon 可以从数据库读取对话历史，也可以接收业务层提供的上下文包。
- daemon 在最终 prompt 中注入 skill instructions、side files 路径，以及 profile 中 daemon 明确持有的运行约束。
- daemon 保存实际发送给 Claude Code 的 `prompt_snapshot_hash` 和大小信息；全文是否持久化由 `collectionMode` 决定。
- daemon 对任何模式都做长度、路径、CLI 调用方式等通用兜底。

## 目标

1. 允许客户端复用已有 `conversationId` 创建新 run。
2. 支持业务层提供业务上下文，也支持 daemon 根据数据库历史拼接通用上下文。
3. 不把 RPA、报告生成、设计生成等业务 prompt 策略写死进 daemon core。
4. 保留现有 `/api/runs` 兼容行为，旧客户端不需要立刻迁移。
5. 为 AskQuestion / `<question-form>` 这类多轮确认流程提供可靠的后端会话基础。
6. 记录每次 run 实际执行 prompt 的 hash、大小和持久化状态；diagnostic/review 模式保存 `prompt_snapshot` 全文，用于 debug 和问题复现。
7. 确保 conversation / `run_messages` 只保存用户和 assistant 可见的对话内容，不被完整内部 prompt 污染。

## 非目标

- 不在 daemon core 中实现 RPA DSL、Playwright 脚本编译或页面探测逻辑。
- 不要求 daemon 对所有业务历史做智能摘要；摘要能力可以作为后续增强。
- 不把前端 UI 表单状态持久化成 daemon 的特殊模型；表单回答以普通 user message 进入 conversation。
- 不允许业务层绕过 daemon 的 skill 注入和权限校验，直接传最终 Claude Code prompt。
- 不改变第一版本的安全边界；目录隔离仍然不是强沙箱。

## Prompt / Context 模式

### 模式 A：Business-Context

业务层提供业务上下文，但不提供最终 prompt。

适用场景：

- RPA codegen 上传后加固。
- RPA 自然语言生成。
- 报告生成、设计生成、数据处理等需要业务层选择上下文的流程。
- 业务层知道哪些文件、参数、用户确认结果应参与本轮任务，但不知道 skill 具体 instructions。

请求形态示例：

```json
{
  "profileId": "rpa-local",
  "workspaceId": "ws_xxx",
  "conversationId": "conv_xxx",
  "kind": "generate",
  "skillId": "playwright-rpa-harden",
  "promptMode": "business-context",
  "collectionMode": "diagnostic",
  "currentPrompt": "请根据上传的 codegen 脚本完成加固",
  "businessContext": {
    "stage": "codegen_harden",
    "inputFiles": ["input/flow.py"],
    "confirmedParamsPath": "input/confirmed-params.json",
    "notes": "用户确认日期字段需要作为运行参数。"
  },
  "metadata": {
    "business": "rpa",
    "stage": "codegen_harden"
  }
}
```

daemon 行为：

- 将 `currentPrompt` 写入当前 conversation 的 user message。
- 校验 `skillId` 是否被 profile/client 允许。
- stage skill side files。
- 读取 `SKILL.md` 并注入 skill instructions。
- 注入 staged side files 的 workspace-relative 路径说明。
- 注入 profile 中 daemon 明确持有且对模型有帮助的运行约束，例如 artifact 输出路径/格式约定、profile 显式配置的业务无关提示；不默认注入 permissionMode、model 等执行细节。
- 不注入 Claude Code tools/MCP 能力说明；这些能力由 Claude Code CLI 自身管理，daemon 不维护工具注册表。
- 按固定渲染契约注入业务层提供的 `businessContext`。
- 生成最终 prompt，计算 `prompt_snapshot_hash` 和大小信息，并按 `collectionMode` 决定是否把全文写入 snapshot 表。
- 执行 workspace 准备、run 状态持久化和 SSE 输出。
- 做最大长度、profile 权限、skill 权限、路径和 CLI 调用方式检查。

### 模式 B：Daemon-Composed

前端只传本轮用户输入和上下文策略，daemon 从数据库读取对话历史并拼接上下文。

适用场景：

- 普通 agent 续聊。
- 没有复杂业务上下文的生成和修订。
- 业务前端希望复用 daemon 默认会话策略。

请求形态示例：

```json
{
  "profileId": "general-agent",
  "workspaceId": "ws_xxx",
  "conversationId": "conv_xxx",
  "kind": "revise",
  "promptMode": "daemon-composed",
  "collectionMode": "lite",
  "currentPrompt": "按刚才的建议继续修改",
  "contextPolicy": {
    "recentMessages": 8,
    "maxMessageChars": 12000,
    "maxTotalChars": 80000,
    "includeRunWarnings": true
  }
}
```

daemon 行为：

- 将 `currentPrompt` 写入当前 conversation 的 user message。
- 使用 conversation 级有序查询读取最近消息、必要 run metadata 和 warning 输入。
- 默认只读取 user/assistant 可见的 `role + content`。
- 默认不把 `thinking_content`、`tool_result`、raw debug events 回灌进 prompt。
- 如本轮显式指定 `skillId`，仍由 daemon 校验并注入 skill instructions / side files 路径 / profile 运行约束。
- 按 `contextPolicy` 生成最终 prompt。
- 计算 `prompt_snapshot_hash` 和大小信息，并按 `collectionMode` 决定是否保存全文。
- 执行 run。

### 兼容模式：Legacy Prompt

现有客户端仍可继续传：

```json
{
  "profileId": "report-docx",
  "workspaceId": "ws_xxx",
  "kind": "generate",
  "skillId": "report-writer",
  "prompt": "Generate the report."
}
```

兼容行为：

- 如果没有 `conversationId`，daemon 继续复用 workspace 默认 conversation，保持现有行为。
- 如果没有 `promptMode`，按当前行为把 `prompt` 当作本轮用户请求。
- `kind=generate + skillId` 仍走 daemon 的 skill 注入逻辑。
- `runs.prompt` 和 user message content 继续保存用户请求，不保存最终内部 prompt。
- daemon 同时保存本次实际执行 prompt 的 hash、大小和持久化状态；全文是否保存由 `collectionMode` 决定。

## 职责边界

### 业务层负责

- 决定本轮业务阶段和业务上下文。
- 提供 `currentPrompt`、`businessContext`、文件引用、用户确认结果、业务 metadata。
- 可以选择或转交用户选择 `skillId`，但不读取或拼接 skill 内部 instructions。
- 控制业务级上下文选择，例如哪些输入文件、DSL、参数确认结果进入本轮任务。
- 渲染 AskQuestion / `<question-form>`，并把用户回答作为下一轮普通 user message 提交。

### daemon 负责

- 创建和复用 conversation。
- 保存 user message、assistant message、run 与 conversation 的关系。
- 保持 conversation / `run_messages` 只包含用户和 assistant 可见内容。
- 校验 workspace/profile/client/skill 权限。
- stage skill side files。
- 注入 `SKILL.md`、side files 路径和 profile 中 daemon 明确持有的运行约束。
- 生成最终 prompt。
- 保存 prompt snapshot hash/必要全文、skill snapshot hash/必要全文和 run metadata。
- 在 `daemon-composed` 模式下按通用策略读取历史对话。
- 对任意模式执行通用 prompt 兜底：
  - 最大总字符数或字节数限制。
  - 单条消息最大长度默认值。
  - 过大 tool result 的 warning。
  - CLI stdin/argv/Windows 命令行长度保护。
- 提供历史查询和 run 查询 API，方便业务层做 context 编排。

## API 扩展

`POST /api/runs` 扩展字段：

```ts
type PromptMode = 'legacy' | 'business-context' | 'daemon-composed';
type CollectionMode = 'lite' | 'diagnostic' | 'review';

interface CreateRunRequest {
  profileId: string;
  workspaceId: string;
  kind: 'generate' | 'revise';
  prompt?: string;
  currentPrompt?: string;
  conversationId?: string;
  promptMode?: PromptMode;
  collectionMode?: CollectionMode;
  businessContext?: Record<string, unknown>;
  contextPolicy?: {
    recentMessages?: number;
    maxMessageChars?: number;
    maxTotalChars?: number;
    includeRunWarnings?: boolean;
  };
  skillId?: string;
  model?: string;
  artifactRuleIds?: string[];
  eventVisibility?: EventVisibility;
  metadata?: Record<string, unknown>;
}
```

响应扩展：

```json
{
  "runId": "run_xxx",
  "status": "queued",
  "conversationId": "conv_xxx",
  "userMessageId": "msg_user_xxx",
  "assistantMessageId": "msg_assistant_xxx"
}
```

### promptMode 字段合法性矩阵

| 字段 | legacy | business-context | daemon-composed |
| --- | --- | --- | --- |
| `prompt` | 必填 | 禁止 | 禁止 |
| `currentPrompt` | 禁止 | 必填 | 必填 |
| `businessContext` | 禁止 | 可选 | 禁止 |
| `contextPolicy` | 禁止 | 禁止 | 可选 |
| `conversationId` | 可选 | 可选 | 可选 |
| `collectionMode` | 可选，默认 `lite` | 可选，默认 `lite` | 可选，默认 `lite` |

### kind × promptMode × skillId 合法性矩阵

| kind | promptMode | 输入字段 | `skillId` | 说明 |
| --- | --- | --- | --- | --- |
| `generate` | `legacy` | `prompt` 必填 | 必填 | 保持当前 generate + skill 行为 |
| `revise` | `legacy` | `prompt` 必填 | 禁止 | 保持当前兼容行为 |
| `generate` | `business-context` | `currentPrompt` 必填，`businessContext` 可选 | 必填 | RPA codegen 加固/自然语言生成优先使用 |
| `revise` | `business-context` | `currentPrompt` 必填，`businessContext` 可选 | MVP 必填 | 用于同一业务 skill 的多轮确认/修订 |
| `generate` | `daemon-composed` | `currentPrompt` 必填，`contextPolicy` 可选 | 必填 | daemon 读取历史后执行生成任务 |
| `revise` | `daemon-composed` | `currentPrompt` 必填，`contextPolicy` 可选 | 可选 | 普通续聊可不带；继续某个 skill 流程时建议显式传 |

补充规则：

- `conversationId` 如存在，必须属于同一 workspace。
- 无 `conversationId` 时继续复用 workspace 默认 conversation。
- `kind=revise` 允许显式 `skillId` 是对当前 validation 中 “revise 禁止 skillId” 的有意变更；implementation plan 需要同步修改 `validation.ts` 和相关测试。
- `businessContext` 必须可 JSON 序列化，并受独立字节上限控制。
- schema 层未知字段继续由 zod strict object 拒绝，不需要依赖某个历史字段名做校验。

### 非 Legacy 字段映射

当前数据库中 `runs.prompt` 是 `TEXT NOT NULL`，且 run 创建时 user message content 来自本轮用户输入。为减少迁移面，MVP 不把 `runs.prompt` 改成 nullable。

字段映射固定为：

| 模式 | `runs.prompt` | `runs.current_prompt` | user message `content` | 最终 prompt |
| --- | --- | --- | --- | --- |
| `legacy` | `prompt` | 可由 `prompt` 派生或为空 | `prompt` | daemon 注入 skill 后生成 |
| `business-context` | `currentPrompt` | `currentPrompt` | `currentPrompt` | daemon 注入 skill/businessContext 后生成 |
| `daemon-composed` | `currentPrompt` | `currentPrompt` | `currentPrompt` | daemon 读取历史后生成 |

`runs.prompt` 始终表示“用户本轮请求”，绝不写入最终内部 prompt。

### collectionMode 权限封顶

`collectionMode` 与 `eventVisibility` 类似，必须受 profile 和 client 权限封顶，不能让低信任调用方驱动 daemon 落盘完整 prompt、tool result 或 review bundle。

MVP 规则建议：

- profile 配置 `maxCollectionMode`，默认 `lite`。
- `lite` 对所有有 run 权限的 client 可用。
- `diagnostic` 需要 profile 上限允许，且 client 具备 `canReadLogs`。
- `review` 需要 profile 上限允许，且 client 同时具备 `canReadLogs` 和 `canReadDebugEvents`。
- 请求超过允许档位时，MVP 返回结构化错误，例如 `COLLECTION_MODE_NOT_ALLOWED`；不做静默降级，避免调用方误以为已经采集完整材料。

### API / DB 命名对照

| API 字段 | DB 字段/表 | 说明 |
| --- | --- | --- |
| `promptMode` | `runs.prompt_mode` | `legacy | business-context | daemon-composed` |
| `collectionMode` | `runs.collection_mode` | `lite | diagnostic | review` |
| `currentPrompt` | `runs.current_prompt` | 用户本轮输入；legacy 可由 `prompt` 派生 |
| `prompt` | `runs.prompt` | 兼容字段，保持“用户请求”语义 |
| `businessContext` | `run_context_snapshots.business_context_json` | 业务上下文，daemon 不解释业务语义 |
| `contextPolicy` | `runs.context_policy_json` | daemon-composed 的历史读取策略 |
| n/a | `runs.prompt_snapshot_hash` | 最终 prompt hash，所有 collectionMode 都保存 |
| n/a | `run_prompt_snapshots.prompt_snapshot` | 最终 prompt 全文，按 collectionMode 保存 |
| n/a | `run_skill_snapshots.skill_snapshot_json` | 本次 run 使用的 skill 快照，按 collectionMode 保存 body |

## 数据模型扩展

当前已有：

- `runs.prompt`
- `runs.metadata_json`
- `run_messages.conversation_id`
- `run_messages.content`
- `run_messages.events_json`
- `profile_snapshots`

`runs` 是列表和状态轮询的高频表，不应直接挂载大文本 blob。建议最小扩展采用“热表轻字段 + 独立快照表”：

```text
runs.prompt_mode TEXT
runs.current_prompt TEXT
runs.collection_mode TEXT
runs.prompt_snapshot_hash TEXT
runs.prompt_snapshot_char_count INTEGER
runs.prompt_snapshot_byte_count INTEGER
runs.prompt_snapshot_persisted INTEGER
runs.business_context_hash TEXT
runs.context_policy_json TEXT
```

独立快照表建议：

```text
run_prompt_snapshots
  run_id TEXT PRIMARY KEY
  prompt_snapshot TEXT          -- lite 可为 NULL，只保存 hash/size
  prompt_snapshot_hash TEXT NOT NULL
  char_count INTEGER NOT NULL
  byte_count INTEGER NOT NULL
  collection_mode TEXT NOT NULL
  created_at INTEGER NOT NULL

run_skill_snapshots
  run_id TEXT PRIMARY KEY
  skill_id TEXT NOT NULL
  skill_snapshot_hash TEXT NOT NULL
  skill_snapshot_json TEXT      -- lite 可只保存 hash + metadata，不保存 SKILL.md body
  side_files_manifest_json TEXT
  created_at INTEGER NOT NULL

run_context_snapshots
  run_id TEXT PRIMARY KEY
  business_context_json TEXT    -- business-context 模式使用；可按上限存储
  business_context_hash TEXT
  rendered_context_hash TEXT
  created_at INTEGER NOT NULL
```

`runs.prompt` 必须保持现有语义：用户本轮请求 / legacy prompt。不能把最终内部 prompt 写回 `runs.prompt`，否则会污染 user message 和 run detail。

`run_messages.prompt_snapshot` 不建议添加。prompt snapshot 是 run 级内部审计材料，不属于用户/assistant 对话内容。

run detail 默认响应不返回 `prompt_snapshot`、`business_context_json` 或未过滤 debug events。完整 prompt/context 读取至少需要 `canReadLogs`；包含未过滤 `tool_result` 的 debug 内容需要 `canReadDebugEvents`。

## Business Context 渲染契约

`businessContext` 是业务层给 daemon 的结构化上下文。daemon 不解释业务语义，但必须用稳定格式注入最终 prompt，让 skill 作者可以依赖这个结构。

MVP 固定为：

````text
## Business Context
The following JSON is supplied by the business layer. Treat file paths as workspace-relative references. File contents are not inlined by the daemon; read them explicitly only when needed.

```json
{ ... deterministic JSON ... }
```
````

渲染规则：

- 使用确定性 JSON 序列化：对象 key 稳定排序，2 空格缩进。
- 文件只传 workspace-relative path，不内联文件内容。
- 如果后续支持文件内联，必须走 workspace-relative path 校验、大小上限和 prompt token 预算。
- `businessContext` 自身有独立字节上限；超过时返回结构化错误，避免只表现为最终 `PROMPT_TOO_LARGE`。
- `businessContext` 原文和渲染后 hash 进入 `run_context_snapshots`，方便复盘。

## Prompt 体积控制

体积控制分两层：

### 业务层策略

业务层可以自由决定提供哪些业务上下文：

- 是否提供历史摘要。
- 提供最近几轮对话，还是让 daemon 自己从数据库读取。
- 是否引用 DSL 原文、DSL 摘要或 workspace 文件路径。
- 是否引用用户确认结果、参数表单答案、业务阶段 metadata。

业务层不决定 skill instructions，不拼最终 prompt。

### daemon 兜底策略

schema 层和最终 prompt 层分开：

- HTTP schema 层保留绝对硬上限，用于防止明显异常请求，例如现有 `prompt` 200k 字符上限。
- final prompt 层使用可配置 `maxTotalChars`，按 daemon 拼接后的 `prompt_snapshot` 计算。
- `maxMessageChars` 默认可沿用 lanceDesign 经验值 `12_000`。
- 超过 final prompt 上限时返回结构化错误，例如 `PROMPT_TOO_LARGE`，并和 schema validation 错误区分。
- 如果历史 run 中存在超大 tool result 或超高 input tokens，daemon 在 `daemon-composed` 模式下注入通用 warning，但不回灌 tool_result 全文。
- 如果 future adapter 使用 argv 传 prompt，保留 `AGENT_PROMPT_TOO_LARGE` 类保护；当前 Claude Code stdin 模式仍应测试确认 prompt 不进入 argv。

## AskQuestion / 表单续聊流程

业务 skill 可以输出 AskQuestion 或等价 `<question-form>` JSON。

流程：

1. daemon 启动 run，并生成最终 prompt。
2. Claude Code 输出 `<question-form>`。
3. daemon 将输出流式返回，并保存 assistant message。
4. RPA Web 或其他业务 Web 渲染表单。
5. 用户提交表单后，业务 Web 创建下一次 run：
   - 同一个 `conversationId`。
   - `currentPrompt` 为格式化后的表单回答。
   - 业务层可提供新的 `businessContext`。
6. daemon 将表单回答作为普通 user message 保存，并重新注入 skill instructions、side files 路径和 profile 运行约束，生成下一轮最终 prompt。

conversation 中保存的是用户/assistant 可见内容；完整内部 prompt 不进入 conversation，只按 `collectionMode` 进入 run 级 snapshot。

daemon 不需要理解表单结构，也不需要维护表单 UI 状态。

## 实现阶段

### Phase 1：conversationId 复用与 message 关联

- `POST /api/runs` 接受可选 `conversationId`。
- 如果缺省则复用 workspace 默认 conversation，保持现有兼容行为。
- 如果传入则校验 workspace 归属并复用。
- 响应返回 `conversationId/userMessageId/assistantMessageId`。
- 每次 run 创建时插入 user message 和 assistant placeholder。

### Phase 2：Business-Context 模式与快照地基

- 新增 `promptMode=business-context`。
- 接受 `currentPrompt` 和可选 `businessContext`。
- 禁止业务层提供最终 prompt 字段。
- `currentPrompt` 写入 user message。
- daemon 校验 skill、stage side files、注入 skill instructions、side files 路径和 profile 运行约束，生成最终 prompt。
- 计算并保存 `prompt_snapshot_hash`、字符数、字节数和 `prompt_snapshot_persisted`。
- 按 `collectionMode` 写入 `run_prompt_snapshots`、`run_skill_snapshots`、`run_context_snapshots`。
- RPA MVP 优先接入该模式。

### Phase 3：Daemon-Composed 模式

- 新增 `contextPolicy`。
- 新增 conversation 级有序历史查询，不能直接使用 run 内 `run_messages.position` 作为跨 run 排序依据。
- 排序键必须稳定；implementation plan 直接采用 conversation 级全局递增 `conversation_seq`，避免 `run.created_at + random id` 在同毫秒 run 下出现不确定顺序。
- 默认 transcript builder：
  - 只读 `role + content`。
  - 排除 `thinking_content`。
  - 排除 `events_json` 中的 `tool_result`、raw debug events。
  - 最近 N 条消息。
  - 单条消息截断。
  - 总长度限制。
  - 通用 context warning。
- 保存 prompt snapshot hash；按 `collectionMode` 保存全文。

### Phase 4：Prompt Snapshot 与查询能力完善

- 明确 `run_prompt_snapshots`、`run_skill_snapshots`、`run_context_snapshots` 等独立快照表，以及 `runs.prompt_snapshot_hash` 等轻量字段。
- 在 run 详情 API 中默认只返回 prompt snapshot hash/大小/是否持久化，不返回全文。
- 完整 prompt/context 读取需要 `canReadLogs` 或更高权限。
- 增加 conversation 查询 API，供业务层读取历史并自行选择上下文。

## RPA MVP 的采用方式

RPA MVP 默认使用 `business-context`：

- RPA Web/BFF 提供 codegen 脚本、DSL、用户确认变量、页面探测摘要和当前阶段 metadata 的引用。
- RPA Web/BFF 不读取或拼接 `SKILL.md`。
- daemon 负责保存 conversation、注入 skill instructions/side files/profile 运行约束、运行 Claude Code、保存 prompt snapshot hash/必要全文、返回 SSE。
- 表单回答作为同一个 conversation 的下一条 user message。

这样既保留业务层的上下文选择自由度，又不会让业务层掌握 skill 内部细节。

## 风险与约束

- 如果业务层提供过大 `businessContext`，daemon 会拒绝执行，而不是悄悄截断导致模型行为不可预期。
- 如果多个业务共享 daemon，必须通过 profile/skill allowlist 控制 skill 使用范围。
- prompt snapshot 可能包含敏感业务数据，API 返回时需要受 profile 或配置控制。
- SQLite 对本地 B/S 场景足够；prompt 构造只发生在创建 run 时，不是每个 SSE token 都读写数据库。
- SaaS 化后可以复用相同 API 和 prompt 模式，但数据库和队列层需要替换或扩展。
