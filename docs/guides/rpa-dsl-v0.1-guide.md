# RPA DSL v0.1 指导文档

本文档说明 RPA Local Web 当前使用的 `flow.dsl.json` 规则。它面向 RPA skill 调试、脚本生成、前端表单、executor 执行、导入导出和后续维护。

当前 DSL 的代码定义以 `apps/rpa-local-web/src/shared/dsl-schema.ts` 为准，服务端校验以 `apps/rpa-local-web/src/server/validators/dsl-validator.ts` 为准。本文档是这些代码规则的说明，不替代代码中的最终校验。

## 设计目标

RPA DSL 是脚本生成流程的中间表示层，用来描述一个 RPA flow 的稳定结构：

- 目标流程是什么。
- 运行时需要哪些参数。
- 每个步骤执行什么页面动作。
- 每个关键步骤应该等待什么状态。
- 每个关键结果应该用什么断言验证。
- 哪些步骤有写操作风险。
- 哪些步骤需要人工介入。

DSL 不是完整的业务脚本语言。复杂业务判断、数据清洗、JSON 生成、异常兜底、下载文件写入、审计日志等逻辑应放在 `flow.hardened.py` 中实现，并在报告中说明。用户最终要下载、查看或复用的业务结果文件必须写入 `<executionDir>/runtime/downloads/`，不要直接写到 `<executionDir>/` 根目录。

## 顶层结构

`flow.dsl.json` 必须是 JSON object，最小结构如下：

```json
{
  "dsl_version": "rpa-dsl.v0.1",
  "flow_id": "weather_lookup",
  "meta": {
    "title": "天气查询",
    "source": "nl",
    "created_at": "2026-06-07T00:00:00+08:00"
  },
  "params": {},
  "context": {},
  "steps": []
}
```

字段说明：

- `dsl_version`：必须是 `rpa-dsl.v0.1`。
- `flow_id`：流程 ID，必须匹配 `^[a-z][a-z0-9_]{0,63}$`。
- `meta`：流程元信息。
- `params`：运行时参数定义，由前端渲染为执行表单。
- `context`：流程上下文，例如 `base_url`、默认超时、storage state 等。
- `steps`：步骤列表，必须是非空数组。

## meta

`meta` 描述 flow 的来源和展示名称。

```json
{
  "title": "中国天气网指定城市指定日期天气查询",
  "source": "nl",
  "created_at": "2026-06-07T00:00:00+08:00",
  "updated_at": "2026-06-07T01:00:00+08:00"
}
```

字段说明：

- `title`：展示给用户看的流程名称。
- `source`：来源枚举，目前支持：
  - `codegen`：Playwright codegen 录制后加固。
  - `nl`：自然语言生成。
  - `imported`：从 `.rpa.zip` 导入。
- `created_at`：可选，创建时间。
- `updated_at`：可选，更新时间。

## params

`params` 定义执行前需要用户填写或确认的变量。前端会根据这里的定义渲染表单，executor 会把用户填写的值传给 `flow.hardened.py`。

支持的参数类型：

```text
string
number
date
boolean
select
secret
```

参数 ID 必须匹配 `^[a-z][a-z0-9_]{0,63}$`。

示例：

```json
{
  "city_code": {
    "type": "string",
    "label": "城市代码",
    "description": "中国天气网城市代码，例如北京 101010100",
    "required": true,
    "default": "101010100"
  },
  "target_date": {
    "type": "date",
    "label": "目标日期",
    "required": true
  },
  "password": {
    "type": "secret",
    "label": "登录密码",
    "required": true,
    "mask": true
  },
  "region": {
    "type": "select",
    "label": "区域",
    "required": true,
    "options": [
      { "label": "北京", "value": "101010100" },
      { "label": "上海", "value": "101020100" }
    ]
  }
}
```

规则：

- `select` 类型必须提供 `options`。
- `secret` 或敏感参数应设置 `mask: true`。
- `default` 只能是 string、number 或 boolean。
- `params` 用来表达运行时变量，不要把固定页面流程硬编码成用户无法修改的脚本。

