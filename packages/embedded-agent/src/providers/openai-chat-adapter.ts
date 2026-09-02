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
  type ProviderErrorDetail,
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
  // Sent with `stream_options: { include_usage: true }` on the FINAL chunk of
  // the stream, which per the OpenAI streaming contract carries an EMPTY
  // `choices` array. Top-level on the chunk, not nested under `choices`.
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

// Gateways in front of OpenAI-compatible providers often return a full HTML
// error page on 4xx/5xx (WAF blocks, region gating); the UI needs the head of
// that body for diagnosis, not the whole page.
const MAX_PROVIDER_ERROR_BODY_CHARS = 500;

// Read bound for the raw network stream, well above MAX_PROVIDER_ERROR_BODY_CHARS
// so a JSON error body's `type`/`code` wrapper around the `message` field isn't
// cut off before extractProviderErrorDetail gets to parse and truncate it, but
// still far below "arbitrarily large" so a hostile/misbehaving gateway can't
// force an unbounded read.
const MAX_PROVIDER_ERROR_BODY_BYTES = 8 * 1024;

function truncateProviderErrorDetail(text: string): string {
  if (text.length <= MAX_PROVIDER_ERROR_BODY_CHARS) return text;
  return `${text.slice(0, MAX_PROVIDER_ERROR_BODY_CHARS)} [truncated]`;
}

/**
 * Reads at most MAX_PROVIDER_ERROR_BODY_BYTES from a response body stream.
 * Errors from the reader propagate to the caller -- enrichment is best-effort
 * and the existing call site already wraps this in a try/catch.
 */
async function readBoundedBodyText(res: Response): Promise<string> {
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < MAX_PROVIDER_ERROR_BODY_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

/**
 * Best-effort extraction of a human-readable detail from a non-ok provider
 * response body, for enriching the `ProviderError` message. Never throws --
 * any shape that doesn't match the expected JSON error shapes falls back to
 * the raw (truncated) text.
 */
/**
 * Parse the provider's error envelope into STRUCTURE. The display string is
 * composed separately by `extractProviderErrorDetail` below, from this result.
 *
 * Splitting the two is the point: the fields were always extracted here and
 * then immediately joined into prose, which left every consumer inward of
 * this line with nothing but a sentence to match on. The join still happens
 * -- the composed message is byte-identical to before -- but the structure
 * now survives alongside it.
 *
 * Returns `undefined` when the body is not the provider's JSON envelope (an
 * edge proxy's HTML rejection, an empty body, unparseable text). Callers must
 * treat that absence as information, not as a parse to retry.
 */
function parseProviderErrorDetail(bodyText: string): ProviderErrorDetail | undefined {
  const trimmed = bodyText.trim();
  if (trimmed.length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (parsed === null || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  const errorObj =
    obj.error !== null && typeof obj.error === 'object'
      ? (obj.error as Record<string, unknown>)
      : undefined;
  const message =
    (errorObj !== undefined && typeof errorObj.message === 'string' ? errorObj.message : undefined) ??
    (typeof obj.message === 'string' ? obj.message : undefined);
  if (message === undefined) return undefined;

  const type = errorObj !== undefined && typeof errorObj.type === 'string' ? errorObj.type : undefined;
  const code = errorObj !== undefined && typeof errorObj.code === 'string' ? errorObj.code : undefined;
  return {
    message,
    ...(type !== undefined ? { type } : {}),
    ...(code !== undefined ? { code } : {}),
  };
}

/**
 * The display half. Composition is unchanged from when parsing and formatting
 * were one function, so the `message` every existing consumer sees is
 * byte-identical.
 */
function extractProviderErrorDetail(bodyText: string): string | undefined {
  const trimmed = bodyText.trim();
  if (trimmed.length === 0) return undefined;

  const detail = parseProviderErrorDetail(bodyText);
  if (detail !== undefined) {
    const context = [detail.type, detail.code].filter((v): v is string => v !== undefined).join('/');
    return truncateProviderErrorDetail(
      context.length > 0 ? `${detail.message} (${context})` : detail.message,
    );
  }

  return truncateProviderErrorDetail(trimmed);
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
        // agent-surface.md Ruling 3 (#1554): pass-through, no local value
        // validation -- the provider is the authority. Snake_case
        // `reasoning_effort` matches the OpenAI-compatible wire convention;
        // `req.reasoningEffort` (camelCase) is this codebase's own naming.
        ...(req.reasoningEffort !== undefined ? { reasoning_effort: req.reasoningEffort } : {}),
        messages: req.messages,
        stream: true,
        stream_options: { include_usage: true },
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
        let message = `provider responded with HTTP ${res.status}`;
        let detail: ProviderErrorDetail | undefined;
        try {
          const bodyText = await readBoundedBodyText(res);
          detail = parseProviderErrorDetail(bodyText);
          const display = extractProviderErrorDetail(bodyText);
          if (display !== undefined) {
            message = `${message}: ${display}`;
          }
        } catch {
          // Enrichment is best-effort only; an unreadable body must not
          // prevent throwing the status-only ProviderError below. `detail`
          // stays undefined, which is the same signal a non-envelope body
          // gives -- consumers cannot tell the two apart and must not need to.
        }
        throw new ProviderError(message, {
          retryable,
          status: res.status,
          retryAfterMs,
          ...(detail !== undefined ? { detail } : {}),
        });
      }
      if (res.body === null) {
        throw new ProviderError('provider returned an empty response body', {
          retryable: true,
        });
      }

      const parser = new SseParser();
      const toolCalls = new Map<number, AccumulatedToolCall>();
      let finishReason: string | null = null;
      let capturedUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;
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
          // Read usage BEFORE the choice-presence guard below: the final
          // usage-bearing chunk has an EMPTY `choices` array per the OpenAI
          // streaming contract, so the early-continue would otherwise skip it.
          // The SSE payload is untrusted JSON -- validate the shape (integer,
          // non-negative counters) before accepting it, so a malformed
          // compatible-provider response falls through to the chars/4
          // estimated fallback instead of corrupting context accounting.
          const usage = chunk.usage;
          if (
            usage !== null &&
            usage !== undefined &&
            Number.isSafeInteger(usage.prompt_tokens) &&
            usage.prompt_tokens >= 0 &&
            Number.isSafeInteger(usage.completion_tokens) &&
            usage.completion_tokens >= 0 &&
            Number.isSafeInteger(usage.total_tokens) &&
            usage.total_tokens >= 0
          ) {
            capturedUsage = usage;
          }
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
      yield {
        type: 'done',
        finishReason,
        usage:
          capturedUsage !== null
            ? {
                promptTokens: capturedUsage.prompt_tokens,
                completionTokens: capturedUsage.completion_tokens,
                totalTokens: capturedUsage.total_tokens,
              }
            : undefined,
      };
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
