import { describe, it, expect } from 'bun:test';
import type { EmbeddedAgentEvent } from '@agent-console/shared';
import { AgentLoop, type AgentLoopDeps } from '../agent-loop.js';
import type { ToolCallOutcome, ToolExecutor } from '../mcp.js';
import {
  ProviderError,
  type ChatMessage,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderRunRequest,
} from '../providers/types.js';

type ScriptedResponse =
  | { kind: 'events'; events: ProviderEvent[] }
  | { kind: 'throw'; error: unknown };

class StubAdapter implements ProviderAdapter {
  calls = 0;
  /** Snapshot of the conversation passed to each run() call (frozen at call time). */
  capturedMessages: ChatMessage[][] = [];
  constructor(private readonly script: ScriptedResponse[]) {}

  async *run(req: ProviderRunRequest): AsyncIterable<ProviderEvent> {
    const idx = this.calls;
    this.calls++;
    this.capturedMessages.push([...req.messages]);
    const resp = this.script[Math.min(idx, this.script.length - 1)];
    if (resp.kind === 'throw') {
      throw resp.error;
    }
    for (const event of resp.events) {
      yield event;
    }
  }
}

class StubExecutor implements ToolExecutor {
  calls: Array<{ name: string; args: unknown }> = [];
  constructor(
    private readonly outcome: ToolCallOutcome = { ok: true, result: 'ok' },
    private readonly onCall?: () => void,
  ) {}
  async listTools() {
    return [];
  }
  async callTool(name: string, args: unknown): Promise<ToolCallOutcome> {
    this.calls.push({ name, args });
    this.onCall?.();
    return this.outcome;
  }
}

/** Every tool_call in an assistant message has a matching tool-role response. */
function everyToolCallAnswered(messages: ChatMessage[]): boolean {
  const respondedIds = new Set(
    messages
      .filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool')
      .map((m) => m.tool_call_id),
  );
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (!respondedIds.has(tc.id)) return false;
      }
    }
  }
  return true;
}

const textResponse = (text: string): ScriptedResponse => ({
  kind: 'events',
  events: [
    ...(text ? [{ type: 'text-delta' as const, text }] : []),
    { type: 'done', finishReason: 'stop' },
  ],
});

const toolCallResponse = (callId: string, name: string, argsJson: string): ScriptedResponse => ({
  kind: 'events',
  events: [
    { type: 'tool-call', callId, name, argsJson },
    { type: 'done', finishReason: 'tool_calls' },
  ],
});

interface Harness {
  loop: AgentLoop;
  events: EmbeddedAgentEvent[];
  sleeps: number[];
  executor: StubExecutor;
  adapter: StubAdapter;
}

function makeLoop(
  script: ScriptedResponse[],
  opts: {
    executor?: StubExecutor;
    maxToolIterations?: number;
    retryDelaysMs?: [number, number];
    onSleep?: (loopRef: { current: AgentLoop | null }) => void;
    reassembleSystemPrompt?: () => Promise<string>;
    loadHandoffPrompt?: () => Promise<string>;
  } = {},
): Harness {
  const events: EmbeddedAgentEvent[] = [];
  const sleeps: number[] = [];
  const executor = opts.executor ?? new StubExecutor();
  const adapter = new StubAdapter(script);
  const loopRef: { current: AgentLoop | null } = { current: null };

  const deps: AgentLoopDeps = {
    adapter,
    model: 'm',
    tools: [],
    executor,
    emit: (event) => events.push(event),
    systemPrompt: 'sys',
    maxToolIterations: opts.maxToolIterations ?? 25,
    retryDelaysMs: opts.retryDelaysMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      opts.onSleep?.(loopRef);
    },
    reassembleSystemPrompt: opts.reassembleSystemPrompt ?? (async () => 'sys'),
    loadHandoffPrompt: opts.loadHandoffPrompt ?? (async () => 'DISTILL_PROMPT'),
  };
  const loop = new AgentLoop(deps);
  loopRef.current = loop;
  return { loop, events, sleeps, executor, adapter };
}

const types = (events: EmbeddedAgentEvent[]) => events.map((e) => e.type);

