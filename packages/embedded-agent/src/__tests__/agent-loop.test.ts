import { describe, it, expect } from 'bun:test';
import type { EmbeddedAgentEvent } from '@agent-console/shared';
import { AgentLoop, type AgentLoopDeps } from '../agent-loop.js';
import type { ToolCallOutcome, ToolExecutor } from '../mcp.js';
import {
  ProviderError,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderRunRequest,
} from '../providers/types.js';

type ScriptedResponse =
  | { kind: 'events'; events: ProviderEvent[] }
  | { kind: 'throw'; error: unknown };

class StubAdapter implements ProviderAdapter {
  calls = 0;
  constructor(private readonly script: ScriptedResponse[]) {}

  async *run(_req: ProviderRunRequest): AsyncIterable<ProviderEvent> {
    const idx = this.calls;
    this.calls++;
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
  constructor(private readonly outcome: ToolCallOutcome = { ok: true, result: 'ok' }) {}
  async listTools() {
    return [];
  }
  async callTool(name: string, args: unknown): Promise<ToolCallOutcome> {
    this.calls.push({ name, args });
    return this.outcome;
  }
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
