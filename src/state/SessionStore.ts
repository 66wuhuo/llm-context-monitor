// ============================================================
// SessionStore — persistent session storage using VS Code Memento
// ============================================================

import type { SessionStats } from '../types';

interface PersistedData {
  sessions: Array<{
    conversationId: string;
    model: string;
    startedAt: number;
    lastActivityAt: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreationTokens: number;
    totalTokens: number;
    totalCost: number;
    turnCount: number;
    isActive: boolean;
  }>;
  cumulative: {
    totalTokens: number;
    totalCost: number;
    totalSessions: number;
    totalTurns: number;
  };
}

export class SessionStore {
  private globalState?: { get(key: string): unknown; update(key: string, value: unknown): Thenable<void> };
  private static readonly STORAGE_KEY = 'llmContext.sessions';

  /** Initialize with VS Code's extension context globalState */
  initialize(globalState: { get(key: string): unknown; update(key: string, value: unknown): Thenable<void> }): void {
    this.globalState = globalState;
  }

  /** Save sessions to persistent storage */
  async persist(sessions: SessionStats[], cumulative: PersistedData['cumulative']): Promise<void> {
    if (!this.globalState) return;

    const data: PersistedData = {
      sessions: sessions.map((s) => ({
        conversationId: s.conversationId,
        model: s.model,
        startedAt: s.startedAt,
        lastActivityAt: s.lastActivityAt,
        totalInputTokens: s.totalUsage.inputTokens,
        totalOutputTokens: s.totalUsage.outputTokens,
        totalCacheReadTokens: s.totalUsage.cacheReadTokens,
        totalCacheCreationTokens: s.totalUsage.cacheCreationTokens,
        totalTokens: s.totalUsage.totalTokens,
        totalCost: Number(s.totalCost.toFixed(4)),
        turnCount: s.turns.length,
        isActive: s.isActive,
      })),
      cumulative,
    };

    await this.globalState.update(SessionStore.STORAGE_KEY, data);
  }

  /** Load sessions from persistent storage */
  load(): PersistedData | null {
    if (!this.globalState) return null;

    const data = this.globalState.get(SessionStore.STORAGE_KEY) as PersistedData | undefined;
    return data ?? null;
  }

  /** Clear all persisted data */
  async clear(): Promise<void> {
    if (!this.globalState) return;
    await this.globalState.update(SessionStore.STORAGE_KEY, undefined);
  }

  /** Check if there is persisted data */
  hasData(): boolean {
    return this.load() !== null;
  }

  /** Persist CA certificate pair */
  async persistCA(pair: { cert: string; key: string }): Promise<void> {
    if (!this.globalState) return;
    await this.globalState.update('llmContext.caCert', pair);
  }

  /** Load persisted CA certificate pair */
  loadCA(): { cert: string; key: string } | null {
    if (!this.globalState) return null;
    const data = this.globalState.get('llmContext.caCert') as
      | { cert: string; key: string }
      | undefined;
    return data ?? null;
  }
}
