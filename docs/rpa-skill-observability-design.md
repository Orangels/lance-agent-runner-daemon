# RPA Skill 观测与复盘扩展设计

日期：2026-06-05

## 背景

本文件只描述 RPA 业务在通用 skill 观测能力之上的专属扩展。通用能力见：`docs/business-skill-observability-design.md`。

RPA 的特殊点是：Claude Code 生成/加固脚本只是第一段，后面还要用本地 executor 验证脚本。单看 daemon run 无法判断 skill 是否真的成功，必须把生成产物和 Playwright 执行结果关联起来。

当前目标 skill：

- `rpa-script-generate`
- `playwright-rpa-harden`

## RPA 专属目标

RPA 复盘需要回答这些业务问题：

- Claude Code 是否产出了符合 DSL v0.1 的 `flow.dsl.json`？
- 是否产出了必需 artifact：`flow.hardened.py`、`config.example.json`、`parameterization-report.md`、`hardening-report.md`？
- 参数化是否合理，是否把固定值泛化成运行参数？
- 选择器是否稳定，是否使用了脆弱 css/xpath？
- 每个关键步骤是否有等待和断言？
- 写操作是否有 `write`、`manual`、dry-run 和幂等保护？
- 脚本在 executor verify/run 时哪一步失败？
- 失败时截图、trace、执行日志是什么？
- 用户对步骤、参数、写操作风险的反馈是什么？

## 与通用能力的关系

通用 review bundle 负责：

- prompt snapshot。
- skill snapshot。
- Claude Code run logs。
- messages/events。
- 通用 artifacts。
- review summary。
- 权限、脱敏、大小限制。

RPA 扩展只追加：

- `daemonRunId` 与 `rpa executionId` 的关联。
- DSL 校验结果。
- RPA artifact 完整性校验。
- selector / wait / assert / write-risk 诊断。
- executor 执行记录。
- 每步事件、失败截图、trace、video。
- RPA 专属用户反馈。

## RPA 专属缺口

### 1. 缺 daemon run 与 RPA execution 的关联

需要明确区分两类 ID：

```text
daemon runId
  = Claude Code 生成/加固脚本的任务 ID

rpa executionId
  = 本地执行 flow.hardened.py 的任务 ID
```

同一个 `daemonRunId` 可能对应多次 execution，例如首次 verify、修复后复验、正式 run。

同一个 `flowId` 可能跨多个 `daemonRunId` 演进，例如首次生成、参数确认后重新生成、加固修复后再验证。RPA 复盘时应把 `flowId` 作为跨 run 的关联键，把 `daemonRunId` 作为某次 Claude Code 生成/加固任务，把 `executionId` 作为某次本地执行任务。

RPA Web 创建 execution 时必须记录：

- `daemonRunId`
- `flowId`
- `dslPath`
- `scriptPath`
- `configPath`
- `params` 的脱敏摘要
- `mode`: `verify | run`
- `headless`
- `dryRun`
- `stepConfirm`
- `highlight`
- `trace`
- `video`

### 2. 缺 DSL 和 artifact 诊断

RPA 需要在 review 时快速判断 Claude Code 产物是否符合约束。

需要保存或生成：

- `dsl-validation.json`
- `artifact-validation.json`
- `parameterization-diagnostics.json`
- `hardening-diagnostics.json`

重点检查：

- 必需 artifact 是否存在。
- `flow.dsl.json` 是否符合 DSL v0.1 schema。
- `params` 是否能驱动执行期参数表单。
- `steps[]` 是否都有稳定 `id/name/action`。
- 需要定位的 step 是否有 `target`。
- 写操作是否标记 `write`。
- 人工介入是否使用 `manual`。
- 关键步骤是否有 `wait` 和 `assert`。
- 是否存在 fragile selector。

### 3. 缺 executor 复盘材料

RPA 生成脚本是否可用，最终要看 executor 结果。

每个 execution 应按 `collectionMode` 保存或引用：

```text
execution.json
execution-log.jsonl
screenshots/*   # optional, controlled by collectionMode
trace.zip       # optional high-sensitive file
video.webm      # optional high-sensitive file
stdout.log
stderr.log
```

其中截图、trace、video、downloads 的落盘和导出策略以后文的 RPA 保存矩阵为准。

`execution.json` 示例：

```json
{
  "executionId": "exec_123",
  "daemonRunId": "run_123",
  "flowId": "case_query",
  "mode": "verify",
  "headless": false,
  "dryRun": true,
  "stepConfirm": true,
  "status": "failed",
  "failedStepId": "step_003",
  "error": {
    "code": "STEP_TARGET_NOT_FOUND",
    "message": "查询按钮不可见"
  },
  "artifacts": {
    "trace": "trace.zip",
    "log": "execution-log.jsonl"
  }
}
```

### 4. 缺 RPA 用户反馈结构化记录

