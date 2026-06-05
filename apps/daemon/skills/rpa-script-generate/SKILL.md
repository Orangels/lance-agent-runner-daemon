---
name: rpa-script-generate
description: 当用户用自然语言描述 RPA 流程，需要 Claude Code 探查网页、确认不确定步骤、生成步骤 DSL 和 Playwright RPA 脚本时使用。
argument-hint: "[目标系统URL] [业务流程描述]"
---

# RPA 自然语言脚本生成 Skill

将用户的自然语言业务流程转成可验证、可导入导出、可参数化的 RPA 流程包草稿。

本 skill 面向本地 B/S RPA MVP。daemon 只负责运行 Claude Code、保存日志和 artifacts；RPA 业务语义、DSL 生成、脚本模板化都由本 skill 指导 Claude Code 在 run workspace 内完成。

## 适用场景

- 用户描述“登录系统、进入菜单、按条件查询、导出数据”等 RPA 流程。
- 需要先探查目标网页，再生成 Playwright Python 脚本。
- 需要让用户逐步确认页面分支、字段含义、写操作风险或人工介入点。
- 需要把固定录入值泛化为运行时参数。

如输入已经是 Playwright codegen 录制脚本，优先使用 `playwright-rpa-harden`。

## 产物

在当前任务 workspace 的 `output/` 目录产出：

- `flow.dsl.json`：统一步骤 DSL，作为前端展示、验证、审计、导入导出的单一事实源。
- `flow.py`：从自然语言和页面探查得到的初版 Playwright Python 脚本。
- `flow.hardened.py`：带参数、等待、断言、dry-run、审计钩子的加固草稿。
- `config.example.json`：部署实例配置示例，不包含真实密钥和 cookie。
- `parameterization-report.md`：固定值泛化建议和用户确认结果。
- `hardening-report.md`：探查记录、人工介入点、风险清单、后续加固建议。

不得输出真实密码、cookie、storage_state、CA/USB-Key 文件、真实业务数据样本。

`output/` 只放 daemon 生成/加固 artifacts。脚本运行时产生的审计日志、截图、trace、下载文件属于 executor executionId 产物，默认写入 `runtime/`，不要写入 `output/`。

## AskQuestion 约束

在生成 `flow.py` / `flow.hardened.py` 前，必须像 `kami-landing` 一样使用 AskQuestion 收集和确认变量参数、页面分支、字段含义、写操作风险和人工介入点。

如果当前 Claude Code 环境提供真实 AskQuestion 工具，优先使用该工具。若没有真实 AskQuestion 工具，则输出等价的 `<question-form>` JSON，并在 `</question-form>` 后停止本轮，等待用户提交答案。等价表单必须声明 `version="rpa-question-form.v0.1"`，JSON 内也必须包含 `"version": "rpa-question-form.v0.1"`，且 `questions[].id` 必须稳定。不要在表单未回答前生成最终脚本，除非用户明确说“跳过问题”或“直接生成”。

## 执行步骤

### 1. 收集边界

优先从用户输入中提取：

- 目标系统入口 URL。
- 业务目标和完成标准。
- 登录、验证码、CA、USB-Key、人工确认等前置条件。
- 查询、下载、提交、删除、导入等写操作风险。
- 已知运行时变量，如日期、单位、账号、查询条件、导出目录。

只在缺少关键执行信息时询问用户。不要用猜测补业务语义。

### 2. 准备输出目录

在当前 workspace 下创建：

```text
output/
screenshots/
notes/
```

中间截图和探查记录放入 `notes/` 或 `screenshots/`，最终交付物放入 `output/`。

### 3. 探查网页

可用时使用 `chrome-devtools-mcp` 探查目标网页。执行前阅读 `references/chrome-devtools-mcp.md`。

探查重点：

- 页面入口、菜单路径、iframe、弹窗、表单、按钮、表格、下载触发点。
- 可用于稳定定位的 role、label、placeholder、text、testid、id。
- 页面加载、接口返回、URL 变化、toast、表格刷新等等待条件。
- 每个关键步骤的成功断言。

`chrome-devtools-mcp` 只用于探索期，不作为生产执行引擎。

### 4. 形成候选步骤

把探查结果转成候选步骤列表，每步必须包含：

- 稳定 `id` 和用户可读 `name`。
- `action`、`target`、`wait`、`assert`。
- 是否 `write`。
- 是否需要 `manual`。

遇到不确定分支，按 `references/confirmation.md` 的规则使用 AskQuestion 或等价 `<question-form>` 向用户确认。

### 5. 参数化泛化

阅读 `references/parameterization.md`，识别页面探查中出现的固定值：

- 日期范围、单位、地区、人员、案件号、报表类型、导出文件名。
- URL 查询参数、下拉框选项、默认筛选条件。
- 运行环境配置，如 base URL、下载目录、超时时间。

先生成 `parameterization-report.md`，再使用 AskQuestion 或等价 `<question-form id="rpa-parameterization" version="rpa-question-form.v0.1">` 让用户确认哪些固定值需要变成参数。用户确认后再更新 `flow.dsl.json` 和脚本。

### 6. 生成 DSL

按 `references/dsl.md` 输出 `output/flow.dsl.json`。

要求：

- `meta.source` 固定为 `nl`。
- `params` 只放参数定义和默认值策略，不放真实敏感值。
- `steps[].target.by` 优先级为 `role > label > placeholder > text > testid > id > css`。
- `xpath` 只能作为临时降级策略，并在 `hardening-report.md` 中说明风险。
- 写操作必须标注 `write: true`，并尽量提供 `idempotency_key`。

### 7. 生成脚本

确认变量参数后，基于 DSL 和 `templates/flow.py.tmpl`、`templates/flow.hardened.py.tmpl`、`templates/config.example.json.tmpl` 生成脚本草稿。

脚本要求：

- 从 `config.json` 和 `run.params.json` 读取运行环境与业务参数。
- 支持 `--mode verify|dry-run|run`。
- `verify` 默认 headed、高亮当前步骤、截图留痕、写操作暂停或跳过。
- `run` 可 headless，并保留 trace、录像和审计日志。
- 不使用固定 `sleep` 表达等待；使用 Playwright 显式等待和断言。
- 不把账号密码、cookie、storage_state 写入脚本或 artifact。

### 8. 自检

交付前检查：

- `output/flow.dsl.json` 是合法 JSON。
- 每个 step 有 `id`、`name`、`action`。
- 每个可操作 step 有 `target` 或明确 `manual`。
- 每个关键业务结果有 `assert`。
- 参数引用都能在 `params`、`context` 或 `config` 中找到。
- 写操作有 `write: true`、dry-run 行为和审计记录。
- `hardening-report.md` 列出未验证风险和人工介入点。

## 重要约束

- 不猜业务含义。不确定就记录并询问。
- 不执行真实提交、删除、导入、审批等不可逆动作，除非用户明确要求并完成确认。
- 不输出或导出认证材料。
- 不把 RPA 逻辑写入 daemon core。
- 生成脚本必须能和 DSL 对齐：前端步骤列表、截图、高亮、日志都以 step id 关联。

