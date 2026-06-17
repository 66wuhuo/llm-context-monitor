// ============================================================
// Shared type definitions for LLM Context Monitor
// ============================================================

/** Supported LLM providers */
export type Provider = 'anthropic' | 'openai' | 'deepseek';

/** Model configuration with context window and pricing */
export interface ModelConfig {
  id: string;
  name: string;
  provider: Provider;
  contextWindow: number;
  inputCostPer1M: number;
  outputCostPer1M: number;
  /** Cost per 1M tokens for cached/read tokens */
  cacheReadCostPer1M?: number;
  /** Cost per 1M tokens for cache writes */
  cacheWriteCostPer1M?: number;
}

/** Token usage breakdown for a single API call */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

/** Statistics for a single conversation turn */
export interface TurnStats {
  turnIndex: number;
  model: string;
  usage: TokenUsage;
  cost: number;
  timestamp: number;
  /** Number of messages in this turn */
  messageCount: number;
}

/** Statistics accumulated for an entire conversation */
export interface SessionStats {
  conversationId: string;
  model: string;
  startedAt: number;
  lastActivityAt: number;
  turns: TurnStats[];
  totalUsage: TokenUsage;
  totalCost: number;
  isActive: boolean;
}

/** Payload sent from extension to webview dashboard */
export interface DashboardPayload {
  currentSession: SessionStats | null;
  allSessions: SessionStats[];
  isStreaming: boolean;
  contextWindowPercent: number;
  /** Per-turn breakdown for the current session (last N turns) */
  recentTurns: TurnStats[];
  /** Cumulative stats across all sessions */
  cumulative: {
    totalTokens: number;
    totalCost: number;
    totalSessions: number;
    totalTurns: number;
  };
}

/** Event types emitted by the proxy/monitor system */
export type MonitorEventType =
  | 'request-detected'
  | 'stream-start'
  | 'token-delta'
  | 'turn-complete'
  | 'stats-updated'
  | 'proxy-started'
  | 'proxy-stopped'
  | 'proxy-error';

/** Data associated with each monitor event */
export interface MonitorEvent {
  type: MonitorEventType;
  conversationId?: string;
  model?: string;
  usage?: TokenUsage;
  cost?: number;
  stats?: SessionStats;
  error?: Error;
  timestamp: number;
}

/** Proxy server status */
export interface ProxyStatus {
  running: boolean;
  port: number;
  requestCount: number;
  bytesTransferred: number;
  startedAt?: number;
}

/** Configuration for a monitored API endpoint */
export interface MonitoredEndpoint {
  host: string;
  provider: Provider;
  enabled: boolean;
}

/** Settings from VS Code configuration, merged with defaults */
export interface MonitorSettings {
  proxyPort: number;
  displayMode: 'compact' | 'detailed' | 'hidden';
  monitoredEndpoints: string[];
  modelOverrides: Record<string, Partial<ModelConfig>>;
  throttleInterval: number;
  autoStartProxy: boolean;
}
