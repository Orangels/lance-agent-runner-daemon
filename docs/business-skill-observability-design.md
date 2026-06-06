# 业务 Skill 观测与复盘能力设计

日期：2026-06-05

## 背景

业务 skill 在初稿阶段一定需要通过真实运行不断修正。只看最终产物，很难判断问题来自用户输入、业务上下文、daemon 组装的最终 prompt、skill 指令、side files、Claude Code 工具调用、运行环境，还是业务系统本身。

因此需要一套通用的 skill 观测与复盘能力。它不只服务 RPA，也应服务后续所有业务 skill，例如报告生成、设计生成、数据处理、代码迁移、知识库整理等。

核心目标是：每次调试一个新业务 skill 时，都能导出足够材料，让开发者和 AI 助手复盘“当时业务层提供了什么上下文、daemon 最终发给 Claude Code 什么 prompt、Claude Code 做了什么、产出了什么、哪里偏离预期”。

## 基本边界

通用 daemon 不理解具体业务语义。它只负责 Claude Code agent runner 的通用能力：会话、prompt 组装、skill 注入、运行、日志、快照、artifact 扫描、权限和复盘包。

业务层不需要、也不应该知道 skill 的具体内容。业务层可以传入 `skillId`、当前用户输入、业务上下文、输入文件引用和用户确认结果；daemon 在每次 run 启动前统一注入 `SKILL.md`、side files 路径，以及 profile 中 daemon 明确持有的运行约束，并生成最终 prompt。daemon 不维护 Claude Code tools/MCP 注册表，MVP 不额外注入 tools/MCP 能力说明。

数据库中的 conversation / message 只保存用户和 assistant 可见的对话内容。完整内部 prompt 不进入普通会话历史；其 hash/大小信息作为 run 级审计锚点保存，全文是否持久化由 `collectionMode` 决定。

## 适用范围

通用部分适用于所有业务 skill：

- prompt snapshot。
- skill snapshot。
- profile snapshot。
- side files manifest / hash。
- Claude Code run events / logs。
- artifact 清单。
- `collectionMode = lite | diagnostic | review` 三档采集模式。
- review bundle 基础结构。
- `review-summary.md`、`diagnostics.json`、`large-files-manifest.json`。
- 权限、脱敏、大小上限和保留策略。

业务专属部分不放在 daemon core 中。每个业务可以在通用 review bundle 之上增加扩展目录和诊断规则，例如 RPA 增加 execution、截图、trace、DSL 诊断；报告生成可以增加 docx 渲染截图、格式检查、引用校验等。

## 非目标

- 不把 debug 观测能力作为生产默认日志。
- 不无脑永久保存每个 Claude Code chunk、tool result、截图、trace 或大文件。
- 不要求 daemon 理解某个业务 skill 的语义。
- 不在通用 daemon core 中写入 RPA、报告、设计等专属诊断逻辑。
- 不允许业务层绕过 daemon 的 skill 注入和权限校验，直接提交最终 Claude Code prompt。

## 当前已有能力

daemon 当前已经具备以下基础能力：

- `run_messages.events_json` 持久化 assistant 文本、thinking、`tool_use`、usage、artifact、error、end 等结构化事件。
- `GET /api/runs/:runId` 可以在 run 结束后读取持久化的 messages 和 events。
- `GET /api/runs/:runId/logs` 可以读取受控 run logs 摘要。
- 每个 run 本地会写：
  - `stdout.log`
  - `stderr.log`
  - `debug-events.ndjson`
- `debug-events.ndjson` 会记录解析后的 Claude Code RunEvent，包括对外过滤掉的 `tool_result`。
- artifact scanner 能保存生成产物。
- event visibility 已有 `quiet / normal / debug` 分级。
- 已有 `profile_snapshots`，可作为 review bundle 的 profile 快照来源。

这些能力足够做基本排查，但还不足以稳定支撑业务 skill 迭代。

## 通用缺口

### 1. 缺最终 prompt snapshot

当前 `runs.prompt` 保存的是请求里的用户 prompt。真正传给 Claude Code 的 prompt 会在运行时拼上 skill instructions、staged side files、profile 运行约束和业务上下文。

需要补齐：

