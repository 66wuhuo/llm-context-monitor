// ============================================================
// extension.ts — entry point: activation, wiring, lifecycle
// ============================================================

import * as vscode from 'vscode';
import { ProxyServer } from './proxy/ProxyServer';
import { CertManager } from './proxy/CertManager';
import { ModelRegistry } from './services/ModelRegistry';
import { TokenService } from './services/TokenService';
import { ConversationTracker } from './services/ConversationTracker';
import { SessionStore } from './state/SessionStore';
import { MetricsAggregator } from './state/MetricsAggregator';
import { StatusBarManager } from './ui/StatusBarManager';
import { DashboardProvider } from './ui/DashboardProvider';
import { CostService } from './services/CostService';
import { JSONLSyncService } from './services/JSONLSyncService';
import { DEFAULT_SETTINGS } from './constants';
import type { MonitorSettings, TokenUsage } from './types';

// ---- Global state ----
let proxyServer: ProxyServer | null = null;
let modelRegistry: ModelRegistry;
let tokenService: TokenService;
let conversationTracker: ConversationTracker;
let sessionStore: SessionStore;
let metricsAggregator: MetricsAggregator;
let statusBar: StatusBarManager;
let dashboardProvider: DashboardProvider;
let costService: CostService;
let jsonlSync: JSONLSyncService;
let jsonlSyncInterval: ReturnType<typeof setInterval> | null = null;
let extensionContext: vscode.ExtensionContext;

/** Output channel for logging */
let outputChannel: vscode.OutputChannel;

// ============================================================
// Extension Activation
// ============================================================

export function activate(context: vscode.ExtensionContext): void {
  // Store context for use by module-level functions
  extensionContext = context;

  // Output channel for diagnostics
  outputChannel = vscode.window.createOutputChannel('LLM 上下文监控');
  outputChannel.appendLine('LLM 上下文监控正在启动...');

  // Initialize services
  modelRegistry = new ModelRegistry();
  tokenService = new TokenService();
  conversationTracker = new ConversationTracker(modelRegistry);
  sessionStore = new SessionStore();
  metricsAggregator = new MetricsAggregator();
  costService = new CostService();
  jsonlSync = new JSONLSyncService(modelRegistry, conversationTracker, costService);

  // Initialize session store with persistent storage
  sessionStore.initialize(context.globalState);

  // Restore JSONL sync state
  const savedSyncState = context.globalState.get<Record<string, any>>(
    'llmContext.jsonlSyncState'
  );
  if (savedSyncState) {
    jsonlSync.loadState(savedSyncState);
    outputChannel.appendLine('JSONL 同步状态已恢复');
  }

  // Load settings
  const settings = getSettings();
  modelRegistry.applyOverrides(settings.modelOverrides);

  // Restore persisted CA certificate
  restoreCA(context);

  // Initialize UI
  statusBar = new StatusBarManager(modelRegistry);
  statusBar.setDisplayMode(settings.displayMode);
  statusBar.setThrottleInterval(settings.throttleInterval);

  dashboardProvider = new DashboardProvider(
    modelRegistry,
    conversationTracker,
    metricsAggregator
  );
  dashboardProvider.setThrottleInterval(settings.throttleInterval);

  // Register the dashboard webview view
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DashboardProvider.viewType,
      dashboardProvider
    )
  );

  // Restore persisted sessions
  restoreSessions();

  // Register all commands
  registerCommands(context);

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('llmContext')) {
        const newSettings = getSettings();
        applySettings(newSettings);
      }
    })
  );

  // Auto-start proxy if configured
  if (settings.autoStartProxy) {
    startProxy(settings.proxyPort, settings.monitoredEndpoints);
  }

  // Run initial JSONL sync (reads Claude Code session files directly)
  runJsonlSync();

  // Set up periodic JSONL sync (every 30s)
  jsonlSyncInterval = setInterval(() => {
    runJsonlSync();
  }, 30_000);

  // Show onboarding notification
  showOnboardingIfNeeded(context);

  // Auto-export CA cert on first run
  exportCAOnFirstRun(context);

  outputChannel.appendLine('LLM 上下文监控已成功启动。');
}

// ============================================================
// Extension Deactivation
// ============================================================

