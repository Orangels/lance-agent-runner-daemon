# chrome-devtools-mcp 连接问题排查与修复

> 记录时间：2026-06-06
> 环境：Linux 服务器（无显示器 / 无 GUI），Claude Code + chrome-devtools-mcp 插件 v1.1.1

## 一、问题现象

在 Claude Code 会话中调用 `mcp__plugin_chrome_devtools_mcp_chrome_devtools__list_pages` 等
chrome-devtools 工具时，持续报错：

```
Error: No such tool available: mcp__plugin_chrome_devtools_mcp_chrome_devtools__list_pages
```

即使执行 `/mcp` 重连、提示 `Reconnected to plugin:chrome-devtools-mcp:chrome-devtools`，
工具仍然不可用。

## 二、排查过程与根因

排查分两层，结论也分两层：

### 1. 会话工具表层面（"No such tool available" 的直接原因）

- MCP server 进程其实是**活着的**（`ps aux` 能看到 `chrome-devtools-mcp` 进程）。
- 握手日志（`~/.cache/claude-cli-nodejs/-home-orangels--claude/mcp-logs-plugin-chrome-devtools-mcp-chrome-devtools/`）
  显示 `Successfully connected (transport: stdio)`、`Connection established ... "hasTools":true`，
  握手是**成功**的。日志里那些 `"error": "Server stderr: ..."` 只是 chrome-devtools-mcp
  把免责声明 banner 打到了 stderr，被 harness 标成 error，**并非真正报错**。
- 真正原因：**会话的工具表在对话启动那一刻就固定了**。`/mcp` 重连只是重启了 server 进程，
  不会把工具动态注入到已经跑起来的会话上下文。
  → **必须彻底重启 Claude Code 进程**（不是 `/mcp`、不是 `/clear`），冷启动时才会从
    plugin 配置加载工具。

### 2. 浏览器层面（即使工具加载出来，调用时也会失败的隐患）

chrome-devtools-mcp **不自带浏览器**。根据其源码逻辑，当不指定
`--channel / --browserUrl / --wsEndpoint / --executablePath` 时，默认 `channel = 'stable'`，
即去拉起**系统安装的 stable 频道 Chrome**。本服务器最初的盘点结果：

| 项目 | 结果 |
|------|------|
| `which google-chrome / google-chrome-stable / chromium / chromium-browser` | ❌ 全部为空 |
| `/opt/google/chrome`、`/usr/bin/`、`/snap/bin/` 等标准路径 | ❌ 均不存在 |
| Puppeteer 自带 Chrome (`~/.cache/puppeteer`) | ❌ 未下载 |

结论：服务器上**没有任何系统级 Chrome / Chromium**，MCP 默认的 stable 模式找不到浏览器，
所以即便工具加载进会话，调用时也无浏览器可驱动。

> 历史备注：排查中曾尝试用 Playwright 自带的 Chromium
> (`~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`，版本 148) 通过
> `--executablePath` 指过去顶替。该 Chromium 二进制本身可用（`--version`、CDP 远程调试均正常），
> 但为了让环境标准、可复制、不依赖 Playwright 的版本目录号，**最终方案改为直接安装系统 Chrome**，
> 见下文第三节。

## 三、修复内容

### 步骤 1：安装系统 Google Chrome（stable）

服务器为 Debian/Ubuntu 系，直接下载官方 deb 包安装（需 sudo）：

```bash
cd /tmp
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt-get update
sudo apt-get install -y ./google-chrome-stable_current_amd64.deb
```

> 若 `apt-get install ./xxx.deb` 报依赖错误，可改用 `sudo dpkg -i google-chrome-stable_current_amd64.deb`
> 后再执行 `sudo apt-get -f install -y` 自动补齐依赖。

安装完成后验证：

```bash
which google-chrome && google-chrome --version
```

预期输出（版本号以实际为准）：

```
/usr/bin/google-chrome
Google Chrome 149.0.7827.53
```

### 步骤 2：让 MCP 指向系统 Chrome

给 MCP 启动参数指定可执行路径、无头模式、隔离 profile。修改后的 `mcpServers` 配置：