describe('AgentLoop — event ordering', () => {
  it('emits state active -> deltas -> assistant-message -> tool-call -> tool-result -> ... -> state idle', async () => {
    const h = makeLoop([
      toolCallResponse('c1', 'do_thing', '{"x":1}'),
      textResponse(''),
    ]);
    await h.loop.runTurn('t1', 'hello');

    expect(types(h.events)).toEqual([
      'state',
      'assistant-message',
      'tool-call',
      'tool-result',
      'assistant-message',
      'context-usage',
      'state',
    ]);
    expect(h.events[0]).toEqual({ v: 1, type: 'state', state: 'active' });
    expect(h.events.at(-1)).toEqual({ v: 1, type: 'state', state: 'idle' });
    const toolCall = h.events.find((e) => e.type === 'tool-call');
    expect(toolCall).toMatchObject({ callId: 'c1', name: 'do_thing', args: { x: 1 } });
    expect(h.executor.calls).toEqual([{ name: 'do_thing', args: { x: 1 } }]);
  });

  it('streams assistant-delta events before the final assistant-message', async () => {
    const h = makeLoop([
      {
        kind: 'events',
        events: [
          { type: 'text-delta', text: 'Hel' },
          { type: 'text-delta', text: 'lo' },
          { type: 'done', finishReason: 'stop' },
        ],
      },
    ]);
    await h.loop.runTurn('t1', 'hi');
    const deltas = h.events.filter((e) => e.type === 'assistant-delta');
    expect(deltas.map((e) => (e as { text: string }).text)).toEqual(['Hel', 'lo']);
    const final = h.events.find((e) => e.type === 'assistant-message');
    expect(final).toMatchObject({ text: 'Hello' });
  });

  it('emits assistant-thinking-delta events before assistant-delta/assistant-message, without leaking reasoning text into the final message', async () => {
    const h = makeLoop([
      {
        kind: 'events',
        events: [
          { type: 'reasoning-delta', text: 'Let me ' },
          { type: 'reasoning-delta', text: 'think.' },
          { type: 'text-delta', text: 'Hel' },
          { type: 'text-delta', text: 'lo' },
          { type: 'done', finishReason: 'stop' },
        ],
      },
    ]);
    await h.loop.runTurn('t1', 'hi');

    expect(types(h.events)).toEqual([
      'state',
      'assistant-thinking-delta',
      'assistant-thinking-delta',
      'assistant-delta',
      'assistant-delta',
      'assistant-message',
      'context-usage',
      'state',
    ]);
    const thinking = h.events.filter((e) => e.type === 'assistant-thinking-delta');
    expect(thinking.map((e) => (e as { text: string }).text)).toEqual(['Let me ', 'think.']);
    const final = h.events.find((e) => e.type === 'assistant-message');
    // Reasoning text is not accumulated into the final assistant-message text.
    expect(final).toMatchObject({ text: 'Hello' });
  });

  it('behaves exactly as before when the provider stream has no reasoning-delta events', async () => {
    const h = makeLoop([textResponse('plain answer')]);
    await h.loop.runTurn('t1', 'hi');
    expect(h.events.filter((e) => e.type === 'assistant-thinking-delta')).toHaveLength(0);
    expect(types(h.events)).toEqual([
      'state',
      'assistant-delta',
      'assistant-message',
      'context-usage',
      'state',
    ]);
  });
});

describe('AgentLoop — boundary values', () => {
  it('emits an assistant-message even when the text is empty', async () => {
    const h = makeLoop([textResponse('')]);
    await h.loop.runTurn('t1', 'hi');
    const msg = h.events.find((e) => e.type === 'assistant-message');
    expect(msg).toEqual({ v: 1, type: 'assistant-message', turnId: 't1', text: '' });
    expect(h.events.filter((e) => e.type === 'assistant-delta')).toHaveLength(0);
  });
});

