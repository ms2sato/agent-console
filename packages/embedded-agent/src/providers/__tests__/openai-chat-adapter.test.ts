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
