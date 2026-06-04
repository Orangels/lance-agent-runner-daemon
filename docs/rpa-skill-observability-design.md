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

每个 execution 应保存：

```text
execution.json
execution-log.jsonl
screenshots/*
trace.zip
video.webm
stdout.log
stderr.log
```

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

RPA `category` 建议：

```text
prompt | skill | dsl | selector | wait | assert | parameterization | write-risk | manual-step | artifact | executor | ux
```

## RPA Review Bundle 扩展目录

RPA 内容放在通用 bundle 的 `extensions/rpa/` 下。

推荐结构：

```text
business-skill-review-bundle.zip
+-- manifest.json
+-- review-summary.md
+-- diagnostics.json
+-- prompt-snapshot.md
+-- skill/
+-- logs/
+-- artifacts/
+-- extensions/
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

`extension-manifest.json` 示例：

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

## RPA 诊断摘要

`rpa-diagnostics.json` 用于让开发者和 AI 快速判断 skill 修改方向。

示例：

```json
{
  "missingArtifacts": ["parameterization-report.md"],
  "schemaErrors": ["steps[2].assert is empty"],
  "fragileSelectors": ["steps[3].target.by=css"],
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

## RPA 体积控制

RPA 扩展尤其容易产生大文件：截图、trace、video、下载文件、网页内容和 tool result 都可能很大。

默认策略：

- normal 模式只保留 execution 最终摘要和失败步骤 id。
- debug 模式保留失败步骤截图、execution-log、trace；每步截图可配置。
- review 模式由用户显式导出，可选择是否包含 video、trace、downloads。
- `rpa-summary.md` 不内联 trace、video、完整 DOM、完整 tool result。
- 大文件进入 `largeFiles` manifest，通过 path/hash 引用。
- 默认不导出 `storage_state`、账号密码、token、cookie、CA/USB-Key 文件。

建议默认保留：

- 失败步骤截图。
- `execution.json`。
- `execution-log.jsonl`。
- `rpa-diagnostics.json`。

建议可选保留：

- 全部步骤截图。
- trace.zip。
- video.webm。
- downloads。

## RPA MVP 必须补齐

1. RPA Web 创建 execution 时保存 `daemonRunId`。
2. execution 失败步骤、错误、截图、trace、执行日志可进入 RPA extension bundle。
3. DSL/artifact 校验结果可进入 `rpa-diagnostics.json`。
4. `rpa-summary.md` 控制 token 体积，优先给 AI 复盘读取。
5. RPA 用户反馈能关联 `daemonRunId`、`executionId`、`stepId` 和 artifact。

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
