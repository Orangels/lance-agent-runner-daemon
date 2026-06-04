# 业务 Skill 观测与复盘能力设计

日期：2026-06-05

## 背景

业务 skill 在初稿阶段一定需要通过真实运行不断修正。只看最终产物，很难判断问题来自 prompt、skill 指令、side files、Claude Code 工具调用、输入材料、运行环境，还是业务系统本身。

因此需要一套通用的 skill 观测与复盘能力。它不只服务 RPA，也应服务后续所有业务 skill，例如报告生成、设计生成、数据处理、代码迁移、知识库整理等。

核心目标是：每次调试一个新业务 skill 时，都能导出足够材料，让开发者和 AI 助手复盘“当时 Claude Code 看到了什么、做了什么、产出了什么、哪里偏离预期”。

## 适用范围

通用部分适用于所有业务 skill：

- prompt snapshot。
- skill snapshot。
- side files manifest / hash。
- Claude Code run events / logs。
- artifact 清单。
- normal / debug / review 三档采集模式。
- review bundle 基础结构。
- `review-summary.md`、`diagnostics.json`、`large-files-manifest.json`。
- 权限、脱敏、大小上限和保留策略。

业务专属部分不放在 daemon core 中。每个业务可以在通用 review bundle 之上增加扩展目录和诊断规则，例如 RPA 增加 execution、截图、trace、DSL 诊断；报告生成可以增加 docx 渲染截图、格式检查、引用校验等。

## 非目标

- 不把 debug 观测能力作为生产默认日志。
- 不无脑永久保存每个 Claude Code chunk、tool result、截图、trace 或大文件。
- 不要求 daemon 理解某个业务 skill 的语义。
- 不在通用 daemon core 中写入 RPA、报告、设计等专属诊断逻辑。

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

这些能力足够做基本排查，但还不足以稳定支撑业务 skill 迭代。

## 通用缺口

### 1. 缺最终 prompt snapshot

当前 `runs.prompt` 保存的是请求里的用户 prompt。对于 `kind=generate`，真正传给 Claude Code 的 prompt 会在运行时拼上 skill 信息、staged skill root 提示和完整 `SKILL.md` body。

需要补齐：

- 保存 `prompt_snapshot`，即本次实际写入 Claude Code stdin 的最终 prompt。
- 保存 `currentPrompt` / 用户原始请求。
- 保存 `promptMode`，兼容后续 `business-composed` 和 `daemon-composed`。
- 保存 prompt 字符数、字节数、是否被截断或拒绝。

### 2. 缺 skill snapshot

只保存 `skillId` 不够。skill 会频繁修改，同一个 `skillId` 在不同时间可能对应不同内容。

需要补齐：

- 保存本次 run 使用的 skill snapshot：
  - `skillId`
  - skill name / description
  - `SKILL.md` content hash
  - `SKILL.md` body snapshot 或可下载副本
  - side files 清单、hash、相对路径
- staged skill root 路径可以保留在内部 debug 信息中，但 API 响应不能暴露不可控绝对路径。

### 3. 缺完整日志下载

当前 `/api/runs/:runId/logs` 只返回每个 log 文件末尾 16KiB。长流程中，关键工具调用、工具结果、错误上下文可能已经被 tail 截掉。

需要补齐：

- 支持完整下载 `stdout.log`、`stderr.log`、`debug-events.ndjson`。
- 或提供打包的 run review bundle。
- 保留权限控制：只有具备 `canReadLogs` / `canReadDebugEvents` 的 client 能读取完整 debug 内容。
- 保持脱敏策略：token、配置目录、敏感路径、密钥类字段不能直接暴露。

### 4. 缺结构化反馈记录

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

业务可以扩展自己的分类。

## 采集模式与体积控制

这些能力不是 daemon 的生产默认日志，而是为调试新业务、新 skill、新流程时打开的观测能力。生产执行默认应保持轻量，避免长期保存大量 tool result、截图、trace、录像和完整 prompt。

推荐分三档。

### normal：生产轻量模式

默认模式，适合日常执行和已稳定流程。

保存：

- run 状态、开始/结束时间、错误码。
- assistant 最终文本摘要。
- usage 摘要。
- artifact 列表和必需产物。
- 业务扩展提供的最终状态摘要。

不默认保存：

- 完整 `debug-events.ndjson`。
- 大型 `tool_result`。
- 业务大文件、截图、trace、video。
- 完整 review bundle。

### debug：业务/skill 调试模式

用于开发新业务流程、调试新 skill、定位生成失败原因。

额外保存：

- prompt snapshot 和 skill snapshot。
- 完整 stdout/stderr/debug-events，受大小上限约束。
- artifact/schema 校验错误。
- 业务扩展诊断数据。
- 用户反馈。

debug 模式仍然要限制体积：

