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
| type | string/date/date_range/select/number/boolean/path |
| label | 前端展示名称 |
| widget | input/date/dateRange/select/checkbox/pathPicker |
| default_strategy | 默认值策略 |
| required | 是否必填 |
| mask | 是否脱敏 |
| reason | 建议参数化原因 |
| status | proposed/accepted/rejected |

用户确认后，把 `accepted` 的参数写入 `flow.dsl.json.params`，并把步骤中的固定值替换为 `${param_name}`。

参数候选确认必须优先使用 AskQuestion；如果当前 Claude Code 环境没有真实 AskQuestion 工具，则输出等价的 `<question-form id="rpa-parameterization" version="rpa-question-form.v0.1">` 结构化表单；表单标签和 JSON 内容都必须声明 `version` 为 `rpa-question-form.v0.1`，由 RPA Web 渲染后把 `[form answers — rpa-parameterization]` 作为下一轮普通用户消息回传。Claude Code 收到答案后再更新 DSL 和脚本。

## 日常执行

日常执行不应每次调用 Claude Code 来提取变量。前端直接读取 DSL 的 `params` 渲染表单，用户填写后生成 `run.params.json`，executor 将参数传给脚本。

