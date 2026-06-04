# 选择器加固规则

优先级固定为：

```text
role > label > placeholder > text > testid > id > css
```

## 推荐写法

- 按钮、菜单、链接：优先 `get_by_role`。
- 表单输入：优先 `get_by_label` 或 `get_by_placeholder`。
- 文本区域或提示：可使用 `get_by_text`，必要时加 scope。
- 测试标识：使用 `get_by_test_id`。
- iframe：显式使用 `frame_locator` 链。

## 风险选择器

以下定位必须进入 `hardening-report.md`：

- 绝对 xpath。
- 坐标点击。
- 动态 class。
- 动态 id。
- nth-child 或列表序号。
- 只有文本、但页面中存在多个同名元素。
- 跨 iframe 但脚本没有显式 frame 定位。

## 加固目标

每个可操作元素都应能回答：

- 用户看见它时叫什么。
- 它属于哪个页面区域。
- 点击或输入后如何证明动作成功。

