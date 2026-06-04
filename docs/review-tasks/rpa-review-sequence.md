# RPA MVP Review 顺序临时任务清单

日期：2026-06-05

用途：把当前 RPA MVP 相关文档和 skill 初稿拆成 4 轮让 Claude Code review，避免一次性 review 内容过大、上下文混杂。

## Review 通用要求

每一轮 review 都需要先和 Claude Code 对齐任务目标。不要只把文件丢给 CC，否则它可能按普通文档润色或泛泛代码审查来处理。

每轮 prompt 都应明确：

1. 本轮 review 的目标。
2. 本轮 review 的文件边界。
3. 本轮 review 结果的用途。
4. 本轮明确不要 review 或不要建议的内容。

通用说明可放在每轮 prompt 开头：

```text
本轮 review 是架构/边界/实现风险 review，不是文档润色，也不是要求你直接改代码。
请严格限制在本轮文件范围内，不要扩展到后续阶段。
review 结果会用于后续 implementation plan，请优先指出职责边界、遗漏风险、过度设计和实现阻塞点。
```

## Review 总顺序

1. 通用 daemon 能力 review。
2. RPA 产品架构 review。
3. RPA skill 初稿 review。
4. RPA 调试复盘扩展 review。

依赖关系：

```text
通用 daemon 能力
  -> RPA 本地 B/S 产品架构
    -> RPA 两个 skill 初稿
      -> RPA 专属调试复盘扩展
```

## Review 1：通用 daemon 能力

### 文件范围

- `docs/daemon-conversation-context-design.md`
- `docs/business-skill-observability-design.md`

### 任务目标对齐

可直接放到本轮 prompt 开头：

```text
任务背景：
我们正在设计一个通用 Claude Code agent runner daemon。当前要扩展它的原生会话能力、prompt/context 组织能力，以及业务 skill 调试复盘能力。这个 daemon 后续会被多个业务复用，不只服务 RPA。

本轮 review 的目标：
只确认 daemon 通用能力的设计边界是否正确，尤其是 daemon 应该负责哪些通用能力、哪些业务上下文组织权应该留给业务层、哪些观测/复盘能力应该做成通用底座、哪些内容不应该进入 daemon core。

本轮 review 的结果用途：
review 输出会用于后续 implementation plan，暂时不要求你直接修改代码或文档。
```

### Review 目标

确认 daemon 作为通用 Claude Code agent runner 的扩展方向是否正确，是否能支撑多业务 skill，而不是被 RPA 业务污染。

### 重点问题

- daemon 是否仍然保持通用，不引入 RPA 专属语义？
- `business-context` / `daemon-composed` 两种 prompt 模式是否合理？其中业务层只提供业务上下文，最终 prompt 由 daemon 注入 skill instructions、side files 路径和 profile 运行约束后生成。
- conversation、message、run、prompt snapshot 的职责划分是否清楚？
- prompt snapshot / skill snapshot / side files manifest 是否应该由 daemon 记录？
- review bundle 基础结构是否适合所有业务 skill 复用？
- `collectionMode = lite | diagnostic | review` 是否合理，且是否与 `eventVisibility = quiet | normal | debug` 解耦？
- 日志体积、token 占比、脱敏、权限和保留周期是否有遗漏？
- `kind × promptMode × skillId` 合法性矩阵是否清楚？
- 非 legacy 模式下 `runs.prompt = currentPrompt`、user message content = `currentPrompt` 的映射是否合理？
- `collectionMode` 是否有 profile/client 权限封顶，避免低权限调用方驱动敏感材料落盘？
- API 和数据模型扩展是否过度设计或不足？

### 期望输出

- 通用 daemon 扩展风险清单。
- 必须调整的职责边界。
- 需要补充到后续 implementation plan 的事项。

## Review 2：RPA 产品架构

### 文件范围

- `docs/rpa-local-bs-mvp-design.md`

### 任务目标对齐

可直接放到本轮 prompt 开头：

```text
任务背景：
我们正在设计 RPA 本地 B/S MVP。daemon 是通用 Claude Code runner，RPA 产品逻辑应放在 apps/rpa-local-web 及其后端/executor 中。最终 MVP 要包含 codegen 上传加固和自然语言生成两种脚本生产方式。

本轮 review 的目标：
只确认 RPA 产品架构、模块边界、MVP 范围、DSL 最小 schema、executor 边界、导入导出和安全约束是否合理。不要 review 具体 skill 文案，也不要让 daemon core 理解 RPA DSL 或 Playwright。

本轮 review 的结果用途：
review 输出会用于拆分 RPA MVP implementation phase plan，暂时不要求你直接修改代码或文档。
```

### Review 目标

确认 RPA 本地 B/S MVP 的产品架构、模块边界、MVP 范围和执行闭环是否合理。

### 重点问题

- `apps/rpa-local-web` 与 `apps/daemon` 的边界是否清楚？
- RPA 逻辑是否都留在 RPA Web/BFF/executor，而不是进入 daemon core？
- `rpa-local-executor` 作为 RPA Web 后端内部模块是否合理？
- `daemon runId` 和 `rpa executionId` 是否拆分清晰？
- codegen 上传加固作为第一阶段、自然语言生成作为第二阶段，是否能完成最终 MVP 双功能目标？
- DSL v0.1 的最小 schema 是否足够支撑前端表单、executor、导入导出和 skill 产物？
- AskQuestion / `<question-form>` 流程是否清楚？
- 导入导出 `.rpa.zip`、manifest、安全边界、浏览器策略是否有遗漏？
- demo 不做登录、不碰真实写操作的约束是否合理？

