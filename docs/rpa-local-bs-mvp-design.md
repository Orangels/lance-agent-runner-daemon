# RPA 本地 B/S MVP 设计

日期：2026-06-05

## 结论

MVP 先实现客户本地 B/S 架构，不先做 SaaS 多租户版本。

本地 B/S 形态放在当前仓库实现，但不能污染通用 daemon。当前仓库继续保持：

```text
apps/daemon = 通用 Claude Code agent runner daemon
apps/web = 通用 runner 测试控制台
apps/rpa-local-web = RPA 本地 B/S MVP demo（新增）
```

RPA 产品逻辑放在 `apps/rpa-local-web`。`apps/daemon` 只提供通用能力：profile、workspace、run、SSE、logs、artifacts、skill staging、Claude Code 子进程执行。

## 背景

原始方案包含两个部署形态：

1. SaaS：服务端运行 Playwright/Claude Code，前端展示生成、验证、trace、录像。
2. 客户本地 B/S：客户内网机器运行本地 web + daemon + Python/Playwright，通过浏览器访问本地服务。

当前 MVP 改为优先客户本地 B/S。主要原因：

- 公安/RPA 场景经常依赖客户内网、CA、USB-Key、验证码、专用浏览器控件。
- 客户电脑或内网服务器可能是国产系统，本地 B/S 比桌面客户端兼容性更好。
- 服务端 SaaS 的多租户浏览器隔离、资源争抢、账号串号问题可以后置。
- 与 `/home/orangels/ls_dev/lanceDesign` 的本地 web + daemon 形态一致，但本仓库的 daemon 必须继续保持通用 runner 定位。

## 目标

MVP 要证明本地生成、加固、执行、留痕闭环：

```text
用户在本地 Web 操作
  -> 自然语言生成或 codegen 录制后加固
  -> Claude Code 生成/加固 Playwright Python 脚本
  -> 本地执行器运行脚本 dry-run / 验证
  -> 本地 Web 展示日志、脚本、trace、录像、执行结果
```

MVP 支持两种 RPA 脚本生产形式：

1. 自然语言描述生成 Playwright 脚本。
2. Playwright codegen 录制脚本后加固。

两种形式最终都收敛到同一组生成/加固产物：

- `flow.dsl.json`
- `flow.hardened.py`
- `config.example.json`
- `parameterization-report.md`
- `hardening-report.md`
- `flow.py`（可选，保留原始/中间脚本）

MVP 生成/加固阶段的必需 artifact 先固定为：

- `flow.dsl.json`
- `flow.hardened.py`
- `config.example.json`
- `parameterization-report.md`
- `hardening-report.md`

verify/run 阶段还会产生执行产物，但它们归属于 `rpa executionId`，由 RPA Web/executor 管理，不作为 daemon 生成/加固 artifacts：

- `trace.zip`
- `videos/*`
- `screenshots/*`
- `execution-log.jsonl`
- `downloads/*`

trace、录像、截图、下载文件和执行日志不要求在生成阶段存在，也不要求由 daemon artifact rules 扫描。

## 非目标

MVP 不做以下内容：

- SaaS 多租户执行平台。
- Browserless 或服务端浏览器集群。
- 容器化 per-run 隔离。
- 中心平台任务下发、授权、租户计费。
- 完整安装器、自动更新、设备绑定。
- daemon 内置 RPA 专属 HTTP API。
- daemon core 直接 import Playwright、Python runner、公安业务逻辑。

## MVP 已确认收敛项

- 最终 MVP 包含 **Playwright codegen 上传后加固** 和 **自然语言生成** 两种脚本生产方式；实现时先落地 codegen 上传加固闭环，再接入自然语言生成闭环。这个顺序只是实施切片，不缩小最终 MVP 范围。
- 本次最终 MVP 的实施切片命名固定为：`codegen 上传加固闭环`、`自然语言生成闭环`、`流程复用与执行闭环`。后续文档和 plan 应使用这些具名切片，不使用含糊的“第一阶段/第二阶段”。
- 首个演示流程 **不做登录**，也不碰验证码、CA/USB-Key、真实写操作。
- DSL v0.1 先冻结 `params`、`steps`、`target`、`wait`、`assert`、`write`、`manual` 的最小字段。
- `<question-form>` MVP 只支持 `radio`、`checkbox`、`select`、`text`、`textarea`。
- 导出包必需包含 `flow.dsl.json`、`flow.hardened.py`、`config.example.json`、`parameterization-report.md`、`hardening-report.md`、`manifest.json`。
- 默认不导出 `storage_state`、账号密码、token、cookie、CA/USB-Key 文件、真实业务数据、trace 和录像。
- 浏览器执行默认优先 Playwright bundled Chromium，同时预留本机 Chrome 路径配置；国产系统兼容性需要尽早单独验证。
- `rpa-local` profile 先配置 `allowedSkillIds` 和生成/加固 artifact rules；`chrome-devtools-mcp` 通过该 profile 使用的 Claude Code `claudeConfigDir` / MCP 配置启用，不新增 daemon core 配置字段。

## 仓库放置

推荐新增：

```text
apps/
  rpa-local-web/
    src/
      api/
      components/
      server/
        daemon-client.ts
        rpa-workflow.ts
        executor/
          python-playwright-executor.ts
          process-manager.ts
          artifact-collector.ts
      shared/
```

`apps/rpa-local-web` 是本地 B/S MVP demo，包含：

- 前端页面。
- 本地 BFF。
- RPA workflow 编排。
- Python/Playwright executor 模块。

不建议直接重写现有 `apps/web`。`apps/web` 继续作为通用 runner 测试控制台，避免 RPA 产品 UI 影响通用集成测试。

## 职责边界

### `apps/daemon`

daemon 继续作为通用 agent 服务。

负责：

- 读取 config/profile/client。
- 管理 workspace。
- 创建和调度 run。
- 启动 Claude Code。
- staging skill。
- 解析 Claude Code SSE 事件。
- 保存 run 状态、消息、日志。
- 扫描和下载 artifacts。

daemon 不负责：

- 判断某个 run 是“自然语言 RPA 生成”还是“codegen 加固”。
- 启动 Playwright codegen UI。
- 直接执行 `flow.hardened.py`。
- 展示 trace/录像。
- 管理公安业务流程状态。

RPA 能力通过 profile、skill、artifact rules 接入 daemon，而不是新增 RPA core。

### `apps/rpa-local-web`

RPA 本地 B/S 应用负责产品流程。

负责：

- 提供 RPA 操作界面。
- 管理“自然语言生成 / codegen 加固 / 本地验证”三个工作流。
- 调用 daemon API 创建 workspace/run。
- 订阅 daemon SSE 或轮询 run 状态。
- 调用本地 executor 执行 Playwright 脚本。
- 展示脚本、加固说明、运行日志、trace、录像。
- 为 RPA 多轮生成/修订组织业务上下文包，例如原始需求、本轮用户输入、表单答案、上一轮 draft DSL/脚本路径、探查摘要路径和当前阶段 metadata。
- 不读取 `SKILL.md` 具体内容，也不拼接最终发给 Claude Code 的完整 prompt；`codegen 上传加固闭环` 和 `自然语言生成闭环` 都以 `business-context` 作为主路径传 `currentPrompt` / `businessContext`，最终 prompt 始终由 daemon 注入 skill、side files、profile 约束后生成。

### `rpa-local-executor`

`rpa-local-executor` 是执行层模块，MVP 阶段不单独起一个平级服务。

它归属于 `apps/rpa-local-web` 的 BFF/server 层，负责：

