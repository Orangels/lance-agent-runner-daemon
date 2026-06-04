# Chrome DevTools MCP 探索约束

`chrome-devtools-mcp` 适合“先探查网页，再生成 Playwright 脚本”的自然语言 RPA 工作流。它只用于探索期，不用于日常生产执行。

## 内网可用条件

- MCP server、Chrome/Chromium、Node 运行时已经在客户本地或内网环境安装。
- 不依赖公网下载、在线更新或外部遥测。
- 目标网页能被本机 Chrome 访问。
- 国产系统上的 Chrome/Chromium 兼容性需要实测。

## 启动原则

- 使用独立 Chrome profile，优先每个 run 使用独立 `--user-data-dir`。
- DevTools remote debugging 只绑定 `127.0.0.1`。
- 探索结束后关闭浏览器或清理临时 profile。
- 禁用无关遥测、性能数据查询和更新检查能力。
- 不在被调试浏览器中打开无关敏感网站。

## 探查内容

优先收集：

- DOM 结构、可访问性 role、label、placeholder、button name。
- iframe、弹窗、toast、下载行为。
- URL 变化、页面加载状态、接口错误、控制台错误。
- 每一步可用于断言的可见状态。
- 关键元素截图和候选选择器。

## 不可用时的降级

如果 `chrome-devtools-mcp` 不可用：

- 请用户提供 Playwright codegen 脚本、页面截图、HTML 片段或录屏。
- 生成的 DSL 标记为未验证草稿。
- 在 `generation-notes.md` 中列出缺失探查证据。
- 不要凭空编造选择器或页面分支。

