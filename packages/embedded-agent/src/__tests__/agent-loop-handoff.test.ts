/**
 * Context Handoff (Phase A) — `AgentLoop.handoff()` polarity test.
 *
 * See docs/design/embedded-agent-worker.md "AgentLoop.handoff()" — Failure
 * invariant: every early-return path (prompt-load failure, provider
 * failure/cancel) returns strictly before the `context-handoff` marker is
 * emitted, so `this.conversation` is NEVER mutated without that marker having
 * also been emitted. This is the audited property; both directions are
 * asserted directly against the messages array a SUBSEQUENT provider call
 * actually receives, not merely against emitted-event side effects.
 */
import { describe, it, expect } from 'bun:test';
import type { EmbeddedAgentEvent } from '@agent-console/shared';
import { AgentLoop, type AgentLoopDeps } from '../agent-loop.js';
import type { ToolCallOutcome, ToolExecutor } from '../mcp.js';
import type { ChatMessage, ProviderAdapter, ProviderEvent, ProviderRunRequest } from '../providers/types.js';

type ScriptedResponse =
  | { kind: 'events'; events: ProviderEvent[] }
  | { kind: 'throw'; error: unknown };

/** Adapter whose response for each successive `run()` call is taken from a
 * fixed script (the last entry repeats once exhausted), recording every
 * request's `messages` snapshot for later inspection. */
class ScriptedAdapter implements ProviderAdapter {
  calls = 0;
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
  async listTools() {
    return [];
  }
  async callTool(): Promise<ToolCallOutcome> {
    return { ok: true, result: 'ok' };
  }
}

const textResponse = (text: string): ScriptedResponse => ({
  kind: 'events',
  events: [{ type: 'text-delta', text }, { type: 'done', finishReason: 'stop' }],
});

function makeDeps(overrides: Partial<AgentLoopDeps> & { adapter: ProviderAdapter }): {
  deps: AgentLoopDeps;
  events: EmbeddedAgentEvent[];
} {
  const events: EmbeddedAgentEvent[] = [];
  const deps: AgentLoopDeps = {
    model: 'm',
    tools: [],
    executor: new StubExecutor(),
    emit: (event) => events.push(event),
    systemPrompt: 'ORIGINAL_SYSTEM_PROMPT',
    maxToolIterations: 25,
    sleep: async () => {},
    reassembleSystemPrompt: async () => 'ORIGINAL_SYSTEM_PROMPT',
    loadHandoffPrompt: async () => 'DISTILL_PROMPT',
    ...overrides,
  };
  return { deps, events };
}

