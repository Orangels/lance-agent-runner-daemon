# 参数化泛化规则

RPA 不是只生成一次性固定脚本。生成阶段要把“录制时的固定值”识别为可配置参数，使脚本能被不同用户、不同日期、不同单位复用。

## 参数候选

优先识别：

- 日期、月份、季度、年度、时间范围。
- 单位、地区、部门、人员、账号角色。
- 案件号、身份证号、手机号、业务编号。
- 报表类型、查询类型、状态、类别。
- 导出目录、文件名、下载命名规则。
- base URL、超时时间、headless、trace、录像等环境配置。

## 分类

- `params`：每次执行都可能变化的业务输入，由前端表单渲染。
- `context`：部署实例配置，如 base URL、storage_state 引用、默认超时。
- `secrets`：认证材料和密钥，只能在本地安全位置引用，不进入 artifact。
- `constants`：业务流程真正固定的值，保留在 DSL。

## parameterization-report.md

报告至少包含：

| 字段 | 说明 |
| --- | --- |
| observed_value | 探查或录制时看到的固定值 |
| proposed_param | 建议参数名 |
| type | string/date/select/number/boolean/secret；必须映射到 DSL v0.1 支持的 `params.*.type` |
| label | 前端展示名称 |
| widget | input/date/select/checkbox/password；仅用于报告建议，不写入 DSL |
| default_strategy | 默认值策略 |
| required | 是否必填 |
| mask | 是否脱敏 |
| reason | 建议参数化原因 |
| status | proposed/accepted/rejected |

用户确认后，把 `accepted` 的参数写入 `flow.dsl.json.params`，并把步骤中的固定值替换为 `${param_name}`。

DSL v0.1 没有 `widget` 字段，也不支持 `path`、`file`、`url`、`date_range` 等参数类型。路径类输入如果必须由用户填写，DSL 中暂时使用 `"type": "string"`；下载目录、trace 目录、结果文件路径等运行环境配置优先放入 `config.example.json` 或脚本默认值，不要写成 `"type": "path"`。

参数候选确认必须优先使用 AskQuestion；如果当前 Claude Code 环境没有真实 AskQuestion 工具，则输出等价的 `<question-form id="rpa-parameterization" version="rpa-question-form.v0.1">` 结构化表单；表单标签和 JSON 内容都必须声明 `version` 为 `rpa-question-form.v0.1`，由 RPA Web 渲染后把 `[form answers — rpa-parameterization]` 作为下一轮普通用户消息回传。Claude Code 收到答案后再更新 DSL 和脚本。

`<question-form>` 标签内部只能放裸 JSON 对象，不要包 ```json fenced code block，不要写注释或 Markdown。问题类型只允许 `radio`、`checkbox`、`select`、`text`、`textarea`；单选用 `radio`，字符串输入用 `text`，不要使用 `single_choice`、`multiple_choice`、`string` 等别名。

## 日常执行

日常执行不应每次调用 Claude Code 来提取变量。前端直接读取 DSL 的 `params` 渲染表单，用户填写后生成 `run.params.json`，executor 将参数传给脚本。
