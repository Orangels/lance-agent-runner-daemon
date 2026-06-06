---
name: playwright-rpa-harden
description: 当输入是 Playwright codegen 录制脚本或已有 RPA DSL，需要归一化 DSL 并加固为可复用、可审计的 Playwright Python RPA 脚本时使用。
argument-hint: "[input/flow.py 或 input/flow.dsl.json]"
---

# Playwright RPA 脚本加固 Skill

将 codegen 录制脚本或已有 DSL 加固为适合本地 B/S RPA MVP 执行的流程包产物。

本 skill 不改变业务意图，只做结构化、泛化、加固和留痕。daemon 仍然只负责运行 Claude Code 和管理 artifacts，不解释 RPA DSL。

## 输入

支持以下任一输入：

- `input/flow.py`：Playwright codegen 录制得到的 Python 脚本。
- `input/flow.dsl.json`：已经存在的步骤 DSL。
- `input/config.example.json`：可选的配置样例。
- 用户补充的业务说明、参数化要求、人工介入说明。

如果同时存在 DSL 和脚本，优先以 DSL 为主，原始脚本作为定位和顺序证据。

## 产物

在 `output/` 目录产出：

- `flow.dsl.json`：归一化后的统一步骤 DSL。
- `flow.hardened.py`：加固后的 Playwright Python 脚本。
- `config.example.json`：运行配置示例。
- `parameterization-report.md`：固定值泛化建议和确认结果。
- `hardening-report.md`：选择器、等待、断言、写操作、人工介入、风险告警清单。

不得输出真实密码、cookie、storage_state、CA/USB-Key 文件、真实业务数据样本。

`output/` 只放 daemon 生成/加固 artifacts。脚本运行时产生的审计日志、截图、trace、下载文件属于 executor executionId 产物，默认写入 `runtime/`，不要写入 `output/`。

## AskQuestion / question-form 约束

在生成 `flow.hardened.py` 前，必须使用 AskQuestion 或等价结构化表单收集和确认参数化候选、写操作风险、人工介入点和无法加固的页面语义。

RPA Web 通常没有真实 AskQuestion 工具；此时使用 RPA Web 的 `<question-form>` 文本协议。输出规则是硬约束：

