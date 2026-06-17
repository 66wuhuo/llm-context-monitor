// ============================================================
// SSEMonitor — parses Server-Sent Events for streaming LLM responses
// ============================================================

import { EventEmitter } from 'eventemitter3';

export interface SSEMonitorEvents {
  'block-start': (data: {
    index: number;
    type: string;
    conversationId: string;
  }) => void;
  'block-delta': (data: {
    index: number;
    deltaType: string;
    text: string;
    thinkingText: string;
    conversationId: string;
  }) => void;
  'block-stop': (data: { index: number; conversationId: string }) => void;
  'message-delta': (data: {
    stopReason: string | null;
    stopSequence: string | null;
    outputTokens: number;
    conversationId: string;
  }) => void;
  'message-start': (data: {
    model: string;
    inputTokens: number | null;
    conversationId: string;
  }) => void;
  'message-stop': (data: { conversationId: string }) => void;
  'turn-complete': (data: {
    inputTokens: number;
    outputTokens: number;
    conversationId: string;
    model: string;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }) => void;
  'parse-error': (data: { error: string; conversationId: string }) => void;
}

export class SSEMonitor extends EventEmitter<SSEMonitorEvents> {
  private buffer: string = '';
  private conversationId: string;
  private model: string = 'unknown';
  private inputTokens: number = 0;
  private outputTokens: number = 0;
  private cacheReadTokens: number = 0;
  private cacheCreationTokens: number = 0;

  /** Whether the turn-complete event has already been emitted */
  private _turnCompleted = false;

  constructor(conversationId: string) {
    super();
    this.conversationId = conversationId;
  }

  /** Feed raw chunk data into the monitor */
  feed(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    this.buffer += text;

    // Split on double newline (SSE event boundary)
    const parts = this.buffer.split('\n\n');
    // Keep the last (possibly incomplete) part in the buffer
    this.buffer = parts.pop() ?? '';

    for (const part of parts) {
      if (!part.trim()) continue;
      this.parseEvent(part.trim());
    }
  }

  /** Signal that the stream has ended — flush remaining buffer */
  flush(): void {
    if (this.buffer.trim()) {
      this.parseEvent(this.buffer.trim());
      this.buffer = '';
    }
    this.emit('message-stop', { conversationId: this.conversationId });
    if (!this._turnCompleted) {
      this._turnCompleted = true;
      this.emit('turn-complete', {
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        conversationId: this.conversationId,
        model: this.model,
        cacheReadTokens: this.cacheReadTokens,
        cacheCreationTokens: this.cacheCreationTokens,
      });
    }
  }

  /** Reset state for a new stream */
  reset(conversationId?: string): void {
    this.buffer = '';
    this._turnCompleted = false;
    if (conversationId) {
      this.conversationId = conversationId;
    }
  }