RPA 用户反馈通常和步骤、参数、写操作风险有关。

RPA 专属反馈字段建议：

```json
{
  "severity": "major",
  "category": "selector",
  "daemonRunId": "run_123",
  "executionId": "exec_123",
  "stepId": "step_003",
  "artifactPath": "output/flow.dsl.json",
  "screenshotPath": "extensions/rpa/executions/exec_123/screenshots/step_003.png",
  "message": "这里应该点击查询按钮，但脚本点到了重置按钮"
}
```

RPA 专属 `category` 只追加 RPA 业务分类。通用的 `prompt`、`skill`、`artifact`、`ux` 等分类继续走通用反馈字段。

```text
dsl | selector | wait | assert | parameterization | write-risk | manual-step | executor
```

## RPA Review Bundle 扩展目录

RPA 内容放在通用 bundle 的 `extensions/rpa/` 下。通用顶层结构见 `docs/business-skill-observability-design.md`，本文件只定义 RPA 扩展子树，避免重复定义通用 bundle 结构。

推荐结构：

```text
extensions/
+-- rpa/
    +-- extension-manifest.json
    +-- rpa-summary.md
    +-- rpa-diagnostics.json
    +-- dsl-validation.json
    +-- artifact-validation.json
    +-- executions/
        +-- exec_123/
            +-- execution.json
            +-- execution-log.jsonl
            +-- screenshots/
            +-- trace.zip
            +-- video.webm
    +-- feedback.jsonl
```

`extension-manifest.json` 示例。`flowId` 即跨多个 `daemonRunId` 的复盘关联键：

```json
{
  "extension": "rpa",
  "schemaVersion": "1.0",
  "daemonRunId": "run_123",
  "flowId": "case_query",
  "dslPath": "artifacts/flow.dsl.json",
  "scriptPath": "artifacts/flow.hardened.py",
  "executionIds": ["exec_123"],
  "largeFiles": [
    {
      "path": "executions/exec_123/trace.zip",
      "kind": "trace",
      "sizeBytes": 10485760,
      "sha256": "..."
    }
  ]
}
```

### 后续 manifest 精细化事项

以下两项不阻塞 MVP 复盘闭环，但建议在自然语言生成闭环完成后、或第一次真实 skill 复盘前补齐：

1. `extension-manifest.json` 中的 `dslPath` / `scriptPath` 目前可以先作为逻辑约定路径使用。后续应从 daemon generic bundle 的实际 `manifest.json` / entries 中解析真实 artifact 路径，再写入 RPA manifest，避免 daemon artifact 布局变化时产生误导性引用。
2. `largeFiles` manifest 后续应覆盖所有 execution artifact。即使 `includeSensitiveFiles=true` 导致某些文件体被内联，也应写入一条 `largeFiles` 记录，并用 `included: true | false` 表示该文件是否已打包进入 bundle。这样 review bundle 的 manifest 与实际内容完全一致。

## MVP Route Mapping

RPA 专属复盘导出由 RPA Web 提供，不新增 daemon 的 RPA 专属 API，也不要求 daemon core 理解 DSL、Playwright、selector 或 executor。

MVP 使用这些 HTTP 边界：

```text
GET  /api/rpa/flows/:flowId/review-bundle/download?daemonRunId=run_...&executionId=exec_...&includeSensitiveFiles=false
POST /api/rpa/feedback
```

RPA Web 的 review bundle 下载流程：

1. 校验 `flowId`、必填 `daemonRunId` 和可选 `executionId`。
2. 调用通用 daemon API：`GET /api/runs/:runId/review-bundle/download`。
3. 在 RPA Web 本地读取对应 flow/execution 材料，生成 `extensions/rpa/*`。
4. 合并为新的 ZIP 返回前端；所有扩展路径都是 bundle-relative logical path，不暴露 host absolute path。

RPA Web 的 feedback 流程：

1. 校验 RPA category 和 severity。
2. 根据 `flow.dsl.json` 的 `params[].mask`、execution `run.params.json`、常见证件/手机号模式和本地 storage root 做 RPA 专属脱敏。
3. 调用通用 daemon API：`POST /api/runs/:runId/feedback`，category 和 metadata 对 daemon 保持 opaque。
4. 导出 bundle 时再调用 `GET /api/runs/:runId/feedback`，由 RPA Web 本地过滤 RPA allowlist category 和可选 `metadata.source = "rpa-local-web"`。

RPA Web 不通过 `flowId` 反推 daemon run；调用方必须传入本次要复盘的 `daemonRunId`。

## RPA 诊断摘要

`rpa-diagnostics.json` 用于让开发者和 AI 快速判断 skill 修改方向。

示例：

