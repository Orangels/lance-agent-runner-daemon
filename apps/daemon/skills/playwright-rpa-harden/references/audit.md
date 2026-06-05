# 审计日志参考

加固脚本应写 JSONL 审计日志，每行记录一个步骤事件。日志不存真实密钥、cookie、完整身份证号、完整手机号等敏感值。

审计日志、截图和 trace 是执行期产物，路径应来自 `config.example.json` 的 `runtime/` 配置，不写入 daemon 扫描的 `output/` 目录。

## 建议字段

```json
{
  "ts": "2026-06-05T10:00:00+08:00",
  "flow_id": "case_query",
  "run_id": "local-run-001",
  "step_id": "s3",
  "step_name": "提交查询",
  "mode": "verify",
  "action": "submit",
  "target": "role=button name=查询",
  "params": { "case_no": "***" },
  "write": true,
  "dry_run": true,
  "status": "ok",
  "error": null,
  "screenshot": "runtime/screenshots/s3.png",
  "trace": "runtime/trace/trace.zip"
}
```

## 要求

- 每步开始和结束至少记录结束事件。
- 失败时记录错误类型、错误消息和失败截图。
- 参数按 DSL `params.*.mask` 脱敏。
- 写操作必须记录 `write` 和 `dry_run`。
- 日志路径由 `config.example.json` 暴露，不写死绝对路径。

