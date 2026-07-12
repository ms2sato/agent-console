/**
 * Provider adapter interface and the OpenAI Chat Completions message/event
 * shapes the loop passes to and receives from a provider.
 *
 * The adapter boundary is provider-neutral: `OpenAIChatAdapter` is the first
 * (and, in v1, only) implementation. Anthropic and others are post-v1 behind
 * this same interface.
 */

/** A tool the model may call, published to the provider in JSON-Schema form. */
export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema for the tool arguments. */
  parameters: unknown;
}

/** An assistant-requested tool call, in the OpenAI Chat Completions shape. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** OpenAI Chat Completions message shapes exchanged with the provider. */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Events streamed out of a provider run. */
export type ProviderEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; callId: string; name: string; argsJson: string }
  | { type: 'done'; finishReason: string | null };

export interface ProviderRunRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal: AbortSignal;
}

export interface ProviderAdapter {
  run(req: ProviderRunRequest): AsyncIterable<ProviderEvent>;
}

/**
 * Error raised by a provider adapter. `retryable` is true for transient
 * failures the loop should retry (timeouts, 5xx, 429); false for failures the
 * loop should surface immediately. `retryAfterMs` carries a parsed
 * `retry-after` hint (429/503). Caller cancellation is NOT a ProviderError —
 * the adapter rethrows the abort so the loop can classify it as a cancel.
 */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    opts: { retryable: boolean; status?: number; retryAfterMs?: number },
  ) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = opts.retryable;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}
