import { describe, it, expect } from 'bun:test';
import { OpenAIChatAdapter } from '../openai-chat-adapter.js';
import {
  ProviderError,
  type ChatMessage,
  type ProviderEvent,
  type ToolDefinition,
} from '../types.js';

const encoder = new TextEncoder();

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

/** A body stream that never yields and rejects its pending read on abort. */
function hangingStream(signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull() {
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    },
  });
}

/** A body stream whose first read rejects, e.g. a dropped connection mid-body. */
function rejectingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull() {
      return Promise.reject(new Error('stream error: connection reset'));
    },
  });
}

interface MockResponseInit {
  status?: number;
  headers?: Record<string, string>;
  body?: ReadableStream<Uint8Array> | null;
}

function mockResponse(init: MockResponseInit): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(init.headers ?? {}),
    body: init.body === undefined ? streamFromChunks([]) : init.body,
  } as unknown as Response;
}

function chunkString(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) {
    out.push(s.slice(i, i + size));
  }
  return out;
}

async function collect(iter: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

describe('OpenAIChatAdapter — SSE text streaming', () => {
  it('streams text deltas and a final done with finishReason', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n';
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ body: streamFromChunks([sse]) }),
    });

    const events = await collect(
      adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
    );

    const text = events
      .filter((e): e is Extract<ProviderEvent, { type: 'text-delta' }> => e.type === 'text-delta')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('Hello world');
    const done = events.at(-1);
    expect(done).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('reassembles SSE frames split at awkward byte boundaries', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"AB"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"CD"}}]}\n\n' +
      'data: [DONE]\n\n';
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      // 7-byte chunks split mid-JSON and mid-"data:" prefix.
      fetchFn: async () => mockResponse({ body: streamFromChunks(chunkString(sse, 7)) }),
    });

    const events = await collect(
      adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
    );
    const text = events
      .filter((e): e is Extract<ProviderEvent, { type: 'text-delta' }> => e.type === 'text-delta')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('ABCD');
  });

  it('emits nothing for a zero-length content delta', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":""}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n' +
      'data: [DONE]\n\n';
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ body: streamFromChunks([sse]) }),
    });

    const events = await collect(
      adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
    );
    const deltas = events.filter((e) => e.type === 'text-delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toEqual({ type: 'text-delta', text: 'x' });
  });
});

describe('OpenAIChatAdapter — reasoning/thinking content', () => {
  it('yields reasoning-delta and text-delta independently, in stream order', async () => {
    const sse =
      'data: {"choices":[{"delta":{"reasoning_content":"Let "}}]}\n\n' +
      'data: {"choices":[{"delta":{"reasoning_content":"me think"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"The "}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n';
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ body: streamFromChunks([sse]) }),
    });

    const events = await collect(
      adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
    );

    expect(events.slice(0, 4)).toEqual([
      { type: 'reasoning-delta', text: 'Let ' },
      { type: 'reasoning-delta', text: 'me think' },
      { type: 'text-delta', text: 'The ' },
      { type: 'text-delta', text: 'answer' },
    ]);
  });

  it('yields both reasoning-delta and text-delta when a single chunk carries both fields', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"answer","reasoning_content":"reason"}}]}\n\n' +
      'data: [DONE]\n\n';
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ body: streamFromChunks([sse]) }),
    });

    const events = await collect(
      adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
    );

    expect(events.slice(0, 2)).toEqual([
      { type: 'text-delta', text: 'answer' },
      { type: 'reasoning-delta', text: 'reason' },
    ]);
  });

  it('yields neither event for a chunk with neither content nor reasoning_content', async () => {
    const sse =
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' + 'data: [DONE]\n\n';
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ body: streamFromChunks([sse]) }),
    });

    const events = await collect(
      adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
    );

    expect(events.filter((e) => e.type === 'text-delta' || e.type === 'reasoning-delta')).toHaveLength(
      0,
    );
  });
});

describe('OpenAIChatAdapter — tool-call accumulation', () => {
  it('accumulates tool-call deltas across chunks by index', async () => {
    const sse =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_","arguments":"{\\"a"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"weather","arguments":"\\":1}"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
      'data: [DONE]\n\n';
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ body: streamFromChunks(chunkString(sse, 11)) }),
    });

    const events = await collect(
      adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
    );
    const toolCalls = events.filter(
      (e): e is Extract<ProviderEvent, { type: 'tool-call' }> => e.type === 'tool-call',
    );
    expect(toolCalls).toEqual([
      { type: 'tool-call', callId: 'call_1', name: 'get_weather', argsJson: '{"a":1}' },
    ]);
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  it('emits one tool-call event per accumulated index, in index order', async () => {
    const sse =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"two","arguments":"{}"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"one","arguments":"{}"}}]}}]}\n\n' +
      'data: [DONE]\n\n';
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ body: streamFromChunks([sse]) }),
    });

    const events = await collect(
      adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
    );
    const names = events
      .filter((e): e is Extract<ProviderEvent, { type: 'tool-call' }> => e.type === 'tool-call')
      .map((e) => e.callId);
    expect(names).toEqual(['a', 'b']);
  });
});