describe('AgentLoop.handoff() — failure invariant (polarity, mandatory)', () => {
  it('FAILS to reset the conversation when the distillation provider call fails: no context-handoff, and a subsequent turn sees exactly the pre-handoff conversation', async () => {
    // Distillation request fails on all 3 retry attempts, then a plain
    // success is scripted for the subsequent runTurn call.
    const adapter = new ScriptedAdapter([
      { kind: 'throw', error: new Error('boom') },
      { kind: 'throw', error: new Error('boom') },
      { kind: 'throw', error: new Error('boom') },
      textResponse('reply to t2'),
    ]);
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    await loop.handoff();

    expect(events.find((e) => e.type === 'turn-error')).toBeDefined();
    expect(events.find((e) => e.type === 'context-handoff')).toBeUndefined();

    // Drive a subsequent turn and inspect what the adapter actually received.
    await loop.runTurn('t2', 'next message');
    const messagesForT2 = adapter.capturedMessages.at(-1)!;

    // Baseline: a FRESH loop instance (handoff() never called) with the same
    // systemPrompt, driven by the identical runTurn call.
    const baselineAdapter = new ScriptedAdapter([textResponse('reply to t2')]);
    const { deps: baselineDeps } = makeDeps({ adapter: baselineAdapter });
    const baselineLoop = new AgentLoop(baselineDeps);
    await baselineLoop.runTurn('t2', 'next message');
    const baselineMessages = baselineAdapter.capturedMessages.at(-1)!;

    expect(messagesForT2).toEqual(baselineMessages);
  });

  it('SUCCEEDS: emits context-handoff and atomically resets the conversation to the seed shape a subsequent turn actually sends', async () => {
    const adapter = new ScriptedAdapter([
      textResponse('DISTILLATION_SUMMARY'),
      textResponse('reply to next'),
    ]);
    const { deps, events } = makeDeps({
      adapter,
      reassembleSystemPrompt: async () => 'REASSEMBLED_SYSTEM_PROMPT',
    });
    const loop = new AgentLoop(deps);

    await loop.handoff();

    const handoffEvent = events.find((e) => e.type === 'context-handoff');
    expect(handoffEvent).toEqual({ v: 1, type: 'context-handoff', distillation: 'DISTILLATION_SUMMARY' });

    await loop.runTurn('t2', 'next');
    const messagesForT2 = adapter.capturedMessages.at(-1)!;

    expect(messagesForT2).toEqual([
      { role: 'system', content: 'REASSEMBLED_SYSTEM_PROMPT' },
      {
        role: 'user',
        content:
          'This conversation continues from a previous one. Prior context summary: DISTILLATION_SUMMARY',
      },
      { role: 'user', content: 'next' },
    ]);
  });
});

