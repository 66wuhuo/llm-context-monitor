# LLM 上下文监控 (LLM Context Monitor)

> VS Code 扩展 — 实时追踪 LLM token 使用量、费用和上下文窗口占用

<p align="center">
  <img src="https://img.shields.io/badge/VS%20Code-^1.93.0-blue" alt="VS Code">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform">
</p>

## 功能

- 📊 **实时 Token 统计** — 输入/输出/缓存 token 分项展示
- 💰 **费用计算** — 基于官方定价自动计算，支持 Anthropic / OpenAI / DeepSeek
- 📈 **上下文窗口进度条** — 颜色分级（绿→黄→橙→红）
- 🔄 **流式更新** — SSE 流式响应逐 token 更新
- 📝 **对话历史** — 记录每次 API 调用的轮次详情
- 💾 **会话持久化** — VS Code 重启后自动恢复
- 📤 **报告导出** — JSON 格式导出
- 🗂️ **JSONL 直读** — 参照 cc-switch，直接读取 Claude Code 本地会话文件，无需代理即可追踪

## 效果预览

状态栏常驻显示：

```
📊 315M/1M (31.5%) · $173.57
```

侧边栏仪表盘：

| 区域 | 内容 |
|------|------|
| 上下文窗口 | 进度条 + 百分比 + 已用/总量 token |
| Token 明细 | 输入 / 输出 / 缓存读取 / 合计 |
| 费用 | 本次会话 / 累计 / 模型名 / 会话数 |
| 对话历史 | 每轮 token + 费用 + 模型 |

## 安装

### 从 VSIX 安装

```bash
code --install-extension llm-context-monitor-0.1.0.vsix
```

### 从 GitHub Releases 下载

前往 [Releases](https://github.com/<your-org>/llm-context-monitor/releases) 下载最新 `.vsix`。

## 使用

扩展随 VS Code 启动自动激活（`onStartupFinished`）。无需额外操作。

### 数据来源

| 来源 | 说明 |
|------|------|
| **JSONL 直读**（主力） | 读取 `~/.claude/projects/` 下 Claude Code 本地会话文件，每 30 秒自动同步 |
| **HTTP 代理**（补充） | 拦截通过 `http://127.0.0.1:9877` 代理的 API 流量（curl / Python / 其他工具） |

JSONL 直读无需任何配置，开箱即用。

### 可选：启用 HTTP 代理

如需监控非 Claude Code 的 LLM 流量：

```bash
# Windows PowerShell
$env:HTTP_PROXY = "http://127.0.0.1:9877"
$env:HTTPS_PROXY = "http://127.0.0.1:9877"
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"

# macOS / Linux
export HTTP_PROXY=http://127.0.0.1:9877
export HTTPS_PROXY=http://127.0.0.1:9877
export NODE_TLS_REJECT_UNAUTHORIZED=0
```

## 命令

| 命令 | 快捷键 | 说明 |
|------|--------|------|
| `llmContext.showDashboard` | — | 打开仪表盘 |
| `llmContext.toggleDisplay` | — | 切换显示模式（紧凑/详细/隐藏） |
| `llmContext.resetStats` | — | 重置统计数据 |
| `llmContext.exportReport` | — | 导出 JSON 报告 |
| `llmContext.exportCACert` | — | 导出代理 CA 证书 |
| `llmContext.startProxy` | — | 手动启动代理 |
| `llmContext.stopProxy` | — | 手动停止代理 |
| `llmContext.resetMitm` | — | 重置 MITM 状态 |

## 配置

| 配置键 | 默认值 | 说明 |
|--------|--------|------|
| `llmContext.proxyPort` | `9877` | 代理端口 |
| `llmContext.display.mode` | `detailed` | 显示模式（compact/detailed/hidden） |
| `llmContext.monitoredEndpoints` | `["api.anthropic.com", "api.openai.com", "api.deepseek.com"]` | 代理监控端点 |
| `llmContext.modelOverrides` | `{}` | 自定义模型定价/上下文窗口 |
| `llmContext.throttleInterval` | `100` | UI 更新节流（ms） |
| `llmContext.autoStartProxy` | `true` | 自动启动代理 |

## 支持的模型

### Anthropic
- Claude Opus 4.8（1M 上下文）
- Claude Fable 5（1M 上下文）
- Claude Sonnet 4.6（200K 上下文）
- Claude Haiku 4.5（200K 上下文）

### OpenAI
- GPT-4o / GPT-4o Mini / GPT-4 Turbo（128K 上下文）

### DeepSeek
- DeepSeek V4 Pro（1M 上下文）
- DeepSeek Chat V3（128K 上下文）
- DeepSeek Reasoner R1（128K 上下文）

可通过 `llmContext.modelOverrides` 添加更多模型。

## 开发

```bash
# 安装依赖
npm install

# 编译
npx webpack --mode production

# 打包
npx vsce package --allow-missing-repository

# 安装测试
code --install-extension llm-context-monitor-0.1.0.vsix --force
```

## 技术架构

```
~/.claude/projects/*.jsonl  ──→  JSONLSyncService  ──┐
                                                       ├──→ ModelRegistry ──→ StatusBar
HTTP 代理 (127.0.0.1:9877)  ──→  ProxyServer (MITM) ──┘                    Dashboard
```

## License

MIT