describe('OpenAIChatAdapter — request body', () => {
  it('omits the tools key entirely when the tool list is empty', async () => {
    let capturedBody: unknown = null;
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return mockResponse({ body: streamFromChunks(['data: [DONE]\n\n']) });
      },
    });

    await collect(
      adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
    );
    expect(capturedBody).not.toBeNull();
    expect('tools' in (capturedBody as Record<string, unknown>)).toBe(false);
    expect((capturedBody as Record<string, unknown>).stream).toBe(true);
  });

  it('includes the OpenAI-shaped tools array when tools are present', async () => {
    let capturedBody: unknown = null;
    const tools: ToolDefinition[] = [
      { name: 't', description: 'd', parameters: { type: 'object' } },
    ];
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return mockResponse({ body: streamFromChunks(['data: [DONE]\n\n']) });
      },
    });

    await collect(adapter.run({ model: 'm', messages, tools, signal: new AbortController().signal }));
    expect((capturedBody as Record<string, unknown>).tools).toEqual([
      { type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object' } } },
    ]);
  });

  it('sends an Authorization header only when an apiKey is configured', async () => {
    let withKey: Headers | null = null;
    const withKeyAdapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      apiKey: 'secret',
      fetchFn: async (_url, init) => {
        withKey = new Headers(init?.headers);
        return mockResponse({ body: streamFromChunks(['data: [DONE]\n\n']) });
      },
    });
    await collect(
      withKeyAdapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
    );
    expect(withKey!.get('authorization')).toBe('Bearer secret');

    let withoutKey: Headers | null = null;
    const noKeyAdapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async (_url, init) => {
        withoutKey = new Headers(init?.headers);
        return mockResponse({ body: streamFromChunks(['data: [DONE]\n\n']) });
      },
    });
    await collect(
      noKeyAdapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
    );
    expect(withoutKey!.get('authorization')).toBeNull();
  });

  it('sends stream_options: { include_usage: true } so the provider emits a final usage chunk', async () => {
    let capturedBody: unknown = null;
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return mockResponse({ body: streamFromChunks(['data: [DONE]\n\n']) });
      },
    });

    await collect(
      adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
    );
    expect(capturedBody).toMatchObject({ stream_options: { include_usage: true } });
  });
});

describe('OpenAIChatAdapter — token usage (Context Handoff Phase A)', () => {
  it('reads usage from the FINAL chunk even though its choices array is empty', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n' +
      'data: [DONE]\n\n';
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ body: streamFromChunks([sse]) }),
    });

    const events = await collect(
      adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
    );
    const done = events.at(-1);
    expect(done).toEqual({
      type: 'done',
      finishReason: null,
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    });
  });

  it('keeps the LATEST non-null usage value seen across the stream', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hi"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":5,"total_tokens":55}}\n\n' +
      'data: [DONE]\n\n';
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ body: streamFromChunks([sse]) }),
    });

    const events = await collect(
      adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
    );
    const done = events.at(-1) as {
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    };
    expect(done.usage).toEqual({ promptTokens: 50, completionTokens: 5, totalTokens: 55 });
  });

  it('yields undefined usage on done when the provider never sends a usage field', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n';
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ body: streamFromChunks([sse]) }),
    });

    const events = await collect(
      adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
    );
    const done = events.at(-1);
    expect(done).toEqual({ type: 'done', finishReason: 'stop', usage: undefined });
  });

  it('treats an explicit usage: null chunk the same as absent usage', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hi"}}],"usage":null}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n';
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ body: streamFromChunks([sse]) }),
    });

    const events = await collect(
      adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
    );
    const done = events.at(-1);
    expect(done).toEqual({ type: 'done', finishReason: 'stop', usage: undefined });
  });

  it('rejects a malformed usage chunk with a negative prompt_tokens, falling back to undefined', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":-5,"completion_tokens":2,"total_tokens":12}}\n\n' +
      'data: [DONE]\n\n';
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ body: streamFromChunks([sse]) }),
    });

    const events = await collect(
      adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
    );
    const done = events.at(-1);
    expect(done).toEqual({ type: 'done', finishReason: null, usage: undefined });
  });

  it('rejects a malformed usage chunk with a non-integer prompt_tokens, falling back to undefined', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":10.5,"completion_tokens":2,"total_tokens":12}}\n\n' +
      'data: [DONE]\n\n';
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ body: streamFromChunks([sse]) }),
    });

    const events = await collect(
      adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
    );
    const done = events.at(-1);
    expect(done).toEqual({ type: 'done', finishReason: null, usage: undefined });
  });

  it('still accepts a well-formed usage chunk (regression)', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n' +
      'data: [DONE]\n\n';
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ body: streamFromChunks([sse]) }),
    });

    const events = await collect(
      adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
    );
    const done = events.at(-1);
    expect(done).toEqual({
      type: 'done',
      finishReason: null,
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    });
  });
});

