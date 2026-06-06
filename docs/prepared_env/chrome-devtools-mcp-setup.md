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

弃用插件安装方式，改用 `claude mcp add -s user` 注册，并使用**短 server 名**，从源头去掉 `plugin_` 长前缀。

RPA daemon 的 `rpa-local` profile 会通过 `CLAUDE_CONFIG_DIR` 指定 Claude Code 配置目录。当前本地配置使用：

```bash
CLAUDE_CONFIG_DIR=/home/orangels/.claude
```

因此必须把 MCP server 注册到 daemon 实际使用的 `CLAUDE_CONFIG_DIR` 下，而不是只注册到交互式 Claude Code 默认读取的配置中：

```bash
CLAUDE_CONFIG_DIR=/home/orangels/.claude \
claude mcp add -s user cdt -- \
npx chrome-devtools-mcp@latest --headless=true --isolated=true
```

效果：

- server 名取 `cdt`，生成的工具名缩短为 `mcp__cdt__list_pages`，**远在 64 字符限制内** → 工具调用恢复正常。
- 其它插件 MCP（context7、oh-my-claudecode 等）同理：用 `claude mcp add -s user` + 短名重新注册即可。

参数说明：

- `--headless=true`：服务器无显示器，必须无头模式。
- `--isolated=true`：使用临时 user-data-dir，会话结束自动清理，保持环境干净。
- `chrome-devtools-mcp@latest`：直接取最新版即可，版本不是本问题的变量。

> 命名原则：server 名越短越好，且尽量只使用简单字母数字。工具名总长 = `mcp__` + server 名 + `__` + 工具名，
> 务必让最长的工具名也落在 64 字符以内。RPA 默认使用 `cdt`，避免模型把 `chrome-dev-mcp` 误写成 `chrome_dev_mcp`。

### RPA daemon 环境初始化脚本

仓库提供了幂等 setup 脚本：

```bash
pnpm setup:rpa-chrome-devtools-mcp -- --mode online
```

等价于：

```bash
scripts/setup-rpa-chrome-devtools-mcp.sh --mode online
```

脚本默认使用 `CLAUDE_CONFIG_DIR=/home/orangels/.claude`，也可通过环境变量覆盖：

```bash
CLAUDE_CONFIG_DIR=/path/to/claude-config pnpm setup:rpa-chrome-devtools-mcp
```

#### 外网 / 开发环境模式

`online` 模式使用 `npx` 启动 MCP，适合开发机、外网演示机或能访问 npm registry 的环境：

```bash
pnpm setup:rpa-chrome-devtools-mcp -- --mode online
```

默认写入：

```bash
npx chrome-devtools-mcp@latest --headless=true --isolated=true
```

如需固定版本，避免生产环境被 `latest` 漂移影响：

```bash
pnpm setup:rpa-chrome-devtools-mcp -- \
  --mode online \
  --package chrome-devtools-mcp@1.1.1
```

#### 内网 / 离线环境模式

客户内网如果没有 npm registry，不要使用 `npx chrome-devtools-mcp@latest`。应在部署包里提前放好已安装的
`chrome-devtools-mcp` 文件目录，然后用本地 JS 入口注册：

```bash
pnpm setup:rpa-chrome-devtools-mcp -- \
  --mode offline \
  --bin /opt/rpa-mcp/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js
```

等价环境变量形式：

```bash
RPA_CHROME_DEVTOOLS_MCP_MODE=offline \
RPA_CHROME_DEVTOOLS_MCP_BIN=/opt/rpa-mcp/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js \
pnpm setup:rpa-chrome-devtools-mcp
```

`offline` 模式写入：

```bash
node /opt/rpa-mcp/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js --headless=true --isolated=true
```

离线模式不会调用 `npx`，也不依赖公网 npm registry。它要求目标机器上已有：

- `node`
- `google-chrome`
- 部署包随附的 `chrome-devtools-mcp` JS 入口文件

脚本行为：

- 始终检查 `claude`、`google-chrome` 是否存在。
- `online` 模式检查 `npx`，`offline` 模式检查 `node` 和 `--bin` 文件。
- 用 daemon 实际使用的 `CLAUDE_CONFIG_DIR` 执行 `claude mcp list`。
- 如果 `cdt` 已存在且命令与当前模式一致，只做验证，不重复写配置。
- 如果不存在，或已存在但命令与当前模式不一致，先写入/替换为当前模式对应的命令。
- 如果检测到历史配置 `chrome-dev-mcp` 或 `chrome_dev_mcp`，脚本会自动移除它们，避免 Claude Code 同时看到多个 Chrome DevTools MCP 前缀。

不要把 `claude mcp add` 放进 daemon 每次启动脚本。它是写配置动作，不是启动 MCP 服务动作；每次启动都写配置会增加排查难度，也可能在并发启动时产生配置写入竞争。启动脚本只负责启动 daemon / RPA Web，MCP 配置缺失时用本 setup 脚本修复。

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

`claude mcp add -s user` 改完配置后，**必须完全退出并重启 Claude Code 进程**，工具才会重新注入会话。对 RPA daemon 来说，就是要重启 daemon 进程，让后续 run 拉起新的 Claude Code 子进程：

- ✅ 完全退出 CLI（关闭终端或 `Ctrl+C` 两次）后重新启动
- ❌ `/mcp` 重连——不会刷新会话工具表
- ❌ `/clear`——同上

重启前建议清掉可能残留的旧 MCP / 浏览器进程，避免僵尸进程占用：

```bash
ps aux | grep -E "chrome-devtools-mcp" | grep -v grep
# 如有残留，按 PID kill 掉
```

重启后，在会话中调用 `mcp__cdt__list_pages` 等工具即可正常使用。RPA 自然语言生成 run 中，也应能看到 `mcp__cdt__*` 工具，而不再降级到 WebFetch。

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

重启 Claude Code 后，在会话里调用 `mcp__cdt__list_pages` 不再报 `No such tool available`，即修复成功。

> 说明：命令行用 `--dump-dom <url>` 直接抓页面在本环境会卡住超时，那是命令行等待 load 事件的行为，
> **与 MCP 无关**。MCP 走的是 CDP 远程调试协议，验证请以 CDP 端点为准。

## 七、复用提示（环境变化时）

- 核心原则：**所有 MCP 都用 `claude mcp add -s user` + 短 server 名注册**，不要用插件方式安装，避免 `plugin_` 长前缀触发 64 字符工具名上限。
- 新机器准备环境：先 `apt` 装系统 Chrome（第四节），再按外网/内网环境运行 `pnpm setup:rpa-chrome-devtools-mcp -- --mode ...`（第三节），最后重启 daemon / Claude Code（第五节）。
- 若再次出现「server 已连接、schema 也在、调用却报 `No such tool available`」且涉及插件 MCP，优先怀疑工具名超长，先核对工具名总长是否超过 64 字符。

如需清理旧短名后重建：

```bash
CLAUDE_CONFIG_DIR=/home/orangels/.claude claude mcp remove cdt
pnpm setup:rpa-chrome-devtools-mcp
```
