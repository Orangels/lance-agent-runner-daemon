# Daemon 原生会话与 Prompt Context 设计

日期：2026-06-05

## 背景

当前 daemon 已经具备 run 执行、SSE 事件、SQLite 持久化、`conversations` / `run_messages` 表和 skill 注入能力，但 `POST /api/runs` 每次都会创建新的 conversation。业务前端如果要做续聊，只能像 lanceDesign 当前实现一样，在前端维护完整 transcript，再把拼好的 prompt 发给 daemon。

这个模式可以工作，但会让每个业务系统都重复实现会话存储和 run 关联能力。RPA 本地 B/S MVP 需要多轮确认、表单提问、脚本生成、脚本加固和后续修订，因此需要补齐 daemon 的通用原生会话能力。

同时，不同业务的 prompt/context 组织方式差异很大。RPA、报告生成、设计生成、普通 agent 续聊不应该被 daemon 的固定 transcript 策略绑死。

因此，本设计采用一个折中边界：

```text
业务层决定本轮模型应该看什么。
daemon 负责会话存储、run 执行、prompt 快照、通用安全兜底和审计。
```

## 与 lanceDesign 的关系

lanceDesign 当前做法：

- Web 侧维护聊天历史。
- Web 侧把历史消息折叠成 transcript。
- Web 侧对单条历史消息做 `12_000` 字符截断。
- Web 侧根据历史 run 事件生成 context warning。
- Web 侧单独提取最新用户输入 `currentPrompt`。
- daemon 接收已经拼好的 `message`，启动 agent，返回流式事件。
- daemon 侧另有 prompt budget 保护，主要防止 argv-bound CLI 或 Windows 命令行长度爆掉。

新 daemon 方案保持 lanceDesign 的核心自由度：业务层仍然可以控制 prompt/context 组织方式。但新增 daemon-native 能力：

- daemon 保存和复用 `conversationId`。
- daemon 保存 user/assistant message 与 run 的对应关系。
- daemon 可以在需要时自己从数据库拼接通用 prompt。
- daemon 保存实际发送给 Claude Code 的 prompt snapshot，便于审计和复现。
- daemon 对任何模式都做长度、路径、CLI 调用方式等通用兜底。

## 目标

1. 允许客户端复用已有 `conversationId` 创建新 run。
2. 支持业务层自行拼 prompt，也支持 daemon 根据数据库历史拼 prompt。
3. 不把 RPA、报告生成、设计生成等业务 prompt 策略写死进 daemon core。
4. 保留现有 `/api/runs` 兼容行为，旧客户端不需要立刻迁移。
5. 为 AskQuestion / `<question-form>` 这类多轮确认流程提供可靠的后端会话基础。
6. 记录每次 run 实际执行用的 prompt snapshot，用于审计、debug 和问题复现。

## 非目标

- 不在 daemon core 中实现 RPA DSL、Playwright 脚本编译或页面探测逻辑。
- 不要求 daemon 对所有业务历史做智能摘要；摘要能力可以作为后续增强。
- 不把前端 UI 表单状态持久化成 daemon 的特殊模型；表单回答以普通 user message 进入 conversation。
- 不改变第一版本的安全边界；目录隔离仍然不是强沙箱。

## Prompt 模式

### 模式 A：Business-Composed

业务层拼好最终 prompt，daemon 只负责执行和记录。

适用场景：

- RPA codegen 上传后加固。
- RPA 自然语言生成。
- 需要业务层强编排上下文的流程。
- 需要把 DSL、录制脚本、页面探测摘要、变量确认结果按业务规则组合的任务。

请求形态示例：

```json
{
  "profileId": "rpa-local",
  "workspaceId": "ws_xxx",
  "conversationId": "conv_xxx",
  "kind": "generate",
  "skillId": "playwright-rpa-harden",
  "promptMode": "business-composed",
  "currentPrompt": "请根据上传的 codegen 脚本完成加固",
  "composedPrompt": "## Task\n...\n\n## Uploaded recording\n...\n\n## Confirmed params\n...",
  "metadata": {
    "business": "rpa",
    "stage": "codegen_harden"
  }
}
```