### 期望输出

- RPA MVP 架构风险清单。
- DSL / executor / artifact / import-export 需要调整的点。
- 后续 phase plan 中必须拆出的任务。

## Review 3：RPA Skill 初稿

### 文件范围

- `apps/daemon/skills/playwright-rpa-harden/SKILL.md`
- `apps/daemon/skills/playwright-rpa-harden/references/`
- `apps/daemon/skills/playwright-rpa-harden/templates/`
- `apps/daemon/skills/rpa-script-generate/SKILL.md`
- `apps/daemon/skills/rpa-script-generate/references/`
- `apps/daemon/skills/rpa-script-generate/templates/`

### 任务目标对齐

可直接放到本轮 prompt 开头：

```text
任务背景：
我们已经确定 RPA MVP 的架构和 DSL/artifact/executor 边界。当前两个 skill 只是初稿，需要 review 它们是否能正确引导 Claude Code 完成 codegen 加固和自然语言生成。

本轮 review 的目标：
只 review 两个 RPA skill 目录，确认 SKILL.md、references、templates 是否和 RPA MVP 设计一致，是否能稳定产出 DSL、脚本、参数化报告和加固报告。不要重新讨论 daemon 架构或 RPA 产品架构，除非发现 skill 与这些设计直接冲突。

本轮 review 的结果用途：
review 输出会用于修改 skill 初稿和后续真实测试，不要求你直接改代码。
```

### Review 目标

确认两个 RPA skill 初稿是否准确执行 RPA MVP 设计，是否能稳定引导 Claude Code 产出 DSL、脚本、报告和参数化结果。

### 重点问题

- 两个 skill 的职责是否清楚：codegen harden 与自然语言生成是否有重复或冲突？
- artifact 要求是否完整且和 RPA MVP 文档一致？
- `flow.dsl.json`、`flow.hardened.py`、`config.example.json`、`parameterization-report.md`、`hardening-report.md` 是否都被明确要求？
- AskQuestion / `<question-form>` 的时机、格式、停止条件是否明确？
- DSL 输出约束是否足够，是否会让 Claude Code 自由发挥过多？
- 选择器、等待、断言、dry-run、write/manual、审计日志要求是否足够强？
- templates 是否能产出可验证的最小 Python/Playwright 脚本？
- 对 chrome-devtools-mcp 的要求是否只用于自然语言探索阶段？
- side files 的 references/templates 划分是否合理？

### 期望输出

- 每个 skill 的问题清单。
- 需要修改的 `SKILL.md` 指令。
- 需要新增/调整的 reference 或 template 文件。
- 哪些问题应等真实测试后通过 review bundle 继续优化。

## Review 4：RPA 调试复盘扩展

### 文件范围

- `docs/rpa-skill-observability-design.md`

### 任务目标对齐

可直接放到本轮 prompt 开头：

```text
任务背景：
我们已经把通用 skill 观测能力和 RPA 专属观测扩展拆开。通用部分服务所有业务 skill，RPA 扩展只服务 RPA 的 DSL、executor、截图、trace、步骤失败等复盘需求。

本轮 review 的目标：
只确认 RPA 专属复盘扩展是否边界清楚、不过度采集、能有效帮助优化 rpa-script-generate 和 playwright-rpa-harden。不要把通用 prompt/skill snapshot/review bundle 能力重复塞回 RPA 文档，除非当前分工有明显问题。

本轮 review 的结果用途：
review 输出会用于后续观测能力 implementation plan 和 RPA skill 调试流程设计，暂时不要求你直接修改代码或文档。
```

### Review 目标

确认 RPA 专属观测扩展是否只包含 RPA 需要的内容，且能帮助后续根据真实运行结果持续优化两个 RPA skill。

### 重点问题

- RPA 专属部分是否和通用 `business-skill-observability-design.md` 分工清楚？
- `extensions/rpa/` 扩展目录是否合理？
- `daemonRunId` 与 `executionId` 的关联是否足够支持复盘？
- execution 日志、失败步骤截图、trace/video、DSL 校验、artifact 校验是否足够定位问题？
- `rpa-summary.md` / `rpa-diagnostics.json` 是否能控制 token 占比？
- `collectionMode = lite | diagnostic | review` 中，RPA 的截图、trace、video 保存策略是否合理？
- 是否有过度采集、敏感信息泄露或 bundle 过大的风险？
- 是否能定位 selector、wait、assert、parameterization、write-risk、manual-step 这些 RPA 特有问题？

### 期望输出

- RPA 复盘扩展风险清单。
- 需要放入 phase plan 的观测任务。
- 需要从 RPA 专属文档下沉到通用文档的内容。
- 需要从通用文档移回 RPA 专属文档的内容。

## 使用建议

每轮 review 单独开上下文或单独发给 Claude Code。

推荐提问格式：

```text
请只 review 以下文件范围，不要扩展到其他任务。
请重点从架构一致性、职责边界、遗漏风险、过度设计、后续实现风险角度 review。
请按 P0/P1/P2 输出问题，并给出具体修改建议。
```

不要一次性把 4 轮内容全部发给 Claude Code，否则上下文太大，review 会变散。
