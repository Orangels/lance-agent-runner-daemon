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

## AskQuestion / question-form 约束

在生成 `flow.py` / `flow.hardened.py` 前，必须使用 AskQuestion 或等价结构化表单收集和确认变量参数、页面分支、字段含义、写操作风险和人工介入点。

RPA Web 通常没有真实 AskQuestion 工具；此时使用 RPA Web 的 `<question-form>` 文本协议。输出规则是硬约束：

- 本轮输出只能包含一句很短的说明 + 一个 `<question-form>` block；不要读文件、不要继续生成脚本、不要在 `</question-form>` 后继续解释。
- `<question-form>` 必须声明稳定 `id`、可读 `title`、`version="rpa-question-form.v0.1"`；JSON 内也必须包含 `"version": "rpa-question-form.v0.1"`。
- 标签内部只能放一个合法 JSON 对象：不要写注释、不要 trailing comma、不要在 JSON 外混入 Markdown。输出时不要包 ```json fenced code block（RPA Web parser 会兼容，但不要主动这样写）。
- `questions[].id` 必须稳定；`questions[].label` 面向用户；必要时设置 `required: true`。
- `questions[].type` 输出时只使用 canonical 类型：`radio`、`checkbox`、`select`、`text`、`textarea`。不要输出 `direction-cards`。普通字符串输入用 `text`。
- `radio` / `checkbox` / `select` 的 `options` 可以是字符串数组或 `{ "label": "...", "value": "...", "description": "..." }` 对象数组；RPA 场景优先使用对象数组，保证回传值稳定。
- 多选限制用 `maxSelections`，不要只写在 label 里。

用户答案会作为下一轮普通消息回传，格式类似 `[form answers — rpa-parameterization]`。收到答案后再更新 DSL、脚本和报告。

不要在表单未回答前生成最终脚本，除非用户明确说“跳过问题”或“直接生成”。

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

可用时使用当前工具列表中真实存在的 Chrome DevTools MCP 工具探查目标网页。执行前阅读 `references/chrome-devtools-mcp.md`。
不要猜测 MCP 工具名或把短横线改成下划线；只调用当前会话工具列表里实际出现的 `mcp__...__list_pages` / `mcp__...__navigate_page` 等工具。RPA profile 推荐的 server 名是 `cdt`，对应工具前缀通常是 `mcp__cdt__`。

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
- `params.*.type` 只能使用 DSL v0.1 支持的枚举：`string | number | date | boolean | select | secret`。不要输出 `path`、`file`、`url`、`text`、`textarea`、`datetime`、`array`、`object` 等未列出的类型。
- 输出文件路径、下载目录、trace 目录等运行环境路径优先放到 `config.example.json` 或脚本默认值；如果确实需要用户运行时填写路径，暂时用 `"type": "string"`，不要发明 `"type": "path"`。
- `steps[].target.by` 优先级为 `role > label > placeholder > text > testid > id > css`。
- `steps[].target.by` 只能使用 DSL v0.1 支持的枚举：`role | label | placeholder | text | testid | id | css | xpath`。不要输出 `target.by = "path"`、`"url"`、`"file"`、`"download"` 或坐标定位。
- `xpath` 只能作为临时降级策略，并在 `hardening-report.md` 中说明风险。
- 写操作必须标注 `write: true`，并尽量提供 `idempotency_key`。

### 7. 生成脚本

确认变量参数后，基于 DSL 和 `templates/flow.py.tmpl`、`templates/flow.hardened.py.tmpl`、`templates/config.example.json.tmpl` 生成脚本草稿。

脚本要求：

- 从配置文件和 `run.params.json` 读取运行环境与业务参数。
- 本地 executor 调用协议：
  `flow.hardened.py --mode verify|run --params <executionDir>/run.params.json --execution-dir <executionDir> [--dry-run] [--headed|--headless]`。
- `--mode verify|dry-run|run`，其中 executor 只传 `verify|run`，脚本可额外兼容 `dry-run`。
- `--execution-dir <executionDir>`，所有审计日志、截图、trace、录像、下载等执行期产物必须写入该目录下。
- `--dry-run`，即使 `--mode run` 也必须强制跳过或暂停不可逆写操作。
- `--headed` / `--headless`，覆盖配置文件和 mode 默认值。
- 可选 `--config <path>`；未传时默认读取脚本同目录的 `config.example.json`，不要假设执行目录里有 `config.json`。
- `verify` 默认 headed、高亮当前步骤、截图留痕、写操作暂停或跳过。
- `run` 默认 headless，并保留 trace、录像和审计日志。
- 不使用固定 `sleep` 表达等待；使用 Playwright 显式等待和断言。
- 不把账号密码、cookie、storage_state 写入脚本或 artifact。

### 8. 自检

交付前检查：

- `output/flow.dsl.json` 是合法 JSON。
- `params.*.type` 全部属于 `string | number | date | boolean | select | secret`，不存在 `path`、`file`、`url` 等未支持类型。
- `steps[].target.by` 全部属于 `role | label | placeholder | text | testid | id | css | xpath`，不存在 `path`、`url`、`file` 等未支持定位类型。
- `steps[].assert[].type` 全部属于 `visible | hidden | text_contains | url_contains | download_exists | row_count_gt`，不存在 `min_count`、`date_in_range`、`url_matches` 等未支持断言类型。
- 每个 step 有 `id`、`name`、`action`。
- `click | input | select | submit | assert` 类型 step 必须有页面元素 `target`，不得输出 `target: null`。
- 本地结果保存、审计日志、截图、trace、下载文件落盘不是页面操作；不要输出成 `action: "assert"` + `target: null`。这类行为优先放在脚本和报告中；若必须在 DSL 步骤里留痕，使用 `action: "wait"` 并配套 `assert: [{ "type": "download_exists", "value": "..." }]`。
- 每个可操作页面 step 有 `target` 或明确 `manual`。
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
