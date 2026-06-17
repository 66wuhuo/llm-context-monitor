# LLM 上下文监控 - VS Code 扩展开发记录

> 项目路径：`c:\Users\23072\Desktop\context\`  
> 开发日期：2026-06-17  
> 安装状态：✅ 已安装到 VS Code

---

## 一、需求概述

用户希望在 VS Code 中实现 LLM 对话时**实时显示上下文使用量**的功能。

### 明确的需求

| 需求项 | 说明 |
|--------|------|
| 平台 | VS Code 扩展 |
| 技术栈 | TypeScript + Node.js |
| 显示指标 | Token 使用量/剩余量、使用百分比+进度条、费用估算、消息轮次统计 |
| 实时性 | 流式响应过程中逐 token 更新 |
| 界面语言 | 中文 |
| 启动方式 | VS Code 打开时自启动 |

---

## 二、技术方案

### 架构设计

采用 **HTTP 代理拦截** 方案：

```
LLM 客户端 → 本地代理(127.0.0.1:9877) → LLM API
                  ↓ 解析请求/响应
            Token/Cost 计算
                  ↓ EventEmitter
         ┌───────┴───────┐
    StatusBarItem   Webview Panel
    (紧凑状态栏)    (详细仪表盘)
```

- **无侵入**：用户只需设置 `HTTP_PROXY=http://127.0.0.1:9877`
- **实时流式**：通过 SSEMonitor 解析 SSE 事件流
- **双 UI 通道**：状态栏常驻 + 侧边栏仪表盘

### 关键依赖

| 包 | 用途 |
|---|------|
| `@anthropic-ai/sdk` | Token 计数 API、模型定价 |
| `eventemitter3` | 解耦事件通知 |
| `undici` | 高性能 HTTP 转发 |
| `@types/vscode` | VS Code API 类型 |
| `webpack` | 打包 |
| `@vscode/vsce` | VSIX 打包发布 |

---

## 三、实现过程

### 阶段 1：项目脚手架

- 初始化 npm 项目
- 安装所有依赖（生产 + 开发）
- 创建 TypeScript 配置、Webpack 配置
- 配置 VS Code 扩展清单 (`package.json`)
- 设置调试配置 (`.vscode/launch.json`, `tasks.json`)

### 阶段 2：核心类型定义

创建 `src/types/index.ts`，定义所有共享类型：
- `ModelConfig` — 模型配置（上下文窗口、定价）
- `TokenUsage` — Token 使用量
- `TurnStats` — 单轮统计
- `SessionStats` — 会话统计
- `DashboardPayload` — 仪表盘数据
- `MonitorSettings` — 配置项

创建 `src/constants.ts`，包含：
- 内置模型注册表（Claude Opus 4.8、Sonnet 4.6、Haiku 4.5、Fable 5；GPT-4o 系列）
- 官方定价数据
- 默认配置值、颜色阈值

### 阶段 3：服务层

| 文件 | 功能 |
|------|------|
| `src/services/ModelRegistry.ts` | 模型元数据管理，支持用户覆盖配置 |
| `src/services/TokenService.ts` | Token 计数（Anthropic API 精确计数 + 本地估算 + SHA-256 缓存） |
| `src/services/CostService.ts` | 费用计算（输入/输出/缓存分别计价） |
| `src/services/ConversationTracker.ts` | 对话状态跟踪、轮次记录 |

### 阶段 4：代理拦截层

| 文件 | 功能 |
|------|------|
| `src/proxy/ProxyServer.ts` | HTTP/HTTPS 代理核心（CONNECT 隧道 + HTTP 转发 + 请求体解析） |
| `src/proxy/SSEMonitor.ts` | SSE 流式事件解析器（Anthropic + OpenAI 格式） |
| `src/proxy/AnthropicParser.ts` | Anthropic Messages API 请求/响应解析 |
| `src/proxy/OpenAIParser.ts` | OpenAI Chat Completions API 请求/响应解析 |

