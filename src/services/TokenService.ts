// ============================================================
// TokenService — token counting with API integration and caching
// ============================================================

import * as crypto from 'crypto';
import { Anthropic } from '@anthropic-ai/sdk';
import type { ModelConfig } from '../types';

export class TokenService {
  private anthropicClient: Anthropic | null = null;
  /** Cache: content hash → token count */
  private cache: Map<string, number> = new Map();
  private apiKey: string | null = null;

  /** Set the Anthropic API key for token counting */
  setApiKey(key: string): void {
    this.apiKey = key;
    this.anthropicClient = new Anthropic({ apiKey: key });
  }

  /** Compute SHA-256 hash of content for caching */
  private hash(content: unknown): string {
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    return crypto.createHash('sha256').update(str).digest('hex');
  }

  /**
   * Count tokens for a list of messages using the Anthropic count_tokens API.
   * Falls back to local estimation if API is unavailable.
   */
  async countTokens(
    model: string,
    system: string | undefined,
    messages: Array<{ role: string; content: unknown }>,
    tools?: unknown[]
  ): Promise<number> {
    const cacheKey = this.hash({ model, system, messages, tools });

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    let count: number;

    // Try API-based counting if available
    if (this.anthropicClient && this.apiKey) {
      try {
        // The Anthropic SDK has deeply nested content types (ContentBlockParam unions).
        // We pass-through user-provided data that the API itself validates, so we
        // cast through any to avoid maintaining exact type parity with the SDK.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const response = await (this.anthropicClient.messages.countTokens as any)({
          model,
          system: system || undefined,
          messages,
          tools,
        });
        count = response.input_tokens;
      } catch {
        count = this.estimateTokensLocal({ system, messages, tools });
      }
    } else {
      count = this.estimateTokensLocal({ system, messages, tools });
    }

    // Cache with size limit (LRU-like: if too many entries, clear half)
    if (this.cache.size > 1000) {
      const entries = Array.from(this.cache.keys()).slice(0, 500);
      for (const key of entries) {
        this.cache.delete(key);
      }
    }
    this.cache.set(cacheKey, count);

    return count;
  }

  /**
   * Local token estimation — fallback when API is unavailable.
   * Rough estimate: ~4 characters per token for English text.
   */
  estimateTokensLocal(content: unknown): number {
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    // ~4 characters per token for English text
    // Slightly more accurate for code (3.5 chars/token)
    const codePattern = /[{}[\]();<>!=+\-*/%&|^~`@#]/g;
    const codeMatches = str.match(codePattern)?.length ?? 0;
    const alphaLength = str.length - codeMatches;
    return Math.ceil(alphaLength / 4 + codeMatches / 3.5);
  }

  /**
   * Estimate output tokens from streaming text deltas.
   * ~3-4 characters per output token.
   */
  estimateDeltaTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 3.5));
  }

  /** Clear the token cache */
  clearCache(): void {
    this.cache.clear();
  }

  /** Get cache statistics */
  getCacheStats(): { size: number; hits: number } {
    return { size: this.cache.size, hits: 0 };
  }
}