- 启动 Python/Playwright 脚本。
- 传入 `config.json`、`--dry-run`、业务参数。
- 为每次执行创建独立运行目录。
- 控制超时、取消、stdout/stderr。
- 收集 trace、录像、下载文件、执行日志。
- 将执行结果返回给 RPA Web。
- 从 RPA Web per-execution 输入目录或导入流程包读取 DSL、脚本和配置模板；per-execution 输入目录由 RPA Web 通过 daemon artifact 下载 API 填充，不直接暴露 daemon workspace 路径给 executor API。
- 将每次执行的 screenshots、trace、video、downloads、execution-log 写入 RPA Web 管理的 per-execution 输出目录，而不是写回 daemon workspace `output/`。

MVP 边界确认：

- `rpa-local-executor` 不暴露独立 HTTP API，不单独监听端口。
- 前端不直接调用 Python/Playwright，也不直接管理 executor 子进程。
- `apps/rpa-local-web` 后端提供执行 API，并在内部调用 executor 模块。
- executor 只关心一次脚本执行：输入 DSL、脚本、config、运行参数和模式，输出事件、日志、截图和 artifacts。
- RPA Web 后端负责把 executor 的进程事件包装成前端可订阅的 SSE/HTTP API，并负责执行产物列表、下载和保留策略。
- daemon artifact API 只暴露 Claude Code 生成/加固产物，不暴露 executionId 下的 trace、录像、截图、下载文件。
- 后续如果需要更强隔离或更高并发，可以保持 RPA Web API 不变，把 executor 内部替换为独立服务或 worker。

需要明确区分两个 ID：

```text
daemon runId
  = Claude Code 生成/加固脚本的任务 ID

rpa executionId
  = 本地执行 flow.hardened.py 的任务 ID
```

同一个 RPA flow 可能先有一次 daemon run 生成脚本，然后有多次 execution 用于 verify、修复后复验和正式 run。

## Daemon Run 调用约定

`kind = generate | revise` 表达本次 run 的业务意图，`promptMode` 表达上下文来源。RPA Web 维护业务流程状态和跨轮上下文包，daemon 负责注入 skill、side files 和 profile 约束并组装最终 prompt。

| 场景 | kind | promptMode | skillId | businessContext 要点 |
| --- | --- | --- | --- | --- |
| 首次自然语言生成 | `generate` | `business-context` | `rpa-script-generate` | 原始需求、目标 URL、业务约束、当前阶段 metadata |
| 首次 codegen 上传加固 | `generate` | `business-context` | `playwright-rpa-harden` | codegen session、`inputFiles: ["input/flow.py"]`、录制来源、当前阶段 metadata |
| 用户回答 `<question-form>` 后继续更新同一 flow | `revise` | `business-context` | 原 skillId | `previousRunId`、上一轮 artifact paths、`formAnswers`、阶段 metadata |
| verify 失败后让 Claude Code 修复 | `revise` | `business-context` | `playwright-rpa-harden` 或 `rpa-script-generate` | execution failure、失败 step、截图/log/trace 路径、当前 DSL/script/config 路径 |

`revise` 不表示 daemon 自动推断历史，也不依赖 Claude Code CLI 的隐式续聊。每次 `revise` 都必须由 RPA Web 明确传入本轮需要的业务上下文和产物引用；daemon 只按通用规则保存对话、注入 skill、生成最终 prompt 并执行 run。

legacy `generate + skillId + prompt` 只保留为兼容旧客户端的路径，不作为 RPA MVP 主路径。

## 两种脚本生产流程

### 1. 自然语言生成

```text
用户输入流程描述、目标系统信息、约束
  -> rpa-local-web 创建/复用 workspace
  -> rpa-local-web 组织本轮业务上下文包
       currentPrompt: 用户本轮输入
       businessContext: 原始需求、历史摘要、表单答案、草稿 DSL/脚本路径、探查摘要路径、阶段 metadata
  -> rpa-local-web 调 daemon POST /api/runs
       promptMode: business-context
       kind: generate
       skillId: rpa-script-generate
  -> daemon 注入 skill、side files、profile 约束并组装最终 prompt
  -> daemon 启动 Claude Code
  -> Claude Code 产出 DSL 和脚本
  -> daemon 扫描生成/加固 artifacts
  -> rpa-local-web 展示产物
  -> 用户点击本地验证
  -> executor 运行 flow.hardened.py --dry-run
  -> rpa-local-web 展示执行结果和留痕
```

Claude Code 执行位置：daemon。

RPA 工作流编排位置：`apps/rpa-local-web`。

脚本实际执行位置：`apps/rpa-local-web` 的 executor 模块。

自然语言生成中的多轮确认不是依赖 Claude Code CLI 的隐式会话续聊。每一次用户确认、补充或修订都创建新的 daemon run；RPA Web 必须把足够的业务上下文、上一轮产物路径和表单答案传给 daemon，daemon 再统一注入 skill 和 profile 约束，生成本轮最终 prompt。

### 2. Playwright codegen 录制后加固

```text
用户在 RPA Web 输入目标 URL 并点击开始录制
  -> rpa-local-web 后端启动 Playwright codegen
       playwright codegen --target python -o <flowInputDir>/flow.py <targetUrl>
  -> 用户在 headed browser 中录制操作
  -> 用户关闭/结束 codegen，子进程退出
  -> rpa-local-web 校验 <flowInputDir>/flow.py 存在且非空
  -> rpa-local-web 通过 daemon POST /api/workspaces/:workspaceId/files 自动上传到 input/flow.py
  -> rpa-local-web 调 daemon POST /api/runs
       kind: generate
       promptMode: business-context
       skillId: playwright-rpa-harden
       businessContext: codegen session、inputFiles、录制来源、阶段 metadata
  -> daemon 注入 skill、side files、profile 约束并组装最终 prompt
  -> daemon 启动 Claude Code
  -> Claude Code 加固脚本
  -> daemon 扫描生成/加固 artifacts
  -> rpa-local-web 通过 daemon artifact API 下载 DSL/脚本到 per-execution 输入目录
  -> rpa-local-web 展示加固说明和脚本
  -> 用户点击本地验证
  -> executor 运行 per-execution 输入目录中的 flow.hardened.py --dry-run
  -> rpa-local-web 展示执行结果和留痕
```

MVP 直接实现 RPA Web 后端启动和管理 Playwright codegen。RPA Web 指定 `-o <flowInputDir>/flow.py`，所以它知道录制脚本的本地位置；录制结束后由 RPA Web 自动上传给 daemon。用户手动上传 `flow.py` 只作为后续 fallback 评估，不作为 MVP 主路径。

`codegen 上传加固闭环` 先只支持单文件 `flow.py`。如果 codegen 录制结果依赖多个 Python 模块、资源文件或复杂目录结构，先明确拒绝并提示不支持，后续再按多文件流程包能力处理。

### RPA Web 与 daemon 文件交换

RPA Web 是 daemon 的 HTTP 客户端，不能依赖 API 返回 daemon workspace 绝对路径。

- **输入方向：** `codegen 上传加固闭环` 由 RPA Web 后端启动 Playwright codegen 并生成本地 `<flowInputDir>/flow.py`，随后使用 daemon `POST /api/workspaces/:workspaceId/files` 自动上传到 `input/flow.py`。不要依赖共享文件系统作为产品 API contract。
- **输出方向：** daemon 生成/加固完成后，RPA Web 通过 `GET /api/runs/:runId/artifacts` 和 artifact download API 获取 `flow.dsl.json`、`flow.hardened.py`、`config.example.json` 等产物，并复制到 RPA Web 自己管理的 flow storage 或 per-execution 输入目录。
- **执行方向：** executor 只读取 RPA Web 准备好的 per-execution 输入目录或导入流程包，不直接读取 daemon workspace `output/` 路径。SaaS 分支未来可以保持同一 RPA Web/executor API，把 artifact 下载替换为对象存储或 worker 分发。