### 阶段 5：状态管理层

| 文件 | 功能 |
|------|------|
| `src/state/SessionStore.ts` | 持久化存储（VS Code Memento），会话恢复 |
| `src/state/MetricsAggregator.ts` | 跨会话累计统计、24 小时滚动窗口 |

### 阶段 6：UI 层

| 文件 | 功能 |
|------|------|
| `src/ui/StatusBarManager.ts` | 状态栏显示（颜色分级、节流 100ms、三种显示模式） |
| `src/ui/DashboardProvider.ts` | 侧边栏仪表盘（进度条、Token 明细、费用卡片、对话历史表） |

### 阶段 7：扩展入口

`src/extension.ts` — 连接所有组件：
- 激活/停用生命周期
- 代理服务器管理
- 代理事件 → UI 更新
- 6 个命令注册
- 配置变更监听
- 会话持久化/恢复
- 引导通知

### 阶段 8：汉化

全面汉化所有用户界面：
- 状态栏文本 + 提示
- 仪表盘 HTML + JS 内联文本
- 通知消息 + 输出日志
- `package.json` 命令标题、配置描述
- CSS 适配（去除 `text-transform: uppercase`）

### 阶段 9：打包安装

- 安装 `@vscode/vsce` 打包工具
- 修复版本兼容性（`@types/vscode` ↔ `engines.vscode`）
- 打包为 `llm-context-monitor-0.1.0.vsix`（459.5 KB）
- 通过 `code --install-extension` 安装到 VS Code
- 验证：`code --list-extensions` 确认已安装

---

## 四、最终项目结构

```
context/
├── .vscode/
│   ├── launch.json              # 调试配置 (F5)
│   └── tasks.json               # 构建任务
├── src/
│   ├── extension.ts             # 入口：激活、命令、生命周期
│   ├── constants.ts             # 模型定义、定价、默认值
│   ├── types/
│   │   └── index.ts             # 共享类型定义
│   ├── proxy/
│   │   ├── ProxyServer.ts       # HTTP/HTTPS 代理核心
│   │   ├── SSEMonitor.ts        # SSE 流式事件解析
│   │   ├── AnthropicParser.ts   # Anthropic API 解析
│   │   └── OpenAIParser.ts      # OpenAI API 解析
│   ├── services/
│   │   ├── TokenService.ts      # Token 计数 (API + 本地)
│   │   ├── CostService.ts       # 费用计算
│   │   ├── ModelRegistry.ts     # 模型元数据注册表
│   │   └── ConversationTracker.ts  # 对话状态跟踪
│   ├── state/
│   │   ├── SessionStore.ts      # 持久化存储
│   │   └── MetricsAggregator.ts # 聚合统计
│   └── ui/
│       ├── StatusBarManager.ts  # 状态栏管理器
│       ├── DashboardProvider.ts # 仪表盘 Webview 提供者
│       └── dashboard/           # Webview 资源目录（备选）
├── out/
│   └── extension.js             # 构建输出 (774 KB)
├── package.json                 # 扩展清单
├── tsconfig.json                # TypeScript 配置
├── webpack.config.js            # Webpack 配置
├── .vscodeignore                # VSIX 打包排除
└── llm-context-monitor-0.1.0.vsix  # 安装包 (459.5 KB)
```

**统计**：14 个源文件 · ~1,800 行 TypeScript · 零编译错误

---

## 五、使用指南

### 启动

扩展安装后随 VS Code 自启动，无需手动操作。

### 监控 LLM 流量

在终端设置代理：
```bash
# Windows CMD
set HTTP_PROXY=http://127.0.0.1:9877

# PowerShell
$env:HTTP_PROXY = "http://127.0.0.1:9877"

# Bash
export HTTP_PROXY=http://127.0.0.1:9877
```

### 命令列表

