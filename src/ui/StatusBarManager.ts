// ============================================================
// StatusBarManager — compact real-time stats in the VS Code status bar
// ============================================================

import * as vscode from 'vscode';
import type { SessionStats } from '../types';
import { USAGE_COLORS } from '../constants';
import type { ModelRegistry } from '../services/ModelRegistry';

export class StatusBarManager {
  private item: vscode.StatusBarItem;
  private modelRegistry: ModelRegistry;
  private displayMode: 'compact' | 'detailed' | 'hidden' = 'detailed';
  private isStreaming: boolean = false;
  private currentStats: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
    model: string;
    percent: number;
  } | null = null;

  /** Throttle: last update timestamp */
  private lastUpdate = 0;
  private throttleInterval = 100;
  private pendingUpdate: ReturnType<typeof setTimeout> | null = null;

  constructor(modelRegistry: ModelRegistry) {
    this.modelRegistry = modelRegistry;

    // Create status bar item, aligned right with high priority
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.name = 'LLM 上下文监控';
    this.item.command = 'llmContext.showDashboard';
    this.item.tooltip = '打开 LLM 上下文仪表盘';
    this.item.text = '$(graph) LLM 监控';
    this.item.show();
  }

  /** Update display mode from configuration */
  setDisplayMode(mode: 'compact' | 'detailed' | 'hidden'): void {
    this.displayMode = mode;
    if (mode === 'hidden') {
      this.item.hide();
    } else {
      this.item.show();
      this.refresh();
    }
  }

  /** Set throttle interval in ms */
  setThrottleInterval(ms: number): void {
    this.throttleInterval = ms;
  }

  /** Update with streaming token delta */
  onStreamDelta(
    inputTokens: number,
    estimatedOutputTokens: number,
    model: string,
    cost: number
  ): void {
    this.isStreaming = true;
    const modelConfig = this.modelRegistry.getModel(model);
    const total = inputTokens + estimatedOutputTokens;
    const percent = modelConfig.contextWindow > 0
      ? Math.round((total / modelConfig.contextWindow) * 1000) / 10
      : 0;

    this.currentStats = {
      inputTokens,
      outputTokens: estimatedOutputTokens,
      cost,
      model,
      percent,
    };

    this.throttledUpdate();
  }

  /** Update with final turn stats */
  onTurnComplete(usage: { inputTokens: number; outputTokens: number }, model: string, cost: number): void {
    this.isStreaming = false;
    const modelConfig = this.modelRegistry.getModel(model);
    const total = usage.inputTokens + usage.outputTokens;
    const percent = modelConfig.contextWindow > 0
      ? Math.round((total / modelConfig.contextWindow) * 1000) / 10
      : 0;

    this.currentStats = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cost,
      model,
      percent,
    };

    this.refresh();
  }

  /** Reset display to idle state */
  reset(): void {
    this.isStreaming = false;
    this.currentStats = null;
    this.item.text = '$(graph) LLM 监控';
    this.item.backgroundColor = undefined;
  }

  /** Refresh the status bar display */
  private refresh(): void {
    if (this.displayMode === 'hidden') return;

    if (!this.currentStats) {
      this.item.text = this.isStreaming
        ? '$(pulse) 流式中...'
        : '$(graph) LLM 监控';
      this.item.backgroundColor = undefined;
      return;
    }

    const { inputTokens, outputTokens, cost, model, percent } = this.currentStats;
    const modelConfig = this.modelRegistry.getModel(model);
    const totalK = Math.round((inputTokens + outputTokens) / 1000);
    const windowK = Math.round(modelConfig.contextWindow / 1000);
    const icon = this.isStreaming ? '$(pulse)' : '$(graph)';

    // Build text based on display mode
    let text: string;
    if (this.displayMode === 'compact') {
      text = `${icon} ${percent}%`;
    } else {
      text = `${icon} ${totalK}K/${windowK}K (${percent}%)`;
      if (cost > 0) {
        text += ` · $${cost.toFixed(2)}`;
      }
    }

    this.item.text = text;

    // Color coding based on usage percentage
    if (percent >= 90) {
      this.item.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.errorBackground'
      );
    } else if (percent >= 75) {
      this.item.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground'
      );
    } else {
      this.item.backgroundColor = undefined;
    }

    // Rich tooltip
    this.item.tooltip = this.buildTooltip();
  }

  /** Build detailed tooltip markdown */
  private buildTooltip(): string {
    if (!this.currentStats) return 'LLM 上下文监控';

    const { inputTokens, outputTokens, cost, model } = this.currentStats;
    const modelConfig = this.modelRegistry.getModel(model);
    const total = inputTokens + outputTokens;
    const remaining = Math.max(0, modelConfig.contextWindow - total);
    const percent = modelConfig.contextWindow > 0
      ? Math.round((total / modelConfig.contextWindow) * 1000) / 10
      : 0;

    return [
      `**LLM 上下文使用情况**`,
      ``,
      `| 指标 | 数值 |`,
      `|--------|-------|`,
      `| 模型 | ${modelConfig.name} |`,
      `| 输入 Token | ${inputTokens.toLocaleString()} |`,
      `| 输出 Token | ${outputTokens.toLocaleString()} |`,
      `| 已用 / 总量 | ${total.toLocaleString()} / ${modelConfig.contextWindow.toLocaleString()} (${percent}%) |`,
      `| 剩余 | ${remaining.toLocaleString()} |`,
      `| 会话费用 | $${cost.toFixed(4)} |`,
      `| 状态 | ${this.isStreaming ? '流式中...' : '空闲'} |`,
      ``,
      `点击查看详细仪表盘`,
    ].join('\n');
  }

  /** Throttled update to avoid excessive DOM writes during streaming */
  private throttledUpdate(): void {
    const now = Date.now();
    if (now - this.lastUpdate >= this.throttleInterval) {
      this.lastUpdate = now;
      this.refresh();
      return;
    }

    // Schedule a pending update
    if (this.pendingUpdate) return;
    this.pendingUpdate = setTimeout(() => {
      this.pendingUpdate = null;
      this.lastUpdate = Date.now();
      this.refresh();
    }, this.throttleInterval - (now - this.lastUpdate));
  }

  /** Dispose the status bar item */
  dispose(): void {
    if (this.pendingUpdate) {
      clearTimeout(this.pendingUpdate);
    }
    this.item.dispose();
  }
}