## 演示流程选择

首个 PoC 流程必须低风险、可重复、可解释：

- 不做登录，不依赖账号密码、验证码、CA/USB-Key 或客户真实认证环境。
- 不做真实写操作；如页面存在提交动作，verify 阶段必须 dry-run 或使用测试页面。
- 优先选择公开页面、内部 mock 页面或半真实只读页面。
- 下载文件必须可控，下载目录按 execution 独立创建。
- 页面步骤要能覆盖 RPA MVP 的关键能力：参数表单、点击/输入/选择、显式等待、断言、截图高亮、trace/日志、导入导出。
- codegen 上传加固路径作为先行演示主线；录制由 RPA Web 后端启动 Playwright codegen 并自动上传 `flow.py` 给 daemon。自然语言生成同属本次最终 MVP，按 `自然语言生成闭环` 实施切片接入。

这个约束只限制首个 MVP demo，不限制后续真实客户流程。真实流程中的登录、验证码、CA/USB-Key 和人工介入通过 DSL `manual` 字段和执行期配置逐步支持。

## 统一步骤 DSL / Schema 草案

步骤 DSL / JSON 是两种 RPA 脚本生产模式的共同中间层，不是自然语言生成专属产物。

```text
自然语言生成
  -> chrome-devtools-mcp 探查
  -> flow.dsl.json
  -> flow.py
  -> flow.hardened.py

Playwright codegen 录制
  -> input/flow.py
  -> 反抽 / 归一化 flow.dsl.json
  -> flow.hardened.py
```

### 与当前方案的兼容性结论

Notion 的 DSL 设计符合当前本地 B/S MVP 架构，但要按本仓库边界落地：

- **不污染通用 daemon：** DSL 是 artifact 和 skill 输入/输出，不进入 daemon core。daemon 只扫描、下载、保存 artifacts，不解释 RPA 业务语义。
- **支持两种上游：** 自然语言生成直接产出 DSL；codegen 路径从原始 `flow.py` 反抽并归一化 DSL。
- **支持前端可视化验证：** 前端步骤列表、当前步骤高亮、截图 bbox、日志都可以围绕 `steps[].id/name/target` 展示。
- **支持 verify / run 分离：** `write`、`manual`、`assert` 等字段能指导 executor 在 `verify + dry-run` 中暂停确认，在 `run` 中按配置执行。
- **支持流程包迁移：** `params` 和 `context` 把运行实例值从业务逻辑中拆出来，A 用户导出流程包时不携带 B 用户的本地配置和密钥。
- **不要求第一版做独立编译器：** Notion 提到的“编译器”在 MVP 中可以先由 `rpa-script-generate` / `playwright-rpa-harden` skill 和脚本模板承担；后续再沉淀为独立 compiler 模块。

### 设计目标

- **统一中间表示：** 录制与自然语言生成产出同一份 DSL，下游处理一致。
- **可编译：** 声明式描述动作、目标和期望；等待、重试、dry-run、幂等保护由模板/加固 skill/executor 生成。
- **可审计：** 每步自带 `id`、`name`、`action`、`target`，可映射审计日志字段。
- **可回归：** 整份 DSL 版本化；页面改版优先修 `target`，业务步骤尽量不动。
- **实例与逻辑解耦：** 地址、输入值、登录态、执行账号、留痕配置通过 `params` / `context` / `config` 注入，不写死在 DSL 或脚本中。

### 设计原则

- **声明式优先：** DSL 表达“做什么”，不表达具体 Python 控制流。
- **选择器语义化：** `target.by` 的枚举顺序就是选择器优先级：`role > label > placeholder > text > testid > id > css`。
- **绝对 XPath 例外化：** `xpath` 只允许作为临时/降级策略，并必须在加固报告中告警。
- **跑完不等于跑对：** 业务步骤必须有断言；没有断言的步骤不能视为加固完成。
- **单一事实源：** 前端高亮、审计、导入导出、回归验证都读 DSL，不再维护另一套步骤定义。

### 顶层结构

```jsonc
{
  "dsl_version": "rpa-dsl.v0.1",
  "flow_id": "case_query",
  "meta": {
    "title": "案件查询",
    "source": "codegen",
    "created_at": "2026-06-05T10:00:00+08:00"
  },
  "params": {
    "case_no": { "type": "string", "required": true, "mask": true }
  },
  "context": {
    "base_url": "${BASE_URL}",
    "storage_state": "secrets/storage_state.json",
    "default_timeout_ms": 15000
  },
  "steps": []
}
```

字段说明：

- `dsl_version`：DSL schema 版本，用于导入校验和后续迁移。
- `flow_id`：流程唯一标识，进入脚本命名、日志和流程包 manifest。
- `meta.source`：`codegen` 或 `nl`，用于追溯生成来源。
- `params`：运行时参数定义，只描述类型、必填、脱敏，不落实例值。
- `context`：部署实例配置引用，允许 `${ENV}` 占位，不写真实密钥。
- `steps`：业务步骤数组，是脚本编译、前端展示、审计、验证的核心。

### step 结构