describe('OpenAIChatAdapter — HTTP errors', () => {
  it('throws a retryable ProviderError with retryAfterMs on 429', async () => {
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ status: 429, headers: { 'retry-after': '2' } }),
    });
    let caught: unknown;
    try {
      await collect(
        adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).status).toBe(429);
    expect((caught as ProviderError).retryAfterMs).toBe(2000);
    expect((caught as ProviderError).retryable).toBe(true);
  });

  it('parses an HTTP-date retry-after header in the future into a positive retryAfterMs', async () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ status: 429, headers: { 'retry-after': future } }),
    });
    let caught: unknown;
    try {
      await collect(
        adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
      );
    } catch (err) {
      caught = err;
    }
    const retryAfterMs = (caught as ProviderError).retryAfterMs;
    expect(retryAfterMs).toBeGreaterThan(0);
    expect(retryAfterMs).toBeLessThanOrEqual(5000);
  });

  it('clamps an HTTP-date retry-after header in the past to 0', async () => {
    const past = new Date(Date.now() - 5000).toUTCString();
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ status: 429, headers: { 'retry-after': past } }),
    });
    let caught: unknown;
    try {
      await collect(
        adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as ProviderError).retryAfterMs).toBe(0);
  });

  it('ignores an invalid retry-after header', async () => {
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () =>
        mockResponse({ status: 429, headers: { 'retry-after': 'not-a-valid-value' } }),
    });
    let caught: unknown;
    try {
      await collect(
        adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as ProviderError).retryAfterMs).toBeUndefined();
  });

  it('marks 5xx retryable and 4xx non-retryable', async () => {
    const server = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ status: 503 }),
    });
    const client = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ status: 400 }),
    });

    const grab = async (a: OpenAIChatAdapter): Promise<ProviderError> => {
      try {
        await collect(a.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }));
      } catch (err) {
        return err as ProviderError;
      }
      throw new Error('expected throw');
    };

    expect((await grab(server)).retryable).toBe(true);
    expect((await grab(client)).retryable).toBe(false);
  });
});

