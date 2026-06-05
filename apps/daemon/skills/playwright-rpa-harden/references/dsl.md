# RPA DSL 加固参考

`playwright-rpa-harden` 必须把输入脚本或已有 DSL 归一化为 `output/flow.dsl.json`。DSL 是脚本、前端展示、审计和导入导出的共同依据。

## 顶层字段

- `dsl_version`：当前 MVP contract 为 `"rpa-dsl.v0.1"`。
- `flow_id`：稳定流程 id，只使用小写字母、数字、下划线。
- `meta.source`：codegen 加固使用 `"codegen"`。
- `params`：运行时业务参数定义。
- `context`：部署环境配置引用。
- `steps`：业务步骤数组。

## Step 必填字段

- `id`：稳定步骤 id；必须唯一、小写，并匹配 `^[a-z][a-z0-9_]{0,63}$`。
- `name`：用户可读步骤名。
- `action`：`navigate | click | input | select | submit | assert | wait | manual`。
- `target`：元素定位；人工步骤可为空。
- `wait`：动作前后等待条件。
- `assert`：关键业务结果断言。
- `write`：是否写操作。
- `manual`：人工介入说明；无人工介入时使用 `null`。

## Step / Target 规则

- `navigate` uses step-level `value` for the URL or URL parameter reference, for example `"value": "${BASE_URL}"`. Do not emit `target.by = "url"`.
- Step `id` must be stable, unique, lowercase, and match `^[a-z][a-z0-9_]{0,63}$`. Semantic ids such as `open_query_page` are allowed.
- Every step must include `write` and `manual`; use `"manual": null` when no manual intervention is needed.
- For `write: true`, emit `idempotency_key` whenever a stable business key is known. If no idempotency key is available, document the risk in `hardening-report.md`.
- Selectable runtime parameters must use `"type": "select"` with `options`; do not emit a separate `widget` field in DSL v0.1.
- Wait keys supported by DSL v0.1 are `visible`, `enabled`, `url_changes`, `url_contains`, `network_idle`, `download`, `toast`, and `table_loaded`.

## 加固要求

- 从 codegen 反抽 DSL 时保留原始业务顺序。
- 合并纯技术噪声步骤，如无意义 mouse move。
- 固定输入值优先进入参数化候选。
- 每个下载、提交、查询、保存动作都必须有结果断言。
- 无法确认业务含义时，在报告中标记为需要用户确认。