```jsonc
{
  "id": "s3",
  "name": "提交查询",
  "action": "submit",
  "target": {
    "frame": ["#mainFrame"],
    "by": "role",
    "role": "button",
    "name": "查询",
    "filter": { "has_text": "查询" },
    "scope": "s2_result_panel"
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

核心字段：

- `id`：稳定步骤 id，前端事件、截图、高亮、审计日志都用它关联。
- `name`：用户可读步骤名。
- `action`：`navigate | click | input | select | submit | assert | wait | manual`。
- `target`：元素定位描述，支持 iframe 链、语义选择器、过滤和父容器限定。
- `value`：输入值引用，必须指向 `params` 或运行时参数，不能写真实敏感值。
- `wait`：动作前/后的等待条件，替代固定延时。
- `assert`：步末断言，证明“跑对”。
- `write`：写操作标记，用于 dry-run、二次确认、重试限制和审计。
- `idempotency_key`：写操作幂等保护依据，避免重试重复提交。
- `manual`：人工介入点，如 `captcha`、`ca_usbkey`、`login`。

MVP DSL v0.1 先冻结最小 schema，不追求覆盖所有网页形态：

- 顶层必须包含 `dsl_version`、`flow_id`、`meta`、`params`、`context`、`steps`。
- `params` 必须能驱动执行期参数表单，至少支持 `string`、`number`、`date`、`boolean`、`select`、`secret`。
- `steps[]` 必须包含 `id`、`name`、`action`，并在需要定位页面元素时包含 `target`。
- `target` MVP 必须覆盖 `by`、`frame`、`role/name`、`label`、`placeholder`、`text`、`testid`、`id`、`css`、`scope`。
- `wait` 至少支持 `before.visible`、`after.visible`、`after.url_changes`、`after.download`、`after.network_idle`。
- `assert[]` 至少支持 `visible`、`text_contains`、`url_contains`、`download_exists`。
- `write` / `manual` 是 verify 和 run 行为分岔的关键字段，不能省略语义。

### 字段与下游行为

| 维度 | DSL 表达 | 下游行为 |
| --- | --- | --- |
| 选择器 | `target.by` / `target.frame` / `target.scope` | 生成 `get_by_role`、`get_by_label`、`frame_locator` 等稳定定位；脆弱定位进入加固告警 |
| 等待 | `wait.before` / `wait.after` | 编译为显式等待、URL 等待、locator 可见等待，禁止固定 `sleep` |
| 断言 | `assert[]` | 编译为 `expect(...)`；verify 模式在前端展示断言结果 |
| 写操作 | `write` / `idempotency_key` | 生成 dry-run 分支、二次确认、有限重试、幂等保护 |
| 人工介入 | `action: manual` / `manual` | verify/run 中暂停，提示验证码、CA、USB-Key、登录等人工动作 |
| 审计 | `id` / `name` / `action` / `target` | 映射 JSONL 审计日志字段 |
| 前端高亮 | `id` / `name` / `target` | 前端步骤列表、当前步骤、高亮 bbox、每步截图都以 step id 关联 |
| 导入导出 | `dsl_version` / `params` / `context` | 导入时校验 schema，要求重新配置实例参数后再 verify |
| 回归修复 | 版本化 DSL | 页面改版时优先修 `target`，减少重新录制 |

### DSL 到 Playwright 的映射

- `target.by=role` + `role/name` -> `get_by_role(role, name=...)`。
- `target.by=label` -> `get_by_label(...)`。
- `target.by=placeholder` -> `get_by_placeholder(...)`。
- `target.by=text` -> `get_by_text(...)`，必要时加 `filter` / `scope`。
- `target.by=testid` -> `get_by_test_id(...)` 或约定的 `data-testid` locator。
- `target.frame[]` -> 逐层 `frame_locator(...)`。
- `wait` -> Playwright 显式等待。
- `assert[]` -> `expect(...)`。
- `write=true` -> `dry-run` 分支、审计日志、重试限制和幂等保护。
- `params` / `context` -> `config.json`、CLI 参数或环境变量。

### DSL 编译责任边界

MVP 阶段不在 `apps/daemon` 中实现独立 DSL 编译器。原因是 daemon 的定位是通用 agent runner，不应理解 RPA DSL 或内置 RPA 脚本生成逻辑。

MVP 中 DSL 到脚本的职责分配：

```text
rpa-script-generate / playwright-rpa-harden skill + templates
  -> 按 DSL 映射规则生成 output/flow.hardened.py
  -> 输出 config.example.json 和 hardening-report.md

rpa-local-executor
  -> 读取 flow.dsl.json 做可视化验证辅助
  -> 维护 stepId/name 与截图、高亮、日志、确认事件的映射
  -> 执行 flow.hardened.py，而不是重新编译完整脚本

apps/daemon
  -> 只运行 Claude Code、管理 run、SSE、logs、artifacts
  -> 不解释 DSL，不 import Playwright，不内置 RPA compiler
```

也就是说，MVP 先让 Claude Code 在 skill 约束和模板指导下产出确定性脚本；executor 用 DSL 做验证、展示和安全控制辅助。等 DSL 和脚本模板稳定后，再把高频、确定的映射规则沉淀为代码化 compiler。

后续 compiler 推荐位置：

```text
apps/rpa-local-web/src/server/compiler/
  dsl-to-playwright-python.ts
```

或在需要被 SaaS、本地 B/S 共同复用时抽成：

```text
packages/rpa-dsl-compiler/
```

不建议放到：

```text
apps/daemon/src/core/
```

这样可以保持 daemon 通用，同时给 RPA 产品层留下逐步代码化、确定化的演进路径。

### 参数化与流程泛化

RPA 脚本不能只固化一次录制时的常量。录制或自然语言生成后，需要把日期、单位、查询条件、下载类型等常量提升成运行参数，让脚本变成可复用流程。

```text
录制 / 自然语言生成
  -> 原始步骤 DSL
  -> 参数化泛化
  -> 可复用 DSL
  -> hardened script
```

参数化泛化由 Claude Code 在生成/加固阶段辅助完成，但日常执行不依赖 Claude Code。

生成/加固阶段：

```text
Claude Code
  -> 扫描录制脚本 / DSL 中的硬编码输入值、选择项、URL query、下载文件名
  -> 产出参数候选和 parameterization-report.md
  -> 在生成脚本前使用 AskQuestion 收集/确认变量参数
  -> 无真实 AskQuestion 工具时，输出等价的 <question-form> JSON
  -> RPA Web 渲染表单并收集用户答案
  -> RPA Web 创建新的 daemon run
       kind: revise
       promptMode: business-context
       skillId: 原 skillId
       currentPrompt: 根据用户确认继续参数化/加固
       businessContext: formAnswers、previousDaemonRunId、draftDslPath、draftScriptPath、原始需求、阶段 metadata
  -> daemon 注入 skill、side files、profile 约束并组装最终 prompt
  -> Claude Code 更新 flow.dsl.json.params 和 step.value 引用
  -> Claude Code 更新 flow.hardened.py
```

生成/加固期确认交互采用和 lanceDesign `kami-landing` 类似的约束：skill 明确要求 Claude Code **Use AskQuestion (or equivalent)**。这里的 AskQuestion 是交互意图和流程约束，不是 daemon 专用 `userQuestion` 事件；如果当前 Claude Code CLI 环境没有真实 AskQuestion 工具，Claude Code 必须手动输出等价的 `<question-form>` 文本协议。

MVP 先固定轻量版本化协议：

- `<question-form>` 必须声明 `version`、`id`、`title` 和 `questions`。
- `version` 先使用 `rpa-question-form.v0.1`。
- `questions[].type` 只支持 `radio`、`checkbox`、`select`、`text`、`textarea`。
- `questions[].id` 必须稳定，作为后续 `formAnswers` 的 key。
- 表单答案由 RPA Web 放入下一轮 run 的 `businessContext.formAnswers`，并可在 `currentPrompt` 中附带一份可读摘要，方便日志和复盘。

等价的 `<question-form>` 示例：

```html
<question-form id="rpa-parameterization" title="确认可变参数" version="rpa-question-form.v0.1">
{
  "version": "rpa-question-form.v0.1",
  "description": "我从录制/探查中发现这些固定值，请确认哪些以后执行时需要填写。",
  "questions": [
    {
      "id": "date_range",
      "label": "查询日期是否作为运行参数？",
      "type": "radio",
      "required": true,
      "options": [
        { "label": "是，每次执行都填写", "value": "param" },
        { "label": "否，固定在脚本里", "value": "constant" }
      ]
    }
  ]
}
</question-form>
```

职责分工：

- **Claude Code / skill**：在生成 `flow.py` / `flow.hardened.py` 前，先使用 AskQuestion 收集/确认变量参数；无真实 AskQuestion 工具时，输出合法 `<question-form>` JSON，并在表单后停止本轮生成。
- **daemon**：只透传 assistant 文本、SSE、日志和 artifacts，不理解 question form，也不挂起 RPA 业务状态；daemon 根据 `currentPrompt` / `businessContext` 注入 skill、side files 和 profile 约束后组装最终 prompt。
- **RPA Web**：解析 assistant 文本中的 `<question-form>`，渲染 radio / checkbox / select / text / textarea；用户提交后保存表单答案，并把表单答案、上一轮产物路径和阶段 metadata 传给下一轮 daemon run。MVP 不支持 `direction-cards`，后续需要更强视觉选择时再加。
- **Claude Code 下一轮**：读取 daemon 注入后的业务上下文中的 `[form answers — rpa-parameterization]` / `businessContext.formAnswers`、上一轮 artifact paths 和阶段 metadata，继续更新 `parameterization-report.md`、`flow.dsl.json` 和脚本。

用户提交后的可读摘要示例：

```text
[form answers — rpa-parameterization]
version: rpa-question-form.v0.1
- date_range: param
```

日常执行阶段：

```text
用户点击执行
  -> RPA Web 读取 flow.dsl.json.params
  -> 前端渲染日期、文本、下拉框等表单
  -> 用户填写 / 确认参数
  -> 生成 run.params.json
  -> executor 校验参数
  -> flow.hardened.py 读取参数并执行