| 命令 | 说明 |
|------|------|
| `llmContext.showDashboard` | 打开仪表盘 |
| `llmContext.toggleDisplay` | 切换显示模式（紧凑/详细/隐藏） |
| `llmContext.resetStats` | 重置统计数据 |
| `llmContext.exportReport` | 导出 JSON/CSV 报告 |
| `llmContext.startProxy` | 手动启动代理 |
| `llmContext.stopProxy` | 手动停止代理 |

### 配置项

| 配置键 | 默认值 | 说明 |
|--------|--------|------|
| `llmContext.proxyPort` | 9877 | 代理端口 |
| `llmContext.display.mode` | detailed | 显示模式 |
| `llmContext.monitoredEndpoints` | [api.anthropic.com, api.openai.com] | 监控端点 |
| `llmContext.modelOverrides` | {} | 模型配置覆盖 |
| `llmContext.throttleInterval` | 100 | UI 更新节流(ms) |
| `llmContext.autoStartProxy` | true | 自启动代理 |

---

## 六、颜色阈值

| 使用率 | 颜色 | 状态栏效果 |
|--------|------|-----------|
| < 50% | 🟢 绿色 | 正常 |
| 50% - 75% | 🟡 黄色 | 警告背景 |
| 75% - 90% | 🟠 橙色 | 警告背景 |
| > 90% | 🔴 红色 | 错误背景 |

---

## 七、支持的模型

### Anthropic (Claude)
- Claude Opus 4.8（1M 上下文窗口）
- Claude Sonnet 4.6（200K 上下文窗口）
- Claude Haiku 4.5（200K 上下文窗口）
- Claude Fable 5（1M 上下文窗口）
- Claude 3 Opus / 3.5 Sonnet

### OpenAI
- GPT-4o（128K 上下文窗口）
- GPT-4o Mini（128K 上下文窗口）
- GPT-4 Turbo（128K 上下文窗口）

### DeepSeek
- DeepSeek V4 Pro（1M 上下文窗口）
- DeepSeek Chat (V3)（128K 上下文窗口）
- DeepSeek Reasoner (R1)（128K 上下文窗口）

用户可通过 `llmContext.modelOverrides` 配置覆盖或添加新模型。

---

## 九、2026-06-17 更新：DeepSeek 支持 + OpenAI 流式修复

### 问题诊断

用户在另一个项目中使用 DeepSeek 时，扩展无法检测到任何 LLM 流量。根因分析发现 **三个层面的问题**：

#### 1. 监控端点缺失
默认 `monitoredEndpoints` 仅包含 `api.anthropic.com` 和 `api.openai.com`，DeepSeek 的 `api.deepseek.com` 不在列表中。

#### 2. SSEMonitor 无法解析 OpenAI 格式（关键 Bug）
`SSEMonitor.dispatchAnthropicEvent()` 仅处理 Anthropic 的事件类型（`message_start`、`content_block_delta` 等），而 **OpenAI 及其兼容 API 的 SSE 格式完全不同**：

- **Anthropic**: `event: message_start\ndata: {"type": "message_start", ...}`
- **OpenAI/DeepSeek**: `data: {"object": "chat.completion.chunk", "choices": [{"delta": {"content": "Hello"}}]}`

OpenAI chunk 会被 JSON.parse 成功解析，但没有 `type` 字段，在 switch-case 中落入 `default` 分支被**静默丢弃**。**这意味着不仅 DeepSeek，OpenAI 的流式监控也从未正常工作过。**

#### 3. 模型注册表缺失
`BUILTIN_MODELS` 中没有 DeepSeek 模型（deepseek-chat、deepseek-reasoner）。

### 修复内容

