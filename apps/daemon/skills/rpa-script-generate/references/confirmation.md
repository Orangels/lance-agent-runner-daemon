# 用户确认规则

自然语言生成 RPA 时，Claude Code 应主动减少打扰，但不能替用户决定业务语义。

## 必须确认

- 页面分支不确定，如同名菜单、多个查询入口、多个导出按钮。
- 字段含义不确定，如“单位”“部门”“辖区”“类别”的业务口径。
- 写操作，如保存、提交、删除、审批、导入、发送、覆盖文件。
- 登录、验证码、CA、USB-Key、扫码、短信等人工介入点。
- 固定值是否需要变成运行时参数。
- 断言标准，如查询结果为空是否算成功、导出文件命名是否有要求。

## 可以不确认

- 明确的页面跳转、普通菜单点击、只读查询条件填入。
- 用户已经在流程描述中说清楚的参数和选项。
- 不影响业务语义的技术细节，如截图文件名、日志文件名。

## 确认方式

必须像 `kami-landing` 一样优先使用 AskQuestion 提出结构化问题，而不是只输出普通自然语言问题。如果当前 Claude Code 环境没有真实 AskQuestion 工具，则输出等价的 `<question-form>` 文本协议。把同一页面或同一阶段的问题合并成一个短表单。每个问题要包含：

- 当前观察到的事实。
- 需要用户选择或确认的点。
- 默认建议，如果有充分依据。

等价 `<question-form>` 格式：

```html
<question-form id="rpa-confirmation" title="确认 RPA 流程细节">
{
  "description": "以下信息会影响生成的 DSL 和脚本，请确认。",
  "questions": [
    {
      "id": "write_action",
      "label": "点击“提交”是否会改变业务数据？",
      "type": "radio",
      "required": true,
      "options": [
        { "label": "会，verify/dry-run 时不要真正提交", "value": "write_guarded" },
        { "label": "不会，只是查询或导出", "value": "read_or_export" }
      ]
    }
  ]
}
</question-form>
```

如果使用 `<question-form>`，输出 `</question-form>` 后停止本轮生成，等待用户提交。用户答案会作为下一轮普通消息回传，格式类似：

```text
[form answers — rpa-confirmation]
- 点击“提交”是否会改变业务数据？: 会，verify/dry-run 时不要真正提交 [value: write_guarded]
```

不可逆写操作前必须暂停，除非当前模式是 dry-run 且脚本不会真正提交。