```

不推荐日常执行时每次都让 Claude Code 重新分析脚本需要哪些参数。那会让生产执行变慢、不稳定，并重新依赖 LLM。默认路径应是 DSL params 驱动前端表单。

因此 MVP 中有两种表单：

- **生成期确认表单**：由 Claude Code 按 AskQuestion 流程提出；无真实 AskQuestion 工具时输出 `<question-form>`，用于页面分支、字段含义、写操作风险、参数化候选等不确定事项确认。
- **执行期参数表单**：由 RPA Web 直接读取 `flow.dsl.json.params` 渲染，用于每次运行前填写 `run.params.json`，不依赖 Claude Code。

参数定义示例：

```jsonc
{
  "params": {
    "start_date": {
      "type": "date",
      "label": "开始日期",
      "required": true,
      "default": "today-7d",
      "mask": false
    },
    "end_date": {
      "type": "date",
      "label": "结束日期",
      "required": true,
      "default": "today",
      "mask": false
    },
    "org_code": {
      "type": "select",
      "label": "单位",
      "required": true,
      "options": [
        { "label": "南京市公安局", "value": "320100" }
      ]
    }
  }
}
```

执行参数文件示例：

```json
{
  "start_date": "2026-06-01",
  "end_date": "2026-06-05",
  "org_code": "320100"
}
```

脚本执行建议优先使用参数文件，而不是大量 CLI 参数：

```bash
python flow.hardened.py --mode run --params run.params.json
python flow.hardened.py --mode verify --dry-run --params run.params.json
```

自然语言辅助填参可以作为增强能力，例如用户输入“下载昨天全市数据”，由规则或 Claude Code 预填 `run.params.json`，但仍需用户确认。它是填表辅助，不是执行必需链路。

MVP 参数化最小闭环：

1. 生成/加固 run 输出 `parameterization-report.md`。
2. 前端展示候选常量，例如日期、单位、查询条件、下载类型。
3. 用户勾选哪些变成参数，并设置 label/type/options/default。
4. 用户确认后再跑一次 `revise + skillId + business-context`，由 RPA Web 传入表单答案、上一轮 run id、上一轮 artifact paths 和阶段 metadata，更新 DSL 和脚本。
5. verify 模式用一组不同参数验证脚本泛化成功。

### MVP 落地策略

第一版不追求完备 schema。从一条真实 PoC 流程反向定义最小 DSL，先验证 codegen 上传加固最小闭环：

```text
codegen flow.py
  -> flow.dsl.json
  -> flow.hardened.py
  -> verify + dry-run 可视化验证
  -> 保存 executionId 下的截图、日志和可选 trace/录像
```

同一最终 MVP 中的 `自然语言生成闭环` 继续完成：

```text
自然语言描述
  -> chrome-devtools-mcp 探查
  -> <question-form> 确认不确定信息和参数化候选
  -> flow.dsl.json
  -> flow.hardened.py
  -> verify + dry-run 可视化验证
```

`.rpa.zip` 导入导出、headless 正式 run、trace/录像留痕属于本次最终 MVP 的 `流程复用与执行闭环`，但不阻塞 codegen 上传加固先行演示闭环。

`codegen 上传加固闭环` 和 `自然语言生成闭环` 都使用 `business-context` 作为主路径。daemon 的 legacy `generate + skillId + prompt` 只作为旧客户端兼容能力，不作为 RPA MVP 闭环的实现路径。

MVP 先支持这些 action：`navigate`、`click`、`input`、`submit`、`assert`、`manual`。`select`、复杂表格编辑、多分支流程、多窗口流程后置。

`flow.dsl.json` 应配套 JSON Schema。导入流程包、加固前、执行前都要校验 schema；校验失败应给出可读错误，不进入 executor。

## Chrome DevTools MCP 探索期工具

自然语言生成模式中，推荐让 Claude Code 通过 `chrome-devtools-mcp` 探查目标网页，再生成步骤 DSL 和 Playwright Python 脚本。

它的定位是：

```text
chrome-devtools-mcp = 探索期工具
Playwright Python 脚本 = 最终确定性执行产物
```

不要把 `chrome-devtools-mcp` 当成生产 RPA 重放引擎。生产重放仍然执行 `flow.hardened.py`，这样更确定、可审计，也能脱离 LLM。

### 内网可运行性

`chrome-devtools-mcp` 可以在内网工作，前提是它以本地工具方式部署。

关键点：

- 它连接的是本机 Chrome / Chrome DevTools Protocol。
- 目标网页能否访问，取决于运行 Chrome 的客户本地机器是否能访问该业务系统。
- 内网不能依赖 `npx chrome-devtools-mcp@latest` 在线拉包。
- 部署包应提供固定版本，或使用客户内网 npm registry / 离线包。
- 默认联网行为需要关闭，包括 usage statistics、update checks、可能访问外部性能数据的能力。

建议启动参数 / 环境变量：

```text
chrome-devtools-mcp
  --isolated
  --no-usage-statistics
  --no-performance-crux

CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1
CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1
```

如果需要连接已有 Chrome，应使用 `--browser-url=http://127.0.0.1:<port>`，并确保 Chrome 以非默认 user data dir 启动。不要默认连接用户日常浏览器 profile。

### 与 daemon 的关系

`chrome-devtools-mcp` 不进入 daemon core，daemon core 也不理解它的 RPA 用途。但仅依赖系统默认 Claude Code 交互会话的动态 plugin / MCP 状态不够稳定：daemon 以 `claude -p` 非交互方式、临时 workspace `cwd` 和 profile 环境启动 Claude Code 时，必须能显式加载同一套 MCP 配置。

后续应补一个通用 profile 能力，而不是 RPA 专属字段：

```json
{
  "profiles": [
    {
      "id": "rpa-local",
      "claudeConfigDir": "/home/orangels/.claude",
      "mcpConfigPaths": [
        ".claude-runner/profiles/rpa-local/mcp.chrome-devtools.json"
      ]
    }
  ]
}
```

daemon 启动 Claude Code 时把这些 profile-owned config 文件作为 `--mcp-config <file>` 传入。这样 `rpa-local` profile 可以稳定加载 `chrome-devtools-mcp`，其他业务 profile 也能复用同一机制加载自己的 MCP server。RPA Web 仍只选择 `profileId` 和 `skillId`，不向单次请求注入任意 MCP 配置。