| 文件 | 修改 |
|------|------|
| `src/types/index.ts` | `Provider` 类型新增 `'deepseek'` |
| `src/constants.ts` | 新增 DeepSeek Chat (V3) 和 DeepSeek Reasoner (R1) 模型定义，含官方定价；`monitoredEndpoints` 默认加入 `api.deepseek.com` |
| `src/proxy/OpenAIParser.ts` | `isOpenAIHost()` 扩展为同时匹配 `api.openai.com` 和 `api.deepseek.com` |
| `src/proxy/SSEMonitor.ts` | **核心修复**：新增 `dispatchOpenAIChunk()` 方法处理 `chat.completion.chunk` 格式；`parseEvent()` 新增 OpenAI 格式检测；新增 `_turnCompleted` 防止 `turn-complete` 事件重复触发；支持 DeepSeek-R1 的 `reasoning_content` 字段 |
| `src/ui/DashboardProvider.ts` | webview 模型回退配置新增 deepseek-chat 和 deepseek-reasoner |

### 支持的 DeepSeek 模型

| 模型 ID | 名称 | 上下文窗口 | 输入/输出 (每1M token) |
|---------|------|-----------|----------------------|
| `deepseek-v4-pro` | DeepSeek V4 Pro | 1M | $0.55 / $2.19 |
| `deepseek-chat` | DeepSeek Chat (V3) | 128K | $0.27 / $1.10 |
| `deepseek-reasoner` | DeepSeek Reasoner (R1) | 128K | $0.55 / $2.19 |

### 环境配置

已设置用户级环境变量 `HTTP_PROXY=http://127.0.0.1:9877`，新终端自动生效：

```powershell
# 查看当前设置
[System.Environment]::GetEnvironmentVariable('HTTP_PROXY', 'User')

# 如需手动修改
[System.Environment]::SetEnvironmentVariable('HTTP_PROXY', 'http://127.0.0.1:9877', 'User')
```

### 验证测试

```bash
curl -x http://127.0.0.1:9877 \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-pro","messages":[{"role":"user","content":"hi"}],"stream":false,"max_tokens":10}' \
  https://api.deepseek.com/v1/chat/completions
```

### 使用方式

`HTTP_PROXY` 已设为 Windows 用户级环境变量，**新终端自动生效**。如临时需要：

```bash
# PowerShell
$env:HTTP_PROXY = "http://127.0.0.1:9877"

# Bash
export HTTP_PROXY=http://127.0.0.1:9877
```

然后运行你的 LLM 工具即可，代理会自动拦截并解析 DeepSeek/Anthropic/OpenAI 的 API 调用。

### 重要提示

~~扩展通过 HTTP 正向代理拦截 API 流量。~~ **此问题已通过 MITM 解决（见下文第十章）。**

客户端需要设置 `NODE_TLS_REJECT_UNAUTHORIZED=0` 以允许代理的 CA 证书。

---

## 十、2026-06-17 更新 #2：MITM HTTPS 拦截

### 问题诊断

curl 测试返回了响应，但仪表盘依然无数据。分析发现：**所有 HTTPS API 流量都通过 CONNECT 隧道传输**，代理无法解析加密的 HTTP 请求/响应体。第九章的修复只解决了格式解析问题，但没有解决 HTTP vs HTTPS 的根本差异。

### 解决方案：MITM（中间人）代理

实现完整的 TLS 中间人代理：

| 组件 | 说明 |
|------|------|
| `src/proxy/CertManager.ts` | **新文件**。使用 openssl 生成自签名 CA 根证书 + 动态主机证书 |
| `handleConnectMITM()` | 拦截 CONNECT → 返回 200 → TLS 解密 → 解析明文 HTTP |
| `tls.TLSSocket` | 服务端模式升级客户端 socket，使用动态生成的假证书 |
| CA 持久化 | `SessionStore.persistCA()` / `loadCA()` — CA 证书通过 VS Code globalState 持久化 |
| 导出 CA | 首次运行自动导出 `llm-monitor-ca.crt` 到扩展存储目录 |

### 环境要求

```bash
# 已设为用户级环境变量（新终端自动生效）
NODE_TLS_REJECT_UNAUTHORIZED=0
HTTP_PROXY=http://127.0.0.1:9877
```

### 修改文件

