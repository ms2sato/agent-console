/**
 * OpenAI Chat Completions streaming provider adapter.
 *
 * POSTs to `{baseUrl}/chat/completions` with `stream: true`, parses the SSE
 * response, streams text deltas, accumulates tool-call deltas by index, and
 * enforces two hard deadlines (idle-read and total-request) so a stuck provider
 * can never leave a turn active indefinitely.
 */

import { SseParser } from './sse.js';
import {
  ProviderError,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderRunRequest,
  type ToolDefinition,
} from './types.js';

/**
 * The subset of the fetch signature the adapter uses. Narrower than
 * `typeof fetch` (which also requires `preconnect`), so a plain test double is
 * assignable while the real `fetch` still satisfies it.
 */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAIChatAdapterOptions {
  baseUrl: string;
  apiKey?: string;
  fetchFn?: FetchFn;
  /** Abort the request when no bytes arrive for this long. Default 60s. */
  idleTimeoutMs?: number;
  /** Absolute ceiling on the whole streaming request. Default 10min. */
  totalTimeoutMs?: number;
}

type AbortReason = 'caller' | 'idle-timeout' | 'total-timeout';

interface AccumulatedToolCall {
  id: string;
  name: string;
  args: string;
}

interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      // `reasoning_content` is the de-facto field name used by
      // OpenAI-Chat-Completions-compatible providers that stream
      // reasoning/thinking content (DeepSeek-R1, many vLLM reasoning-parser
      // configs, OpenRouter passthrough, some Ollama models). It streams the
      // same way `content` does -- just another delta field, not a separate
      // message shape.
      reasoning_content?: string | null;
      tool_calls?: OpenAIToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
}

function toOpenAITools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * Parse a `retry-after` header. Supports both forms allowed by RFC 9110
 * § 10.2.3: delta-seconds (`"120"`) and HTTP-date (`"Wed, 21 Oct 2026
 * 07:28:00 GMT"`).
 */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = new Date(trimmed);
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }
  return undefined;
}

export class OpenAIChatAdapter implements ProviderAdapter {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: FetchFn;
  private readonly idleTimeoutMs: number;
  private readonly totalTimeoutMs: number;

  constructor(opts: OpenAIChatAdapterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 60_000;
    this.totalTimeoutMs = opts.totalTimeoutMs ?? 600_000;
  }

  async *run(req: ProviderRunRequest): AsyncIterable<ProviderEvent> {
    const ac = new AbortController();
    // Holder object so control-flow analysis does not narrow the reason across
    // the awaits below; timer/listener callbacks mutate it asynchronously.
    const abort: { reason: AbortReason | null } = { reason: null };

    const onCallerAbort = () => {
      abort.reason = 'caller';
      ac.abort();
    };

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const totalTimer = setTimeout(() => {
      abort.reason = 'total-timeout';
      ac.abort();
    }, this.totalTimeoutMs);
    const armIdle = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        abort.reason = 'idle-timeout';
        ac.abort();
      }, this.idleTimeoutMs);
    };

    if (req.signal.aborted) {
      abort.reason = 'caller';
      ac.abort();
    } else {
      req.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    try {
      armIdle();

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      };
      if (this.apiKey !== undefined) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const body: Record<string, unknown> = {
        model: req.model,
        messages: req.messages,
        stream: true,
      };
      // Omit `tools` entirely when the list is empty (some providers reject `[]`).
      if (req.tools.length > 0) {
        body.tools = toOpenAITools(req.tools);
      }

      const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      if (!res.ok) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
        const retryable = res.status === 429 || res.status >= 500;
        throw new ProviderError(
          `provider responded with HTTP ${res.status}`,
          { retryable, status: res.status, retryAfterMs },
        );
      }
      if (res.body === null) {
        throw new ProviderError('provider returned an empty response body', {
          retryable: true,
        });
      }

      const parser = new SseParser();
      const toolCalls = new Map<number, AccumulatedToolCall>();
      let finishReason: string | null = null;
      const decoder = new TextDecoder();
      const reader = res.body.getReader();

      let streamDone = false;
      while (!streamDone) {
        const { value, done } = await reader.read();
        if (done) break;
        armIdle();
        const text = decoder.decode(value, { stream: true });
        for (const sseLine of parser.push(text)) {
          if (sseLine.kind === 'done') {
            streamDone = true;
            break;
          }
          if (sseLine.kind === 'ignore') continue;
          const chunk = sseLine.json as OpenAIStreamChunk;
          const choice = chunk.choices?.[0];
          if (choice === undefined) continue;

          const content = choice.delta?.content;
          if (typeof content === 'string' && content.length > 0) {
            yield { type: 'text-delta', text: content };
          }

          const reasoning = choice.delta?.reasoning_content;
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            yield { type: 'reasoning-delta', text: reasoning };
          }

          const deltas = choice.delta?.tool_calls;
          if (deltas !== undefined) {
            for (const delta of deltas) {
              const entry = toolCalls.get(delta.index) ?? { id: '', name: '', args: '' };
              if (delta.id !== undefined) entry.id = delta.id;
              if (delta.function?.name !== undefined) entry.name += delta.function.name;
              if (delta.function?.arguments !== undefined) {
                entry.args += delta.function.arguments;
              }
              toolCalls.set(delta.index, entry);
            }
          }

          if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            finishReason = choice.finish_reason;
          }
        }
      }

      for (const entry of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
        const [, call] = entry;
        yield { type: 'tool-call', callId: call.id, name: call.name, argsJson: call.args };
      }
      yield { type: 'done', finishReason };
    } catch (err) {
      if (abort.reason === 'idle-timeout' || abort.reason === 'total-timeout') {
        throw new ProviderError(`provider ${abort.reason} exceeded`, { retryable: true });
      }
      // Caller cancellation (or any non-timeout error): rethrow so the loop can
      // classify it. The loop checks its own signal to distinguish a cancel.
      throw err;
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      req.signal.removeEventListener('abort', onCallerAbort);
    }
  }
}
