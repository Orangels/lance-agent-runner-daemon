# RPA 步骤 DSL 参考

DSL 是自然语言生成和 Playwright codegen 加固的共同中间表示。前端展示、验证截图、审计日志、导入导出和脚本生成都围绕它工作。

## 顶层结构

```json
{
  "dsl_version": "rpa-dsl.v0.1",
  "flow_id": "case_query",
  "meta": {
    "title": "案件查询",
    "source": "nl",
    "created_at": "2026-06-05T10:00:00+08:00"
  },
  "params": {
    "case_no": {
      "type": "string",
      "label": "案件编号",
      "required": true,
      "mask": true
    }
  },
  "context": {
    "base_url": "${BASE_URL}",
    "storage_state": "secrets/storage_state.json",
    "default_timeout_ms": 15000
  },
  "steps": []
}
```

字段要求：

- `dsl_version`：当前 MVP contract 为 `"rpa-dsl.v0.1"`。
- `flow_id`：小写字母、数字、下划线组成，用于文件名、日志和流程包 manifest。
- `meta.title`：流程显示名称；优先使用 `businessContext.flowName`，不要自行改写用户填写的名称。
- `meta.source`：自然语言生成使用 `"nl"`，codegen 加固使用 `"codegen"`。
- `params`：运行时业务参数定义，不存真实敏感值。
- `context`：部署实例配置引用，可以使用 `${ENV}` 占位。
- `steps`：稳定、有序的业务步骤。

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

## Step 结构

```json
{
  "id": "s3",
  "name": "提交查询",
  "action": "submit",
  "target": {
    "frame": ["#mainFrame"],
    "by": "role",
    "role": "button",
    "name": "查询",
    "scope": "s2_query_form"
  },
  "value": "${case_no}",
  "wait": {
    "before": { "visible": true },
    "after": { "url_changes": true }
  },
  "assert": [
    {
      "type": "visible",
      "target": { "by": "role", "role": "table" }
    }
  ],
  "write": true,
  "idempotency_key": "case_no",
  "manual": null
}
```

## Action 枚举

- `navigate`：进入 URL。
- `click`：点击按钮、菜单、链接。
- `input`：输入文本或日期。
- `select`：选择下拉、单选、多选。
- `submit`：触发查询、保存、提交、导出等动作。
- `assert`：只验证状态。
- `wait`：等待页面、网络、下载或用户可见状态。
- `manual`：验证码、CA、USB-Key、登录等人工介入。

页面元素 target 要求：

- `click | input | select | submit | assert` 类型 step 必须有页面元素 `target`。
- 不要输出 `action: "assert"` 且 `target: null`；这会被 RPA Web 校验为 `STEP_TARGET_REQUIRED`。
- 本地结果保存、审计日志、截图、trace、运行时 JSON 落盘不是页面元素操作，优先不要作为 DSL step；在脚本审计日志、executor artifact、`hardening-report.md` 中体现。业务结果 JSON/CSV/XLSX/PDF/TXT 应写入 `runtime/downloads/`，这样 RPA Web 才能作为下载产物识别。
- 如果确实需要在 DSL 中保留“本地产物已生成”的可视化步骤，使用 `action: "wait"`，省略 step-level `target`，并用 `assert: [{ "type": "download_exists", "value": "result.json" }]` 表达产物存在性。

## Target 规则

选择器优先级：

```text
role > label > placeholder > text > testid > id > css
```

DSL v0.1 只支持以下 `target.by`：

```text
role | label | placeholder | text | testid | id | css | xpath
```

禁止输出任何未列出的 `target.by`，包括但不限于：

```text
path | url | file | download | coordinate | selector
```

说明：

- 优先使用 Playwright 语义定位，如 `get_by_role`、`get_by_label`。
- `navigate` uses step-level `value` for the URL or URL parameter reference, for example `"value": "${BASE_URL}"`. Do not emit `target.by = "url"`.
- 本地结果文件、下载文件或 trace 文件不是页面元素，不要用 `target.by = "path"` 表达。需要记录本地文件产物时，在脚本审计日志、`hardening-report.md` 或 executor artifact 中体现；可下载业务结果应落到 `config["downloads"]["dir"]`。
- 不要用 `target: null` 绕过页面 target 要求；对于 `assert` step，缺少 target 会导致 `STEP_TARGET_REQUIRED`。
- CSS id 如果以数字开头，不能写成 `div#7d` 或 `#7d`，Playwright/CSS 会报 `not a valid selector`；必须写成属性选择器，如 `[id="7d"] ul.t`。
- Step `id` must be stable, unique, lowercase, and match `^[a-z][a-z0-9_]{0,63}$`. Semantic ids such as `open_query_page` are allowed.
- Every step must include `write` and `manual`; use `"manual": null` when no manual intervention is needed.
- For `write: true`, emit `idempotency_key` whenever a stable business key is known. If no idempotency key is available, document the risk in `hardening-report.md`.
- Wait keys supported by DSL v0.1 are `visible`, `enabled`, `url_changes`, `url_contains`, `network_idle`, `download`, `toast`, and `table_loaded`.
- `frame` 表示 iframe 链，按外到内排列。
- `scope` 用于限定父容器，避免同名按钮误点。
- `xpath` 只允许作为临时降级策略，并必须进入生成或加固报告。
- 坐标点击不能作为加固后的最终定位方式。

## Wait 和 Assert

每个关键步骤必须有动作前后等待或结果断言。

常见等待：

- `visible`
- `enabled`
- `url_changes`
- `url_contains`
- `network_idle`
- `download`
- `toast`
- `table_loaded`

常见断言：

- `visible`
- `hidden`
- `text_contains`
- `url_contains`
- `row_count_gt`
- `download_exists`

这些是 DSL v0.1 支持的完整 `assert[].type` 枚举。禁止输出任何未列出的断言类型，包括但不限于：

```text
min_count | date_in_range | url_matches | element_count | json_schema | custom
```

说明：

- 列表数量校验使用 `row_count_gt`，不要发明 `min_count`。
- URL 校验使用 `url_contains`，不要发明 `url_matches`。
- 业务级判断（例如目标日期是否在 7 天预报范围内、JSON 字段是否满足业务规则）放在 `flow.hardened.py` 的运行逻辑、审计日志和 `hardening-report.md` 中，不要发明新的 DSL assert type。
- 如果 DSL 只需要表达“页面上已经有可提取数据”，使用 `visible`、`text_contains` 或 `row_count_gt` 组合表达。

## 写操作

涉及查询提交、保存、导出、删除、审批、导入等动作时：

- 设置 `write: true`。
- 能提供幂等依据时设置 `idempotency_key`。
- verify/dry-run 模式默认不执行不可逆写操作。
- 审计日志必须记录 step id、action、target、参数摘要和执行结果。