describe('AgentLoop — provider retries', () => {
  it('retries twice with the configured backoff then succeeds', async () => {
    const h = makeLoop([
      { kind: 'throw', error: new Error('boom') },
      { kind: 'throw', error: new Error('boom') },
      textResponse('recovered'),
    ]);
    await h.loop.runTurn('t1', 'hi');
    expect(h.sleeps).toEqual([500, 2000]);
    expect(h.adapter.calls).toBe(3);
    expect(h.events.find((e) => e.type === 'assistant-message')).toMatchObject({
      text: 'recovered',
    });
    expect(h.events.find((e) => e.type === 'turn-error')).toBeUndefined();
  });

  it('honors a 429 retryAfterMs for the backoff delay', async () => {
    const h = makeLoop([
      {
        kind: 'throw',
        error: new ProviderError('rate limited', {
          retryable: true,
          status: 429,
          retryAfterMs: 5000,
        }),
      },
      textResponse('ok'),
    ]);
    await h.loop.runTurn('t1', 'hi');
    expect(h.sleeps[0]).toBe(5000);
  });

  it('emits a single turn-error then state idle after 3 failures', async () => {
    const h = makeLoop([{ kind: 'throw', error: new Error('down') }]);
    await h.loop.runTurn('t1', 'hi');
    expect(h.adapter.calls).toBe(3);
    expect(h.sleeps).toEqual([500, 2000]);
    const turnErrors = h.events.filter((e) => e.type === 'turn-error');
    expect(turnErrors).toHaveLength(1);
    expect(types(h.events)).toEqual(['state', 'turn-error', 'state']);
    expect(h.events.at(-1)).toEqual({ v: 1, type: 'state', state: 'idle' });
  });

  it('does not retry when the turn is canceled during backoff', async () => {
    const h = makeLoop([{ kind: 'throw', error: new Error('boom') }], {
      onSleep: (loopRef) => loopRef.current?.cancel(),
    });
    await h.loop.runTurn('t1', 'hi');
    expect(h.adapter.calls).toBe(1);
    const turnError = h.events.find((e) => e.type === 'turn-error');
    expect(turnError).toMatchObject({ message: 'turn canceled' });
  });

  it('fails fast on a non-retryable provider error without retrying or sleeping', async () => {
    const h = makeLoop([
      {
        kind: 'throw',
        error: new ProviderError('bad request', { retryable: false, status: 400 }),
      },
    ]);
    await h.loop.runTurn('t1', 'hi');
    expect(h.adapter.calls).toBe(1);
    expect(h.sleeps).toEqual([]);
    const turnError = h.events.find((e) => e.type === 'turn-error');
    expect(turnError).toMatchObject({ message: 'bad request' });
  });
});

describe('AgentLoop — malformed tool arguments', () => {
  it('feeds exactly 2 synthetic re-asks then a turn-error', async () => {
    const h = makeLoop([toolCallResponse('c', 'do', 'not json at all')]);
    await h.loop.runTurn('t1', 'hi');
    expect(h.adapter.calls).toBe(3);
    // No tool-call event is emitted for malformed args (never executed).
    expect(h.events.filter((e) => e.type === 'tool-call')).toHaveLength(0);
    expect(h.executor.calls).toHaveLength(0);
    const turnError = h.events.find((e) => e.type === 'turn-error');
    expect(turnError).toBeDefined();
    expect(h.events.at(-1)).toEqual({ v: 1, type: 'state', state: 'idle' });
  });

  it('recovers when the model returns well-formed args on a later attempt', async () => {
    const h = makeLoop([
      toolCallResponse('c1', 'do', 'garbage'),
      toolCallResponse('c2', 'do', '{"ok":true}'),
      textResponse('finished'),
    ]);
    await h.loop.runTurn('t1', 'hi');
    expect(h.events.find((e) => e.type === 'turn-error')).toBeUndefined();
    expect(h.events.filter((e) => e.type === 'tool-call')).toHaveLength(1);
    expect(h.executor.calls).toEqual([{ name: 'do', args: { ok: true } }]);
    expect(h.events.at(-1)).toEqual({ v: 1, type: 'state', state: 'idle' });
  });

  it('treats an empty-string argsJson as an empty object', async () => {
    const h = makeLoop([toolCallResponse('c1', 'do', ''), textResponse('done')]);
    await h.loop.runTurn('t1', 'hi');
    expect(h.executor.calls).toEqual([{ name: 'do', args: {} }]);
  });
});

