# 参数化加固规则

codegen 脚本通常把录制时的日期、单位、查询条件写死。加固时要识别这些固定值，并让用户确认是否转为运行时参数。

## 候选来源

- `page.get_by_label(...).fill("固定值")`
- `page.get_by_text("固定选项").click()`
- URL query 中的固定值。
- 下载路径和文件名。
- select option value。
- 脚本中的 base URL、timeout、headless。

## 输出要求

在 `parameterization-report.md` 中列出候选参数：

| observed_value | proposed_param | type | widget | required | mask | reason | status |
| --- | --- | --- | --- | --- | --- | --- | --- |

`type` 必须最终映射到 DSL v0.1 支持的 `params.*.type`：`string | number | date | boolean | select | secret`。不要输出 `path`、`file`、`url`、`date_range`、`datetime`、`array` 或 `object`。`widget` 只用于报告中的 UI 建议，不写入 `flow.dsl.json`。

路径类输入如果必须由用户填写，DSL 中暂时使用 `"type": "string"`；下载目录、trace 目录、结果文件路径等运行环境配置优先放入 `config.example.json` 或脚本默认值，不要写成 `"type": "path"`。

用户确认后：

- DSL `params` 增加参数定义。
- DSL step `value` 替换为 `${param_name}`。
- `flow.hardened.py` 从 `run.params.json` 读取参数。
- 敏感参数按 `mask: true` 写入审计脱敏规则。

确认方式必须优先使用 AskQuestion；如果当前 Claude Code 环境没有真实 AskQuestion 工具，则输出等价的 `<question-form id="rpa-parameterization" version="rpa-question-form.v0.1">` 文本协议。Claude Code 输出合法 JSON 表单并停止本轮；表单标签和 JSON 内容都必须声明 `version` 为 `rpa-question-form.v0.1`；RPA Web 负责渲染；用户提交后以前缀 `[form answers — rpa-parameterization]` 的普通消息回传，Claude Code 再继续更新 DSL、脚本和报告。