export function deactivate(): void {
  outputChannel.appendLine('LLM 上下文监控正在停止...');

  // Stop periodic JSONL sync
  if (jsonlSyncInterval) {
    clearInterval(jsonlSyncInterval);
    jsonlSyncInterval = null;
  }

  // Final JSONL sync + persist state
  runJsonlSync();
  persistJsonlSyncState();

  // Persist current sessions
  persistSessions();

  // Stop proxy
  if (proxyServer) {
    proxyServer.stop().catch((err) => {
      outputChannel.appendLine(`停止代理出错: ${err.message}`);
    });
  }

  // Dispose UI
  statusBar?.dispose();
  outputChannel?.dispose();

  outputChannel.appendLine('LLM 上下文监控已停止。');
}

// ============================================================
// Proxy Management
// ============================================================

async function startProxy(port: number, monitoredHosts: string[]): Promise<void> {
  if (proxyServer) {
    await proxyServer.stop();
  }

  proxyServer = new ProxyServer(
    port,
    tokenService,
    modelRegistry,
    conversationTracker
  );
  proxyServer.setMonitoredHosts(monitoredHosts);

  // Restore CA cert if previously persisted
  const caPair = sessionStore.loadCA();
  if (caPair) {
    proxyServer.setCACert(caPair);
  }

  // Wire proxy events to UI
  proxyServer.on('request-detected', (data) => {
    outputChannel.appendLine(
      `[Request] session=${data.conversationId} model=${data.model} ` +
        `inputTokens=${data.inputTokens} stream=${data.stream}`
    );

    // Update status bar with initial counts
    statusBar.onStreamDelta(
      data.inputTokens,
      0, // output starts at 0
      data.model,
      0
    );

    // Update dashboard
    dashboardProvider.onStreamDelta(data.inputTokens, 0, data.model);
  });

  proxyServer.on('token-delta', (data) => {
    const session = conversationTracker.getActiveSession();
    if (session) {
      const inputTokens = session.totalUsage.inputTokens;
      const model = session.model;

      // Estimate cost
      const modelConfig = modelRegistry.getModel(model);
      const usage: TokenUsage = {
        inputTokens,
        outputTokens: data.estimatedOutputTokens,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: inputTokens + data.estimatedOutputTokens,
      };
      const cost = costService.calculateCostFromUsage(usage, modelConfig);

      statusBar.onStreamDelta(inputTokens, data.estimatedOutputTokens, model, cost);
      dashboardProvider.onStreamDelta(inputTokens, data.estimatedOutputTokens, model);
    }
  });

  proxyServer.on('turn-complete', (data) => {
    outputChannel.appendLine(
      `[Turn Complete] session=${data.conversationId} model=${data.model} ` +
        `input=${data.usage.inputTokens} output=${data.usage.outputTokens} ` +
        `total=${data.usage.totalTokens}`
    );

    const modelConfig = modelRegistry.getModel(data.model);
    const cost = costService.calculateCostFromUsage(data.usage, modelConfig);

    statusBar.onTurnComplete(
      { inputTokens: data.usage.inputTokens, outputTokens: data.usage.outputTokens },
      data.model,
      cost
    );

    dashboardProvider.onTurnComplete();

    // Update aggregate metrics
    const allSessions = conversationTracker.getAllSessions();
    metricsAggregator.recalculate(allSessions);

    // Auto-persist
    persistSessions();
  });

  proxyServer.on('proxy-started', (data) => {
    // Reset MITM failure counters on each start (fresh chance)
    proxyServer!.resetMitmFailures();
    outputChannel.appendLine(`Proxy started on port ${data.port}`);

    // Persist the CA cert for future restarts
    const caPair = proxyServer!.getCACertPair();
    sessionStore.persistCA(caPair);

    const mitmStatus = CertManager.isAvailable()
      ? 'MITM 已启用'
      : 'openssl 不可用，MITM 已禁用';
    outputChannel.appendLine(`MITM status: ${mitmStatus}`);

    vscode.window.setStatusBarMessage(
      `LLM 上下文监控：代理运行在端口 ${data.port} (${mitmStatus})`,
      5000
    );
  });

  proxyServer.on('proxy-stopped', () => {
    outputChannel.appendLine('Proxy stopped');
  });

  proxyServer.on('proxy-error', (data) => {
    outputChannel.appendLine(`代理警告: ${data.error.message}`);
    // Use warning level for TLS trust issues (expected, not fatal)
    vscode.window.showWarningMessage(
      `LLM 上下文监控: ${data.error.message}`,
      '导出 CA 证书',
      '不再显示'
    ).then((selection) => {
      if (selection === '导出 CA 证书') {
        exportCACertToFile(extensionContext);
      }
    });
  });

  try {
    const actualPort = await proxyServer.start();
    outputChannel.appendLine(`Proxy listening on 127.0.0.1:${actualPort}`);
  } catch (err) {
    outputChannel.appendLine(`Failed to start proxy: ${(err as Error).message}`);
    vscode.window.showErrorMessage(
      `LLM 上下文监控：代理启动失败 — ${(err as Error).message}`
    );
  }
}