## context

`context` 是流程级上下文，供脚本和 executor 使用。

常见字段：

```json
{
  "base_url": "https://www.weather.com.cn/",
  "storage_state": "storage/state.json",
  "default_timeout_ms": 15000
}
```

规则：

- `context` 必须是 object。
- 可以包含业务自定义字段。
- 不要在 `context` 中存放明文密码、token、cookie、CA 文件路径等敏感材料。

## steps

`steps` 是 DSL 的核心。每个 step 描述一个页面动作、等待条件、断言和风险标记。

基础结构：

```json
{
  "id": "s1_open_forecast",
  "name": "打开城市7天预报页",
  "action": "navigate",
  "value": "https://www.weather.com.cn/weather/${city_code}.shtml",
  "wait": {
    "after": { "network_idle": true }
  },
  "assert": [
    { "type": "url_contains", "value": "/weather/" }
  ],
  "write": false,
  "manual": null
}
```

必填规则：

- `id` 必须存在、唯一，并匹配 `^[a-z][a-z0-9_]{0,63}$`。
- `name` 必须是非空字符串。
- `action` 必须属于支持的动作枚举。
- `write` 必须是 boolean。
- `manual` 必须存在；不需要人工介入时写 `null`。

## action

支持的 action：

```text
navigate
click
input
select
submit
assert
wait
manual
```

含义：

- `navigate`：打开或跳转页面。
- `click`：点击页面元素。
- `input`：输入文本或参数值。
- `select`：选择下拉项。
- `submit`：提交表单或触发关键动作。
- `assert`：显式验证页面状态。
- `wait`：等待页面、网络、产物或业务状态。
- `manual`：人工介入步骤。

需要页面元素 `target` 的 action：

```text
click
input
select
submit
assert
```

这些 action 如果没有 `target`，会被校验为 `STEP_TARGET_REQUIRED`。

不需要页面元素 `target` 的 action：

```text
navigate
wait
manual
```

注意：

- 不要用 `action: "assert"` 加 `target: null` 表示“本地产物已生成”。
- 本地 JSON、下载文件、日志、trace、截图等不是页面元素操作，优先放在 `flow.hardened.py` 中实现；业务结果 JSON/CSV/XLSX/PDF/TXT 应写入 `<executionDir>/runtime/downloads/`。
- 如果确实需要在 DSL 中表达产物存在性，使用 `action: "wait"`，并配套 `assert: [{ "type": "download_exists", "value": "..." }]`。

## target

`target` 描述页面元素定位方式。

支持的 `target.by`：

```text
role
label
placeholder
text
testid
id
css
xpath
```

示例：

```json
{ "by": "role", "role": "button", "name": "查询" }
```

```json
{ "by": "label", "label": "案件编号" }
```

```json
{ "by": "css", "css": "[id=\"7d\"] ul.t li" }
```

```json
{ "by": "xpath", "xpath": "//button[contains(., '查询')]" }
```

规则：

- 优先使用语义稳定的定位方式：`role`、`label`、`placeholder`、`text`、`testid`、`id`。
- `css` 可用，但需要避免脆弱选择器。
- `xpath` 是 fallback，validator 会给出 `XPATH_FALLBACK` warning。
- CSS ID 如果以数字开头，不能写 `#7d`，必须写成属性选择器 `[id="7d"]`，否则会触发 `CSS_NUMERIC_ID_SHORTHAND`。

## wait

`wait` 描述动作前后的等待条件。

结构：

```json
{
  "before": {
    "visible": true,
    "enabled": true
  },
  "after": {
    "network_idle": true,
    "table_loaded": true
  }
}
```

支持的等待条件：

```text
visible
enabled
url_changes
url_contains
network_idle
download
toast
table_loaded
```

规则：

- `navigate | click | input | select | submit` 这些 actionable step 建议定义明确的 `wait`。
- 缺少 `wait` 不一定报错，但会产生 `MISSING_WAIT` warning。
- 等待条件只表达页面或执行时机，不表达复杂业务判断。

