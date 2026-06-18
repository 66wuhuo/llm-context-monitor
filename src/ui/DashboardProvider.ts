// ============================================================
// DashboardProvider — WebviewView provider for the sidebar panel
// ============================================================

import * as vscode from 'vscode';
import type { DashboardPayload, SessionStats, TurnStats, TokenUsage } from '../types';
import type { ModelRegistry } from '../services/ModelRegistry';
import type { ConversationTracker } from '../services/ConversationTracker';
import type { MetricsAggregator, CumulativeMetrics } from '../state/MetricsAggregator';
import { MAX_RECENT_TURNS } from '../constants';

export class DashboardProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'llmContext.dashboard';
  private _view?: vscode.WebviewView;

  private modelRegistry: ModelRegistry;
  private conversationTracker: ConversationTracker;
  private metricsAggregator: MetricsAggregator;
  private isStreaming: boolean = false;

  /** Latest stats for incremental updates */
  private currentInputTokens: number = 0;
  private currentOutputTokens: number = 0;
  private currentModel: string = 'unknown';

  /** Throttle for streaming updates */
  private lastUpdate = 0;
  private throttleInterval = 100;

  constructor(
    modelRegistry: ModelRegistry,
    conversationTracker: ConversationTracker,
    metricsAggregator: MetricsAggregator
  ) {
    this.modelRegistry = modelRegistry;
    this.conversationTracker = conversationTracker;
    this.metricsAggregator = metricsAggregator;
  }

  setThrottleInterval(ms: number): void {
    this.throttleInterval = ms;
  }

  /** Called when the webview becomes visible */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };

    webviewView.webview.html = this.getHtmlContent();

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case 'reset':
          vscode.commands.executeCommand('llmContext.resetStats');
          break;
        case 'export':
          vscode.commands.executeCommand('llmContext.exportReport');
          break;
        case 'ready':
          // Webview is ready, push initial state
          this.pushFullUpdate();
          break;
      }
    });

    // Push initial data once the webview is ready
    webviewView.webview.postMessage({
      command: 'init',
      payload: this.buildPayload(),
    });
  }

  /** Update on streaming token delta */
  onStreamDelta(inputTokens: number, outputTokens: number, model: string): void {
    this.isStreaming = true;
    this.currentInputTokens = inputTokens;
    this.currentOutputTokens = outputTokens;
    this.currentModel = model;
    this.throttledPush();
  }

  /** Update on turn completion */
  onTurnComplete(): void {
    this.isStreaming = false;
    this.pushFullUpdate();
  }

  /** Reset the dashboard */
  reset(): void {
    this.isStreaming = false;
    this.currentInputTokens = 0;
    this.currentOutputTokens = 0;
    this.pushFullUpdate();
  }

  /** Push a complete dashboard update */
  private pushFullUpdate(): void {
    if (!this._view) return;
    this._view.webview.postMessage({
      command: 'update',
      payload: this.buildPayload(),
    });
  }

  /** Throttled push for streaming updates */
  private throttledPush(): void {
    const now = Date.now();
    if (now - this.lastUpdate >= this.throttleInterval) {
      this.lastUpdate = now;
      this.pushFullUpdate();
    }
  }

  /** Build the complete dashboard payload */
  private buildPayload(): DashboardPayload {
    const currentSession = this.conversationTracker.getActiveSession();
    const allSessions = this.conversationTracker.getAllSessions();

    // Use session data when available (JSONL sync), fall back to streaming counters
    const model = currentSession?.model ?? this.currentModel;
    const modelConfig = this.modelRegistry.getModel(model);
    const totalTokens = currentSession
      ? currentSession.totalUsage.totalTokens
      : this.currentInputTokens + this.currentOutputTokens;
    const contextWindowPercent = modelConfig.contextWindow > 0
      ? Math.min(100, Math.round((totalTokens / modelConfig.contextWindow) * 1000) / 10)
      : 0;

    // Get recent turns
    const recentTurns: TurnStats[] = currentSession
      ? currentSession.turns.slice(-MAX_RECENT_TURNS)
      : [];

    // Cumulative metrics
    const cumulative = this.metricsAggregator.getCumulative();

    return {
      currentSession,
      allSessions,
      isStreaming: this.isStreaming,
      contextWindowPercent,
      recentTurns,
      cumulative,
    };
  }

  /** Get the HTML content for the webview */
  private getHtmlContent(): string {
    // Inline all CSS and JS since we can't load external resources in the webview
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LLM 上下文仪表盘</title>
  <style>
    ${this.getStyles()}
  </style>
</head>
<body>
  <div id="app">
    <!-- Header -->
    <div class="header">
      <h2>📊 LLM 上下文监控</h2>
      <div class="header-actions">
        <button id="btn-reset" title="重置统计">🔄</button>
        <button id="btn-export" title="导出报告">📥</button>
      </div>
    </div>

    <!-- Progress Bar Section -->
    <div class="section">
      <div class="section-title">上下文窗口使用</div>
      <div class="progress-container">
        <div class="progress-bar">
          <div id="progress-fill" class="progress-fill" style="width: 0%"></div>
        </div>
        <div class="progress-label">
          <span id="progress-percent">0%</span>
          <span id="progress-tokens">0 / 0 tokens</span>
        </div>
      </div>
      <div id="streaming-indicator" class="streaming-indicator hidden">
        <span class="pulse-dot"></span> 流式传输中...
      </div>
    </div>

    <!-- Token Breakdown -->
    <div class="section">
      <div class="section-title">Token 明细</div>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">输入</div>
          <div id="stat-input" class="stat-value">0</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">输出</div>
          <div id="stat-output" class="stat-value">0</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">缓存读取</div>
          <div id="stat-cache-read" class="stat-value">0</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">合计</div>
          <div id="stat-total" class="stat-value">0</div>
        </div>
      </div>
    </div>

    <!-- Cost Section -->
    <div class="section">
      <div class="section-title">费用</div>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">本次会话</div>
          <div id="stat-session-cost" class="stat-value">$0.00</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">累计</div>
          <div id="stat-cumulative-cost" class="stat-value">$0.00</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">模型</div>
          <div id="stat-model" class="stat-value">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">会话数</div>
          <div id="stat-sessions" class="stat-value">0</div>
        </div>
      </div>
    </div>

    <!-- Turn History -->
    <div class="section">
      <div class="section-title">对话历史</div>
      <div id="turn-history" class="turn-history">
        <div class="empty-state">暂无活动</div>
      </div>
    </div>
  </div>

  <script>
    ${this.getScript()}
  </script>
</body>
</html>`;
  }

  private getStyles(): string {
    return /* css */ `
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: var(--vscode-font-family, -apple-system, sans-serif);
        font-size: var(--vscode-font-size, 13px);
        color: var(--vscode-foreground);
        padding: 12px;
        line-height: 1.4;
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 16px;
      }
      .header h2 { font-size: 16px; font-weight: 600; }
      .header-actions { display: flex; gap: 4px; }
      .header-actions button {
        background: none;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        padding: 4px 8px;
        cursor: pointer;
        color: var(--vscode-foreground);
        font-size: 14px;
      }
      .header-actions button:hover {
        background: var(--vscode-toolbar-hoverBackground);
      }

      .section {
        margin-bottom: 16px;
        padding: 12px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 6px;
        background: var(--vscode-editor-background, rgba(0,0,0,0.05));
      }
      .section-title {
        font-weight: 600;
        font-size: 12px;
        text-transform: none;
        letter-spacing: 0.5px;
        margin-bottom: 8px;
        color: var(--vscode-descriptionForeground);
      }

      .progress-container { margin-bottom: 4px; }
      .progress-bar {
        height: 12px;
        background: var(--vscode-progressBar-background, #e0e0e0);
        border-radius: 6px;
        overflow: hidden;
        margin-bottom: 4px;
      }
      .progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #4caf50, #ffc107 50%, #f44336 100%);
        background-size: 200% 100%;
        border-radius: 6px;
        transition: width 0.3s ease;
        min-width: 0;
      }
      .progress-label {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      }

      .streaming-indicator {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--vscode-charts-green, #4caf50);
        margin-top: 4px;
      }
      .streaming-indicator.hidden { display: none; }
      .pulse-dot {
        width: 6px; height: 6px;
        border-radius: 50%;
        background: var(--vscode-charts-green, #4caf50);
        animation: pulse 1.5s infinite;
      }
      @keyframes pulse {
        0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; }
      }

      .stats-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .stat-card {
        padding: 8px;
        border-radius: 4px;
        background: var(--vscode-badge-background, rgba(128,128,128,0.1));
      }
      .stat-label {
        font-size: 10px;
        text-transform: none;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 2px;
      }
      .stat-value {
        font-size: 18px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }

      .turn-history {
        max-height: 200px;
        overflow-y: auto;
      }
      .turn-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 0;
        border-bottom: 1px solid var(--vscode-panel-border);
        font-size: 11px;
      }
      .turn-item:last-child { border-bottom: none; }
      .turn-index { font-weight: 600; min-width: 24px; }
      .turn-tokens { color: var(--vscode-descriptionForeground); }
      .turn-cost { font-weight: 600; color: var(--vscode-charts-orange, #ff9800); }
      .turn-model { font-size: 10px; color: var(--vscode-descriptionForeground); }

      .empty-state {
        text-align: center;
        color: var(--vscode-descriptionForeground);
        padding: 16px;
        font-style: italic;
      }
    `;
  }

  private getScript(): string {
    return /* js */ `
      const vscode = acquireVsCodeApi();

      // Request initial data
      vscode.postMessage({ command: 'ready' });

      // Handle messages from extension
      window.addEventListener('message', (event) => {
        const { command, payload } = event.data;
        if (command === 'update' || command === 'init') {
          updateDashboard(payload);
        }
      });

      // Button handlers
      document.getElementById('btn-reset').addEventListener('click', () => {
        vscode.postMessage({ command: 'reset' });
      });
      document.getElementById('btn-export').addEventListener('click', () => {
        vscode.postMessage({ command: 'export' });
      });

      function updateDashboard(data) {
        // Progress bar
        const pct = data.contextWindowPercent || 0;
        document.getElementById('progress-fill').style.width = pct + '%';
        document.getElementById('progress-percent').textContent = pct + '%';

        // Streaming indicator
        const streamInd = document.getElementById('streaming-indicator');
        if (data.isStreaming) {
          streamInd.classList.remove('hidden');
        } else {
          streamInd.classList.add('hidden');
        }

        // Session info
        const session = data.currentSession;
        if (session) {
          document.getElementById('stat-input').textContent = formatNumber(session.totalUsage.inputTokens);
          document.getElementById('stat-output').textContent = formatNumber(session.totalUsage.outputTokens);
          document.getElementById('stat-cache-read').textContent = formatNumber(session.totalUsage.cacheReadTokens);
          document.getElementById('stat-total').textContent = formatNumber(session.totalUsage.totalTokens);
          document.getElementById('stat-session-cost').textContent = '$' + session.totalCost.toFixed(3);
          document.getElementById('stat-model').textContent = session.model;

          const modelConfig = getModelConfig(session.model);
          const total = session.totalUsage.totalTokens;
          document.getElementById('progress-tokens').textContent =
            formatNumber(total) + ' / ' + formatNumber(modelConfig.contextWindow) + ' token';
        } else {
          document.getElementById('stat-input').textContent = '0';
          document.getElementById('stat-output').textContent = '0';
          document.getElementById('stat-cache-read').textContent = '0';
          document.getElementById('stat-total').textContent = '0';
          document.getElementById('stat-session-cost').textContent = '$0.00';
          document.getElementById('stat-model').textContent = '-';
        }

        // Cumulative
        document.getElementById('stat-cumulative-cost').textContent =
          '$' + (data.cumulative?.totalCost || 0).toFixed(3);
        document.getElementById('stat-sessions').textContent =
          String(data.cumulative?.totalSessions || 0);

        // Turn history
        const historyEl = document.getElementById('turn-history');
        const turns = data.recentTurns || [];
        if (turns.length === 0) {
          historyEl.innerHTML = '<div class="empty-state">暂无活动</div>';
        } else {
          historyEl.innerHTML = turns.slice().reverse().map(t => {
            const tks = (t.usage?.totalTokens || 0);
            const usedLabel = formatNumber(tks);
            return '<div class="turn-item">' +
              '<span class="turn-index">#' + t.turnIndex + '</span>' +
              '<span class="turn-model">' + escapeHtml(t.model) + '</span>' +
              '<span class="turn-tokens">' + usedLabel + ' token</span>' +
              '<span class="turn-cost">$' + (t.cost || 0).toFixed(4) + '</span>' +
            '</div>';
          }).join('');
        }
      }

      function getModelConfig(modelId) {
        // Hard-coded fallbacks for the webview context.
        // The extension host has ModelRegistry for authoritative data;
        // these are used when the webview renders before the host pushes data.
        var defaults = {
          'claude-opus-4-8': { contextWindow: 1000000 },
          'claude-sonnet-4-6': { contextWindow: 200000 },
          'claude-haiku-4-5-20251001': { contextWindow: 200000 },
          'claude-fable-5': { contextWindow: 1000000 },
          'gpt-4o': { contextWindow: 128000 },
          'gpt-4o-mini': { contextWindow: 128000 },
          'gpt-4-turbo': { contextWindow: 128000 },
          'deepseek-chat': { contextWindow: 128000 },
          'deepseek-reasoner': { contextWindow: 128000 },
          'deepseek-v4-pro': { contextWindow: 1000000 },
        };
        // Exact match first
        if (defaults[modelId]) return defaults[modelId];
        // Fuzzy: check if any known key is a prefix of the requested id
        var lower = modelId.toLowerCase();
        for (var key in defaults) {
          if (lower.indexOf(key) === 0 || key.indexOf(lower) === 0) {
            return defaults[key];
          }
        }
        // Fallback: assume 1M context (modern default)
        return { contextWindow: 1000000 };
      }

      function formatNumber(n) {
        if (n === undefined || n === null) return '0';
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
        if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
        return String(n);
      }

      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }
    `;
  }
}