async function stopProxy(): Promise<void> {
  if (proxyServer) {
    await proxyServer.stop();
    proxyServer = null;
    outputChannel.appendLine('代理已由用户命令停止');
    vscode.window.showInformationMessage('LLM 上下文监控：代理已停止');
  }
}

// ============================================================
// Commands
// ============================================================

function registerCommands(context: vscode.ExtensionContext): void {
  // Show dashboard
  context.subscriptions.push(
    vscode.commands.registerCommand('llmContext.showDashboard', () => {
      vscode.commands.executeCommand(
        'workbench.view.extension.llmContext'
      );
    })
  );

  // Toggle display mode
  context.subscriptions.push(
    vscode.commands.registerCommand('llmContext.toggleDisplay', async () => {
      const current = vscode.workspace
        .getConfiguration('llmContext.display')
        .get<string>('mode', 'detailed');

      const options = ['compact', 'detailed', 'hidden'];
      const currentIndex = options.indexOf(current);
      const next = options[(currentIndex + 1) % options.length];

      await vscode.workspace
        .getConfiguration('llmContext.display')
        .update('mode', next, vscode.ConfigurationTarget.Global);

      vscode.window.showInformationMessage(
        `LLM 上下文显示模式: ${next === 'compact' ? '紧凑' : next === 'detailed' ? '详细' : '隐藏'}`
      );
    })
  );

  // Reset statistics
  context.subscriptions.push(
    vscode.commands.registerCommand('llmContext.resetStats', async () => {
      const confirmed = await vscode.window.showWarningMessage(
        '确认重置所有 LLM 上下文统计数据？此操作不可撤销。',
        { modal: true },
        '确认重置'
      );

      if (confirmed === '确认重置') {
        conversationTracker.reset();
        metricsAggregator.recalculate([]);
        sessionStore.clear();
        statusBar.reset();
        dashboardProvider.reset();
        vscode.window.showInformationMessage(
          'LLM 上下文统计数据已重置。'
        );
        outputChannel.appendLine('用户已重置统计数据');
      }
    })
  );

  // Export report
  context.subscriptions.push(
    vscode.commands.registerCommand('llmContext.exportReport', async () => {
      const sessions = conversationTracker.getAllSessions();
      const cumulative = metricsAggregator.getCumulative();

      const report = {
        generatedAt: new Date().toISOString(),
        cumulative,
        sessions: sessions.map((s) => ({
          id: s.conversationId,
          model: s.model,
          startedAt: new Date(s.startedAt).toISOString(),
          lastActivityAt: new Date(s.lastActivityAt).toISOString(),
          turns: s.turns.length,
          totalTokens: s.totalUsage.totalTokens,
          totalCost: Number(s.totalCost.toFixed(4)),
          isActive: s.isActive,
        })),
      };

      // Save as JSON file
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('llm-context-report.json'),
        filters: {
          'JSON 文件': ['json'],
          'CSV 文件': ['csv'],
          '所有文件': ['*'],
        },
      });

      if (uri) {
        const content = JSON.stringify(report, null, 2);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
        vscode.window.showInformationMessage(
          `报告已导出到 ${uri.fsPath}`
        );
        outputChannel.appendLine(`报告已导出到 ${uri.fsPath}`);
      }
    })
  );

  // Start proxy
  context.subscriptions.push(
    vscode.commands.registerCommand('llmContext.startProxy', async () => {
      const settings = getSettings();
      await startProxy(settings.proxyPort, settings.monitoredEndpoints);
    })
  );

  // Stop proxy
  context.subscriptions.push(
    vscode.commands.registerCommand('llmContext.stopProxy', async () => {
      await stopProxy();
    })
  );

  // Export CA certificate
  context.subscriptions.push(
    vscode.commands.registerCommand('llmContext.exportCACert', async () => {
      await exportCACertToFile(extensionContext);
    })
  );

  // Reset MITM state (retry TLS interception after fixing trust issues)
  context.subscriptions.push(
    vscode.commands.registerCommand('llmContext.resetMitm', async () => {
      if (proxyServer) {
        proxyServer.resetMitmFailures();
        vscode.window.showInformationMessage('MITM 状态已重置，将重新尝试 TLS 拦截。');
        outputChannel.appendLine('用户手动重置 MITM 状态');
      }
    })
  );
}