## assert

`assert` 描述步骤执行后的验证条件。它用于验证页面状态、URL、下载产物或表格数量。

支持的完整枚举：

```text
visible
hidden
text_contains
url_contains
download_exists
row_count_gt
```

示例：

```json
{ "type": "visible", "target": { "by": "text", "text": "查询结果" } }
```

```json
{ "type": "hidden", "target": { "by": "text", "text": "加载中" } }
```

```json
{ "type": "text_contains", "target": { "by": "css", "css": ".result" }, "text": "北京" }
```

```json
{ "type": "url_contains", "value": "/weather/" }
```

```json
{ "type": "download_exists", "value": "weather.json" }
```

```json
{ "type": "row_count_gt", "target": { "by": "css", "css": "[id=\"7d\"] ul.t li" }, "value": 0 }
```

语义：

- `visible`：目标元素应可见。
- `hidden`：目标元素应隐藏或不可见。
- `text_contains`：目标元素或页面区域应包含指定文本。
- `url_contains`：当前 URL 应包含指定字符串。
- `download_exists`：执行目录中应存在指定产物或下载文件；业务结果文件通常对应 `runtime/downloads/<value>`。
- `row_count_gt`：目标元素集合数量应大于指定值，例如 `value: 0` 表示至少 1 行。

禁止输出未支持类型，包括但不限于：

```text
min_count
date_in_range
url_matches
text_equals
json_schema
not_empty
exists
```

边界：

- DSL 的 `assert` 只表达简单、可视化、可审计的验证条件。
- 业务级判断，例如“目标日期是否在 7 天预报范围内”“JSON 字段是否满足业务规则”，应放在 `flow.hardened.py` 的运行逻辑和报告中，不要发明新的 `assert.type`。
- RPA Web 对少数安全别名有生成后归一化，例如 `min_count: 5` 可归一化为 `row_count_gt: 4`，但 skill 和最终 DSL 都必须以 canonical assert type 为准。

## write

`write` 标记该步骤是否会对外部系统产生写操作。

```json
{
  "action": "submit",
  "write": true,
  "idempotency_key": "submit_case_update_${case_no}",
  "manual": {
    "type": "confirm",
    "instruction": "提交前由用户确认写操作内容",
    "riskLevel": "high"
  }
}
```

规则：

- 查询、读取、页面跳转、截图、下载通常是 `write: false`。
- 提交、保存、删除、审批、发送、上传等会改变外部系统状态的步骤必须是 `write: true`。
- `write: true` 且没有 `idempotency_key` 或 high-risk manual confirmation，会产生 `WRITE_MISSING_IDEMPOTENCY_OR_MANUAL_CONFIRMATION` warning。
- MVP demo 尽量避免真实写操作。

## manual

`manual` 描述人工介入点。不需要人工介入时必须写 `null`。

支持类型：

```text
captcha
login
ca_usbkey
confirm
other
```

示例：

```json
{
  "type": "captcha",
  "instruction": "请用户在浏览器中完成验证码，然后点击继续。",
  "riskLevel": "medium"
}
```

规则：

- `manual` 字段必须存在。
- 无人工介入时写 `null`。
- 有人工介入时必须提供 `instruction`。
- CA、USBKey、验证码、登录、多因素认证、写操作确认都应明确写入 `manual`。

## 参数引用

DSL 中可以使用 `${param_id}` 风格引用参数。

示例：

```json
{
  "value": "https://www.weather.com.cn/weather/${city_code}.shtml"
}
```

当前 DSL 只定义参数结构和引用约定，具体替换逻辑由 executor / `flow.hardened.py` 实现。不要在 DSL 中把一次录制得到的固定日期、单位、城市、案件号永久硬编码，应该抽成 `params`。

## 生成产物中的 canonical 要求

Claude Code 或 skill 生成的 `flow.dsl.json` 必须直接使用 canonical DSL：

- `action` 使用支持枚举。
- `target.by` 使用支持枚举。
- `assert[].type` 使用支持枚举。
- 需要 `target` 的 action 必须有 `target`。
- 所有 step 必须有 `write` 和 `manual`。