```json
"mcpServers": {
  "chrome-devtools": {
    "command": "npx",
    "args": [
      "chrome-devtools-mcp@1.1.1",
      "--executablePath",
      "/usr/bin/google-chrome",
      "--headless",
      "--isolated"
    ]
  }
}
```

参数说明：
- `--executablePath /usr/bin/google-chrome`：显式指向刚安装的系统 Chrome，最稳妥、与环境无关。
  （也可省略此参数，让 MCP 走默认 stable 模式自动发现 `/usr/bin/google-chrome`；显式指定可避免歧义。）
- `--headless`：服务器无显示器，必须无头模式。
- `--isolated`：使用临时 user-data-dir，会话结束自动清理，保持服务器环境干净。

### 修改的文件（两份都改，保持一致）

1. marketplace 源文件：
   `~/.claude/plugins/marketplaces/chrome-devtools-plugins/.claude-plugin/plugin.json`
2. **实际生效**的 cache 副本（`installed_plugins.json` 的 installPath 指向此处）：
   `~/.claude/plugins/cache/chrome-devtools-plugins/chrome-devtools-mcp/1.1.1/.claude-plugin/plugin.json`

> 注意：真正被加载的是 cache 那份；marketplace 那份是源。两份都改，避免插件重装/升级后不一致。
> ⚠️ 这是改 plugin 安装目录里的文件，插件升级时可能被覆盖，升级后需重新应用。

## 四、验证

安装并改完配置后，先用命令行直接验证 Chrome + CDP 可用（不依赖会话工具表）：

```bash
# 后台用 MCP 的真实工作方式（远程调试端口 + CDP）拉起 Chrome
rm -rf /tmp/cdptest && mkdir -p /tmp/cdptest
/usr/bin/google-chrome --headless=new --disable-gpu --no-sandbox \
  --user-data-dir=/tmp/cdptest --remote-debugging-port=9333 about:blank &

sleep 3
# 探测 DevTools 端点，应返回 Chrome 版本与 webSocketDebuggerUrl
curl -sS http://127.0.0.1:9333/json/version

# 通过 CDP 新建标签页打开目标网页，应在标签列表里看到该 URL
curl -sS "http://127.0.0.1:9333/json/new?https://www.weather.com.cn/" -X PUT
curl -sS http://127.0.0.1:9333/json/list

# 清理
pkill -f "remote-debugging-port=9333"; rm -rf /tmp/cdptest
```

预期 `/json/version` 返回类似：

```json
{
   "Browser": "Chrome/149.0.7827.53",
   "Protocol-Version": "1.3",
   "webSocketDebuggerUrl": "ws://127.0.0.1:9333/devtools/browser/..."
}
```

> 说明：命令行用 `--dump-dom <url>` 直接抓页面在本环境会卡住超时，那是命令行等待
> load 事件的行为，**与 MCP 无关**。MCP 走的是 CDP 远程调试协议（上面的方式），这条路是通的。
> 因此验证请以 CDP 端点为准，不要用 `--dump-dom` 的结果下结论。

## 五、生效操作（重要）

修改配置后，**必须完全退出并重启 Claude Code 进程**，工具才会注入会话：

- ✅ 完全退出 CLI（关闭终端或 `Ctrl+C` 两次）后重新启动
- ❌ `/mcp` 重连——不行，不会刷新会话工具表
- ❌ `/clear`——不行，同上

重启前建议清掉可能残留的旧 MCP / 浏览器进程，避免僵尸进程占用：

```bash
ps aux | grep -E "chrome-devtools-mcp@1.1.1" | grep -v grep
# 如有残留，按 PID kill 掉
```

重启后，在会话中调用 `list_pages` 等工具即可正常使用。

## 六、复用提示（环境变化时）

- 在全新机器上准备环境，按第三节顺序执行即可：先 `apt` 装 Chrome，再改两份 `plugin.json`，最后重启 Claude Code。
- 插件升级到新版本后，cache 路径里的版本号（`.../1.1.1/...`）会变，且配置可能被重置为默认，
  需重新在新版本目录的 `plugin.json` 里加回 `--executablePath` 等参数。
- 若不想写死路径，也可去掉 `--executablePath`，让 MCP 默认 stable 模式自动发现 `/usr/bin/google-chrome`；
  显式指定的好处是排查时一眼能看出用的是哪个浏览器。
