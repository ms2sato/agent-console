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

/** OpenAI Chat Completions content-part shapes for a multi-part user message (image attachments). */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * OpenAI Chat Completions message shapes exchanged with the provider. Only
 * the `user` variant's content is ever multi-part -- image attachments are
 * always delivered on a user turn; the other roles have no
 * attachment concept and stay plain strings.
 */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Events streamed out of a provider run. */
export type ProviderEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; callId: string; name: string; argsJson: string }
  | {
      type: 'done';
      finishReason: string | null;
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    };

export interface ProviderRunRequest {
  model: string;
  /**
   * agent-surface.md Ruling 3 (#1554): the resolved worker-override, or
   * absent when no override is set. Pass-through -- no local value
   * validation, the provider is the authority. Consumed at
   * `OpenAIChatAdapter.run()`'s request body composition, keyed
   * `reasoning_effort` there (the provider's own snake_case convention).
   */
  reasoningEffort?: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal: AbortSignal;
}

export interface ProviderAdapter {
  /**
   * Stream one provider request.
   *
   * **Contract: an implementation MUST settle once `req.signal` aborts** --
   * by returning or by throwing, promptly, and even while data is still
   * arriving. This is an obligation on the implementation, not a courtesy:
   * an iterator that ignores the signal cannot be stopped by its consumer at
   * all, because `for await` has no way to abandon a pending `next()`.
   *
   * Callers rely on it for more than tidiness. `AgentLoop.cancel()` is
   * implemented as an abort, so a non-cooperative adapter makes cancel a
   * no-op; and the embedded-agent's activation budget (`main.ts`'s
   * `RESTORE_BOUNDARY_COMPACTION_BUDGET_MS`) bounds the restore-boundary
   * compaction by cancelling it, so a non-cooperative adapter would leave
   * `ready` blocked exactly as if there were no budget.
   *
   * `OpenAIChatAdapter` satisfies this by passing the signal to `fetch` and
   * reading the body through the resulting stream -- and that is pinned by a
   * test rather than asserted, including for a body that keeps emitting
   * rather than merely hanging (see openai-chat-adapter.test.ts, "settles
   * promptly when the caller aborts a stream that is still emitting").
   */
  run(req: ProviderRunRequest): AsyncIterable<ProviderEvent>;
}

/**
 * Error raised by a provider adapter. `retryable` is true for transient
 * failures the loop should retry (timeouts, 5xx, 429); false for failures the
 * loop should surface immediately. `retryAfterMs` carries a parsed
 * `retry-after` hint (429/503). Caller cancellation is NOT a ProviderError —
 * the adapter rethrows the abort so the loop can classify it as a cancel.
 */
/** The provider's own error envelope, parsed once at the boundary. */
export interface ProviderErrorDetail {
  /** The provider's human-readable message, unjoined. */
  readonly message: string;
  /** e.g. `invalid_parameter_error`. */
  readonly type?: string;
  /** e.g. `context_length_exceeded`. */
  readonly code?: string;
}

export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  /**
   * The provider's error envelope as STRUCTURE, when the body carried one.
   *
   * The body is parsed once, here at the system boundary, and travels inward
   * as fields. `message` on this class is a composed, display-only string --
   * no layer above may re-parse it to decide what happened. Parsing an
   * external wire error at the boundary is validation of untrusted input;
   * re-parsing our own composed prose further in would be the internal
   * string-matching that discipline forbids.
   *
   * `undefined` when the body was absent, unreadable, or not the provider's
   * JSON envelope -- an edge proxy's HTML rejection, for instance. That
   * absence is meaningful to consumers rather than a gap to paper over.
   */
  readonly detail: ProviderErrorDetail | undefined;

  constructor(
    message: string,
    opts: {
      retryable: boolean;
      status?: number;
      retryAfterMs?: number;
      detail?: ProviderErrorDetail;
    },
  ) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = opts.retryable;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.detail = opts.detail;
  }
}