- 保持 `runs.prompt` 的“用户请求 / legacy prompt”语义，不把最终内部 prompt 写进去。
- 保存 `current_prompt`，表示本轮用户输入；legacy 模式可由 `prompt` 派生。
- 保存 `business_context_hash`，业务上下文原文放入独立 `run_context_snapshots`，daemon 不解释具体业务语义。
- 所有 collectionMode 都保存 `prompt_snapshot_hash`、字符数、字节数、是否持久化、是否截断或拒绝。
- `lite` 默认不保存 `prompt_snapshot` 全文；`diagnostic/review` 保存全文。
- prompt snapshot 全文放入独立 `run_prompt_snapshots`，不要挂在 `runs` 高频表上。
- 保存 `prompt_mode`，当前建议为 `legacy | business-context | daemon-composed`。

### 2. 缺 skill snapshot

只保存 `skillId` 不够。skill 会频繁修改，同一个 `skillId` 在不同时间可能对应不同内容。

需要补齐：

- 保存本次 run 使用的 skill snapshot：
  - `skillId`
  - skill name / description
  - `SKILL.md` content hash
  - side files 清单、hash、相对路径、大小
- `SKILL.md` body 和大 side files 内容不要放入 `runs` 表。
- `lite` 默认只保存 hash + metadata + side files manifest。
- `diagnostic/review` 可保存 `SKILL.md` body snapshot 或可下载副本。
- side files manifest 应在 skill staging 时生成，路径使用 workspace-relative 或 bundle-relative 路径。
- staged skill root 绝对路径可以保留在内部 debug 信息中，但 API 响应和 bundle 默认不暴露 sandbox 绝对路径。
- 大 side files 默认只进入 manifest；是否把内容打入 bundle 由显式导出选项控制。

### 3. 缺 profile snapshot

run 执行时的 profile 决定可用 skill、artifact rules、权限模式、环境策略和工具配置。如果只保存 `profileId`，复盘时无法确认当时 profile 是否已改变。

需要补齐：

- review bundle 中包含 `profile-snapshot.json`。
- 复用现有 `profile_snapshots`，避免重复设计一套 profile 快照机制。
- manifest 中记录 `profileSnapshotHash` 或对应 snapshot id。

### 4. 缺完整日志下载

当前 `/api/runs/:runId/logs` 只返回每个 log 文件末尾 16KiB。长流程中，关键工具调用、工具结果、错误上下文可能已经被 tail 截掉。

需要补齐：

- 支持完整下载 `stdout.log`、`stderr.log`。
- 支持完整下载 `debug-events.ndjson`，但权限必须高于普通日志。
- 或提供打包的 run review bundle。
- 权限边界：
  - `stdout.log` / `stderr.log` 完整下载需要 `canReadLogs`。
  - `debug-events.ndjson` 或包含未过滤 `tool_result` 的 bundle 内容需要 `canReadDebugEvents`。
- 保持脱敏策略：token、配置目录、敏感路径、密钥类字段不能直接暴露。

### 5. 缺结构化反馈记录

真实测试后，用户反馈如果只留在聊天里，很难批量回看和反推 skill 修改点。

通用反馈字段建议：

```json
{
  "severity": "major",
  "category": "skill",
  "message": "这里应该先询问用户参数，而不是直接写死",
  "runId": "run_123",
  "artifactPath": "output/result.json"
}
```

通用 `category` 可以先支持：

```text
prompt | skill | side-files | artifact | schema | tool-use | missing-context | user-feedback | ux | other
```

业务可以扩展自己的分类。daemon 只保存反馈，不解释业务分类含义。写入反馈需要鉴权，并校验调用方有权访问对应 workspace/run。

## 采集模式与事件可见性

采集模式和事件可见性是两件事，不能混在一起。

- `collectionMode`：决定 daemon 在本地保存多少调试材料。
- `eventVisibility`：决定 SSE/API 对调用方暴露多少实时事件。

建议保留既有 `eventVisibility = quiet | normal | debug`，另增独立的 `collectionMode = lite | diagnostic | review`。

`collectionMode` 控制的是本地是否落盘敏感调试材料，因此也必须受 profile 和 client 权限封顶：

- profile 配置 `maxCollectionMode`，默认 `lite`。
- `lite` 对所有有 run 权限的 client 可用。
- `diagnostic` 需要 profile 上限允许，且 client 具备 `canReadLogs`。
- `review` 需要 profile 上限允许，且 client 同时具备 `canReadLogs` 和 `canReadDebugEvents`。
- 请求超过允许档位时，MVP 返回结构化错误，例如 `COLLECTION_MODE_NOT_ALLOWED`；不做静默降级。

持久化矩阵：