describe('AgentLoop — iteration cap', () => {
  it('emits turn-error after maxToolIterations when the model keeps calling tools', async () => {
    const h = makeLoop([toolCallResponse('c', 'loop_tool', '{}')], { maxToolIterations: 2 });
    await h.loop.runTurn('t1', 'hi');
    expect(h.adapter.calls).toBe(2);
    const turnError = h.events.find((e) => e.type === 'turn-error');
    expect(turnError).toMatchObject({ message: 'maximum tool iterations reached' });
    expect(h.events.at(-1)).toEqual({ v: 1, type: 'state', state: 'idle' });
  });
});

describe('AgentLoop — tool-result truncation', () => {
  it('truncates a tool result larger than 16 KiB, UTF-8-safe', async () => {
    const executor = new StubExecutor({ ok: true, result: 'z'.repeat(20000) });
    const h = makeLoop([toolCallResponse('c', 'big', '{}'), textResponse('done')], { executor });
    await h.loop.runTurn('t1', 'hi');
    const result = h.events.find((e) => e.type === 'tool-result') as
      | { result: string }
      | undefined;
    expect(result).toBeDefined();
    expect(new TextEncoder().encode(result!.result).length).toBeLessThanOrEqual(16384);
  });
});

describe('AgentLoop — conversation stays valid after an early return', () => {
  it('answers pending tool calls when the turn is canceled mid-tool-execution', async () => {
    // Executor cancels the turn as soon as the (single) tool call executes, so
    // the post-execution abort check ends the turn before the tool result is
    // appended. Without the fix, the assistant message's tool_call is left
    // unanswered and the NEXT turn's provider request is malformed.
    const loopRef: { current: AgentLoop | null } = { current: null };
    const executor = new StubExecutor({ ok: true, result: 'ignored' }, () =>
      loopRef.current?.cancel(),
    );
    const h = makeLoop([toolCallResponse('c1', 'do_thing', '{"x":1}'), textResponse('second turn')], {
      executor,
    });
    loopRef.current = h.loop;

    await h.loop.runTurn('t1', 'first');
    expect(h.events.find((e) => e.type === 'turn-error')).toMatchObject({ message: 'turn canceled' });

    await h.loop.runTurn('t2', 'second');
    // The second run() receives the conversation with the aborted turn's
    // tool_call already answered.
    const secondTurnMessages = h.adapter.capturedMessages[1];
    expect(everyToolCallAnswered(secondTurnMessages)).toBe(true);
    expect(
      secondTurnMessages.some((m) => m.role === 'tool' && m.tool_call_id === 'c1'),
    ).toBe(true);
    // The second turn actually completes (assistant-message emitted for t2).
    expect(h.events.some((e) => e.type === 'assistant-message' && e.turnId === 't2')).toBe(true);
  });

  it('answers pending tool calls when the re-ask cap is exceeded', async () => {
    const h = makeLoop([
      toolCallResponse('c1', 'do', 'garbage-1'),
      toolCallResponse('c2', 'do', 'garbage-2'),
      toolCallResponse('c3', 'do', 'garbage-3'),
      textResponse('second turn'),
    ]);

    await h.loop.runTurn('t1', 'first');
    expect(h.events.find((e) => e.type === 'turn-error')).toBeDefined();

    await h.loop.runTurn('t2', 'second');
    const secondTurnMessages = h.adapter.capturedMessages.at(-1)!;
    expect(everyToolCallAnswered(secondTurnMessages)).toBe(true);
    // The tool_call that tripped the cap (c3) must have a matching response.
    expect(
      secondTurnMessages.some((m) => m.role === 'tool' && m.tool_call_id === 'c3'),
    ).toBe(true);
  });
});