`mcp.chrome-devtools.json` 的内容由 profile/部署配置管理，例如固定版本、关闭联网统计和更新检查，并指定可用的 Chrome / Chromium：

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@1.1.1",
        "--no-usage-statistics",
        "--no-update-checks",
        "--no-performance-crux",
        "--executablePath=/path/to/chrome",
        "--chromeArg=--no-sandbox",
        "--userDataDir=/path/to/rpa-chrome-devtools-profile"
      ],
      "env": {
        "DISPLAY": ":2",
        "CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS": "1",
        "CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS": "1"
      }
    }
  }
}
```

实现时还应提供同环境预检：用 daemon 即将使用的 `CLAUDE_CONFIG_DIR`、`PATH`、`DISPLAY`、`--mcp-config` 和 `cwd` 验证 `chrome-devtools-mcp` 能连接成功并暴露工具；失败时 RPA Web 应显示 `chrome-devtools-mcp unavailable` 并允许按降级策略继续或终止。

```text
rpa-local-web
  -> daemon POST /api/runs
     profileId: rpa-local
     skillId: rpa-script-generate
     -> daemon 按 profile 启动 Claude Code
        -> daemon 传入 profile.mcpConfigPaths 对应的 --mcp-config
        -> Claude Code 读取该 claudeConfigDir / mcp-config 下的 MCP 配置
           -> chrome-devtools-mcp
              -> 本机专用 Chrome profile
                 -> 探查内网页面
        -> 输出 flow.dsl.json / flow.py / flow.hardened.py
```

daemon 仍然不理解 RPA 业务语义，也不理解 MCP server 的业务用途。它只负责选择 profile、准备 workspace、staging skill、启动 Claude Code 和扫描生成/加固 artifacts。

### 安全约束

- 探索期浏览器必须使用独立 profile，优先使用 `--isolated` 或每个 run 独立 `--user-data-dir`。
- remote debugging port 只能绑定本机回环地址，不对局域网开放。
- 探索结束后关闭浏览器或清理临时 profile。
- 不在被调试浏览器中打开无关敏感网站。
- 不把浏览器 profile、cookie、storage_state 当作 artifact 暴露给前端或下载 API。
- Chrome / Chromium 兼容性需要在目标国产系统上实测。

## Skill 设计

MVP 需要至少两个 skill：

```text
apps/daemon/skills/
  rpa-script-generate/
    SKILL.md
    references/
    templates/
  playwright-rpa-harden/
    SKILL.md
    references/
      selectors.md
      audit.md
      config.md
    templates/
      flow.hardened.py.tmpl
```

`rpa-script-generate` 负责自然语言生成链路：

- 理解用户目标、目标系统入口、业务输入、写操作风险。
- 引导用户补充登录态、验证码、CA、USB-Key、人工介入点等约束。
- 使用 `chrome-devtools-mcp` 探查页面结构、菜单、表单、按钮、iframe、弹窗、网络状态。
- 不确定的页面分支、字段含义、敏感动作必须先用 AskQuestion 收集确认；无真实 AskQuestion 工具时，通过 `<question-form>` 逐步向用户确认，不猜业务含义。
- 先产出 `flow.dsl.json`，再生成 `flow.py` / `flow.hardened.py` 草稿。
- 输出 `config.example.json`、人工介入点、风险清单和后续加固建议。

`playwright-rpa-harden` 负责 codegen / DSL 加固链路：

- 从 Playwright codegen 原始 `flow.py` 反抽并归一化 `flow.dsl.json`。
- 如果输入已有 `flow.dsl.json`，优先使用 DSL，原始脚本只作为辅助证据。
- 稳定选择器。
- 显式等待。
- 异常重试。
- 登录态/人工介入点标注。
- 每步断言。
- `dry_run`。
- 审计日志。
- 脚本支持 trace/录像开关，但实际 trace/录像由 executor 在 verify/run 阶段生成和保存。
- 参数化配置。
- 参数化候选和高风险动作需要确认时，先用 AskQuestion；无真实 AskQuestion 工具时输出 `<question-form>`，由 RPA Web 渲染后回传答案。
- 输出 `flow.hardened.py` 和 `hardening-report.md`。

## Profile 和 artifact rules

RPA MVP 使用独立 profile，例如：

```text
rpa-local
```

该 profile 的特点：

- `skillRoots` 指向 RPA skills。
- `allowedSkillIds` 包含 `rpa-script-generate` 和 `playwright-rpa-harden`。
- `profileConcurrency` 初期建议为 `1`。
- `permissionMode` 由本地受控配置决定，不能由请求覆盖。
- `artifactRules` 只覆盖 Claude Code 生成/加固产物，例如脚本、DSL、配置模板和报告。
- `chrome-devtools-mcp` 通过该 profile 使用的 Claude Code `claudeConfigDir` / MCP 配置启用；codegen 上传加固阶段不依赖它，自然语言生成阶段再正式启用。

artifact rule 建议：

```text
output/flow.dsl.json
output/flow.py
output/flow.hardened.py
output/config.example.json
output/parameterization-report.md
output/hardening-report.md
```

其中 `flow.dsl.json`、`flow.hardened.py`、`config.example.json`、`parameterization-report.md`、`hardening-report.md` 是生成/加固阶段必需产物。

verify/run 阶段产物由 RPA Web 的 execution storage 管理，例如：

```text
executions/<executionId>/screenshots/**/*
executions/<executionId>/trace.zip
executions/<executionId>/videos/**/*
executions/<executionId>/downloads/**/*
executions/<executionId>/execution-log.jsonl
```

这些执行产物通过 RPA Web 执行 API 列出和下载，不进入 daemon artifact rules。

daemon 只按规则扫描生成/加固产物，不解释 RPA 业务语义。

## 本地 B/S 运行形态

MVP 本地启动形态：

```text
pnpm dev:daemon
pnpm dev:rpa-local-web
```

后续可演进为单命令：

```text
rpa-local --host 127.0.0.1 --port 17891
```

最终客户本地部署形态参考 lanceDesign：

```text
本地 daemon 进程
本地 web 进程
浏览器访问本地 web
daemon 调 Claude Code
executor 调 Python/Playwright
数据留在客户本地
```

国产系统兼容性目标：

- 前端只要求现代浏览器。
- 后端优先使用 Node + Python + Playwright 的跨平台能力。
- Claude Code 运行方式按目标系统实际支持情况配置。
- 内网模型通过 Anthropic-compatible 网关配置到 daemon profile。
- Playwright 执行浏览器 MVP 默认优先使用 bundled Chromium，减少客户机器 Chrome 版本差异。
- 同时预留本机 Chrome / Chromium 可执行路径配置，用于国产系统或客户指定浏览器场景。
- 国产系统兼容性需要尽早单独验证：Node、Python、Playwright 浏览器安装、headed 模式、截图、trace、下载目录都要覆盖。

## 可视化验证与执行模式

可视化演示主要服务于脚本生命周期中的生成后首次验证、修复确认和人工接管，不是日常自动执行的必选路径。

MVP 推荐先做：

```text
真实浏览器窗口：给当前操作元素注入临时高亮，用户肉眼可看
RPA Web：显示步骤列表 + 当前步骤截图 + 截图高亮 + 日志
```

不要求第一版实现完整 CDP screencast。第一版可以通过每步截图、元素 bbox、执行事件流在前端做准实时验证；同时在本机打开 headed browser，让用户看到真实页面执行过程。

### 运行模式

脚本执行分三类模式：

```text
verify
  headed browser
  页面内高亮
  每步截图
  前端步骤流
  dry-run 默认开启
  用户逐步确认

dry-run
  headed 或 headless 都可
  只定位 / 填表 / 断言
  不提交写操作
  生成 trace / 日志
  可不逐步确认

run
  默认 headless
  不展示实时画面
  保存审计日志、trace、录像
  写操作按配置执行