describe('OpenAIChatAdapter — HTTP error body enrichment', () => {
  it('includes the provider error message and type/code from an OpenAI-shape JSON error body', async () => {
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () =>
        mockResponse({
          status: 403,
          body: streamFromChunks([
            JSON.stringify({
              type: 'error',
              error: {
                type: 'RegionError',
                code: 'region_not_supported',
                message: 'regional opt-in required: https://example.com/opt-in',
              },
            }),
          ]),
        }),
    });
    let caught: unknown;
    try {
      await collect(
        adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    const err = caught as ProviderError;
    expect(err.message).toContain('provider responded with HTTP 403');
    expect(err.message).toContain('regional opt-in required: https://example.com/opt-in');
    expect(err.message).toContain('RegionError');
    expect(err.message).toContain('region_not_supported');
    // retryable/status/retryAfterMs semantics stay exactly as before.
    expect(err.status).toBe(403);
    expect(err.retryable).toBe(false);
  });

  it('surfaces the truncated head of a non-JSON (e.g. HTML gateway) error body split across multiple reads', async () => {
    const html = '<html><body><h1>403 Forbidden</h1><p>Access denied by WAF.</p></body></html>';
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      // 10-byte chunks force the bounded-read loop to make several reader.read()
      // calls, exercising the loop rather than a single-chunk stream.
      fetchFn: async () => mockResponse({ status: 403, body: streamFromChunks(chunkString(html, 10)) }),
    });
    let caught: unknown;
    try {
      await collect(
        adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
      );
    } catch (err) {
      caught = err;
    }
    const err = caught as ProviderError;
    expect(err.message).toContain('provider responded with HTTP 403');
    expect(err.message).toContain(html);
  });

  it('does not truncate a body exactly at the 500-char cap', async () => {
    const body = 'a'.repeat(500);
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ status: 400, body: streamFromChunks([body]) }),
    });
    let caught: unknown;
    try {
      await collect(
        adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
      );
    } catch (err) {
      caught = err;
    }
    const err = caught as ProviderError;
    expect(err.message).toContain(body);
    expect(err.message).not.toContain('[truncated]');
  });

  it('truncates a body one char over the 500-char cap and marks it as truncated', async () => {
    const body = 'a'.repeat(501);
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ status: 400, body: streamFromChunks([body]) }),
    });
    let caught: unknown;
    try {
      await collect(
        adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
      );
    } catch (err) {
      caught = err;
    }
    const err = caught as ProviderError;
    expect(err.message).toContain('a'.repeat(500));
    expect(err.message).not.toContain('a'.repeat(501));
    expect(err.message).toContain('[truncated]');
  });

  it('stays status-only when the body is null', async () => {
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ status: 500, body: null }),
    });
    let caught: unknown;
    try {
      await collect(
        adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as ProviderError).message).toBe('provider responded with HTTP 500');
  });

  it('degrades to today’s status-only message when reading the body rejects, without throwing a secondary error', async () => {
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () =>
        mockResponse({
          status: 503,
          headers: { 'retry-after': '3' },
          body: rejectingStream(),
        }),
    });
    let caught: unknown;
    try {
      await collect(
        adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    const err = caught as ProviderError;
    expect(err.message).toBe('provider responded with HTTP 503');
    expect(err.status).toBe(503);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(3000);
  });

  it('never surfaces the Authorization header value in the enriched error message', async () => {
    const apiKey = 'sk-should-never-leak-1234567890';
    let capturedHeaders: Headers | null = null;
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      apiKey,
      fetchFn: async (_url, init) => {
        capturedHeaders = new Headers(init.headers);
        return mockResponse({
          status: 403,
          body: streamFromChunks([JSON.stringify({ error: { message: 'forbidden' } })]),
        });
      },
    });
    let caught: unknown;
    try {
      await collect(
        adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
      );
    } catch (err) {
      caught = err;
    }
    expect(capturedHeaders!.get('authorization')).toBe(`Bearer ${apiKey}`);
    expect((caught as ProviderError).message).not.toContain(apiKey);
  });

  it('stops reading once the bounded prefix is reached, never consuming a much larger body', async () => {
    // Mirrors production's MAX_PROVIDER_ERROR_BODY_BYTES (8 * 1024); kept local
    // to this test rather than imported, since the constant is not exported.
    const BOUND_BYTES = 8 * 1024;
    const CHUNK_BYTES = 1024;
    const TOTAL_CHUNKS = 24; // 24KB total, 3x the bound -- a res.text()-based
    // unbounded read would consume all of it.
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > TOTAL_CHUNKS) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode('a'.repeat(CHUNK_BYTES)));
      },
    });
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      fetchFn: async () => mockResponse({ status: 500, body }),
    });
    let caught: unknown;
    try {
      await collect(
        adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    // The loop's length check stops consuming once BOUND_BYTES is reached, so
    // only ~BOUND_BYTES/CHUNK_BYTES reads happen (+1 for the stream's own
    // readahead prefetch) -- proving the stream was never fully drained. A
    // res.text()-based unbounded read would have pulled all TOTAL_CHUNKS.
    expect(pulls).toBeLessThanOrEqual(BOUND_BYTES / CHUNK_BYTES + 1);
    expect(pulls).toBeLessThan(TOTAL_CHUNKS);
  });
});

describe('OpenAIChatAdapter — deadlines and cancellation', () => {
  it('aborts with a retryable error when no bytes arrive within the idle timeout', async () => {
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      idleTimeoutMs: 25,
      totalTimeoutMs: 10_000,
      fetchFn: async (_url, init) => mockResponse({ body: hangingStream(init!.signal!) }),
    });
    let caught: unknown;
    try {
      await collect(
        adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).retryable).toBe(true);
  });

  it('aborts with a retryable error when the total-request ceiling is exceeded', async () => {
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      idleTimeoutMs: 10_000,
      totalTimeoutMs: 25,
      fetchFn: async (_url, init) => mockResponse({ body: hangingStream(init!.signal!) }),
    });
    let caught: unknown;
    try {
      await collect(
        adapter.run({ model: 'm', messages, tools: [], signal: new AbortController().signal }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).retryable).toBe(true);
  });

  it('rethrows caller cancellation as a non-ProviderError', async () => {
    const caller = new AbortController();
    const adapter = new OpenAIChatAdapter({
      baseUrl: 'http://x/v1',
      idleTimeoutMs: 10_000,
      totalTimeoutMs: 10_000,
      fetchFn: async (_url, init) => mockResponse({ body: hangingStream(init!.signal!) }),
    });

    const consume = (async (): Promise<unknown> => {
      try {
        await collect(adapter.run({ model: 'm', messages, tools: [], signal: caller.signal }));
        return null;
      } catch (err) {
        return err;
      }
    })();
    await new Promise((r) => setTimeout(r, 15));
    caller.abort();
    const caught = await consume;
    expect(caught).not.toBeInstanceOf(ProviderError);
  });
});