describe('AgentLoop — wire-event size caps', () => {
  it('truncates an assistant-message text larger than 256 KiB in the emitted event', async () => {
    const huge = 'a'.repeat(300_000);
    const h = makeLoop([textResponse(huge)]);
    await h.loop.runTurn('t1', 'hi');
    const msg = h.events.find((e) => e.type === 'assistant-message') as
      | { text: string }
      | undefined;
    expect(msg).toBeDefined();
    expect(new TextEncoder().encode(msg!.text).length).toBeLessThanOrEqual(262144);
  });

  it('truncates oversized tool-call args on the wire while executing with the full args', async () => {
    const blob = 'x'.repeat(300_000);
    const fullArgs = { blob };
    const argsJson = JSON.stringify(fullArgs);
    expect(new TextEncoder().encode(argsJson).length).toBeGreaterThan(262144);

    const h = makeLoop([toolCallResponse('c1', 'big_args', argsJson), textResponse('done')]);
    await h.loop.runTurn('t1', 'hi');

    const toolCall = h.events.find((e) => e.type === 'tool-call') as { args: unknown } | undefined;
    expect(toolCall).toBeDefined();
    // Oversized args are emitted as a UTF-8-safe-truncated string under the cap.
    expect(typeof toolCall!.args).toBe('string');
    expect(new TextEncoder().encode(toolCall!.args as string).length).toBeLessThanOrEqual(262144);
    // The tool is still executed with the full, untruncated parsed args.
    expect(h.executor.calls).toEqual([{ name: 'big_args', args: fullArgs }]);
  });

  it('emits small tool-call args as the parsed object (no truncation)', async () => {
    const h = makeLoop([toolCallResponse('c1', 'small', '{"a":1}'), textResponse('done')]);
    await h.loop.runTurn('t1', 'hi');
    const toolCall = h.events.find((e) => e.type === 'tool-call') as { args: unknown } | undefined;
    expect(toolCall!.args).toEqual({ a: 1 });
  });
});

describe('AgentLoop — context-usage accounting (Token accounting, Context Handoff Phase A)', () => {
  it('falls back to a chars/4 estimate (estimated: true) when the provider omits usage', async () => {
    const h = makeLoop([textResponse('ok')]);
    await h.loop.runTurn('t1', 'hi');
    const usageEvent = h.events.find((e) => e.type === 'context-usage') as
      | { promptTokens: number; estimated: boolean }
      | undefined;
    expect(usageEvent).toBeDefined();
    expect(usageEvent!.estimated).toBe(true);
    expect(usageEvent!.promptTokens).toBeGreaterThan(0);
  });

  it('uses the real usage.promptTokens (estimated: false) when the provider sends usage', async () => {
    const h = makeLoop([
      {
        kind: 'events',
        events: [
          { type: 'text-delta', text: 'ok' },
          {
            type: 'done',
            finishReason: 'stop',
            usage: { promptTokens: 123, completionTokens: 4, totalTokens: 127 },
          },
        ],
      },
    ]);
    await h.loop.runTurn('t1', 'hi');
    const usageEvent = h.events.find((e) => e.type === 'context-usage');
    expect(usageEvent).toEqual({ v: 1, type: 'context-usage', promptTokens: 123, estimated: false });
  });

  it("does not emit context-usage when the turn's very first provider attempt fails (all retries exhausted)", async () => {
    const h = makeLoop([{ kind: 'throw', error: new Error('down') }]);
    await h.loop.runTurn('t1', 'hi');
    expect(h.events.find((e) => e.type === 'context-usage')).toBeUndefined();
    expect(h.events.find((e) => e.type === 'turn-error')).toBeDefined();
  });

  it("emits context-usage exactly once for a multi-tool-call turn, using the LAST iteration's usage value", async () => {
    const h = makeLoop([
      {
        kind: 'events',
        events: [
          { type: 'tool-call', callId: 'c1', name: 'do', argsJson: '{}' },
          {
            type: 'done',
            finishReason: 'tool_calls',
            usage: { promptTokens: 100, completionTokens: 1, totalTokens: 101 },
          },
        ],
      },
      {
        kind: 'events',
        events: [
          { type: 'text-delta', text: 'done' },
          {
            type: 'done',
            finishReason: 'stop',
            usage: { promptTokens: 200, completionTokens: 2, totalTokens: 202 },
          },
        ],
      },
    ]);
    await h.loop.runTurn('t1', 'hi');
    const usageEvents = h.events.filter((e) => e.type === 'context-usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toEqual({ v: 1, type: 'context-usage', promptTokens: 200, estimated: false });
  });
});
