# chrome-devtools-mcp 连接问题排查与修复

> 记录时间：2026-06-06
> 环境：Linux 服务器（无显示器 / 无 GUI），Claude Code + chrome-devtools-mcp

## 一、问题现象

在 Claude Code 会话中调用 chrome-devtools 工具时，持续报错：

```
Error: No such tool available: mcp__plugin_chrome_devtools_mcp_chrome_devtools__list_pages
```

关键特征：

- MCP server 显示**已连接**，system prompt / `/mcp` 里也**列出了工具 schema**，但实际调用一律返回 `No such tool available`。
- 所有**以插件方式安装**的 MCP（chrome-devtools、context7、oh-my-claudecode）**同时失效**，不止 chrome-devtools 一个。

「连接正常、schema 也在、却调不动，而且是所有插件 MCP 一起挂」——这是定位真正根因的最强线索。

## 二、根因：插件工具名超过 64 字符上限

- 插件方式安装会生成**超长工具名前缀**：
  `mcp__plugin_{插件名}_{server名}__{tool}`，
  例如 `mcp__plugin_chrome_devtools_mcp_chrome_devtools__take_screenshot`。
- 该名称**超过 Anthropic API 的 64 字符工具名上限** → API 返回 400 校验错误 → 客户端层面表现为
  `No such tool available`。
- 因为限制来自工具名长度，所有插件安装的 MCP（前缀都带 `plugin_` 长串）会**一起失效**，与具体是哪个 server 无关。

相关 issue：

- anthropic/claude-code #20830
- anthropic/claude-code #19882

### 已排除的方向（都不是原因）

排查中验证过下列方向，均**不是**本问题的根因：

| 排除项 | 结论 |
|------|------|
| Chrome 安装方式 / 是否装了浏览器 | 与本错误无关 |
| Ubuntu 服务器环境 | 与本错误无关 |
| MCP server 没启动 | server 进程是活的，握手成功 |
| 升级 chrome-devtools-mcp 版本 | 升级修不了，因为前缀长度不变 |
| `/mcp` 重连、`/clear` | 不影响工具名长度，无效 |

> 历史备注：早期排查曾把矛头指向「会话工具表在启动时固定，需要彻底重启 Claude Code」以及
> 「服务器没有系统 Chrome」。重启确实是让配置变更生效的必要操作（见第五节），
> 没有浏览器也确实会让 chrome-devtools 工具在调用时无浏览器可驱动（见第四节）；
> 但这两点都**不是** `No such tool available` 的直接原因。直接原因就是工具名超长。

## 三、解决方案：改用 `claude mcp add -s user` + 短 server 名

弃用插件安装方式，改用 `claude mcp add -s user` 注册，并使用**短 server 名**，从源头去掉 `plugin_` 长前缀：

```bash
claude mcp add -s user chrome-dev-mcp -- npx chrome-devtools-mcp@latest --headless=true --isolated=true
```

效果：

- server 名取 `chrome-dev-mcp`，生成的工具名缩短为 `mcp__chrome-dev-mcp__list_pages`（约 20 字符），**远在 64 字符限制内** → 工具调用恢复正常。
- 其它插件 MCP（context7、oh-my-claudecode 等）同理：用 `claude mcp add -s user` + 短名重新注册即可。

参数说明：

- `--headless=true`：服务器无显示器，必须无头模式。
- `--isolated=true`：使用临时 user-data-dir，会话结束自动清理，保持环境干净。
- `chrome-devtools-mcp@latest`：直接取最新版即可，版本不是本问题的变量。

> 命名原则：server 名越短越好。工具名总长 = `mcp__` + server 名 + `__` + 工具名，
> 务必让最长的工具名也落在 64 字符以内。

## 四、前置条件：服务器需有可用的 Chrome

工具名问题解决后，chrome-devtools-mcp 真正调用时还需要一个可驱动的浏览器。
chrome-devtools-mcp **不自带浏览器**：不指定 `--channel / --browserUrl / --wsEndpoint / --executablePath`
时，默认 `channel = 'stable'`，即拉起系统安装的 stable 频道 Chrome。若服务器上没有任何
系统级 Chrome / Chromium，工具调用时会因无浏览器可驱动而失败。

Debian/Ubuntu 系安装系统 Google Chrome（stable）：

```bash
cd /tmp
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt-get update
sudo apt-get install -y ./google-chrome-stable_current_amd64.deb
```

> 若 `apt-get install ./xxx.deb` 报依赖错误，可改用 `sudo dpkg -i google-chrome-stable_current_amd64.deb`
> 后再执行 `sudo apt-get -f install -y` 自动补齐依赖。

验证：

```bash
which google-chrome && google-chrome --version
# 预期：/usr/bin/google-chrome  +  Google Chrome 149.x（版本以实际为准）
```

装好系统 Chrome 后，第三节的 `--headless=true --isolated=true` 即可走默认 stable 模式自动发现
`/usr/bin/google-chrome`；如需排查时一眼看出用哪个浏览器，也可显式加
`--executablePath /usr/bin/google-chrome`。

## 五、生效操作（重要）

`claude mcp add -s user` 改完配置后，**必须完全退出并重启 Claude Code 进程**，工具才会重新注入会话：

- ✅ 完全退出 CLI（关闭终端或 `Ctrl+C` 两次）后重新启动
- ❌ `/mcp` 重连——不会刷新会话工具表
- ❌ `/clear`——同上

重启前建议清掉可能残留的旧 MCP / 浏览器进程，避免僵尸进程占用：

```bash
ps aux | grep -E "chrome-devtools-mcp" | grep -v grep
# 如有残留，按 PID kill 掉
```

重启后，在会话中调用 `mcp__chrome-dev-mcp__list_pages` 等工具即可正常使用。

## 六、验证

可先用命令行直接验证 Chrome + CDP 可用（不依赖会话工具表）：

```bash
# 用 MCP 的真实工作方式（远程调试端口 + CDP）后台拉起 Chrome
rm -rf /tmp/cdptest && mkdir -p /tmp/cdptest
/usr/bin/google-chrome --headless=new --disable-gpu --no-sandbox \
  --user-data-dir=/tmp/cdptest --remote-debugging-port=9333 about:blank &

sleep 3
# 探测 DevTools 端点，应返回 Chrome 版本与 webSocketDebuggerUrl
curl -sS http://127.0.0.1:9333/json/version

# 清理
pkill -f "remote-debugging-port=9333"; rm -rf /tmp/cdptest
```

重启 Claude Code 后，在会话里调用 `mcp__chrome-dev-mcp__list_pages` 不再报 `No such tool available`，即修复成功。

> 说明：命令行用 `--dump-dom <url>` 直接抓页面在本环境会卡住超时，那是命令行等待 load 事件的行为，
> **与 MCP 无关**。MCP 走的是 CDP 远程调试协议，验证请以 CDP 端点为准。

## 七、复用提示（环境变化时）

- 核心原则：**所有 MCP 都用 `claude mcp add -s user` + 短 server 名注册**，不要用插件方式安装，避免 `plugin_` 长前缀触发 64 字符工具名上限。
- 新机器准备环境：先 `apt` 装系统 Chrome（第四节），再 `claude mcp add -s user chrome-dev-mcp ...`（第三节），最后重启 Claude Code（第五节）。
- 若再次出现「server 已连接、schema 也在、调用却报 `No such tool available`」且涉及插件 MCP，优先怀疑工具名超长，先核对工具名总长是否超过 64 字符。

```
claude mcp remove cdt
claude mcp add -s user chrome-dev-mcp -- npx chrome-devtools-mcp@latest --headless=true --isolated=true
```