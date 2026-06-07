# RPA DSL 加固参考

`playwright-rpa-harden` 必须把输入脚本或已有 DSL 归一化为 `output/flow.dsl.json`。DSL 是脚本、前端展示、审计和导入导出的共同依据。

## 顶层字段

- `dsl_version`：当前 MVP contract 为 `"rpa-dsl.v0.1"`。
- `flow_id`：稳定流程 id，只使用小写字母、数字、下划线。
- `meta.title`：流程显示名称；优先使用 `businessContext.flowName`，不要自行改写用户填写的名称。
- `meta.source`：codegen 加固使用 `"codegen"`。
- `params`：运行时业务参数定义。
- `context`：部署环境配置引用。
- `steps`：业务步骤数组。

## Param 类型枚举

DSL v0.1 只支持以下参数类型：

```text
string | number | date | boolean | select | secret
```

禁止输出任何未列出的 `params.*.type`，包括但不限于：

```text
path | file | url | text | textarea | datetime | array | object
```

说明：

- 运行时文件路径、下载目录、trace 目录、结果保存路径等部署/运行环境值，优先放到 `config.example.json` 或脚本默认值。
- 用户最终要下载、查看或复用的业务结果文件必须写入 `config["downloads"]["dir"]`，默认对应 `<executionDir>/runtime/downloads/`；不要直接写入 `<executionDir>/` 根目录。
- 如果确实需要用户在运行前填写某个路径，暂时使用 `"type": "string"`，不要发明 `"type": "path"`。
- URL 如果是部署配置，放到 `context.base_url` 或 `config.example.json`；如果是业务输入，使用 `"type": "string"`。
- `select` 参数必须提供 `options`，不要额外输出 `widget` 字段。

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
- `click | input | select | submit | assert` 类型 step 必须有页面元素 `target`。
- 不要输出 `action: "assert"` 且 `target: null`；这会被 RPA Web 校验为 `STEP_TARGET_REQUIRED`。
- `target.by` 只能使用 DSL v0.1 支持的枚举：`role | label | placeholder | text | testid | id | css | xpath`。
- 不要输出 `target.by = "path"`、`"url"`、`"file"`、`"download"`、`"coordinate"` 或其他未支持定位类型。
- 本地结果文件、下载文件或 trace 文件不是页面元素，不要用 `target.by = "path"` 表达。需要记录本地文件产物时，在脚本审计日志、`hardening-report.md` 或 executor artifact 中体现；可下载业务结果应落到 `config["downloads"]["dir"]`。
- 本地结果保存、审计日志、截图、trace、运行时 JSON 落盘不是页面元素操作，优先不要作为 DSL step；如果确实需要留痕，使用 `action: "wait"`，省略 step-level `target`，并用 `assert: [{ "type": "download_exists", "value": "..." }]` 表达产物存在性。业务结果 JSON/CSV/XLSX/PDF/TXT 应写入 `runtime/downloads/`，这样 RPA Web 才能作为下载产物识别。
- CSS id 如果以数字开头，不能写成 `div#7d` 或 `#7d`，Playwright/CSS 会报 `not a valid selector`；必须写成属性选择器，如 `[id="7d"] ul.t`。
- Step `id` must be stable, unique, lowercase, and match `^[a-z][a-z0-9_]{0,63}$`. Semantic ids such as `open_query_page` are allowed.
- Every step must include `write` and `manual`; use `"manual": null` when no manual intervention is needed.
- For `write: true`, emit `idempotency_key` whenever a stable business key is known. If no idempotency key is available, document the risk in `hardening-report.md`.
- Wait keys supported by DSL v0.1 are `visible`, `enabled`, `url_changes`, `url_contains`, `network_idle`, `download`, `toast`, and `table_loaded`.

## Assert 类型枚举

DSL v0.1 只支持以下 `assert[].type`：

```text
visible | hidden | text_contains | url_contains | download_exists | row_count_gt
```

禁止输出任何未列出的断言类型，包括但不限于：

```text
min_count | date_in_range | url_matches | element_count | json_schema | custom
```

说明：

- 列表数量校验使用 `row_count_gt`，不要发明 `min_count`。
- URL 校验使用 `url_contains`，不要发明 `url_matches`。
- 业务级判断（例如目标日期是否在 7 天预报范围内、JSON 字段是否满足业务规则）放在 `flow.hardened.py` 的运行逻辑、审计日志和 `hardening-report.md` 中，不要发明新的 DSL assert type。
- 如果 DSL 只需要表达“页面上已经有可提取数据”，使用 `visible`、`text_contains` 或 `row_count_gt` 组合表达。

## 加固要求

- 从 codegen 反抽 DSL 时保留原始业务顺序。
- 合并纯技术噪声步骤，如无意义 mouse move。
- 固定输入值优先进入参数化候选。
- 每个下载、提交、查询、保存动作都必须有结果断言。
- 无法确认业务含义时，在报告中标记为需要用户确认。