// ============================================================
// Settings
// ============================================================

function getSettings(): MonitorSettings {
  const config = vscode.workspace.getConfiguration('llmContext');
  return {
    proxyPort: config.get<number>('proxyPort', DEFAULT_SETTINGS.proxyPort),
    displayMode:
      config.get<'compact' | 'detailed' | 'hidden'>(
        'display.mode',
        DEFAULT_SETTINGS.displayMode
      ),
    monitoredEndpoints: config.get<string[]>(
      'monitoredEndpoints',
      DEFAULT_SETTINGS.monitoredEndpoints
    ),
    modelOverrides: config.get<Record<string, any>>('modelOverrides', {}),
    throttleInterval: config.get<number>(
      'throttleInterval',
      DEFAULT_SETTINGS.throttleInterval
    ),
    autoStartProxy: config.get<boolean>(
      'autoStartProxy',
      DEFAULT_SETTINGS.autoStartProxy
    ),
  };
}

function applySettings(settings: MonitorSettings): void {
  outputChannel.appendLine('配置已变更，正在应用...');

  modelRegistry.applyOverrides(settings.modelOverrides);
  statusBar.setDisplayMode(settings.displayMode);
  statusBar.setThrottleInterval(settings.throttleInterval);
  dashboardProvider.setThrottleInterval(settings.throttleInterval);

  if (proxyServer) {
    proxyServer.setMonitoredHosts(settings.monitoredEndpoints);
  }

  // Attempt to set API key from VS Code secrets or environment
  trySetApiKey();
}

// ============================================================
// Persistence
// ============================================================

async function persistSessions(): Promise<void> {
  const sessions = conversationTracker.getAllSessions();
  const cumulative = metricsAggregator.getCumulative();
  await sessionStore.persist(sessions, {
    totalTokens: cumulative.totalTokens,
    totalCost: cumulative.totalCost,
    totalSessions: cumulative.totalSessions,
    totalTurns: cumulative.totalTurns,
  });
}

function restoreSessions(): void {
  const data = sessionStore.load();
  if (!data) return;

  outputChannel.appendLine(
    `正在恢复 ${data.sessions.length} 个已持久化的会话`
  );

  // Rebuild session state from persisted data
  for (const ps of data.sessions) {
    conversationTracker.startConversation(ps.conversationId, ps.model);

    // Reconstruct usage
    const usage: TokenUsage = {
      inputTokens: ps.totalInputTokens,
      outputTokens: ps.totalOutputTokens,
      cacheReadTokens: ps.totalCacheReadTokens,
      cacheCreationTokens: ps.totalCacheCreationTokens,
      totalTokens: ps.totalTokens,
    };

    conversationTracker.recordTurn(
      ps.conversationId,
      usage,
      ps.model,
      1 // Simplified: don't preserve per-turn detail in persistence
    );

    if (!ps.isActive) {
      conversationTracker.endConversation(ps.conversationId);
    }
  }

  // Recalculate cumulative from restored sessions
  const sessions = conversationTracker.getAllSessions();
  metricsAggregator.recalculate(sessions);
}

// ============================================================
// CA Certificate Management
// ============================================================

function restoreCA(context: vscode.ExtensionContext): void {
  const caData = context.globalState.get<{ cert: string; key: string }>(
    'llmContext.caCert'
  );
  if (caData && caData.cert && caData.key) {
    sessionStore.persistCA(caData);
    outputChannel.appendLine('CA 证书已从存储中恢复');
  }
}

async function exportCAOnFirstRun(context: vscode.ExtensionContext): Promise<void> {
  const hasExported = context.globalState.get<boolean>('llmContext.caExported');
  if (hasExported) return;

  // Wait for proxy to start and generate CA
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const caPair = proxyServer?.getCACertPair();
  if (!caPair) return;

  const caPath = vscode.Uri.joinPath(
    context.globalStorageUri,
    'llm-monitor-ca.crt'
  );

  try {
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    await vscode.workspace.fs.writeFile(caPath, Buffer.from(caPair.cert, 'utf-8'));
    context.globalState.update('llmContext.caExported', true);

    outputChannel.appendLine(`CA 证书已导出到: ${caPath.fsPath}`);
    outputChannel.appendLine('如需信任 CA 证书，请在终端执行:');
    outputChannel.appendLine(`  set NODE_TLS_REJECT_UNAUTHORIZED=0`);
    outputChannel.appendLine(`  # 或将 CA 证书添加到系统信任存储`);
  } catch (err) {
    outputChannel.appendLine(`导出 CA 证书失败: ${(err as Error).message}`);
  }
}