| 材料 | lite | diagnostic | review |
| --- | --- | --- | --- |
| `runs.prompt_snapshot_hash` / size | 保存 | 保存 | 保存 |
| `run_prompt_snapshots.prompt_snapshot` 全文 | 不默认保存 | 保存 | 保存 |
| skill hash / side files manifest | 保存 | 保存 | 保存 |
| `SKILL.md` body snapshot | 不默认保存 | 保存 | 保存 |
| `businessContext` 原文 | 可按大小保存或只存 hash | 保存 | 保存 |
| stdout/stderr 完整日志 | 不默认长期保存 | 保存，受上限 | 保存，受上限 |
| `debug-events.ndjson` / tool result | 不默认保存 | 保存，需权限 | 保存，需权限 |
| review bundle | 不生成 | 可手动导出 | 显式生成 |

### collectionMode: lite

生产轻量模式，适合日常执行和已稳定流程。

保存：

- run 状态、开始/结束时间、错误码。
- assistant 最终文本摘要。
- usage 摘要。
- artifact 列表和必需产物。
- `prompt_snapshot_hash`、字符数、字节数、是否持久化。
- skill hash、side files manifest、profile snapshot 引用。
- 业务扩展提供的最终状态摘要。

不默认保存：

- `prompt_snapshot` 全文。
- `SKILL.md` body snapshot。
- 完整 `debug-events.ndjson` 长期归档。
- 大型 `tool_result`。
- 业务大文件、截图、trace、video。
- 完整 review bundle。

### collectionMode: diagnostic

用于开发新业务流程、调试新 skill、定位生成失败原因。

额外保存：

- prompt snapshot 全文。
- skill snapshot 全文或可下载副本。
- businessContext 原文和渲染 hash。
- profile snapshot 引用。
- 完整 stdout/stderr/debug-events，受大小上限约束。
- artifact/schema 校验错误。
- 业务扩展诊断数据。
- 用户反馈。

diagnostic 模式仍然要限制体积：

- 单个 run log 有最大字节数，优先复用 `server.maxLogBytesPerRun`。
- 单个 tool result 超限后保存摘要、hash、前后片段，不直接全文塞入 review 摘要。
- 大文件放入 raw/logs/artifacts 目录，由 manifest 引用。
- review 摘要中只放结论和必要片段。

### collectionMode: review

用于把一次或一组 run 导出给开发者或 AI 助手复盘。

特点：

- 不建议每次生产运行自动打开，必须由用户或调试配置显式启用。
- 可选择是否包含业务扩展大文件。
- 默认生成两层内容：
  - `review-summary.md` / `diagnostics.json`：优先给 AI 读取，控制 token 体积。
  - `raw/`、`logs/`、`artifacts/`：完整材料，只有需要时再查。
- bundle 总大小必须有限额，例如本地默认 100MB 起步，可配置为 `server.maxReviewBundleBytes`。
- bundle 保留周期单独配置，例如 `server.reviewBundleRetentionMs`。

## AI 复盘友好原则

这些材料最终是给开发者和 AI 用来优化 skill 的，不是越多越好。必须优先让 AI 先读摘要，再按需展开原始材料。

review bundle 应包含：

- `review-summary.md`：人类/AI 优先阅读的短摘要，建议控制在 5k 到 15k 字符。
- `diagnostics.json`：机器可读诊断结论。
- `large-files-manifest.json`：列出未内联的大文件、大小、hash、用途。
- 原始日志和 artifacts 放在独立目录，不直接拼进摘要。

`review-summary.md` 应优先回答：

- 本次任务目标是什么。
- 使用了哪个 skill 和 skill hash。
- daemon 最终 prompt 是否包含预期的 skill instructions、side files 路径、profile 运行约束和 business context。
- Claude Code 产出了哪些 artifact。
- 哪些 artifact 缺失或 schema 不合格。
- 是否出现明显 tool-use / context / prompt 问题。
- 最可能需要修改 skill 的点是什么。
- 建议下一步查看哪些原始文件。

## 推荐新增通用能力

### 1. Run 级轻字段

`runs` 是列表和状态轮询的高频表，不应直接挂载完整 prompt 或完整 skill body。建议只新增轻量字段：

```text
runs.prompt_mode
runs.current_prompt
runs.collection_mode
runs.context_policy_json
runs.prompt_snapshot_hash
runs.prompt_snapshot_char_count
runs.prompt_snapshot_byte_count
runs.prompt_snapshot_persisted
runs.business_context_hash
```

`runs.prompt` 继续保持“用户请求 / legacy prompt”语义。长期应使用明确字段，而不是让 `runs.prompt` 同时表示“用户请求”和“最终执行 prompt”。

### 2. 独立快照表

