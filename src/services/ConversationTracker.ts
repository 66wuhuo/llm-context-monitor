// ============================================================
// ConversationTracker — tracks per-conversation state
// ============================================================

import * as crypto from 'crypto';
import type { SessionStats, TurnStats, TokenUsage } from '../types';
import { CostService } from './CostService';
import { ModelRegistry } from './ModelRegistry';

export class ConversationTracker {
  private sessions: Map<string, SessionStats> = new Map();
  private activeConversationId: string | null = null;
  private turnCounter: Map<string, number> = new Map();
  private costService: CostService;
  private modelRegistry: ModelRegistry;

  constructor(modelRegistry: ModelRegistry) {
    this.costService = new CostService();
    this.modelRegistry = modelRegistry;
  }

  /** Generate a new conversation ID */
  generateConversationId(): string {
    const id = crypto.randomUUID();
    return id;
  }

  /** Start tracking a new conversation */
  startConversation(
    conversationId: string,
    model: string
  ): SessionStats {
    const now = Date.now();
    const stats: SessionStats = {
      conversationId,
      model,
      startedAt: now,
      lastActivityAt: now,
      turns: [],
      totalUsage: this.emptyUsage(),
      totalCost: 0,
      isActive: true,
    };
    this.sessions.set(conversationId, stats);
    this.activeConversationId = conversationId;
    this.turnCounter.set(conversationId, 0);
    return stats;
  }

  /** Record a completed turn in the current conversation */
  recordTurn(
    conversationId: string,
    usage: TokenUsage,
    model: string,
    messageCount: number = 1
  ): TurnStats | null {
    const session = this.sessions.get(conversationId);
    if (!session) return null;

    const turnIndex = (this.turnCounter.get(conversationId) ?? 0) + 1;
    this.turnCounter.set(conversationId, turnIndex);

    const modelConfig = this.modelRegistry.getModel(model);
    const cost = this.costService.calculateCostFromUsage(usage, modelConfig);

    const turn: TurnStats = {
      turnIndex,
      model,
      usage,
      cost,
      timestamp: Date.now(),
      messageCount,
    };

    session.turns.push(turn);
    session.totalUsage = this.accumulateUsage(session.totalUsage, usage);
    session.totalCost = this.roundCost(session.totalCost + cost);
    session.lastActivityAt = Date.now();
    session.model = model; // Update in case model changed

    return turn;
  }

  /** End a conversation */
  endConversation(conversationId: string): void {
    const session = this.sessions.get(conversationId);
    if (session) {
      session.isActive = false;
    }
    if (this.activeConversationId === conversationId) {
      this.activeConversationId = null;
    }
  }

  /** Get a session by ID */
  getSession(conversationId: string): SessionStats | null {
    return this.sessions.get(conversationId) ?? null;
  }

  /** Get the currently active session */
  getActiveSession(): SessionStats | null {
    if (this.activeConversationId) {
      return this.sessions.get(this.activeConversationId) ?? null;
    }
    return null;
  }

  /** Get all sessions */
  getAllSessions(): SessionStats[] {
    return Array.from(this.sessions.values());
  }

  /** Get the current active conversation ID */
  getActiveConversationId(): string | null {
    return this.activeConversationId;
  }

  /** Set the active conversation */
  setActiveConversation(conversationId: string): void {
    if (this.sessions.has(conversationId)) {
      this.activeConversationId = conversationId;
    }
  }

  /** Reset all tracking data */
  reset(): void {
    this.sessions.clear();
    this.activeConversationId = null;
    this.turnCounter.clear();
  }

  /** Remove a specific session */
  removeSession(conversationId: string): boolean {
    this.turnCounter.delete(conversationId);
    if (this.activeConversationId === conversationId) {
      this.activeConversationId = null;
    }
    return this.sessions.delete(conversationId);
  }

  private emptyUsage(): TokenUsage {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
    };
  }

  private accumulateUsage(current: TokenUsage, added: TokenUsage): TokenUsage {
    return {
      inputTokens: current.inputTokens + added.inputTokens,
      outputTokens: current.outputTokens + added.outputTokens,
      cacheReadTokens: current.cacheReadTokens + added.cacheReadTokens,
      cacheCreationTokens: current.cacheCreationTokens + added.cacheCreationTokens,
      totalTokens: current.totalTokens + added.totalTokens,
    };
  }

  private roundCost(cost: number): number {
    return Math.round(cost * 10000) / 10000;
  }
}