```

MVP 优先支持：

- `verify`：用于用户生成或修复脚本后的首次验证，默认 `headed + highlight + per-step screenshot + dry-run + stepConfirm`。
- `run`：用于脚本确认后的日常执行，默认 `headless + audit log + trace/video`。

`dry-run` 是一个开关，可以叠加到 `verify` 或 `run`。例如生产执行前可以先 `run + dryRun=true` 做无提交检查。

### executor 参数建议

executor API 可抽象为：

```json
{
  "mode": "verify",
  "headless": false,
  "dryRun": true,
  "stepConfirm": true,
  "highlight": true,
  "screenshots": "per-step",
  "trace": true,
  "video": true
}
```

脚本 CLI 可对应为：

```bash
python flow.hardened.py --mode verify --dry-run
python flow.hardened.py --mode run --headless
python flow.hardened.py --mode run --headed
```

### RPA Web 执行 API

MVP 中执行 API 属于 `apps/rpa-local-web` 后端，不属于 daemon，也不属于独立 executor 服务。

建议先固定以下接口：

```text
POST /api/rpa/executions
GET  /api/rpa/executions/:executionId
GET  /api/rpa/executions/:executionId/events
POST /api/rpa/executions/:executionId/cancel
GET  /api/rpa/executions/:executionId/logs
GET  /api/rpa/executions/:executionId/screenshots/:fileName
GET  /api/rpa/executions/:executionId/artifacts
GET  /api/rpa/executions/:executionId/artifacts/:artifactId/download
```

执行状态先固定为：

```text
queued | running | succeeded | failed | canceled
```

创建执行请求示例：

```json
{
  "flowId": "case_query",
  "workspaceId": "ws_123",
  "daemonRunId": "run_123",
  "inputSource": {
    "type": "daemon-artifacts",
    "dslArtifactId": "art_dsl_001",
    "scriptArtifactId": "art_script_001",
    "configArtifactId": "art_config_001"
  },
  "mode": "verify",
  "headless": false,
  "dryRun": true,
  "stepConfirm": true,
  "params": {
    "case_no": "demo-001"
  }
}
```

`daemonRunId` 只是可选关联字段，用于从 daemon 生成/加固 run 追溯到本次 execution。导入 `.rpa.zip` 后执行、本地已有流程执行、或后续从 SaaS 下发流程时，可以没有 `daemonRunId`。

`inputSource.type` 先固定为三类：

- `daemon-artifacts`：从 daemon run 的 artifact list/download API 获取 DSL、脚本和配置模板；`codegen 上传加固闭环` 的验证使用这一类。
- `imported-package`：从已导入的 `.rpa.zip` 流程包读取 DSL、脚本和配置模板；导入导出阶段使用这一类。
- `local-flow`：从 RPA Web 已保存的本地流程版本读取 DSL、脚本和配置模板；脚本确认后日常执行使用这一类。

RPA Web 后端收到 `inputSource.type = daemon-artifacts` 后，应先通过 daemon artifact download API 把 DSL、脚本和配置模板复制到本次 execution 的输入目录，再把该本地输入目录交给 executor。executor API 不接受 daemon workspace 绝对路径，也不要求前端知道 daemon workspace 内部布局。

响应示例：

```json
{
  "executionId": "exec_123",
  "status": "queued"
}
```

执行产物列表响应示例：

```json
{
  "executionId": "exec_123",
  "artifacts": [
    {
      "artifactId": "art_trace_001",
      "type": "trace",
      "fileName": "trace.zip",
      "relativePath": "trace.zip",
      "size": 102400,
      "createdAt": "2026-06-05T10:00:00+08:00",
      "downloadable": true
    }
  ]
}
```

执行 artifact 类型先固定为：`screenshot`、`trace`、`video`、`log`、`download`、`report`。下载接口必须只接受 RPA Web 已登记的 `artifactId`，不能让前端传任意路径。

### 前端验证事件

executor 执行时向 RPA Web BFF 发事件，前端基于 DSL 展示当前步骤。为了避免和 daemon `runId` 混淆，执行生命周期事件使用 `execution.*` 前缀，步骤事件使用 `step.*` 前缀：

```json
{
  "type": "step.started",
  "executionId": "exec_123",
  "stepId": "step_003",
  "name": "点击查询"
}
```

截图和高亮事件：

```json
{
  "type": "step.screenshot",
  "executionId": "exec_123",
  "stepId": "step_003",
  "screenshot": "screenshots/step_003.png",
  "highlight": {
    "selector": "button[name='查询']",
    "bbox": { "x": 120, "y": 300, "width": 80, "height": 32 }
  }
}
```

MVP 事件类型先固定为：

- `execution.started`
- `step.started`
- `step.screenshot`
- `step.completed`
- `step.failed`
- `artifact.created`
- `execution.canceled`
- `execution.completed`
- `execution.failed`

真实浏览器窗口内可以由 executor 注入临时 overlay / outline；RPA Web 前端则在每步截图上绘制高亮框。这样用户既能看真实浏览器，也能在 Web 操作台中看到步骤、截图、日志和断言结果。

## 安全和隔离

本地 B/S MVP 不声明强 sandbox。

安全边界：

- 客户本地部署环境、profile、调用方视为可信。
- daemon 目录隔离仍按当前设计执行。
- 每个 workspace/run 独立目录。
- executor 每次执行使用独立 working directory。
- executor 从 RPA Web per-execution 输入目录或导入流程包读取 DSL、脚本和配置模板；per-execution 输入目录由 RPA Web 通过 daemon artifact download API 或导入包解压生成。
- daemon artifact API 不暴露 executionId 下的 trace、录像、截图、下载文件和执行日志。
- 不复用业务系统 cookie/storage，除非用户显式配置 `storage_state`。
- `storage_state`、账号密码、token、cookie、CA/USB-Key 文件属于本地敏感配置，不进入 `.rpa.zip`，也不作为普通 artifact 暴露下载。
- 下载目录、trace 目录、录像目录按 execution 独立创建，执行结束后由本地留痕策略决定保留或清理。
- 写操作默认支持 `dry_run`。
- 敏感动作应在脚本中保留确认点或人工介入点。

需要避免：

- API 响应暴露本地绝对路径。
- 脚本硬编码账号、密码、token、CA 凭据。
- 在默认导出流程中夹带 `storage_state`、trace、录像或真实下载文件。
- 不同 execution 共用下载目录、trace 目录、录像目录。
- executor 长时间挂住不退出。

## RPA 流程包导入 / 导出

需要支持把 A 用户生成并验证过的通用流程导出给 B 用户使用。导入导出的单位不是单个 Python 脚本，而是 RPA 流程包。

导入导出是本次最终 MVP 的流程包能力，但不是 codegen 上传加固先行演示闭环的前置条件。建议先完成 codegen -> DSL/脚本 -> verify dry-run，再实现 `.rpa.zip` 导出、导入和导入后重新 verify。

推荐包格式：

```text
case-query.rpa.zip
+-- manifest.json
+-- flow.dsl.json
+-- flow.hardened.py
+-- config.example.json
+-- parameterization-report.md
+-- hardening-report.md
+-- README.md
+-- samples/
+   +-- step-001.png
+   +-- step-002.png
+-- validation/
+   +-- last-verify-report.json
+```

`manifest.json` 记录流程包元数据：

```json
{
  "schemaVersion": "rpa-package.v0.1",
  "flowId": "case_query",
  "name": "案件查询流程",
  "description": "根据案件编号查询案件信息",
  "createdAt": "2026-06-05T10:00:00+08:00",
  "generator": {
    "mode": "codegen",
    "skillId": "playwright-rpa-harden"
  },
  "dsl": {
    "version": "rpa-dsl.v0.1",
    "path": "flow.dsl.json"
  },
  "artifacts": {
    "dsl": "flow.dsl.json",
    "script": "flow.hardened.py",
    "configTemplate": "config.example.json",
    "parameterizationReport": "parameterization-report.md",
    "hardeningReport": "hardening-report.md"
  },
  "params": {
    "schemaPath": "flow.dsl.json#/params",
    "requiresUserInput": true
  },
  "requirements": {
    "runtime": "python-playwright",
    "executorMinVersion": "0.1.0",
    "browser": "playwright-chromium",
    "browserChannel": null,
    "manualIntervention": []
  },
  "checksums": {
    "flow.dsl.json": "sha256:...",
    "flow.hardened.py": "sha256:..."
  }
}
```

MVP manifest 至少要表达：流程 id/name/version、DSL 路径、脚本路径、参数 schema、生成 skill 信息、executor 最低版本、浏览器要求和关键文件 checksum。

### 导出规则

- 导出 `flow.dsl.json`、`flow.hardened.py`、`config.example.json`、`parameterization-report.md`、`hardening-report.md` 和 `manifest.json`。
- 可选导出脱敏后的样例截图和验证报告。
- 默认不导出 trace/录像，除非用户显式选择并确认已脱敏。
- 不导出账号、密码、token、cookie、`storage_state`、CA/USB-Key 相关文件。
- 不导出真实业务输入数据；示例参数只能使用占位符或脱敏值。

### 导入规则

B 用户导入流程包时不能直接运行 A 用户配置。导入流程应为：

```text
上传 .rpa.zip
  -> 校验 manifest/schema
  -> 展示 flow.dsl.json 步骤
  -> 要求 B 用户配置 base_url、账号角色、storage_state、业务参数
  -> 默认进入 verify + dry-run
  -> 验证通过后保存为 B 用户本地流程