完整或半完整快照放入独立表，对齐现有 `profile_snapshots` 模式：

```text
run_prompt_snapshots
  run_id TEXT PRIMARY KEY
  prompt_snapshot TEXT
  prompt_snapshot_hash TEXT NOT NULL
  char_count INTEGER NOT NULL
  byte_count INTEGER NOT NULL
  collection_mode TEXT NOT NULL
  created_at INTEGER NOT NULL

run_skill_snapshots
  run_id TEXT PRIMARY KEY
  skill_id TEXT NOT NULL
  skill_snapshot_hash TEXT NOT NULL
  skill_snapshot_json TEXT
  side_files_manifest_json TEXT
  created_at INTEGER NOT NULL

run_context_snapshots
  run_id TEXT PRIMARY KEY
  business_context_json TEXT
  business_context_hash TEXT
  rendered_context_hash TEXT
  created_at INTEGER NOT NULL
```

存储策略由 `collectionMode` 决定：`lite` 保存 hash/size/manifest，`diagnostic/review` 保存全文或可下载副本。

### 3. API / DB 命名对照

| API 字段 | DB 字段/表 | 说明 |
| --- | --- | --- |
| `promptMode` | `runs.prompt_mode` | `legacy | business-context | daemon-composed` |
| `currentPrompt` | `runs.current_prompt` | 本轮用户输入 |
| `businessContext` | `run_context_snapshots.business_context_json` | 业务上下文，daemon 不解释业务语义 |
| `contextPolicy` | `runs.context_policy_json` | daemon-composed 的历史读取策略 |
| `collectionMode` | `runs.collection_mode` | `lite | diagnostic | review` |
| n/a | `runs.prompt_snapshot_hash` | 所有模式都保存的审计锚点 |
| n/a | `run_prompt_snapshots.prompt_snapshot` | 按 collectionMode 保存的最终 prompt 全文 |
| n/a | `run_skill_snapshots.skill_snapshot_json` | 按 collectionMode 保存的 skill 快照 |

### 4. 完整 Run Logs 下载

新增 run logs 下载接口，或扩展现有 logs API：

```text
GET /api/runs/:runId/logs/stdout/download
GET /api/runs/:runId/logs/stderr/download
GET /api/runs/:runId/logs/debug-events/download
```

也可以先实现 bundle：

```text
GET /api/runs/:runId/review-bundle/download
```

权限建议：

- `stdout/stderr` 完整下载：`canReadLogs`。
- `debug-events` 完整下载：`canReadDebugEvents`。
- review bundle：根据内容动态要求权限；只要包含未过滤 tool results 或 raw debug events，就要求 `canReadDebugEvents`。

### 5. 通用 Run Review Bundle

通用 review bundle 建议包含：

```text
business-skill-review-bundle.zip
+-- manifest.json
+-- request.json
+-- prompt-snapshot.md
+-- profile-snapshot.json
+-- skill/
|   +-- SKILL.md
|   +-- side-files-manifest.json
+-- logs/
|   +-- stdout.log
|   +-- stderr.log
|   +-- debug-events.ndjson
+-- messages.filtered.json
+-- messages.debug.json
+-- artifacts/
+-- diagnostics.json
+-- review-summary.md
+-- large-files-manifest.json
+-- feedback.jsonl
+-- extensions/
```

`messages.filtered.json` 只包含普通 run detail 可以暴露的 user/assistant 可见内容和受控事件。`messages.debug.json` 或未过滤 `debug-events.ndjson` 只有在调用方具备 `canReadDebugEvents` 时才生成或导出。

`manifest.json` 至少包含：

```json
{
  "schemaVersion": "1.0",
  "runId": "run_123",
  "conversationId": "conv_123",
  "workspaceId": "ws_123",
  "profileId": "business-profile",
  "profileSnapshotHash": "sha256:...",
  "kind": "generate",
  "skillId": "business-skill",
  "model": "...",
  "startedAt": "2026-06-05T10:00:00+08:00",
  "finishedAt": "2026-06-05T10:02:00+08:00",
  "status": "failed",
  "promptSnapshotHash": "sha256:...",
  "promptSnapshotPersisted": true,
  "skillSnapshotHash": "sha256:...",
  "collectionMode": "review",
  "eventVisibility": "debug",
  "extensions": ["rpa"],
  "redaction": {
    "applied": true,
    "notes": ["paths and token-like values redacted"]
  }
}
```

manifest 采用 schemaVersion 管理，后续字段只做 additive 扩展；不要随意删除或重命名已有字段。