// ============================================================
// JSONL Session Sync
// ============================================================

async function runJsonlSync(): Promise<void> {
  try {
    const result = await jsonlSync.syncAll();

    if (result.imported > 0) {
      outputChannel.appendLine(
        `JSONL 同步: 导入 ${result.imported} 条, ` +
        `跳过 ${result.skipped} 条, ` +
        `Token ${result.totalTokens.toLocaleString()}, ` +
        `模型: ${Object.keys(result.models).join(', ')}`
      );

      // Update metrics and dashboard after new data arrives
      const allSessions = conversationTracker.getAllSessions();
      metricsAggregator.recalculate(allSessions);
      dashboardProvider.onTurnComplete();

      // Auto-persist sessions + sync state
      persistSessions();
      persistJsonlSyncState();
    }

    if (result.filesScanned > 0 && result.imported === 0) {
      // Silent — no new data
    }
  } catch (err) {
    outputChannel.appendLine(
      `JSONL 同步错误: ${(err as Error).message}`
    );
  }
}

function persistJsonlSyncState(): void {
  const state = jsonlSync.saveState();
  extensionContext.globalState.update('llmContext.jsonlSyncState', state);
}

// ============================================================
// CA Certificate Export
// ============================================================

async function exportCACertToFile(_context?: vscode.ExtensionContext): Promise<void> {
  const caPair = proxyServer?.getCACertPair();
  if (!caPair) {
    vscode.window.showWarningMessage('CA 证书尚未生成。请等待代理启动后再试。');
    return;
  }

  const defaultUri = vscode.Uri.file('llm-monitor-ca.crt');
  const uri = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { '证书文件': ['crt', 'pem'], '所有文件': ['*'] },
  });

  if (uri) {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(caPair.cert, 'utf-8'));
    outputChannel.appendLine(`CA 证书已导出到: ${uri.fsPath}`);

    const choice = await vscode.window.showInformationMessage(
      `CA 证书已导出到 ${uri.fsPath}`,
      '复制安装说明',
      '知道了'
    );

    if (choice === '复制安装说明') {
      const instructions = [
        '# Windows (CMD, 管理员)',
        `certutil -addstore Root "${uri.fsPath}"`,
        '',
        '# macOS',
        `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${uri.fsPath}"`,
        '',
        '# Linux (Debian/Ubuntu)',
        `sudo cp "${uri.fsPath}" /usr/local/share/ca-certificates/llm-monitor-ca.crt`,
        'sudo update-ca-certificates',
        '',
        '# 或者设置环境变量跳过 TLS 验证',
        'NODE_TLS_REJECT_UNAUTHORIZED=0',
        'HTTP_PROXY=http://127.0.0.1:9877',
        'HTTPS_PROXY=http://127.0.0.1:9877',
      ].join('\n');
      await vscode.env.clipboard.writeText(instructions);
      vscode.window.showInformationMessage('安装说明已复制到剪贴板');
    }
  }
}

// ============================================================
// Helpers
// ============================================================

function trySetApiKey(): void {
  // Try to get API key from ANTHROPIC_API_KEY environment variable
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    tokenService.setApiKey(apiKey);
    outputChannel.appendLine('已从环境变量配置 Anthropic API 密钥');
  }
}

function showOnboardingIfNeeded(context: vscode.ExtensionContext): void {
  const hasSeenOnboarding = context.globalState.get<boolean>(
    'llmContext.onboardingShown'
  );

  if (!hasSeenOnboarding) {
    const settings = getSettings();
    vscode.window
      .showInformationMessage(
        `🚀 LLM 上下文监控已启动！\n\n` +
          `1. 设置代理：HTTP_PROXY=http://127.0.0.1:${settings.proxyPort}\n` +
          `2. 设置 HTTPS 代理：HTTPS_PROXY=http://127.0.0.1:${settings.proxyPort}\n` +
          `3. 跳过 TLS 验证（MITM 解密需要）：NODE_TLS_REJECT_UNAUTHORIZED=0\n\n` +
          `打开仪表盘：点击活动栏的 📊 图标。`,
        { modal: false },
        '打开仪表盘',
        '知道了'
      )
      .then((selection) => {
        if (selection === '打开仪表盘') {
          vscode.commands.executeCommand('llmContext.showDashboard');
        }
      });

    context.globalState.update('llmContext.onboardingShown', true);
  }
}