  private parseEvent(eventText: string): void {
    const lines = eventText.split('\n');
    let eventType = '';
    let dataStr = '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        dataStr = line.slice(6).trim();
      }
    }

    if (!dataStr) return;

    // OpenAI format: "data: [DONE]"
    if (dataStr === '[DONE]') {
      this.flush();
      return;
    }

    try {
      const data = JSON.parse(dataStr);

      // OpenAI-compatible format: "object": "chat.completion.chunk"
      if (data.object === 'chat.completion.chunk') {
        this.dispatchOpenAIChunk(data);
        return;
      }

      this.dispatchAnthropicEvent(eventType, data);
    } catch {
      // Non-JSON line, ignore (e.g., comments starting with ':')
    }
  }

  private dispatchAnthropicEvent(
    eventType: string,
    data: Record<string, unknown>
  ): void {
    const type = (data.type as string) ?? eventType;

    switch (type) {
      case 'message_start': {
        const message = data.message as Record<string, unknown> | undefined;
        this.model = (message?.model as string) ?? this.model;
        this.inputTokens = (message?.usage as Record<string, number>)?.input_tokens ?? 0;
        this.emit('message-start', {
          model: this.model,
          inputTokens: this.inputTokens,
          conversationId: this.conversationId,
        });

        // Note cache usage if present
        const usage = message?.usage as Record<string, number> | undefined;
        if (usage) {
          this.cacheReadTokens = usage.cache_read_input_tokens ?? 0;
          this.cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
        }
        break;
      }

      case 'content_block_start': {
        const blockIndex = (data.index as number) ?? 0;
        const contentBlock = data.content_block as Record<string, unknown> | undefined;
        const blockType = (contentBlock?.type as string) ?? 'unknown';
        this.emit('block-start', {
          index: blockIndex,
          type: blockType,
          conversationId: this.conversationId,
        });
        break;
      }

      case 'content_block_delta': {
        const blockIndex = (data.index as number) ?? 0;
        const delta = data.delta as Record<string, unknown> | undefined;
        const deltaType = (delta?.type as string) ?? 'unknown';
        const text = (delta?.text as string) ?? '';
        const thinkingText = (delta?.thinking as string) ?? '';
        this.emit('block-delta', {
          index: blockIndex,
          deltaType,
          text,
          thinkingText,
          conversationId: this.conversationId,
        });
        break;
      }

      case 'content_block_stop': {
        const blockIndex = (data.index as number) ?? 0;
        this.emit('block-stop', {
          index: blockIndex,
          conversationId: this.conversationId,
        });
        break;
      }

      case 'message_delta': {
        const delta = data.delta as Record<string, unknown> | undefined;
        const usage = data.usage as Record<string, number> | undefined;
        const stopReason = (delta?.stop_reason as string) ?? null;
        const stopSequence = (delta?.stop_sequence as string) ?? null;
        this.outputTokens = usage?.output_tokens ?? 0;
        this.emit('message-delta', {
          stopReason,
          stopSequence,
          outputTokens: this.outputTokens,
          conversationId: this.conversationId,
        });
        break;
      }

      case 'message_stop': {
        this.emit('message-stop', { conversationId: this.conversationId });
        // Turn complete with final token counts (guard against double emission)
        if (!this._turnCompleted) {
          this._turnCompleted = true;
          this.emit('turn-complete', {
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            conversationId: this.conversationId,
            model: this.model,
            cacheReadTokens: this.cacheReadTokens,
            cacheCreationTokens: this.cacheCreationTokens,
          });
        }
        break;
      }

      default:
        // Unknown event type, silently ignore
        break;
    }
  }

  /**
   * Handle OpenAI-compatible SSE chunk format.
   * Example: {"id":"chatcmpl-xxx","object":"chat.completion.chunk",
   *           "model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"Hi"}}]}
   * This covers OpenAI, DeepSeek, and other OpenAI-compatible providers.
   */
  private dispatchOpenAIChunk(data: Record<string, unknown>): void {
    // Extract model from chunk (present in every chunk)
    const chunkModel = data.model as string | undefined;
    if (chunkModel && chunkModel !== this.model) {
      this.model = chunkModel;
    }

    // Extract usage if present (usually in final chunk)
    const usage = data.usage as Record<string, number> | undefined;
    if (usage) {
      this.inputTokens = usage.prompt_tokens ?? this.inputTokens;
      this.outputTokens = usage.completion_tokens ?? this.outputTokens;
    }

    // Extract choices
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) {
      // Chunk without choices but with usage — final chunk
      if (usage && !this._turnCompleted) {
        this._turnCompleted = true;
        this.emit('turn-complete', {
          inputTokens: this.inputTokens,
          outputTokens: this.outputTokens,
          conversationId: this.conversationId,
          model: this.model,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        });
      }
      return;
    }

    const choice = choices[0];
    const delta = choice.delta as Record<string, unknown> | undefined;
    const finishReason = choice.finish_reason as string | null | undefined;
    const index = (choice.index as number) ?? 0;

    // Extract text content delta
    let text = '';
    if (delta) {
      text = (delta.content as string) ?? '';

      // DeepSeek-R1 / reasoning models: capture reasoning_content as thinking
      const reasoning = (delta.reasoning_content as string) ?? '';
      if (reasoning) {
        // Emit reasoning as thinking text
        this.emit('block-delta', {
          index,
          deltaType: 'thinking',
          text: '',
          thinkingText: reasoning,
          conversationId: this.conversationId,
        });
      }
    }

    // Emit text content delta
    if (text) {
      this.emit('block-delta', {
        index,
        deltaType: 'text',
        text,
        thinkingText: '',
        conversationId: this.conversationId,
      });
    }

    // On finish or if usage is present, the turn is complete
    if ((finishReason || usage) && !this._turnCompleted) {
      this._turnCompleted = true;
      this.emit('turn-complete', {
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        conversationId: this.conversationId,
        model: this.model,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
    }
  }
}