daemon 行为：

- 将 `currentPrompt` 写入当前 conversation 的 user message。
- 使用 `composedPrompt` 作为本轮 Claude Code 的实际输入。
- 将 `composedPrompt` 保存为 prompt snapshot。
- 执行 skill 注入、workspace 准备、run 状态持久化和 SSE 输出。
- 做最大长度、profile 权限、skill 权限、路径和 CLI 调用方式检查。

### 模式 B：Daemon-Composed

前端只传本轮用户输入和上下文策略，daemon 从数据库读取历史消息并拼接 prompt。

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
- 读取该 conversation 的最近消息、必要 run metadata 和 warning 输入。
- 按 `contextPolicy` 拼接 prompt。
- 保存实际 prompt snapshot。
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

- 如果没有 `conversationId`，daemon 创建新 conversation。
- 如果没有 `promptMode`，按当前行为把 `prompt` 当作本轮用户请求。
- 第一阶段可以让 `prompt` 同时承担 `currentPrompt` 和实际输入，避免破坏现有 API。

## 职责边界

### 业务层负责

- 决定本轮采用 `business-composed` 还是 `daemon-composed`。
- 在 `business-composed` 模式下生成最终 `composedPrompt`。
- 决定哪些业务上下文进入 prompt，例如 RPA DSL、录制脚本、变量确认结果、页面探测摘要。
- 控制业务级截断策略和业务级 warning。
- 渲染 AskQuestion / `<question-form>`，并把用户回答作为下一轮普通 user message 提交。

### daemon 负责

- 创建和复用 conversation。
- 保存 user message、assistant message、run 与 conversation 的关系。
- 保存 prompt snapshot 和 run metadata。
- 校验 workspace/profile/client/skill 权限。
- 在 `daemon-composed` 模式下按通用策略拼接 prompt。
- 对任意模式执行通用 prompt 兜底：
  - 最大总字符数或字节数限制。
  - 单条消息最大长度默认值。
  - 过大 tool result 的 warning。
  - CLI stdin/argv/Windows 命令行长度保护。
- 提供历史查询和 run 查询 API，方便业务层自己做 context 编排。

## API 扩展

`POST /api/runs` 扩展字段：

