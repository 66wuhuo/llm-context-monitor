# LLM 上下文监控 (LLM Context Monitor)

> VS Code 扩展 — 实时追踪 LLM token 使用量、费用和上下文窗口占用

<p align="center">
  <img src="https://img.shields.io/badge/VS%20Code-^1.93.0-blue" alt="VS Code">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform">
  <img src="https://img.shields.io/github/v/release/66wuhuo/llm-context-monitor" alt="Release">
</p>

## 功能

- 📊 **Token 统计** — 输入/输出/缓存 token 分项展示，状态栏常驻
- 💰 **费用计算** — 基于官方定价，支持 Anthropic / OpenAI / DeepSeek
- 📈 **上下文窗口** — 进度条 + 百分比，颜色分级（绿→黄→橙→红）
- 🗂️ **JSONL 直读** — 参照 [cc-switch](https://github.com/farion1231/cc-switch)，直接读取 `~/.claude/projects/` 下 Claude Code 本地会话文件，**无需代理、零配置**
- 🔄 **HTTP MITM 代理** — 拦截其他工具（curl / Python SDK）的 API 流量，HTTPS 解密
- 🔍 **智能模型识别** — 四级模糊匹配（精确 → 忽略大小写 → 前缀 → 包含），不再显示 "unknown"
- 💾 **会话持久化** — VS Code 重启后自动恢复统计数据
- 📤 **报告导出** — JSON 格式，含会话明细和累计汇总
- 🔁 **增量同步** — 每 30 秒扫描 JSONL 新行，按 `message.id` 去重

## 效果预览

状态栏常驻显示：

```
📊 221K/1.0M (22.1%) · $2.47
```

| 使用率 | 颜色 | 说明 |
|--------|------|------|
| < 50% | 🟢 绿色 | 正常 |
| 50%–75% | 🟡 黄色 | 关注 |
| 75%–90% | 🟠 橙色 | 警告 |
| > 90% | 🔴 红色 | 危险 |

侧边栏仪表盘：

| 区域 | 内容 |
|------|------|
| 上下文窗口 | 进度条 + 百分比 + 已用/总量 token |
| Token 明细 | 输入 / 输出 / 缓存读取 / 合计 |
| 费用 | 本次会话 / 累计 / 模型 / 会话数 |
| 对话历史 | 每轮 token + 费用 + 模型 |

## 安装

前往 [Releases](https://github.com/66wuhuo/llm-context-monitor/releases) 下载最新 `.vsix`：

```bash
code --install-extension llm-context-monitor-0.1.1.vsix
```

安装后无需任何配置，扩展随 VS Code 启动自动激活。

## 数据来源

| 来源 | 说明 | 需要配置 |
|------|------|---------|
| **JSONL 直读** | 读取 `~/.claude/projects/` 下 Claude Code 本地会话 | ❌ 零配置 |
| **HTTP 代理** | 拦截 `http://127.0.0.1:9877` 的 API 流量 | ✅ 需设环境变量 |

### 可选：启用 HTTP 代理

如需监控 curl / Python / 其他工具的 LLM 流量：

**Windows PowerShell：**
```powershell
$env:HTTP_PROXY = "http://127.0.0.1:9877"
$env:HTTPS_PROXY = "http://127.0.0.1:9877"
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
```

**macOS / Linux：**
```bash
export HTTP_PROXY=http://127.0.0.1:9877
export HTTPS_PROXY=http://127.0.0.1:9877
export NODE_TLS_REJECT_UNAUTHORIZED=0
```

带 `-k` 信任代理自签名证书：
```bash
curl -k --proxy-insecure -x http://127.0.0.1:9877 \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":50,"messages":[{"role":"user","content":"hi"}]}' \
  https://api.anthropic.com/v1/messages
```

## 命令

| 命令 | 说明 |
|------|------|
| `llmContext.showDashboard` | 打开仪表盘 |
| `llmContext.toggleDisplay` | 切换显示模式（紧凑/详细/隐藏） |
| `llmContext.resetStats` | 重置统计数据 |
| `llmContext.exportReport` | 导出 JSON 报告 |
| `llmContext.exportCACert` | 导出代理 CA 证书 + 安装说明 |
| `llmContext.resetMitm` | 重置代理 MITM 状态（TLS 失败后重试） |
| `llmContext.startProxy` / `stopProxy` | 手动启停代理 |

## 配置

`Ctrl+,` 打开设置，搜索 `llmContext`：

| 配置键 | 默认值 | 说明 |
|--------|--------|------|
| `llmContext.proxyPort` | `9877` | 代理端口 |
| `llmContext.display.mode` | `detailed` | `compact` / `detailed` / `hidden` |
| `llmContext.monitoredEndpoints` | `["api.anthropic.com", "api.openai.com", "api.deepseek.com"]` | 代理监控的 API 域名 |
| `llmContext.modelOverrides` | `{}` | 自定义模型（定价/上下文窗口） |
| `llmContext.autoStartProxy` | `true` | 启动时自动开启代理 |

## 支持模型

| 系列 | 模型 | 上下文窗口 |
|------|------|-----------|
| Anthropic | Claude Opus 4.8 / Fable 5 | 1M |
| Anthropic | Claude Sonnet 4.6 / Haiku 4.5 | 200K |
| Anthropic | Claude 3 Opus / 3.5 Sonnet | 200K |
| OpenAI | GPT-4o / GPT-4o Mini / GPT-4 Turbo | 128K |
| DeepSeek | V4 Pro / V4 Flash | 1M |
| DeepSeek | Chat V3 / Reasoner R1 | 128K |

未识别模型自动回退为 1M 上下文窗口，并显示实际模型 ID（标记"未识别"）。通过 `llmContext.modelOverrides` 可添加任意模型。

## 常见问题

**Q: 仪表盘显示 "unknown" 模型？**
A: 首次安装后等待 30 秒让 JSONL 同步完成。如果仍显示 unknown，按 `Ctrl+Shift+P` → `显示 LLM 上下文仪表盘` 刷新。

**Q: 百分比显示 0%？**
A: 已修复于 v0.1.1。升级到最新版即可。

**Q: 弹 TLS 握手错误？**
A: 正常现象——Claude Code 的 undici 库不走 HTTP 代理。扩展会自动回退，不影响 JSONL 直读。如需代理，设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`。

## 技术架构

```
                          ┌─ ConversationTracker ──┐
~/.claude/projects/*.jsonl → JSONLSyncService ─┤                        ├→ StatusBar
                          │                        ├→ MetricsAggregator ─┤
curl / Python SDK ──→ HTTP MITM 代理 ──→ ProxyServer ─┤                        └→ Dashboard
                          │                        ├→ CostService
                          └─ ModelRegistry ────────┘
```

## 开发

```bash
npm install
npx webpack --mode production
npx vsce package --allow-missing-repository
code --install-extension llm-context-monitor-0.1.1.vsix --force
```

## License

MIT