RPA Web 的 generated DSL normalizer 只处理少数安全别名，目的是提高生成容错，而不是放宽 DSL 设计。normalizer 之后会重新写回 canonical `flow.dsl.json` 并执行严格校验。

## 常见错误与修复

### STEP_TARGET_REQUIRED

错误原因：

```json
{
  "action": "assert",
  "target": null
}
```

修复：

- 如果要验证页面元素，补充真实 `target`。
- 如果要验证本地产物，改成 `action: "wait"`，并使用 `download_exists`。

### UNSUPPORTED_ASSERT_TYPE

错误原因：

```json
{ "type": "date_in_range" }
```

修复：

- 如果是简单页面断言，改成支持枚举。
- 如果是业务判断，放进 `flow.hardened.py`，并在报告里说明。

### CSS_NUMERIC_ID_SHORTHAND

错误原因：

```json
{ "by": "css", "css": "div#7d ul.t" }
```

修复：

```json
{ "by": "css", "css": "[id=\"7d\"] ul.t" }
```

### MISSING_WAIT

原因：动作步骤缺少等待条件。

修复：补充 `wait.before` 或 `wait.after`，例如 `network_idle`、`visible`、`table_loaded`。

### MISSING_ASSERT

原因：`submit` 或 `assert` 等关键步骤缺少结果断言。

修复：补充 `assert`，例如 `visible`、`url_contains`、`row_count_gt`。

## 完整示例

```json
{
  "dsl_version": "rpa-dsl.v0.1",
  "flow_id": "weather_lookup",
  "meta": {
    "title": "中国天气网指定城市指定日期天气查询",
    "source": "nl",
    "created_at": "2026-06-07T00:00:00+08:00"
  },
  "params": {
    "city_code": {
      "type": "string",
      "label": "城市代码",
      "required": true,
      "default": "101010100"
    },
    "target_date": {
      "type": "date",
      "label": "目标日期",
      "required": true
    },
    "city_name": {
      "type": "string",
      "label": "城市名称",
      "required": false,
      "default": "北京"
    }
  },
  "context": {
    "base_url": "https://www.weather.com.cn/",
    "default_timeout_ms": 15000
  },
  "steps": [
    {
      "id": "s1_open_forecast",
      "name": "打开城市7天预报页",
      "action": "navigate",
      "value": "https://www.weather.com.cn/weather/${city_code}.shtml",
      "wait": {
        "after": {
          "network_idle": true
        }
      },
      "assert": [
        {
          "type": "url_contains",
          "value": "/weather/"
        }
      ],
      "write": false,
      "manual": null
    },
    {
      "id": "s2_assert_forecast_loaded",
      "name": "确认7天预报数据已加载",
      "action": "assert",
      "target": {
        "by": "css",
        "css": "[id=\"7d\"] ul.t li"
      },
      "assert": [
        {
          "type": "row_count_gt",
          "target": {
            "by": "css",
            "css": "[id=\"7d\"] ul.t li"
          },
          "value": 0
        }
      ],
      "write": false,
      "manual": null
    },
    {
      "id": "s3_extract_weather",
      "name": "提取目标日期天气并写入 JSON",
      "action": "wait",
      "wait": {
        "after": {
          "table_loaded": true
        }
      },
      "assert": [
        {
          "type": "download_exists",
          "value": "weather.json"
        }
      ],
      "write": false,
      "manual": null
    }
  ]
}
```

## 当前边界和后续演进

当前 DSL v0.1 刻意保持小而稳定。它优先服务：

- 前端展示步骤。
- 执行前参数表单。
- verify/run 可视化。
- 生成产物校验。
- 导入导出 `.rpa.zip`。
- review bundle 复盘。

后续如需支持更复杂的断言，例如 JSON schema、正则匹配、范围判断、表格列校验，应先扩展 DSL schema、validator、executor、skill 文档和导入导出测试，不要只在 skill 中临时发明字段。
