// ============================================================
// Constants: model definitions, pricing, and defaults
// ============================================================

import type { ModelConfig } from './types';

/**
 * Built-in model registry.
 * Pricing sourced from official Anthropic and OpenAI docs as of 2026-06.
 * Users can override via llmContext.modelOverrides setting.
 */
export const BUILTIN_MODELS: ModelConfig[] = [
  // ---- Anthropic (Claude) ----
  {
    id: 'claude-opus-4-8',
    name: 'Claude Opus 4.8',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    inputCostPer1M: 5.0,
    outputCostPer1M: 25.0,
    cacheReadCostPer1M: 0.50,
    cacheWriteCostPer1M: 10.0,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    contextWindow: 200_000,
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
    cacheReadCostPer1M: 0.30,
    cacheWriteCostPer1M: 6.0,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    contextWindow: 200_000,
    inputCostPer1M: 0.80,
    outputCostPer1M: 4.0,
    cacheReadCostPer1M: 0.08,
    cacheWriteCostPer1M: 1.60,
  },
  {
    id: 'claude-fable-5',
    name: 'Claude Fable 5',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    inputCostPer1M: 5.0,
    outputCostPer1M: 25.0,
    cacheReadCostPer1M: 0.50,
    cacheWriteCostPer1M: 10.0,
  },
  // Generic Anthropic fallback
  {
    id: 'claude-3-opus-20240229',
    name: 'Claude 3 Opus',
    provider: 'anthropic',
    contextWindow: 200_000,
    inputCostPer1M: 15.0,
    outputCostPer1M: 75.0,
  },
  {
    id: 'claude-3-5-sonnet-20241022',
    name: 'Claude 3.5 Sonnet',
    provider: 'anthropic',
    contextWindow: 200_000,
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
  },

  // ---- OpenAI ----
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128_000,
    inputCostPer1M: 2.50,
    outputCostPer1M: 10.0,
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai',
    contextWindow: 128_000,
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60,
  },
  {
    id: 'gpt-4-turbo',
    name: 'GPT-4 Turbo',
    provider: 'openai',
    contextWindow: 128_000,
    inputCostPer1M: 10.0,
    outputCostPer1M: 30.0,
  },

  // ---- DeepSeek (OpenAI-compatible) ----
  {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat (V3)',
    provider: 'deepseek',
    contextWindow: 128_000,
    inputCostPer1M: 0.27,
    outputCostPer1M: 1.10,
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek Reasoner (R1)',
    provider: 'deepseek',
    contextWindow: 128_000,
    inputCostPer1M: 0.55,
    outputCostPer1M: 2.19,
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    provider: 'deepseek',
    contextWindow: 1_000_000,
    inputCostPer1M: 0.55,
    outputCostPer1M: 2.19,
  },
];

/** Default model to use when the detected model is unknown.
 *  Uses conservative defaults: 1M context window (common in 2026),
 *  mid-range pricing. The model name will be overridden with the actual
 *  detected id so users can identify it. */
export const DEFAULT_MODEL: ModelConfig = {
  id: 'unknown',
  name: 'Unknown Model',
  provider: 'anthropic',
  contextWindow: 1_000_000,
  inputCostPer1M: 3.0,
  outputCostPer1M: 15.0,
};

/** Default monitor settings */
export const DEFAULT_SETTINGS = {
  proxyPort: 9877,
  displayMode: 'detailed' as const,
  monitoredEndpoints: ['api.anthropic.com', 'api.openai.com', 'api.deepseek.com'],
  throttleInterval: 100,
  autoStartProxy: true,
};

/** Proxy headers to strip/rewrite */
export const PROXY_STRIP_HEADERS = [
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
];

/** Maximum recent turns to show in dashboard */
export const MAX_RECENT_TURNS = 50;

/** Status bar display format templates */
export const STATUS_BAR_FORMATS = {
  compact: '📊 {percent}%',
  detailed: '📊 {used}/{total}K ({percent}%) · ${cost}',
} as const;

/** Color thresholds for context usage */
export const USAGE_COLORS = {
  GREEN: { threshold: 50, color: '#4caf50' },
  YELLOW: { threshold: 75, color: '#ffc107' },
  ORANGE: { threshold: 90, color: '#ff9800' },
  RED: { threshold: Infinity, color: '#f44336' },
} as const;
