// ============================================================
// OpenAIParser — parse OpenAI API request/response bodies
// ============================================================

import type { Provider } from '../types';

export interface OpenAIParsedRequest {
  provider: Provider;
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
  maxTokens?: number;
  stream: boolean;
  apiPath: string;
}

export class OpenAIParser {
  /**
   * Check if a hostname uses the OpenAI-compatible API format.
   * This includes OpenAI, DeepSeek, and other compatible providers.
   */
  static isOpenAIHost(host: string): boolean {
    return (
      host.includes('api.openai.com') ||
      host.includes('api.deepseek.com')
    );
  }

  /** Parse an OpenAI Chat Completions request body */
  static parseRequest(body: string, path: string): OpenAIParsedRequest | null {
    try {
      const data = JSON.parse(body);
      return {
        provider: 'openai' as const,
        model: data.model ?? 'unknown',
        messages: data.messages ?? [],
        tools: data.tools,
        maxTokens: data.max_tokens ?? data.max_completion_tokens,
        stream: data.stream === true,
        apiPath: path,
      };
    } catch {
      return null;
    }
  }

  /** Parse an OpenAI API response body (non-streaming) */
  static parseResponse(body: string): {
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    model?: string;
  } | null {
    try {
      const data = JSON.parse(body);
      return {
        usage: data.usage,
        model: data.model,
      };
    } catch {
      return null;
    }
  }

  /** Check if path is a chat completions endpoint */
  static isChatCompletionsApi(path: string): boolean {
    return path.includes('/v1/chat/completions');
  }
}
