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

用户确认后：

- DSL `params` 增加参数定义。
- DSL step `value` 替换为 `${param_name}`。
- `flow.hardened.py` 从 `run.params.json` 读取参数。
- 敏感参数按 `mask: true` 写入审计脱敏规则。

确认方式必须优先使用 AskQuestion；如果当前 Claude Code 环境没有真实 AskQuestion 工具，则输出等价的 `<question-form id="rpa-parameterization">` 文本协议。Claude Code 输出合法 JSON 表单并停止本轮；RPA Web 负责渲染；用户提交后以前缀 `[form answers — rpa-parameterization]` 的普通消息回传，Claude Code 再继续更新 DSL、脚本和报告。