| 文件 | 类型 |
|------|------|
| `src/proxy/CertManager.ts` | **新增** — CA + 主机证书管理 |
| `src/proxy/ProxyServer.ts` | 修改 — +MITM CONNECT 处理 |
| `src/state/SessionStore.ts` | 修改 — +CA 持久化 |
| `src/extension.ts` | 修改 — CA 恢复/导出/引导消息 |

### 当前数据流

```
客户端 ──CONNECT──→ 代理(MITM: TLS解密) ──真实TLS──→ LLM API
                      │  ↑
                   明文HTTP  加密响应
                      │  ↑
                 解析/计数/TLS加密
                      │
                   UI 更新
```

---

## 十一、更新扩展

修改代码后，重新打包并安装：

```bash
cd c:\Users\23072\Desktop\context
npx webpack --mode production
npx vsce package --allow-missing-repository
code --install-extension llm-context-monitor-0.1.0.vsix --force
```

然后在 VS Code 中执行 `Developer: Reload Window`。

---

## 十二、2026-06-17 更新 #3：修复 MITM OpenSSL 配置缺失 + 端到端验证

### 问题诊断

**MITM 证书生成持续失败**，根因为 Conda 自带的 OpenSSL (`C:\Users\23072\miniconda3\Library\bin\openssl.exe`) 的 `OPENSSLDIR` 硬编码为 `C:\Program Files\Common Files\ssl`，该目录在本机不存在，导致 `openssl req` 无法加载配置文件。

错误日志：
```
Can't open "C:\Program Files\Common Files\ssl\/openssl.cnf" for reading, No such file or directory
```

证书生成失败 → MITM 回退为普通 CONNECT 隧道 → HTTPS 流量无法解密 → 扩展无法监控任何 LLM API 调用。

### 修复方案

**修改 `src/proxy/CertManager.ts`：**

1. **内嵌最小化 `openssl.cnf`**：定义 `MINIMAL_OPENSSL_CNF` 常量，包含 `[req]`、`[v3_ca]`、`[v3_host]` 三个 section
2. **动态生成临时配置文件**：`ensureMinConfig()` 在 temp 目录创建最小配置
3. **通过 `-config` 参数显式指定**：所有 `openssl req` / `openssl x509` 命令添加 `-config <path>` 参数，绕过编译时 OPENSSLDIR

```typescript
// 关键修复：通过 CLI 参数指定配置，而非依赖 OPENSSL_CONF 环境变量
private configArg(): string {
  return `-config "${this.ensureMinConfig()}"`;
}
```

### 端到端验证结果

| 测试项 | 结果 |
|--------|------|
| OpenSSL 证书生成 | ✅ `cert generated for api.anthropic.com` |
| CONNECT 隧道拦截 | ✅ `sent 200 for api.anthropic.com` |
| TLS 解密 | ✅ `TLSSocket created` + `piped TLS socket` |
| HTTP 请求解密 | ✅ `HTTP request received: POST /v1/messages` |
| 请求体解析 | ✅ `body read (89 bytes)` |
| 路由分发 | ✅ `routing to handleAnthropicMessage` |
| Anthropic 非流式 | ✅ 正常转发，响应正确 |
| Anthropic 流式 (SSE) | ✅ 正常转发 |

### curl 测试命令

```bash
# 需要 -k 跳过代理签发证书的 TLS 验证
curl -s -k --proxy-insecure -x http://127.0.0.1:9877 \
  -H "x-api-key: YOUR_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":50,"messages":[{"role":"user","content":"hi"}]}' \
  https://api.anthropic.com/v1/messages
```

### 已知限制

1. **DeepSeek HTTPS 拦截**：curl 测试中 DeepSeek 请求走普通 CONNECT 隧道而非 MITM，待进一步排查（可能是运行时配置未包含 `api.deepseek.com`）
2. **调试日志**：`ProxyServer.ts` 中 `debugLog()` 同时写入 stderr 和临时文件，生产环境应设为可选
3. **TLS 信任**：客户端需 `NODE_TLS_REJECT_UNAUTHORIZED=0` 或 `-k` 才能信任代理自签名 CA