```json
{
  "limits": {
    "maxItemsPerList": 20,
    "omitted": {
      "fragileSelectors": 3
    }
  },
  "missingArtifacts": ["parameterization-report.md"],
  "schemaErrors": ["steps[2].assert is empty"],
  "fragileSelectors": ["steps[3].target.by=css"],
  "missingWaits": ["step_002"],
  "manualSteps": [
    {
      "stepId": "step_004",
      "reason": "需要用户处理验证码或 CA/USB-Key"
    }
  ],
  "unconfirmedWriteSteps": ["step_005"],
  "parameterizationIssues": [
    {
      "field": "start_date",
      "message": "录制值被写死，未提升为 params"
    }
  ],
  "executionFailures": [
    {
      "executionId": "exec_123",
      "stepId": "step_003",
      "category": "selector",
      "message": "target not found"
    }
  ]
}
```

`rpa-summary.md` 应优先回答：

- 本次 RPA 目标是什么。
- 使用 codegen 上传加固还是自然语言生成。
- DSL/artifact 是否完整。
- 参数化是否合理。
- 最脆弱的 selector 是哪些。
- verify/run 是否通过。
- 失败步骤和截图在哪里。
- 最可能需要修改哪个 skill 指令、reference 或 template。

## RPA 体积控制与脱敏

RPA 扩展尤其容易产生大文件和高敏材料：截图、trace、video、下载文件、网页内容和 tool result 都可能很大，也可能包含身份证号、手机号、案件号、单位名称等屏幕级敏感信息。

RPA 扩展必须复用通用 `collectionMode = lite | diagnostic | review` 与权限封顶规则。`eventVisibility = quiet | normal | debug` 只影响 SSE/API 实时事件可见性，不决定 RPA 复盘材料是否落盘或导出。

RPA 保存矩阵建议：

| 材料 | lite | diagnostic | review |
| --- | --- | --- | --- |
| `execution.json` 摘要 | 保存 | 保存 | 保存 |
| `rpa-summary.md` / `rpa-diagnostics.json` | 保存摘要 | 保存摘要 | 保存摘要 |
| `execution-log.jsonl` | 不默认保存全文 | 保存脱敏摘要或尾部片段 | 保存脱敏全文，受大小上限 |
| 失败步骤截图 | 不默认保存 | 可配置保存本地 path/hash，不默认内联 | 用户显式确认后导出，进入 large files manifest |
| 全步骤截图 | 不保存 | 不默认保存 | 用户显式确认后可选导出 |
| `trace.zip` | 不保存 | 不默认保存，仅记录 path/hash | 高敏文件，用户显式确认后可选导出 |
| `video.webm` | 不保存 | 不默认保存 | 用户显式确认后可选导出 |
| downloads | 不保存 | 不默认保存 | 用户显式确认后可选导出 |

脱敏规则：

- `rpa-summary.md` 不内联 trace、video、完整 DOM、完整 tool result。
- 大文件进入通用 `largeFiles` manifest，通过 path/hash 引用。
- `trace.zip` 因包含 DOM 快照、网络信息和页面文本，按高敏材料处理，默认只记录 path/hash，不内联内容。
- 截图和 video 可能包含屏幕级敏感信息，默认不进入 `lite` / `diagnostic` bundle；`review` 导出时需要用户显式确认。
- `execution-log.jsonl`、`feedback.jsonl` 和错误信息走通用脱敏流水线，并追加 RPA 规则：按 DSL `params[].mask`、字段名和常见证件/手机号模式脱敏。
- 默认不导出 `storage_state`、账号密码、token、cookie、CA/USB-Key 文件。

## RPA MVP 必须补齐

1. RPA Web 创建 execution 时保存 `daemonRunId`、`flowId` 和 `executionId` 关联。
2. RPA 扩展遵守通用 `collectionMode` 与权限封顶规则。
3. execution 失败步骤、错误、截图、trace、执行日志按 RPA 保存矩阵记录或导出到 extension bundle。
4. DSL/artifact 校验结果可进入 `rpa-diagnostics.json`，并对列表设置上限和 omitted 计数。
5. `rpa-summary.md` 控制 token 体积，优先给 AI 复盘读取。
6. RPA 用户反馈能关联 `daemonRunId`、`executionId`、`stepId` 和 artifact，并走 RPA 专属脱敏规则。

## 使用方式

优化 RPA skill 时，先读通用 bundle：

1. `review-summary.md`
2. `prompt-snapshot.md`
3. `skill/SKILL.md`
4. `logs/debug-events.ndjson`
5. `artifacts/`

再读 RPA 扩展：

1. `extensions/rpa/rpa-summary.md`
2. `extensions/rpa/rpa-diagnostics.json`
3. `extensions/rpa/dsl-validation.json`
4. `extensions/rpa/executions/*/execution.json`
5. 失败步骤截图、trace、execution-log。

这样可以先判断问题是否来自通用 prompt/skill，再判断是否来自 RPA DSL、选择器、等待、断言、参数化或 executor。