```

导入后默认不能直接生产执行。必须先完成 `verify`，至少确认目标系统入口、关键选择器、人工介入点和写操作风险。

### 与 DSL 的关系

流程包迁移依赖 `flow.dsl.json`。前端用 DSL 展示步骤和风险，executor 用 DSL 做步骤事件和高亮映射，Claude Code 后续也可以基于 DSL 做修复和重新加固。

## 与 SaaS 后续分支的关系

本地 B/S MVP 和 SaaS 后续版本共享：

- 步骤 DSL。
- RPA skills。
- hardened 脚本模板。
- artifact 命名规范。
- 审计日志字段。
- 生成/加固 prompt 约束。

差异只在 executor：

```text
local B/S MVP executor = 本地 Python/Playwright 子进程
SaaS executor = server worker / Browserless / container worker
```

因此 MVP 实现时要避免把 executor 假设写死进 DSL 或 skill。脚本产物应能在本地或 SaaS worker 中运行。

## 风险

### daemon 被产品逻辑污染

风险：为了快速 demo，在 daemon core 里新增 RPA route、RPA service、Playwright 执行逻辑。

对策：RPA 逻辑全部放 `apps/rpa-local-web`；daemon 只接受 profile/skill/artifact 配置。

### 本地环境差异大

风险：Windows、国产 Linux、浏览器、Python、Playwright、Claude Code 支持情况不同。

对策：MVP 先在明确环境跑通；执行器做依赖检查和可读错误；后续再做安装/诊断工具。

### codegen 自动启动复杂

风险：从 Web 后端启动 headed codegen 涉及窗口、权限、显示环境。

对策：MVP 直接实现 RPA Web 后端启动 Playwright codegen；录制状态、取消、子进程退出和 `flow.py` 校验要给出可读错误。手动上传 `flow.py` 只作为后续 fallback 评估。

### 执行和生成混淆

风险：把脚本验证也塞进 Claude Code run，导致状态、取消、日志、trace 控制不清晰。

对策：Claude Code run 只负责生成/加固；脚本执行由 executor 管。

## MVP 功能清单

本节列出的是本次最终 MVP 的目标和实施切片。实施切片用于降低实现风险，不代表裁剪最终目标。

### MVP 实施切片：codegen 上传加固闭环

1. 新增 `apps/rpa-local-web`。
2. RPA Web 能配置 daemon URL 和 API key。
3. RPA Web 能创建/复用 `rpa-local` workspace。
4. RPA Web 后端启动 Playwright codegen，指定 `-o <flowInputDir>/flow.py`，录制结束后校验 `flow.py` 存在且非空。
5. RPA Web 通过 daemon `POST /api/workspaces/:workspaceId/files` 自动上传 `flow.py` 到 `input/flow.py`。
6. 使用 `generate + business-context + playwright-rpa-harden` 提交 codegen 加固 run，由 daemon 注入 skill、side files 和 profile 约束。
7. 支持 SSE 展示 Claude Code 加固过程。
8. 支持列出和下载 daemon 生成/加固 artifacts：`flow.dsl.json`、`flow.hardened.py`、`config.example.json`、`parameterization-report.md`、`hardening-report.md`。
9. 支持 executor 本地运行 `flow.hardened.py --dry-run`。
10. 支持 execution 状态、SSE 事件、取消、stdout/stderr、每步截图和执行日志。
11. 支持 RPA Web 执行 artifact 列表和下载，至少覆盖截图和执行日志；trace/录像可作为该切片的增强项。

### MVP 实施切片：自然语言生成闭环

1. 复用已落地的 daemon `business-context` / `revise + skillId` 能力，用于同一业务 skill 的多轮确认和修订。
2. 支持自然语言提交生成 run，使用 `generate + business-context + rpa-script-generate` 和 `chrome-devtools-mcp` 探查页面。
3. 支持 AskQuestion 等价协议：解析 Claude Code 输出的 `<question-form>`，渲染表单，并通过下一轮 `revise + business-context + rpa-script-generate` 回传答案。

### MVP 实施切片：流程复用与执行闭环

1. 支持执行期参数表单：RPA Web 根据 `flow.dsl.json.params` 渲染组件并生成 `run.params.json`。
2. 支持 `.rpa.zip` 导出、导入和导入后重新 verify。
3. 支持 confirmed flow 的 headless run 模式、trace/录像留痕和保留策略。
4. 文档明确本地 B/S MVP 与 SaaS 后续分支的复用边界。

## RPA Web UI 配置与健康状态

- 顶部 `Daemon` 状态读取 `GET /api/rpa/daemon/health`，并在 daemon 不可达时显示 degraded/error state。
- `Settings` 页读取 `GET /api/rpa/config` 和 `GET /api/rpa/daemon/health`，展示 daemon base URL、默认 profile、本地 storage root、codegen command、浏览器/display 配置提示，以及 daemon 连接失败时的可读错误。
- 这些 UI 能力只属于 `apps/rpa-local-web`，不得把 RPA 专属健康状态或配置语义下沉到 `apps/daemon` core。

## 已落地的 skill 草案

第一版 RPA skill 已放在 daemon-managed skills 目录中，作为 Claude Code 生成 artifacts 的流程约束，不改变 daemon 的通用 agent runner 定位：

- `apps/daemon/skills/rpa-script-generate/`：自然语言描述 -> 页面探查 -> 用户确认 -> 参数化 -> `flow.dsl.json` -> Playwright 脚本草稿。
- `apps/daemon/skills/playwright-rpa-harden/`：Playwright codegen 脚本或已有 DSL -> DSL 归一化 -> 选择器、等待、断言、dry-run、审计、参数化加固 -> `flow.hardened.py`。

这两个 skill 都要求 DSL 作为前端展示、验证截图、审计、导入导出和脚本生成的单一事实源。MVP 阶段仍不在 `apps/daemon/src` 中实现独立 DSL compiler。