---

## 十三、2026-06-17 更新 #4：修复模型识别 + 上下文窗口默认值

### 问题

用户反馈两个问题：
1. **最大上下文始终显示 200K token** — 即使使用 deepseek-v4-pro（1M 上下文窗口）
2. **模型显示"未知/Unknown Model"** — 明明用的是已知模型

### 根因分析

**三层缺陷叠加：**

| 层级 | 问题 | 影响 |
|------|------|------|
| `ModelRegistry.getModel()` | 仅做 `Map.get(id)` 精确匹配 | API 返回 `claude-sonnet-4-6-20250514`（带日期后缀）无法匹配到注册的 `claude-sonnet-4-6` |
| `findModel()` 前缀匹配 | 单向：仅检查"注册 ID 是否以请求 ID 开头" | 请求 ID 比注册 ID 长时（如带日期后缀）永远匹配不到 |
| `DEFAULT_MODEL` | `contextWindow: 200_000` | 所有未识别模型回退到 200K |

### 修复内容

**1. `ModelRegistry.getModel()` — 四级回退匹配：**
```
精确匹配 → 忽略大小写 → 双向模糊匹配 → 显示实际 ID（标记"未识别"）
```

**2. `findModel()` — 双向前缀/包含匹配：**
```
2a. 注册 ID 以请求 ID 开头（"claude-sonnet" → "claude-sonnet-4-6"）
2b. 请求 ID 以注册 ID 开头（"claude-sonnet-4-6-20250514" → "claude-sonnet-4-6"）
3a. 注册 ID 包含请求 ID
3b. 请求 ID 包含注册 ID
```

**3. `DEFAULT_MODEL` — 上下文窗口提升至 1M：**
```typescript
contextWindow: 1_000_000  // 200K → 1M（2026 年旗舰模型标准）
```

**4. `DashboardProvider` webview 端同步更新：**
- 回退默认值 200K → 1M
- 添加双向前缀模糊匹配

---

## 十四、2026-06-18 更新 #5：JSONL 直读方案（参照 cc-switch）

### 根本问题

HTTP 代理方案无法拦截 Claude Code 自身流量。Claude Code 使用 undici HTTP 库，**不读取 `HTTP_PROXY` 环境变量**，导致代理收不到任何 LLM API 调用，仪表盘始终显示 "unknown" 模型和空数据。

### 解决方案

参照 cc-switch（GitHub 50K+ Star），**直接读取 Claude Code 本地会话文件**：

```
~/.claude/projects/<项目>/<session>.jsonl  →  解析 →  提取模型+Token → 仪表盘
```

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/services/JSONLSyncService.ts` | 核心：扫描 JSONL 文件，增量解析 assistant 消息，按 message.id 去重 |

### 技术要点

- **扫描策略**：`projects/<项目>/*.jsonl` + `projects/<项目>/<session>/subagents/*.jsonl`
- **数据提取**：`message.role === "assistant"` → `message.model` + `message.usage`
- **去重**：同一 `message.id` 取 `output_tokens` 最大者（流式写入多次快照）
- **增量同步**：追踪 `lastModified` + `lastLineOffset`，只解析新增行
- **周期同步**：每 30 秒自动扫描，扩展停用时持久化同步状态

### 实测结果

```
首次同步: 导入 2,524 条, Token 315,581,643
模型识别: deepseek-v4-pro ✅, deepseek-v4-flash ✅
上下文窗口: 1,000,000 token ✅
```

### 与 HTTP 代理的关系

| 数据源 | 用途 | 覆盖范围 |
|--------|------|---------|
| **JSONL 直读** | 主要数据源 | Claude Code 所有历史 + 实时会话 |
| HTTP 代理 | 补充数据源 | curl / Python / 其他工具通过代理的流量 |
