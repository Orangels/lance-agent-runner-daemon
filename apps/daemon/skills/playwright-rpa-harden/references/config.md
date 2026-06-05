# 配置参考

加固脚本从配置文件和运行参数中读取实例信息。

`output/` 只用于 daemon 生成/加固产物，例如 DSL、脚本和报告。脚本执行时产生的审计日志、截图、trace、下载文件必须写入 `runtime/`，由 RPA Web / executor 按 executionId 管理。

## config.example.json

```json
{
  "base_url": "https://example.internal",
  "storage_state": "secrets/storage_state.json",
  "default_timeout_ms": 15000,
  "browser": {
    "headless": false,
    "slow_mo_ms": 80
  },
  "audit": {
    "jsonl_path": "runtime/audit.jsonl",
    "screenshots_dir": "runtime/screenshots",
    "trace_dir": "runtime/trace"
  },
  "downloads": {
    "dir": "runtime/downloads"
  }
}
```

## run.params.json

`run.params.json` 由前端根据 DSL `params` 渲染表单后生成。脚本只读取参数值，不在运行时调用 Claude Code 提取变量。

```json
{
  "start_date": "2026-06-01",
  "end_date": "2026-06-05",
  "org_name": "某单位"
}
```

## 禁止项

- 不在 config 示例中写真实账号密码。
- 不导出真实 storage_state 内容。
- 不写客户机器绝对路径。
- 不把 secrets 复制到流程包。

