// ============================================================
// CostService — calculates API costs from token usage
// ============================================================

import type { ModelConfig, TokenUsage } from '../types';

export class CostService {
  /**
   * Calculate cost for a turn based on token usage and model pricing.
   * Returns the cost in USD.
   */
  calculateCost(
    inputTokens: number,
    outputTokens: number,
    model: ModelConfig,
    cacheReadTokens: number = 0,
    cacheCreationTokens: number = 0
  ): number {
    let cost = 0;

    // Regular input tokens (excluding cache reads)
    const regularInputTokens = Math.max(0, inputTokens - cacheReadTokens);
    cost += (regularInputTokens / 1_000_000) * model.inputCostPer1M;

    // Output tokens
    cost += (outputTokens / 1_000_000) * model.outputCostPer1M;

    // Cache read tokens (discounted rate)
    if (model.cacheReadCostPer1M !== undefined && cacheReadTokens > 0) {
      cost += (cacheReadTokens / 1_000_000) * model.cacheReadCostPer1M;
    }

    // Cache creation tokens (premium rate)
    if (model.cacheWriteCostPer1M !== undefined && cacheCreationTokens > 0) {
      cost += (cacheCreationTokens / 1_000_000) * model.cacheWriteCostPer1M;
    }

    return Math.round(cost * 10000) / 10000; // 4 decimal places
  }

  /**
   * Calculate cost from a TokenUsage object.
   */
  calculateCostFromUsage(usage: TokenUsage, model: ModelConfig): number {
    return this.calculateCost(
      usage.inputTokens,
      usage.outputTokens,
      model,
      usage.cacheReadTokens,
      usage.cacheCreationTokens
    );
  }

  /**
   * Estimate remaining cost if context window is fully used.
   */
  estimateMaxCost(model: ModelConfig, usedInputTokens: number): number {
    const remainingInput = Math.max(0, model.contextWindow - usedInputTokens);
    return (
      (remainingInput / 1_000_000) * model.inputCostPer1M +
      (remainingInput / 1_000_000) * model.outputCostPer1M
    );
  }

  /**
   * Format cost as a human-readable USD string.
   */
  formatCost(cost: number): string {
    if (cost >= 1) {
      return `$${cost.toFixed(2)}`;
    }
    if (cost >= 0.01) {
      return `$${cost.toFixed(3)}`;
    }
    return `$${cost.toFixed(4)}`;
  }

  /**
   * Calculate cumulative cost across multiple turns.
   */
  calculateCumulativeCost(
    turns: Array<{ inputTokens: number; outputTokens: number; model: ModelConfig }>
  ): number {
    return turns.reduce((total, turn) => {
      return (
        total + this.calculateCost(turn.inputTokens, turn.outputTokens, turn.model)
      );
    }, 0);
  }
}
