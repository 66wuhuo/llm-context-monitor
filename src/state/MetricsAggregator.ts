// ============================================================
// MetricsAggregator — cumulative and rolling-window statistics
// ============================================================

import type { SessionStats, TurnStats } from '../types';

export interface CumulativeMetrics {
  totalTokens: number;
  totalCost: number;
  totalSessions: number;
  totalTurns: number;
  /** Per-model breakdown */
  byModel: Record<string, { tokens: number; cost: number; turns: number }>;
}

export class MetricsAggregator {
  private cumulative: CumulativeMetrics = this.emptyCumulative();

  /** Recalculate cumulative metrics from all sessions */
  recalculate(sessions: SessionStats[]): CumulativeMetrics {
    const metrics = this.emptyCumulative();
    metrics.totalSessions = sessions.length;

    for (const session of sessions) {
      metrics.totalTokens += session.totalUsage.totalTokens;
      metrics.totalCost += session.totalCost;
      metrics.totalTurns += session.turns.length;

      const modelId = session.model;
      if (!metrics.byModel[modelId]) {
        metrics.byModel[modelId] = { tokens: 0, cost: 0, turns: 0 };
      }
      metrics.byModel[modelId].tokens += session.totalUsage.totalTokens;
      metrics.byModel[modelId].cost += session.totalCost;
      metrics.byModel[modelId].turns += session.turns.length;
    }

    // Round costs
    metrics.totalCost = Math.round(metrics.totalCost * 10000) / 10000;
    for (const key of Object.keys(metrics.byModel)) {
      metrics.byModel[key].cost =
        Math.round(metrics.byModel[key].cost * 10000) / 10000;
    }

    this.cumulative = metrics;
    return metrics;
  }

  /** Get current cumulative metrics */
  getCumulative(): CumulativeMetrics {
    return { ...this.cumulative, byModel: { ...this.cumulative.byModel } };
  }

  /** Get rolling window stats (last 24 hours of turns) */
  getRolling24h(sessions: SessionStats[]): {
    tokens: number;
    cost: number;
    turns: number;
  } {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let tokens = 0;
    let cost = 0;
    let turns = 0;

    for (const session of sessions) {
      for (const turn of session.turns) {
        if (turn.timestamp >= cutoff) {
          tokens += turn.usage.totalTokens;
          cost += turn.cost;
          turns++;
        }
      }
    }

    return {
      tokens,
      cost: Math.round(cost * 10000) / 10000,
      turns,
    };
  }

  /** Get per-session summary statistics */
  getSessionSummary(session: SessionStats): {
    avgTokensPerTurn: number;
    avgCostPerTurn: number;
    turnsPerHour: number;
    durationMinutes: number;
  } {
    const turnsCount = session.turns.length;
    const totalTokens = session.totalUsage.totalTokens;
    const totalCost = session.totalCost;
    const durationMs = session.lastActivityAt - session.startedAt;
    const durationMinutes = Math.max(1, Math.round(durationMs / 60000));
    const hours = durationMinutes / 60;

    return {
      avgTokensPerTurn: turnsCount > 0 ? Math.round(totalTokens / turnsCount) : 0,
      avgCostPerTurn: turnsCount > 0 ? Math.round((totalCost / turnsCount) * 10000) / 10000 : 0,
      turnsPerHour: hours > 0 ? Math.round(turnsCount / hours) : 0,
      durationMinutes,
    };
  }

  private emptyCumulative(): CumulativeMetrics {
    return {
      totalTokens: 0,
      totalCost: 0,
      totalSessions: 0,
      totalTurns: 0,
      byModel: {},
    };
  }
}