- 单个 run log 有最大字节数。
- 单个 tool result 超限后保存摘要、hash、前后片段，不直接全文塞入 review 摘要。
- 大文件放入 raw/logs/artifacts 目录，由 manifest 引用。
- review 摘要中只放结论和必要片段。

### review：显式复盘包模式

用于把一次或一组 run 导出给开发者或 AI 助手复盘。

特点：

- 不自动生成，必须用户显式点击导出。
- 可选择是否包含业务扩展大文件。
- 默认生成两层内容：
  - `review-summary.md` / `diagnostics.json`：优先给 AI 读取，控制 token 体积。
  - `raw/`、`logs/`、`artifacts/`：完整材料，只有需要时再查。
- bundle 总大小必须有限额，例如本地默认 100MB 起步，可配置。

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
- Claude Code 产出了哪些 artifact。
- 哪些 artifact 缺失或 schema 不合格。
- 是否出现明显 tool-use / context / prompt 问题。
- 最可能需要修改 skill 的点是什么。
- 建议下一步查看哪些原始文件。

## 推荐新增通用能力

### 1. Prompt / Skill Snapshot

在 daemon 侧新增 run 级快照字段或等价持久化：

```text
runs.prompt_mode
runs.current_prompt
runs.prompt_snapshot
runs.prompt_snapshot_hash
runs.skill_snapshot_json
runs.context_policy_json
```

如果不想立刻改 schema，第一阶段可以把这些写入受控 artifact 或 metadata，但长期应有明确字段，避免 `runs.prompt` 同时表示“用户请求”和“最终执行 prompt”。

### 2. 完整 Run Logs 下载

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

### 3. 通用 Run Review Bundle

通用 review bundle 建议包含：

```text
business-skill-review-bundle.zip
+-- manifest.json
+-- request.json
+-- prompt-snapshot.md
+-- skill/
|   +-- SKILL.md
|   +-- side-files-manifest.json
+-- logs/
|   +-- stdout.log
|   +-- stderr.log
|   +-- debug-events.ndjson
+-- messages.json
+-- artifacts/
+-- diagnostics.json
+-- review-summary.md
+-- large-files-manifest.json
+-- feedback.jsonl
+-- extensions/
```

`manifest.json` 至少包含：

```json
{
  "schemaVersion": "1.0",
  "runId": "run_123",
  "conversationId": "conv_123",
  "workspaceId": "ws_123",
  "profileId": "business-profile",
  "kind": "generate",
  "skillId": "business-skill",
  "model": "...",
  "startedAt": "2026-06-05T10:00:00+08:00",
  "finishedAt": "2026-06-05T10:02:00+08:00",
  "status": "failed",
  "promptSnapshotHash": "sha256:...",
  "skillSnapshotHash": "sha256:...",
  "extensions": ["rpa"],
  "redaction": {
    "applied": true,
    "notes": ["paths and token-like values redacted"]
  }
}
```

### 4. 业务扩展机制

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

## 权限和安全

这些观测数据可能包含业务内容、用户输入、下载文件、工具结果和 prompt，必须按敏感数据处理。

原则：

- 默认只在本地保存，不自动上传。
- review bundle 需要用户显式导出。
- bundle 导出前提供脱敏选项。
- 默认不包含账号密码、token、cookie、私钥、`storage_state` 等敏感配置。
- prompt snapshot 可能包含业务上下文，应受 `canReadLogs` 或更高权限控制。
- `debug-events.ndjson` 中的 `tool_result` 只能给调试授权用户读取。
- API 响应不暴露 sandbox 绝对路径。

## 通用 MVP 优先级

### 必须补齐

1. `prompt_snapshot` / composed prompt 持久化。
2. skill snapshot 或至少 skill content hash + side files manifest。
3. 完整 run logs 下载或 review bundle 下载。
4. `review-summary.md` / `diagnostics.json` 的基础格式。
5. normal/debug/review 三档采集模式。

### 可以随后增强

1. 用户反馈结构化表单。
2. bundle 脱敏预览 UI。
3. 独立 `run_events` 表或长期事件归档。
4. 多 run 的横向对比报告。
5. 业务扩展诊断插件化。

## 使用方式

后续每次测试业务 skill 后，应能导出 review bundle。优化 skill 时，按这个顺序查看：

1. `review-summary.md`：先看摘要和建议。
2. `prompt-snapshot.md`：确认 Claude Code 收到的任务和 skill 约束是否正确。
3. `skill/SKILL.md` 和 side files manifest：确认当次 skill 版本。
4. `diagnostics.json`：查看机器诊断结论。
5. `logs/debug-events.ndjson`：按需查看工具调用和工具结果。
6. `artifacts/`：检查最终产物。
7. `extensions/`：查看业务专属复盘材料。
8. 再修改 `SKILL.md`、references 或 templates。
