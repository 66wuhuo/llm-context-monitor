// ============================================================
// AnthropicParser — parse Anthropic API request/response bodies
// ============================================================

import type { Provider } from '../types';

export interface ParsedRequest {
  provider: Provider;
  model: string;
  system?: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
  maxTokens?: number;
  stream: boolean;
  apiPath: string;
}

export interface ParsedResponse {
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  model?: string;
  stop_reason?: string;
}

export class AnthropicParser {
  /** Check if a hostname belongs to Anthropic */
  static isAnthropicHost(host: string): boolean {
    return host.includes('api.anthropic.com');
  }

  /** Parse an Anthropic API request body to extract key metadata */
  static parseRequest(body: string, path: string): ParsedRequest | null {
    try {
      const data = JSON.parse(body);
      return {
        provider: 'anthropic' as const,
        model: data.model ?? 'unknown',
        system: typeof data.system === 'string' ? data.system : undefined,
        messages: data.messages ?? [],
        tools: data.tools,
        maxTokens: data.max_tokens,
        stream: data.stream === true,
        apiPath: path,
      };
    } catch {
      return null;
    }
  }

  /** Parse an Anthropic API response body (non-streaming) */
  static parseResponse(body: string): ParsedResponse | null {
    try {
      const data = JSON.parse(body);
      return {
        usage: data.usage,
        model: data.model,
        stop_reason: data.stop_reason,
      };
    } catch {
      return null;
    }
  }

  /** Extract the model ID from the API path or request body */
  static extractModel(path: string, body?: string): string {
    // Anthropic paths include the endpoint version, model is in the body
    if (path.includes('/v1/messages') && body) {
      try {
        const data = JSON.parse(body);
        return data.model ?? 'unknown';
      } catch {
        // ignore
      }
    }
    return 'unknown';
  }

  /** Determine if a path is a Messages API call (vs. count_tokens, etc.) */
  static isMessagesApi(path: string): boolean {
    return path.includes('/v1/messages') && !path.includes('/count_tokens');
  }

  /** Determine if a path is the count_tokens API */
  static isCountTokensApi(path: string): boolean {
    return path.includes('/v1/messages/count_tokens');
  }
}