- 本轮输出只能包含一句很短的说明 + 一个 `<question-form>` block；不要继续加固脚本、不要验证 artifacts、不要在 `</question-form>` 后继续解释。
- `<question-form>` 必须声明稳定 `id`、可读 `title`、`version="rpa-question-form.v0.1"`；JSON 内也必须包含 `"version": "rpa-question-form.v0.1"`。
- 标签内部只能放一个合法 JSON 对象：不要写注释、不要 trailing comma、不要在 JSON 外混入 Markdown。输出时不要包 ```json fenced code block（RPA Web parser 会兼容，但不要主动这样写）。
- `questions[].id` 必须稳定；`questions[].label` 面向用户；必要时设置 `required: true`。
- `questions[].type` 输出时只使用 canonical 类型：`radio`、`checkbox`、`select`、`text`、`textarea`。不要输出 `direction-cards`。普通字符串输入用 `text`。
- `radio` / `checkbox` / `select` 的 `options` 可以是字符串数组或 `{ "label": "...", "value": "...", "description": "..." }` 对象数组；RPA 场景优先使用对象数组，保证回传值稳定。
- 多选限制用 `maxSelections`，不要只写在 label 里。

用户答案会作为下一轮普通消息回传，格式类似 `[form answers — rpa-parameterization]`。收到答案后再更新 DSL、脚本和报告。

不要在关键问题未回答前输出最终加固脚本，除非用户明确说“跳过问题”或“直接生成”。

## 执行步骤

### 1. 检查输入

- 如果只有 `flow.py`，从脚本中反抽步骤并生成 `flow.dsl.json`。
- 如果已有 `flow.dsl.json`，校验 schema、参数引用、步骤顺序和 step id。
- 记录原始脚本中的固定延时、坐标点击、xpath、脆弱 css、缺失断言、缺失等待。

### 2. 归一化 DSL

按 `references/dsl.md` 输出统一结构：

- `meta.source` 使用 `"codegen"`。
- step id 稳定递增，如 `s1`、`s2`。
- 每个 step 有用户可读 `name`。
- 写操作标记 `write: true`。
- 人工介入标记 `manual`。

### 3. 参数化

按 `references/parameterization.md` 识别录制脚本中的固定值。

常见候选：

- 日期、单位、地区、人员、案件号、报表类型。
- 导出目录、文件名、下载路径。
- base URL、超时时间、headless、trace、录像等环境配置。

用户未确认前，先在 `parameterization-report.md` 中标记为 `proposed`，并使用 AskQuestion 或等价 `<question-form id="rpa-parameterization" version="rpa-question-form.v0.1">` 收集确认。已确认参数写入 DSL `params`，脚本从 `run.params.json` 读取。

### 4. 加固选择器

按 `references/selectors.md` 重写定位：

```text
role > label > placeholder > text > testid > id > css
```

要求：

- 避免坐标点击。
- 避免绝对 xpath。
- 避免依赖动态 class、动态 id、列表序号。
- iframe 必须显式表达。
- 同名元素必须加 scope 或 filter。

无法加固的定位进入 `hardening-report.md` 风险清单。

### 5. 加固等待和断言

- 用 Playwright 显式等待替代固定 `sleep`。
- 每个关键步骤补充可验证断言。
- 下载步骤断言文件存在或下载事件完成。
- 查询步骤断言表格、结果区域、空结果提示或 toast。
- 页面提交后等待 URL、toast、表格刷新或网络完成。

### 6. 加固写操作

写操作包括提交、保存、删除、审批、导入、导出、覆盖文件等。

要求：

- `verify` / `dry-run` 默认不执行不可逆写操作。
- 写操作执行前记录审计日志。
- 可重试动作必须避免重复提交。
- 能提供业务幂等依据时写入 `idempotency_key`。

### 7. 生成脚本

在 AskQuestion / `<question-form>` 中的关键参数和风险点确认后，基于 `templates/flow.hardened.py.tmpl` 生成 `output/flow.hardened.py`。

脚本必须支持：

- 本地 executor 调用协议：
  `flow.hardened.py --mode verify|run --params <executionDir>/run.params.json --execution-dir <executionDir> [--dry-run] [--headed|--headless]`。
- `--mode verify|dry-run|run`，其中 executor 只传 `verify|run`，脚本可额外兼容 `dry-run`。
- `--params run.params.json`，读取运行时业务参数。
- `--execution-dir <executionDir>`，所有审计日志、截图、trace、录像、下载等执行期产物必须写入该目录下。
- `--dry-run`，即使 `--mode run` 也必须强制跳过或暂停不可逆写操作。
- `--headed` / `--headless`，覆盖配置文件和 mode 默认值；`--headed` 用于用户可视化验证，`--headless` 用于后台执行。
- 可选 `--config <path>`；未传时默认读取脚本同目录的 `config.example.json`，不要假设执行目录里有 `config.json`。
- JSONL 审计日志。
- 每步截图或失败截图。
- trace/录像配置入口。
- 人工介入暂停点。

### 8. 自检

交付前检查：

- `output/flow.dsl.json` 是合法 JSON。
- `output/flow.hardened.py` 不包含真实认证材料。
- 没有固定 `time.sleep` 作为主要等待策略。
- 没有坐标点击作为最终定位。
- 每个写操作有 dry-run 分支和审计记录。
- `hardening-report.md` 列出无法完全加固的风险。

## 重要约束

- 不改变用户录制的业务流程顺序，除非用户明确确认。
- 不把登录态、密钥、cookie、storage_state 内容写入 artifact。
- 不把 xpath 或 css 美化成“已加固”，无法替换就显式告警。
- 不把重试加到不可幂等写操作上。
- DSL 是前端展示、导入导出、审计、验证的单一事实源。