### 6. 业务扩展机制

通用 bundle 预留 `extensions/` 目录。每个业务按需添加自己的扩展内容，不进入 daemon core。

示例：

```text
extensions/
+-- rpa/
+-- report-docx/
+-- design-page/
```

每个扩展目录应包含自己的 `extension-manifest.json`，说明：

- 扩展名称。
- 关联 run/execution/artifact。
- 主要文件列表。
- 大文件清单。
- 安全和脱敏说明。

`manifest.json` 中的 `extensions` 必须与实际目录一致。daemon 只校验目录和 manifest 基本存在，不理解扩展内部业务语义。

### 7. 脱敏流水线

review bundle 导出前应走统一脱敏流水线，覆盖：

- `prompt-snapshot.md`
- `request.json`
- `messages.filtered.json` / `messages.debug.json`
- `logs/*.log` / `debug-events.ndjson`
- `manifest.json`
- `diagnostics.json`
- 可文本化的 artifact manifest

脱敏目标至少包括：

- token-like values。
- cookie、secret、password、private key。
- sandbox 绝对路径和本机用户目录。
- `storage_state`、账号密码等敏感配置。

业务扩展可以追加业务专属脱敏规则，但通用 daemon 不理解业务语义。

## 权限和安全

这些观测数据可能包含业务内容、用户输入、下载文件、工具结果和 prompt，必须按敏感数据处理。

原则：

- 默认只在本地保存，不自动上传。
- review bundle 需要用户显式导出，或在明确调试配置下生成。
- bundle 导出前提供脱敏选项。
- 默认不包含账号密码、token、cookie、私钥、`storage_state` 等敏感配置。
- prompt snapshot 可能包含业务上下文，应至少受 `canReadLogs` 控制。
- `debug-events.ndjson` 中的 `tool_result` 只能给具备 `canReadDebugEvents` 的调试授权用户读取。
- API 响应不暴露 sandbox 绝对路径。
- 日志和 bundle 保留周期可配置，生产默认应短于业务数据保留周期。

## 通用 MVP 优先级

### 必须补齐

1. `runs.prompt` 保持用户请求语义；非 legacy 模式下 `runs.prompt = currentPrompt`，最终 prompt 只进 snapshot。
2. `kind × promptMode × skillId` 合法性矩阵落入 validation，明确 `revise + skillId` 是有意变更。
3. prompt/skill/context 大快照使用独立表。
4. 所有 run 保存 prompt snapshot hash/size；全文按 `collectionMode` 持久化。
5. `business-context` / `daemon-composed` 两种非 legacy prompt 模式。
6. `businessContext` 固定渲染契约：确定性 JSON、文件只传 workspace-relative path、不内联。
7. skill snapshot 至少包含 skill content hash + side files manifest；body 按 `collectionMode` 保存。
8. profile snapshot 引用或 `profile-snapshot.json`。
9. `collectionMode = lite | diagnostic | review`，并与 `eventVisibility` 解耦且受 profile/client 权限封顶。
10. 完整 run logs 下载或 review bundle 下载，并落好 `canReadLogs` / `canReadDebugEvents` 权限边界。
11. `review-summary.md` / `diagnostics.json` 的基础格式。
12. review bundle 权限、大小上限、脱敏和保留周期。

### 可以随后增强

1. 用户反馈结构化表单和 `run_feedback` 表。
2. bundle 脱敏预览 UI。
3. 独立 `run_events` 表或长期事件归档。
4. 多 run 的横向对比报告。
5. 业务扩展诊断插件化。
6. businessContext 文件内容内联注入。
7. 多 run review bundle 的相同 skillSnapshotHash 去重。

## 使用方式

后续每次测试业务 skill 后，应能导出 review bundle。优化 skill 时，按这个顺序查看：

1. `review-summary.md`：先看摘要和建议。
2. `prompt-snapshot.md`：确认 Claude Code 收到的任务、skill 约束、profile 运行约束和业务上下文是否正确。
3. `skill/SKILL.md` 和 side files manifest：确认当次 skill 版本。
4. `profile-snapshot.json`：确认当次 profile、权限和 skill allowlist。
5. `diagnostics.json`：查看机器诊断结论。
6. `messages.filtered.json`：查看用户/assistant 可见对话。
7. `logs/debug-events.ndjson`：在具备权限时按需查看工具调用和工具结果。
8. `artifacts/`：检查最终产物。
9. `extensions/`：查看业务专属复盘材料。
10. 再修改 `SKILL.md`、references 或 templates。