```ts
type PromptMode = 'legacy' | 'business-composed' | 'daemon-composed';

interface CreateRunRequest {
  profileId: string;
  workspaceId: string;
  kind: 'generate' | 'revise';
  prompt?: string;
  currentPrompt?: string;
  conversationId?: string;
  promptMode?: PromptMode;
  composedPrompt?: string;
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

校验规则：

- `business-composed` 必须提供 `currentPrompt` 和 `composedPrompt`。
- `daemon-composed` 必须提供 `currentPrompt`，不能提供 `composedPrompt`。
- `legacy` 可以继续使用 `prompt`。
- `conversationId` 如存在，必须属于同一 workspace。
- `skillId` 仍需通过 profile allowlist 校验。
- 为支持多轮 skill 会话，`kind=revise` 后续应允许显式 `skillId`，或从 conversation 默认 skill 继承。MVP 更推荐显式传 `skillId`，行为清晰且不需要新增复杂继承规则。

## 数据模型扩展

当前已有：

- `runs.prompt`
- `runs.metadata_json`
- `run_messages.conversation_id`
- `run_messages.content`
- `run_messages.events_json`

建议最小扩展：

- `runs.prompt_mode TEXT`
- `runs.current_prompt TEXT`
- `runs.prompt_snapshot TEXT`
- `runs.context_policy_json TEXT`
- `run_messages.prompt_snapshot TEXT` 可选；若只在 run 级别审计，第一阶段可不加。

第一阶段可以先复用 `runs.prompt` 保存实际执行 prompt，以 `runs.metadata_json` 存 `promptMode/currentPrompt/contextPolicy`，减少迁移面。但长期应拆出明确字段，避免 `prompt` 同时表示“用户本轮输入”和“最终执行输入”。

## Prompt 体积控制

体积控制分两层：

### 业务层策略

业务层可以自由决定：

- 是否包含完整历史。
- 包含最近几轮消息。
- 是否包含 DSL 原文还是摘要。
- 是否引用 workspace 文件而不是内联大内容。
- 对业务上下文采用什么截断规则。

RPA MVP 默认使用业务层策略，因为 RPA prompt 需要包含 codegen 脚本、DSL、变量确认结果、页面探测结果和当前阶段目标。

### daemon 兜底策略

daemon 不替业务层做业务判断，但必须防止不可执行的 prompt 进入 runner：

- `maxTotalChars` 默认可先设为 `80_000`。
- `maxMessageChars` 默认沿用 lanceDesign 经验值 `12_000`。
- 超过硬限制时返回结构化错误，例如 `PROMPT_TOO_LARGE`。
- 如果历史 run 中存在超大 tool result 或超高 input tokens，daemon 在 `daemon-composed` 模式下注入通用 warning。
- 如果 future adapter 使用 argv 传 prompt，保留 `AGENT_PROMPT_TOO_LARGE` 类保护；当前 Claude Code stdin 模式仍应测试确认 prompt 不进入 argv。

## AskQuestion / 表单续聊流程

业务 skill 可以输出 AskQuestion 或等价 `<question-form>` JSON。

流程：

1. daemon 启动 run。
2. Claude Code 输出 `<question-form>`。
3. daemon 将输出流式返回，并保存 assistant message。
4. RPA Web 渲染表单。
5. 用户提交表单后，RPA Web 创建下一次 run：
   - 同一个 `conversationId`。
   - `currentPrompt` 为格式化后的表单回答。
   - RPA MVP 使用 `business-composed` 重新拼本轮 prompt。
6. daemon 将表单回答作为普通 user message 保存。

daemon 不需要理解表单结构，也不需要维护表单 UI 状态。

## 实现阶段

### Phase 1：conversationId 复用与 message 关联

- `POST /api/runs` 接受可选 `conversationId`。
- 如果缺省则创建新 conversation。
- 如果传入则校验 workspace 归属并复用。
- 响应返回 `conversationId/userMessageId/assistantMessageId`。
- 每次 run 创建时插入 user message 和 assistant placeholder。

### Phase 2：Business-Composed 模式

- 新增 `promptMode=business-composed`。
- 接受 `currentPrompt` 和 `composedPrompt`。
- `currentPrompt` 写入 user message。
- `composedPrompt` 作为实际执行 prompt 和 prompt snapshot。
- RPA MVP 优先接入该模式。

### Phase 3：Daemon-Composed 模式

- 新增 `contextPolicy`。
- daemon 从 `run_messages` 读取最近历史。
- 实现默认 transcript builder：
  - 最近 N 条消息。
  - 单条消息截断。
  - 总长度限制。
  - 通用 context warning。
- 保存 prompt snapshot。

### Phase 4：Prompt Snapshot 与查询能力完善

- 明确 `runs.prompt_snapshot` 或等价字段。
- 在 run 详情 API 中按权限返回 prompt snapshot 摘要或完整内容。
- 增加 conversation 查询 API，供业务层读取历史并自行拼 prompt。

## RPA MVP 的采用方式

RPA MVP 默认使用 `business-composed`：

- RPA Web/BFF 负责把 codegen 脚本、DSL、用户确认变量、页面探测摘要和最近交互组织成 prompt。
- daemon 负责保存 conversation、运行 Claude Code、保存 prompt snapshot、返回 SSE。
- 表单回答作为同一个 conversation 的下一条 user message。

这样既对齐 lanceDesign 的业务 prompt 自由度，又补齐 daemon 的通用原生会话能力。

## 风险与约束

- 如果业务层拼入过大内容，daemon 会拒绝执行，而不是悄悄截断导致模型行为不可预期。
- 如果多个业务共享 daemon，必须通过 profile/skill allowlist 控制 skill 使用范围。
- prompt snapshot 可能包含敏感业务数据，API 返回时需要受 profile 或配置控制。
- SQLite 对本地 B/S 场景足够；prompt 构造只发生在创建 run 时，不是每个 SSE token 都读写数据库。
- SaaS 化后可以复用相同 API 和 prompt 模式，但数据库和队列层需要替换或扩展。