describe('AgentLoop.handoff() — additional behaviors', () => {
  it('emits a turn-error (not context-handoff) and leaves the conversation untouched when loadHandoffPrompt throws', async () => {
    const adapter = new ScriptedAdapter([textResponse('should not be called for handoff')]);
    const { deps, events } = makeDeps({
      adapter,
      loadHandoffPrompt: async () => {
        throw new Error('prompt file unreadable');
      },
    });
    const loop = new AgentLoop(deps);

    await loop.handoff();

    expect(adapter.calls).toBe(0);
    const turnError = events.find((e) => e.type === 'turn-error');
    expect(turnError).toMatchObject({ message: expect.stringContaining('failed to load handoff prompt') });
    expect(events.find((e) => e.type === 'context-handoff')).toBeUndefined();
  });

  it('emits TWO context-usage events for a successful handoff: the distillation call\'s own pre-reset usage, then a fresh post-reset estimate', async () => {
    const adapter = new ScriptedAdapter([textResponse('SUMMARY')]);
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    await loop.handoff();

    const usageEvents = events.filter((e) => e.type === 'context-usage');
    expect(usageEvents).toHaveLength(2);
    // Neither this adapter script nor `textResponse` sends a provider `usage`
    // payload, so both readings fall back to the chars/4 estimate.
    expect(usageEvents[0]).toMatchObject({ estimated: true });
    expect(usageEvents[1]).toMatchObject({ estimated: true });
    // Order: state(active) -> context-usage (pre-reset, distillation call's own
    // usage) -> context-handoff -> context-usage (post-reset estimate) -> state(idle).
    // No assistant-delta -- the distillation call suppresses streaming deltas
    // (see the regression test below); the marker carries the full text.
    const types = events.map((e) => e.type);
    expect(types).toEqual(['state', 'context-usage', 'context-handoff', 'context-usage', 'state']);
  });

  it('the pre-reset context-usage carries the distillation call\'s own real usage when the provider sends one', async () => {
    const adapter = new ScriptedAdapter([
      {
        kind: 'events',
        events: [
          { type: 'text-delta', text: 'SUMMARY' },
          {
            type: 'done',
            finishReason: 'stop',
            usage: { promptTokens: 12345, completionTokens: 10, totalTokens: 12355 },
          },
        ],
      },
    ]);
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    await loop.handoff();

    const usageEvents = events.filter((e) => e.type === 'context-usage');
    expect(usageEvents).toHaveLength(2);
    // First (pre-reset) event: the distillation call's own real usage.
    expect(usageEvents[0]).toEqual({
      v: 1,
      type: 'context-usage',
      promptTokens: 12345,
      estimated: false,
    });
    // Second (post-reset) event: always a fresh chars/4 estimate over the
    // brand-new seed conversation, regardless of the first event's source.
    expect(usageEvents[1]).toMatchObject({ estimated: true });
  });

  it('regression: suppresses assistant-delta/assistant-thinking-delta during the distillation call, but a subsequent normal runTurn still streams them', async () => {
    const adapter = new ScriptedAdapter([
      {
        kind: 'events',
        events: [
          { type: 'reasoning-delta', text: 'thinking about it' },
          { type: 'text-delta', text: 'DISTIL' },
          { type: 'text-delta', text: 'LATION' },
          { type: 'done', finishReason: 'stop' },
        ],
      },
      textResponse('reply to next'),
    ]);
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    await loop.handoff();

    // Only state (active/idle), context-usage (x2), and context-handoff should
    // be present for the handoff call -- no assistant-delta /
    // assistant-thinking-delta, and no dangling assistant-message either
    // (handoff() never emits one).
    expect(events.map((e) => e.type)).toEqual([
      'state',
      'context-usage',
      'context-handoff',
      'context-usage',
      'state',
    ]);
    expect(events.find((e) => e.type === 'assistant-delta')).toBeUndefined();
    expect(events.find((e) => e.type === 'assistant-thinking-delta')).toBeUndefined();
    expect(events.find((e) => e.type === 'assistant-message')).toBeUndefined();
    expect(events.find((e) => e.type === 'context-handoff')).toEqual({
      v: 1,
      type: 'context-handoff',
      distillation: 'DISTILLATION',
    });

    // Existing runTurn behavior is unchanged: a normal turn still streams
    // assistant-delta as before.
    events.length = 0;
    await loop.runTurn('t2', 'next');
    const deltaEvents = events.filter((e) => e.type === 'assistant-delta');
    expect(deltaEvents).toHaveLength(1);
    expect(deltaEvents[0]).toMatchObject({ turnId: 't2', text: 'reply to next' });
    expect(events.find((e) => e.type === 'assistant-message')).toMatchObject({
      turnId: 't2',
      text: 'reply to next',
    });
  });

  it('falls back to the ORIGINAL system prompt when reassembleSystemPrompt throws, but still completes the reset', async () => {
    const adapter = new ScriptedAdapter([textResponse('SUMMARY'), textResponse('reply')]);
    const { deps, events } = makeDeps({
      adapter,
      reassembleSystemPrompt: async () => {
        throw new Error('fs error');
      },
    });
    const loop = new AgentLoop(deps);

    await loop.handoff();
    expect(events.find((e) => e.type === 'context-handoff')).toBeDefined();

    await loop.runTurn('t2', 'next');
    const messagesForT2 = adapter.capturedMessages.at(-1)!;
    expect(messagesForT2[0]).toEqual({ role: 'system', content: 'ORIGINAL_SYSTEM_PROMPT' });
  });

  it('rejects the distillation (turn-error, no context-handoff, conversation untouched) when the provider returns any tool calls, even alongside text', async () => {
    const adapter = new ScriptedAdapter([
      {
        kind: 'events',
        events: [
          { type: 'text-delta', text: 'SUMMARY' },
          { type: 'tool-call', callId: 'c1', name: 'ignored_tool', argsJson: '{}' },
          { type: 'done', finishReason: 'tool_calls' },
        ],
      },
      textResponse('reply to t2'),
    ]);
    let toolCalled = false;
    const { deps, events } = makeDeps({
      adapter,
      executor: {
        async listTools() {
          return [];
        },
        async callTool(): Promise<ToolCallOutcome> {
          toolCalled = true;
          return { ok: true, result: 'ok' };
        },
      },
    });
    const loop = new AgentLoop(deps);

    await loop.handoff();

    expect(toolCalled).toBe(false);
    expect(events.find((e) => e.type === 'tool-call')).toBeUndefined();
    expect(events.find((e) => e.type === 'tool-result')).toBeUndefined();
    expect(events.find((e) => e.type === 'context-handoff')).toBeUndefined();
    const turnError = events.find((e) => e.type === 'turn-error');
    expect(turnError).toMatchObject({
      message: expect.stringContaining('no usable distillation'),
    });

    // Conversation is provably untouched: a subsequent turn matches a fresh
    // baseline loop's request exactly (preserve-on-failure).
    await loop.runTurn('t2', 'next message');
    const messagesForT2 = adapter.capturedMessages.at(-1)!;

    const baselineAdapter = new ScriptedAdapter([textResponse('reply to t2')]);
    const { deps: baselineDeps } = makeDeps({ adapter: baselineAdapter });
    const baselineLoop = new AgentLoop(baselineDeps);
    await baselineLoop.runTurn('t2', 'next message');
    const baselineMessages = baselineAdapter.capturedMessages.at(-1)!;

    expect(messagesForT2).toEqual(baselineMessages);
  });

  it('rejects the distillation (turn-error, no context-handoff) when the provider returns empty/whitespace-only text', async () => {
    const adapter = new ScriptedAdapter([textResponse('   \n\t  ')]);
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    await loop.handoff();

    expect(events.find((e) => e.type === 'context-handoff')).toBeUndefined();
    const turnError = events.find((e) => e.type === 'turn-error');
    expect(turnError).toMatchObject({
      message: expect.stringContaining('no usable distillation'),
    });
    // No context-usage either -- the response was rejected before step 6's
    // pre-reset usage emission and step 12's post-reset estimate.
    expect(events.find((e) => e.type === 'context-usage')).toBeUndefined();
  });

  it('emits turn-error when handoff is canceled mid-flight, and the conversation stays untouched', async () => {
    const abortingAdapter: ProviderAdapter = {
      async *run(req: ProviderRunRequest): AsyncIterable<ProviderEvent> {
        // Never resolves; the loop's own AbortController drives cancellation.
        await new Promise<never>((_resolve, reject) => {
          req.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      },
    };
    const { deps, events } = makeDeps({ adapter: abortingAdapter });
    const loop = new AgentLoop(deps);

    const handoffPromise = loop.handoff();
    // Give the handoff a tick to reach the provider call, then cancel it.
    await new Promise((r) => setTimeout(r, 5));
    loop.cancel();
    await handoffPromise;

    expect(events.find((e) => e.type === 'context-handoff')).toBeUndefined();
    const turnError = events.find((e) => e.type === 'turn-error');
    expect(turnError).toMatchObject({ message: expect.stringContaining('Context handoff failed') });

    // Drive a subsequent turn on the SAME (already-canceled) loop instance
    // and compare against a fresh baseline loop with an identical
    // systemPrompt and no prior handoff -- the conversations must match.
    // AgentLoop captured `deps` by reference at construction; swap the
    // adapter field on that same object so the canceled loop's next turn
    // uses a responsive adapter instead of the never-resolving one.
    const followUpAdapter = new ScriptedAdapter([textResponse('reply')]);
    deps.adapter = followUpAdapter;
    await loop.runTurn('t2', 'next');
    const messagesForT2 = followUpAdapter.capturedMessages.at(-1)!;

    const baselineAdapter = new ScriptedAdapter([textResponse('reply')]);
    const { deps: baselineDeps } = makeDeps({ adapter: baselineAdapter });
    const baselineLoop = new AgentLoop(baselineDeps);
    await baselineLoop.runTurn('t2', 'next');
    const baselineMessages = baselineAdapter.capturedMessages.at(-1)!;

    expect(messagesForT2).toEqual(baselineMessages);
  });
});
