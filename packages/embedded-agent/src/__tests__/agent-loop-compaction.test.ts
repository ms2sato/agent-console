/**
 * Compaction — `AgentLoop.compact()` polarity test, the auto threshold's
 * boundary values, and the `Compact` tool's reservation semantics.
 *
 * See docs/design/embedded-agent-worker.md "`AgentLoop.compact()`" — Failure
 * invariant: every early-return path (prompt-load failure, provider
 * failure/cancel, unusable summary) returns strictly before the
 * `context-compacted` marker is emitted, so `this.conversation` is NEVER
 * mutated without that marker having also been emitted. This is the audited
 * property; both directions are asserted directly against the messages array
 * a SUBSEQUENT provider call actually receives, not merely against
 * emitted-event side effects.
 */
import { describe, it, expect } from 'bun:test';
import type { EmbeddedAgentEvent } from '@agent-console/shared';
import {
  AgentLoop,
  selectPartialDistillationMessages,
  type AgentLoopDeps,
} from '../agent-loop.js';
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
  capturedToolNames: string[][] = [];
  constructor(private readonly script: ScriptedResponse[]) {}

  async *run(req: ProviderRunRequest): AsyncIterable<ProviderEvent> {
    const idx = this.calls;
    this.calls++;
    this.capturedMessages.push([...req.messages]);
    this.capturedToolNames.push(req.tools.map((t) => t.name));
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
    loadCompactionPrompt: async () => 'DISTILL_PROMPT',
    // Auto OFF by default so the turn-boundary check never fires in tests
    // that are about something else; the auto-threshold describe below opts
    // in explicitly.
    compaction: { auto: false },
    ...overrides,
  };
  return { deps, events };
}

describe('AgentLoop.compact() — failure invariant (polarity, mandatory)', () => {
  it('FAILS to reset the conversation when the distillation provider call fails: no context-compacted, and a subsequent turn sees exactly the pre-compaction conversation', async () => {
    // Seed a successful turn first, then distillation fails on all 3 retry
    // attempts, then a plain success is scripted for the subsequent runTurn
    // call. Seeding matters: an implementation that incorrectly wipes
    // `this.conversation` on failure would otherwise be indistinguishable
    // from a correct one, since a fresh loop has nothing to preserve either.
    const adapter = new ScriptedAdapter([
      textResponse('seed reply'),
      { kind: 'throw', error: new Error('boom') },
      { kind: 'throw', error: new Error('boom') },
      { kind: 'throw', error: new Error('boom') },
      textResponse('reply to t2'),
    ]);
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t0', 'seed message');

    await loop.compact('manual');

    expect(events.find((e) => e.type === 'turn-error')).toBeDefined();
    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();

    // Drive a subsequent turn and inspect what the adapter actually received.
    await loop.runTurn('t2', 'next message');
    const messagesForT2 = adapter.capturedMessages.at(-1)!;

    // Baseline: a loop seeded with the IDENTICAL prior turn (but no compaction
    // attempt in between), driven by the identical runTurn call. Comparing
    // against a baseline that also carries the seeded history -- rather than
    // an empty fresh loop -- is what actually proves preservation.
    const baselineAdapter = new ScriptedAdapter([textResponse('seed reply'), textResponse('reply to t2')]);
    const { deps: baselineDeps } = makeDeps({ adapter: baselineAdapter });
    const baselineLoop = new AgentLoop(baselineDeps);
    await baselineLoop.runTurn('t0', 'seed message');
    await baselineLoop.runTurn('t2', 'next message');
    const baselineMessages = baselineAdapter.capturedMessages.at(-1)!;

    expect(messagesForT2).toEqual(baselineMessages);
    // Sanity: the seeded turn's history is actually present, not merely
    // equal to an equally-empty baseline.
    expect(messagesForT2.some((m) => m.role === 'assistant' && m.content === 'seed reply')).toBe(true);
  });

  it('SUCCEEDS: emits context-compacted and atomically resets the conversation to the seed shape a subsequent turn actually sends', async () => {
    const adapter = new ScriptedAdapter([
      textResponse('DISTILLATION_SUMMARY'),
      textResponse('reply to next'),
    ]);
    const { deps, events } = makeDeps({
      adapter,
      reassembleSystemPrompt: async () => 'REASSEMBLED_SYSTEM_PROMPT',
    });
    const loop = new AgentLoop(deps);

    await loop.compact('manual');

    const compactedEvent = events.find((e) => e.type === 'context-compacted');
    expect(compactedEvent).toMatchObject({
      v: 1,
      type: 'context-compacted',
      source: 'manual',
      summary: 'DISTILLATION_SUMMARY',
    });

    await loop.runTurn('t2', 'next');
    const messagesForT2 = adapter.capturedMessages.at(-1)!;

    expect(messagesForT2).toEqual([
      { role: 'system', content: 'REASSEMBLED_SYSTEM_PROMPT' },
      {
        role: 'user',
        content:
          'Summary of the earlier part of this conversation, which has been compacted away: DISTILLATION_SUMMARY',
      },
      { role: 'user', content: 'next' },
    ]);
  });
});

describe('AgentLoop.compact() — additional behaviors', () => {
  it('emits a turn-error (not context-compacted) and leaves the conversation untouched when loadCompactionPrompt throws', async () => {
    const adapter = new ScriptedAdapter([textResponse('should not be called for compaction')]);
    const { deps, events } = makeDeps({
      adapter,
      loadCompactionPrompt: async () => {
        throw new Error('prompt file unreadable');
      },
    });
    const loop = new AgentLoop(deps);

    await loop.compact('manual');

    expect(adapter.calls).toBe(0);
    const turnError = events.find((e) => e.type === 'turn-error');
    expect(turnError).toMatchObject({ message: expect.stringContaining('failed to load compaction prompt') });
    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();
  });

  it('emits TWO context-usage events for a successful compaction: the distillation call\'s own pre-reset usage, then a fresh post-reset estimate', async () => {
    const adapter = new ScriptedAdapter([textResponse('SUMMARY')]);
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    await loop.compact('manual');

    const usageEvents = events.filter((e) => e.type === 'context-usage');
    expect(usageEvents).toHaveLength(2);
    // Neither this adapter script nor `textResponse` sends a provider `usage`
    // payload, so both readings fall back to the chars/4 estimate.
    expect(usageEvents[0]).toMatchObject({ estimated: true });
    expect(usageEvents[1]).toMatchObject({ estimated: true });
    // Order: state(active) -> context-usage (pre-reset, distillation call's own
    // usage) -> context-compacted -> context-usage (post-reset estimate) -> state(idle).
    // No assistant-delta -- the distillation call suppresses streaming deltas
    // (see the regression test below); the marker carries the full text.
    const types = events.map((e) => e.type);
    expect(types).toEqual(['state', 'context-usage', 'context-compacted', 'context-usage', 'state']);
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

    await loop.compact('manual');

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

    await loop.compact('manual');

    // Only state (active/idle), context-usage (x2), and context-compacted should
    // be present for the compaction call -- no assistant-delta /
    // assistant-thinking-delta, and no dangling assistant-message either
    // (compact() never emits one).
    expect(events.map((e) => e.type)).toEqual([
      'state',
      'context-usage',
      'context-compacted',
      'context-usage',
      'state',
    ]);
    expect(events.find((e) => e.type === 'assistant-delta')).toBeUndefined();
    expect(events.find((e) => e.type === 'assistant-thinking-delta')).toBeUndefined();
    expect(events.find((e) => e.type === 'assistant-message')).toBeUndefined();
    expect(events.find((e) => e.type === 'context-compacted')).toMatchObject({
      v: 1,
      type: 'context-compacted',
      source: 'manual',
      summary: 'DISTILLATION',
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

    await loop.compact('manual');
    expect(events.find((e) => e.type === 'context-compacted')).toBeDefined();

    await loop.runTurn('t2', 'next');
    const messagesForT2 = adapter.capturedMessages.at(-1)!;
    expect(messagesForT2[0]).toEqual({ role: 'system', content: 'ORIGINAL_SYSTEM_PROMPT' });
  });

  it('rejects the distillation (turn-error, no context-compacted, conversation untouched) when the provider returns any tool calls, even alongside text', async () => {
    // Seed a successful turn first -- see the failure-invariant polarity test
    // above for why an empty-vs-empty baseline can't distinguish "preserved"
    // from "wrongly reset".
    const adapter = new ScriptedAdapter([
      textResponse('seed reply'),
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

    await loop.runTurn('t0', 'seed message');

    await loop.compact('manual');

    expect(toolCalled).toBe(false);
    expect(events.find((e) => e.type === 'tool-call')).toBeUndefined();
    expect(events.find((e) => e.type === 'tool-result')).toBeUndefined();
    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();
    const turnError = events.find((e) => e.type === 'turn-error');
    expect(turnError).toMatchObject({
      message: expect.stringContaining('no usable summary'),
    });

    // Conversation is provably untouched: a subsequent turn matches a
    // baseline loop seeded with the IDENTICAL prior turn (preserve-on-failure).
    await loop.runTurn('t2', 'next message');
    const messagesForT2 = adapter.capturedMessages.at(-1)!;

    const baselineAdapter = new ScriptedAdapter([textResponse('seed reply'), textResponse('reply to t2')]);
    const { deps: baselineDeps } = makeDeps({ adapter: baselineAdapter });
    const baselineLoop = new AgentLoop(baselineDeps);
    await baselineLoop.runTurn('t0', 'seed message');
    await baselineLoop.runTurn('t2', 'next message');
    const baselineMessages = baselineAdapter.capturedMessages.at(-1)!;

    expect(messagesForT2).toEqual(baselineMessages);
    expect(messagesForT2.some((m) => m.role === 'assistant' && m.content === 'seed reply')).toBe(true);
  });

  it('rejects the distillation (turn-error, no context-compacted) when the provider returns empty/whitespace-only text', async () => {
    const adapter = new ScriptedAdapter([textResponse('   \n\t  ')]);
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    await loop.compact('manual');

    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();
    const turnError = events.find((e) => e.type === 'turn-error');
    expect(turnError).toMatchObject({
      message: expect.stringContaining('no usable summary'),
    });
    // No context-usage either -- the response was rejected before step 6's
    // pre-reset usage emission and step 12's post-reset estimate.
    expect(events.find((e) => e.type === 'context-usage')).toBeUndefined();
  });

  it('emits turn-error when compaction is canceled mid-flight, and the conversation stays untouched', async () => {
    let signalProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      signalProviderStarted = resolve;
    });
    const abortingAdapter: ProviderAdapter = {
      async *run(req: ProviderRunRequest): AsyncIterable<ProviderEvent> {
        signalProviderStarted();
        // Never resolves; the loop's own AbortController drives cancellation.
        await new Promise<never>((_resolve, reject) => {
          req.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      },
    };
    // Seed with a responsive adapter first so the loop carries prior turn
    // history into the canceled compaction -- see the failure-invariant
    // polarity test above for why an empty-vs-empty baseline can't
    // distinguish "preserved" from "wrongly reset".
    const seedAdapter = new ScriptedAdapter([textResponse('seed reply')]);
    const { deps, events } = makeDeps({ adapter: seedAdapter });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t0', 'seed message');

    // AgentLoop captured `deps` by reference at construction; swap the
    // adapter field on that same object so the compaction call reaches the
    // never-resolving aborting adapter instead of the seed one.
    deps.adapter = abortingAdapter;

    const compactPromise = loop.compact('manual');
    await providerStarted;
    loop.cancel();
    await compactPromise;

    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();
    const turnError = events.find((e) => e.type === 'turn-error');
    expect(turnError).toMatchObject({ message: expect.stringContaining('Context compaction failed') });

    // Drive a subsequent turn on the SAME (already-canceled) loop instance
    // and compare against a baseline loop seeded with the IDENTICAL prior
    // turn (but no compaction attempt) -- the conversations must match.
    const followUpAdapter = new ScriptedAdapter([textResponse('reply')]);
    deps.adapter = followUpAdapter;
    await loop.runTurn('t2', 'next');
    const messagesForT2 = followUpAdapter.capturedMessages.at(-1)!;

    const baselineAdapter = new ScriptedAdapter([textResponse('seed reply'), textResponse('reply')]);
    const { deps: baselineDeps } = makeDeps({ adapter: baselineAdapter });
    const baselineLoop = new AgentLoop(baselineDeps);
    await baselineLoop.runTurn('t0', 'seed message');
    await baselineLoop.runTurn('t2', 'next');
    const baselineMessages = baselineAdapter.capturedMessages.at(-1)!;

    expect(messagesForT2).toEqual(baselineMessages);
    expect(messagesForT2.some((m) => m.role === 'assistant' && m.content === 'seed reply')).toBe(true);
  });
});

/**
 * A scripted response whose `done` event carries a real provider usage
 * payload, so the auto threshold reads an exact `promptTokens` rather than
 * the chars/4 estimate. Every threshold test below pins the numerator this
 * way; otherwise the ratio would depend on the incidental byte length of the
 * test's own strings.
 */
const textResponseWithUsage = (text: string, promptTokens: number): ScriptedResponse => ({
  kind: 'events',
  events: [
    { type: 'text-delta', text },
    {
      type: 'done',
      finishReason: 'stop',
      usage: { promptTokens, completionTokens: 1, totalTokens: promptTokens + 1 },
    },
  ],
});

describe('Compaction — the automatic threshold at its boundary values', () => {
  // 1000-token window, default 0.85 threshold => fires at >= 850.
  const WINDOW = 1000;

  it('does NOT fire just below the threshold (849/1000 with the 0.85 default)', async () => {
    const adapter = new ScriptedAdapter([textResponseWithUsage('reply', 849)]);
    const { deps, events } = makeDeps({
      adapter,
      compaction: { auto: true, contextWindowTokens: WINDOW },
    });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'hello');

    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();
  });

  it('fires EXACTLY AT the threshold (850/1000) — the comparison is >=, not >', async () => {
    const adapter = new ScriptedAdapter([
      textResponseWithUsage('reply', 850),
      textResponse('SUMMARY'),
    ]);
    const { deps, events } = makeDeps({
      adapter,
      compaction: { auto: true, contextWindowTokens: WINDOW },
    });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'hello');

    expect(events.find((e) => e.type === 'context-compacted')).toMatchObject({
      source: 'auto',
      summary: 'SUMMARY',
    });
  });

  it('fires above the threshold (900/1000)', async () => {
    const adapter = new ScriptedAdapter([
      textResponseWithUsage('reply', 900),
      textResponse('SUMMARY'),
    ]);
    const { deps, events } = makeDeps({
      adapter,
      compaction: { auto: true, contextWindowTokens: WINDOW },
    });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'hello');

    expect(events.find((e) => e.type === 'context-compacted')).toMatchObject({ source: 'auto' });
  });

  it('honours a definition-supplied threshold in place of the default', async () => {
    // 600/1000 = 0.6: below the 0.85 default, at the configured 0.6.
    const adapter = new ScriptedAdapter([
      textResponseWithUsage('reply', 600),
      textResponse('SUMMARY'),
    ]);
    const { deps, events } = makeDeps({
      adapter,
      compaction: { auto: true, contextWindowTokens: WINDOW, threshold: 0.6 },
    });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'hello');

    expect(events.find((e) => e.type === 'context-compacted')).toMatchObject({ source: 'auto' });
  });

  it('CANNOT fire when contextWindowTokens is unset, however large the usage', async () => {
    // A structural gate, not a numeric one: with no denominator there is no
    // ratio at all, and we deliberately do not guess the model's window.
    const adapter = new ScriptedAdapter([textResponseWithUsage('reply', 9_999_999)]);
    const { deps, events } = makeDeps({ adapter, compaction: { auto: true } });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'hello');

    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();
  });

  it('does not fire when the worker toggle is OFF, even above the threshold', async () => {
    const adapter = new ScriptedAdapter([textResponseWithUsage('reply', 999)]);
    const { deps, events } = makeDeps({
      adapter,
      compaction: { auto: false, contextWindowTokens: WINDOW },
    });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'hello');

    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();
  });

  it('setAutoCompaction(true) takes effect at the very next turn boundary', async () => {
    const adapter = new ScriptedAdapter([
      textResponseWithUsage('reply one', 999),
      textResponseWithUsage('reply two', 999),
      textResponse('SUMMARY'),
    ]);
    const { deps, events } = makeDeps({
      adapter,
      compaction: { auto: false, contextWindowTokens: WINDOW },
    });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'hello');
    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();

    loop.setAutoCompaction(true);
    await loop.runTurn('t2', 'hello again');

    expect(events.find((e) => e.type === 'context-compacted')).toMatchObject({ source: 'auto' });
  });

  it('setAutoCompaction(false) suppresses a firing that would otherwise happen', async () => {
    const adapter = new ScriptedAdapter([textResponseWithUsage('reply', 999)]);
    const { deps, events } = makeDeps({
      adapter,
      compaction: { auto: true, contextWindowTokens: WINDOW },
    });
    const loop = new AgentLoop(deps);

    loop.setAutoCompaction(false);
    await loop.runTurn('t1', 'hello');

    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();
  });

  it('does not fire when the turn produced no usage reading at all (the vacuous case)', async () => {
    // A turn whose very first provider attempt fails emits no context-usage,
    // so there is no ratio to compare -- not a small ratio, an absent one.
    const adapter = new ScriptedAdapter([
      { kind: 'throw', error: new Error('boom') },
      { kind: 'throw', error: new Error('boom') },
      { kind: 'throw', error: new Error('boom') },
    ]);
    const { deps, events } = makeDeps({
      adapter,
      compaction: { auto: true, contextWindowTokens: 1 },
    });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'hello');

    expect(events.find((e) => e.type === 'context-usage')).toBeUndefined();
    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();
  });
});

/** Emits a single tool call by name, then finishes the iteration. */
const toolCallResponse = (name: string, callId: string): ScriptedResponse => ({
  kind: 'events',
  events: [
    { type: 'tool-call', callId, name, argsJson: '{}' },
    { type: 'done', finishReason: 'tool_calls' },
  ],
});

describe('Compaction — the Compact tool and its turn-boundary reservation', () => {
  it('publishes Compact to the provider regardless of enabledTools (the tool list the loop was constructed with is empty)', async () => {
    const adapter = new ScriptedAdapter([textResponse('hi')]);
    const { deps } = makeDeps({ adapter, tools: [] });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'hello');

    // `tools: []` is the strongest form of "every builtin tool off"; Compact
    // is still there, because it is not reachable from that configuration at
    // all -- it is prepended by the loop itself.
    const names = adapter.capturedToolNames.at(-1)!;
    expect(names).toEqual(['Compact']);
  });

  it('reserves rather than compacting mid-turn: the compaction runs AFTER the turn concludes', async () => {
    const adapter = new ScriptedAdapter([
      toolCallResponse('Compact', 'c1'),
      textResponse('all done'),
      textResponse('SUMMARY'),
    ]);
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'please compact');

    const types = events.map((e) => e.type);
    // The compaction marker lands after the turn's own idle, never between
    // the tool call and the assistant message that follows it.
    expect(types.indexOf('context-compacted')).toBeGreaterThan(types.indexOf('assistant-message'));
    expect(events.find((e) => e.type === 'context-compacted')).toMatchObject({
      source: 'manual',
      summary: 'SUMMARY',
    });
  });

  it('surfaces the call as an ordinary tool-call/tool-result pair, on the same path every other tool uses', async () => {
    const adapter = new ScriptedAdapter([
      toolCallResponse('Compact', 'c1'),
      textResponse('all done'),
      textResponse('SUMMARY'),
    ]);
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'please compact');

    expect(events.find((e) => e.type === 'tool-call')).toMatchObject({
      turnId: 't1',
      callId: 'c1',
      name: 'Compact',
    });
    expect(events.find((e) => e.type === 'tool-result')).toMatchObject({
      turnId: 't1',
      callId: 'c1',
      ok: true,
      result: 'Compaction scheduled; runs when this turn completes.',
    });
  });

  it('never reaches the tool executor for Compact', async () => {
    let executorCalledWith: string | null = null;
    const adapter = new ScriptedAdapter([
      toolCallResponse('Compact', 'c1'),
      textResponse('all done'),
      textResponse('SUMMARY'),
    ]);
    const { deps } = makeDeps({
      adapter,
      executor: {
        async listTools() {
          return [];
        },
        async callTool(name: string): Promise<ToolCallOutcome> {
          executorCalledWith = name;
          return { ok: true, result: 'ok' };
        },
      },
    });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'please compact');

    expect(executorCalledWith).toBeNull();
  });

  it('is idempotent within one turn: two Compact calls produce ONE compaction', async () => {
    const adapter = new ScriptedAdapter([
      toolCallResponse('Compact', 'c1'),
      toolCallResponse('Compact', 'c2'),
      textResponse('all done'),
      textResponse('SUMMARY'),
    ]);
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'compact twice');

    expect(events.filter((e) => e.type === 'context-compacted')).toHaveLength(1);
  });

  it('runs even in a small context — a manual request has no threshold gate', async () => {
    // No contextWindowTokens at all, which makes auto compaction structurally
    // impossible; the manual reservation is unaffected by that.
    const adapter = new ScriptedAdapter([
      toolCallResponse('Compact', 'c1'),
      textResponse('all done'),
      textResponse('SUMMARY'),
    ]);
    const { deps, events } = makeDeps({ adapter, compaction: { auto: false } });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'compact please');

    expect(events.find((e) => e.type === 'context-compacted')).toMatchObject({ source: 'manual' });
  });

  it('still runs at the boundary when the turn ended in an error', async () => {
    // Compact is reserved, then the NEXT provider attempt fails the turn. A
    // failed turn is exactly when a user may want the context reclaimed.
    const adapter = new ScriptedAdapter([
      toolCallResponse('Compact', 'c1'),
      { kind: 'throw', error: new Error('boom') },
      { kind: 'throw', error: new Error('boom') },
      { kind: 'throw', error: new Error('boom') },
      textResponse('SUMMARY'),
    ]);
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'compact then fail');

    expect(events.find((e) => e.type === 'turn-error')).toBeDefined();
    expect(events.find((e) => e.type === 'context-compacted')).toMatchObject({ source: 'manual' });
  });

  it('DISCARDS the reservation when the turn is canceled', async () => {
    let signalProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      signalProviderStarted = resolve;
    });
    let call = 0;
    const adapter: ProviderAdapter & { capturedMessages: ChatMessage[][] } = {
      capturedMessages: [],
      async *run(req: ProviderRunRequest): AsyncIterable<ProviderEvent> {
        adapter.capturedMessages.push([...req.messages]);
        if (call++ === 0) {
          yield { type: 'tool-call', callId: 'c1', name: 'Compact', argsJson: '{}' };
          yield { type: 'done', finishReason: 'tool_calls' };
          return;
        }
        signalProviderStarted();
        await new Promise<never>((_resolve, reject) => {
          req.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      },
    };
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    const turn = loop.runTurn('t1', 'compact then cancel');
    await providerStarted;
    loop.cancel();
    await turn;

    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();

    // And the reservation is genuinely gone, not merely deferred: a later
    // clean turn does not suddenly compact.
    call = 1;
    const followUp = new ScriptedAdapter([textResponse('fine')]);
    deps.adapter = followUp;
    await loop.runTurn('t2', 'anything');
    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();
  });
});

describe('Compaction — the boundary marker reports its own severity', () => {
  it('carries preTokens from the distillation call and postTokens from the seed', async () => {
    // Visibility, not prevention: SDK-side compaction fidelity measured
    // non-deterministic, and the chosen response is to let each compaction
    // declare how aggressive it was rather than to build machinery that
    // tries to stop it. See the event's doc comment in shared.
    const adapter = new ScriptedAdapter([textResponseWithUsage('A SHORT SUMMARY', 50_000)]);
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    await loop.compact('manual');

    const marker = events.find((e) => e.type === 'context-compacted');
    expect(marker).toMatchObject({ preTokens: 50_000 });
    // The post value is the seed's own chars/4 estimate -- small, and
    // strictly smaller than the pre value, which is the whole point.
    const postTokens = (marker as { postTokens?: number }).postTokens;
    expect(typeof postTokens).toBe('number');
    expect(postTokens!).toBeLessThan(50_000);
  });

  it('reports preTokens from the chars/4 fallback when the provider sends no usage of its own', async () => {
    // `preTokens` is optional on the wire because an engine may have no
    // figure -- but THIS engine always does: a provider that reports nothing
    // falls back to the chars/4 estimate over the request it just made, so
    // the marker is never silently missing its severity on this path.
    const adapter = new ScriptedAdapter([textResponse('SUMMARY')]);
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t0', 'a message long enough to estimate from');
    events.length = 0;
    await loop.compact('manual');

    const marker = events.find((e) => e.type === 'context-compacted') as { preTokens?: number };
    expect(typeof marker.preTokens).toBe('number');
    expect(marker.preTokens!).toBeGreaterThan(0);
  });

  it('reports the post value on the context-usage event too, so the bar and the marker cannot disagree', async () => {
    const adapter = new ScriptedAdapter([textResponseWithUsage('SUMMARY', 50_000)]);
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    await loop.compact('manual');

    const marker = events.find((e) => e.type === 'context-compacted') as { postTokens?: number };
    const usageEvents = events.filter((e) => e.type === 'context-usage');
    expect(usageEvents.at(-1)).toMatchObject({
      promptTokens: marker.postTokens,
      estimated: true,
    });
  });
});

/**
 * Compaction at the restore boundary (#1411) — the SECOND firing point of the
 * same automatic predicate, evaluated once after `init` and before the first
 * user turn. See docs/design/embedded-agent-worker.md "Compaction at the
 * restore boundary" for the four-row table these boundary values walk, and
 * for why `FULL_DISTILL_MAX_RATIO` (0.9) and `PARTIAL_DISTILL_INPUT_RATIO`
 * (0.7) are two constants rather than one.
 */
describe('Compaction at the restore boundary — the four boundary cases', () => {
  // 1000-token window, default 0.85 threshold, 0.9 full-distill ceiling.
  // estimateTokensFromChars is round(totalChars / 4), so `4 * n` characters
  // of `.content` across the array is exactly n estimated tokens.
  const WINDOW = 1000;

  /**
   * A restored conversation whose total estimate is exactly `tokens`.
   *
   * NOTE: `AgentLoop` takes OWNERSHIP of the array handed to it as
   * `restoredConversation` (`this.conversation = deps.restoredConversation`),
   * and `compact()` splices that same array in place. Any expectation built
   * from one of these arrays must therefore be materialised BEFORE the call
   * under test, or it silently becomes an expectation about the
   * post-compaction seed. (Production is unaffected: the array there is
   * freshly parsed out of the init command's JSON.)
   */
  function restoredOfSize(tokens: number): ChatMessage[] {
    const systemChars = 40;
    return [
      { role: 'system', content: 'S'.repeat(systemChars) },
      { role: 'user', content: 'U'.repeat(tokens * 4 - systemChars) },
    ];
  }

  it('does NOTHING when contextWindowTokens is unset, however large the restored conversation', async () => {
    // The same structural gate the turn-end path applies: no denominator, no
    // ratio, and we do not guess the model's window. The provider's 400 on
    // the first turn stays Tier A's accepted behaviour.
    const adapter = new ScriptedAdapter([textResponse('SUMMARY')]);
    const { deps, events } = makeDeps({
      adapter,
      compaction: { auto: true },
      restoredConversation: restoredOfSize(9_999),
    });
    const loop = new AgentLoop(deps);

    await loop.compactAtRestoreBoundaryIfNeeded();

    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();
    expect(adapter.calls).toBe(0);
    // Nothing was ATTEMPTED either: a path that skipped the window/toggle gate
    // and fell through to the partial branch would find nothing fitting and
    // surface a compaction turn-error without ever calling the provider,
    // which the two assertions above cannot tell apart from doing nothing.
    expect(events.find((e) => e.type === 'turn-error')).toBeUndefined();
  });

  it('does NOTHING below the threshold (849/1000)', async () => {
    const adapter = new ScriptedAdapter([textResponse('SUMMARY')]);
    const { deps, events } = makeDeps({
      adapter,
      compaction: { auto: true, contextWindowTokens: WINDOW },
      restoredConversation: restoredOfSize(849),
    });
    const loop = new AgentLoop(deps);

    await loop.compactAtRestoreBoundaryIfNeeded();

    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();
    expect(adapter.calls).toBe(0);
    // Nothing was ATTEMPTED either: a path that skipped the window/toggle gate
    // and fell through to the partial branch would find nothing fitting and
    // surface a compaction turn-error without ever calling the provider,
    // which the two assertions above cannot tell apart from doing nothing.
    expect(events.find((e) => e.type === 'turn-error')).toBeUndefined();
  });

  it('compacts in FULL exactly at the threshold (850/1000) — the whole conversation is the distillation input', async () => {
    const adapter = new ScriptedAdapter([textResponse('SUMMARY')]);
    const restored = restoredOfSize(850);
    const expectedInput: ChatMessage[] = [...restored, { role: 'user', content: 'DISTILL_PROMPT' }];
    const { deps, events } = makeDeps({
      adapter,
      compaction: { auto: true, contextWindowTokens: WINDOW },
      restoredConversation: restored,
    });
    const loop = new AgentLoop(deps);

    await loop.compactAtRestoreBoundaryIfNeeded();

    expect(events.find((e) => e.type === 'context-compacted')).toMatchObject({
      source: 'auto',
      summary: 'SUMMARY',
    });
    // Full, not partial: every restored message reached the distillation, and
    // the summary carries no partial caveat.
    expect(adapter.capturedMessages[0]).toEqual(expectedInput);
  });

  it('still compacts in FULL exactly at the full-distill ceiling (900/1000) — the comparison is <=, not <', async () => {
    const adapter = new ScriptedAdapter([textResponse('SUMMARY')]);
    const restored = restoredOfSize(900);
    const expectedInput: ChatMessage[] = [...restored, { role: 'user', content: 'DISTILL_PROMPT' }];
    const { deps, events } = makeDeps({
      adapter,
      compaction: { auto: true, contextWindowTokens: WINDOW },
      restoredConversation: restored,
    });
    const loop = new AgentLoop(deps);

    await loop.compactAtRestoreBoundaryIfNeeded();

    expect(events.find((e) => e.type === 'context-compacted')).toMatchObject({ source: 'auto' });
    expect(adapter.capturedMessages[0]).toEqual(expectedInput);
    const compacted = events.find((e) => e.type === 'context-compacted');
    expect(compacted && 'summary' in compacted ? compacted.summary : undefined).toBe('SUMMARY');
  });

  it('distills PARTIALLY above the full-distill ceiling (950/1000): a strict tail suffix within the 0.7 budget, and a caveat inside the summary', async () => {
    // 40 + 1200 + 1200 + 1000 = 3440 chars => 860 tokens... deliberately
    // sized below so the numbers are stated rather than implied:
    //   system 400 + A 1200 + B 1200 + C 1000 = 3800 chars => 950 tokens
    // Budget is floor(0.7 * 1000) = 700 tokens = 2800 chars for the ASSEMBLED
    // request (system + suffix + the 14-char DISTILL_PROMPT):
    //   from C:      400 + 1000 + 14 = 1414 chars =>  354 tokens  (fits)
    //   from B:      400 + 2200 + 14 = 2614 chars =>  654 tokens  (fits)
    //   from A:      400 + 3400 + 14 = 3814 chars =>  954 tokens  (does not)
    // so the largest fitting suffix starts at B.
    const restored: ChatMessage[] = [
      { role: 'system', content: 'S'.repeat(400) },
      { role: 'user', content: 'A'.repeat(1200) },
      { role: 'assistant', content: 'B'.repeat(1200) },
      { role: 'user', content: 'C'.repeat(1000) },
    ];
    const expectedInput: ChatMessage[] = [
      restored[0],
      restored[2],
      restored[3],
      { role: 'user', content: 'DISTILL_PROMPT' },
    ];
    const adapter = new ScriptedAdapter([textResponse('PARTIAL_SUMMARY')]);
    const { deps, events } = makeDeps({
      adapter,
      compaction: { auto: true, contextWindowTokens: WINDOW },
      restoredConversation: restored,
    });
    const loop = new AgentLoop(deps);

    await loop.compactAtRestoreBoundaryIfNeeded();

    expect(adapter.capturedMessages[0]).toEqual(expectedInput);

    const compacted = events.find((e) => e.type === 'context-compacted');
    expect(compacted).toBeDefined();
    const summary = compacted && 'summary' in compacted ? compacted.summary : undefined;
    // The caveat rides INSIDE the summary string -- that is what makes it
    // survive into the persisted event, and therefore into a later restore
    // that reseeds through the ordinary (non-partial) seed wording.
    expect(summary).toBe(
      '[Earlier messages exceeded the context window and are not covered by this summary.] PARTIAL_SUMMARY',
    );
    // ...and the summary the model sees is the same string, via the unchanged
    // single-writer seed builder.
    await loop.runTurn('t1', 'after');
    const postCompactionRequest = adapter.capturedMessages[1];
    expect(postCompactionRequest).toHaveLength(3);
    expect(postCompactionRequest[1].content).toContain(
      '[Earlier messages exceeded the context window and are not covered by this summary.]',
    );
  });

  it('does NOTHING when the worker auto toggle is OFF, however large the restored conversation', async () => {
    const adapter = new ScriptedAdapter([textResponse('SUMMARY')]);
    const { deps, events } = makeDeps({
      adapter,
      compaction: { auto: false, contextWindowTokens: WINDOW },
      restoredConversation: restoredOfSize(9_999),
    });
    const loop = new AgentLoop(deps);

    await loop.compactAtRestoreBoundaryIfNeeded();

    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();
    expect(adapter.calls).toBe(0);
    // Nothing was ATTEMPTED either: a path that skipped the window/toggle gate
    // and fell through to the partial branch would find nothing fitting and
    // surface a compaction turn-error without ever calling the provider,
    // which the two assertions above cannot tell apart from doing nothing.
    expect(events.find((e) => e.type === 'turn-error')).toBeUndefined();
  });

  it('does NOTHING for a loop that was NOT restored — a fresh conversation is the vacuous case, not a small one', async () => {
    // A fresh loop's conversation is one system message; its estimate is
    // meaningless as a window ratio. The systemPrompt here is deliberately
    // far over the window, so only the restored-or-not gate can explain a
    // pass.
    const adapter = new ScriptedAdapter([textResponse('SUMMARY')]);
    const { deps, events } = makeDeps({
      adapter,
      systemPrompt: 'S'.repeat(40_000),
      compaction: { auto: true, contextWindowTokens: WINDOW },
    });
    const loop = new AgentLoop(deps);

    await loop.compactAtRestoreBoundaryIfNeeded();

    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();
    expect(adapter.calls).toBe(0);
    // Nothing was ATTEMPTED either: a path that skipped the window/toggle gate
    // and fell through to the partial branch would find nothing fitting and
    // surface a compaction turn-error without ever calling the provider,
    // which the two assertions above cannot tell apart from doing nothing.
    expect(events.find((e) => e.type === 'turn-error')).toBeUndefined();
  });

  it('publishes the restored conversation size as a context-usage reading before any turn has run', async () => {
    const adapter = new ScriptedAdapter([textResponse('SUMMARY')]);
    const { deps, events } = makeDeps({
      adapter,
      compaction: { auto: true, contextWindowTokens: WINDOW },
      restoredConversation: restoredOfSize(400),
    });
    const loop = new AgentLoop(deps);

    await loop.compactAtRestoreBoundaryIfNeeded();

    expect(events.find((e) => e.type === 'context-usage')).toMatchObject({
      promptTokens: 400,
      estimated: true,
    });
  });
});

describe('Compaction at the restore boundary — when nothing fits the distillation budget', () => {
  it('names the cause specifically and preserves the conversation (polarity: a subsequent turn sees the untouched array)', async () => {
    // A 100-token window against a system prompt alone larger than the 70-token
    // budget: no suffix, however short, can fit. The failure must be the same
    // preserve-on-failure every other compaction failure already uses.
    const restored: ChatMessage[] = [
      { role: 'system', content: 'S'.repeat(1200) },
      { role: 'user', content: 'U'.repeat(400) },
    ];
    const expectedNextTurnRequest: ChatMessage[] = [...restored, { role: 'user', content: 'next' }];
    const adapter = new ScriptedAdapter([textResponse('reply after failure')]);
    const { deps, events } = makeDeps({
      adapter,
      compaction: { auto: true, contextWindowTokens: 100 },
      restoredConversation: restored,
    });
    const loop = new AgentLoop(deps);

    await loop.compactAtRestoreBoundaryIfNeeded();

    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();
    const turnError = events.find((e) => e.type === 'turn-error');
    expect(turnError).toBeDefined();
    expect(turnError && 'message' in turnError ? turnError.message : '').toBe(
      'Context compaction failed: restore-boundary compaction skipped: conversation exceeds the distillation input budget',
    );
    // No provider call was made at all -- the request was never assembled.
    expect(adapter.calls).toBe(0);

    // Preserve-on-failure: the next turn sees exactly the pre-compaction array.
    await loop.runTurn('t1', 'next');
    expect(adapter.capturedMessages[0]).toEqual(expectedNextTurnRequest);
  });
});

describe('selectPartialDistillationMessages — suffix selection rules', () => {
  const PROMPT: ChatMessage = { role: 'user', content: 'P'.repeat(40) }; // 10 tokens

  it('returns the LARGEST tail suffix that fits, keeping the system head', () => {
    const conversation: ChatMessage[] = [
      { role: 'system', content: 'S'.repeat(40) },   // 10 tokens
      { role: 'user', content: 'A'.repeat(400) },    // 100 tokens
      { role: 'assistant', content: 'B'.repeat(400) }, // 100 tokens
      { role: 'user', content: 'C'.repeat(400) },    // 100 tokens
    ];
    // head 10 + prompt 10 = 20; budget 220 admits two 100-token messages.
    expect(selectPartialDistillationMessages(conversation, PROMPT, 220)).toEqual([
      conversation[0],
      conversation[2],
      conversation[3],
      PROMPT,
    ]);
  });

  it('never starts a suffix at a tool message — it skips past to the owning assistant message', () => {
    // Starting at the tool message would hand the provider a tool result whose
    // owning assistant `tool_calls` entry is not in the request: the exact
    // structural violation mid-turn repair exists to prevent.
    const conversation: ChatMessage[] = [
      { role: 'system', content: 'S'.repeat(40) },
      { role: 'user', content: 'A'.repeat(400) },
      {
        role: 'assistant',
        content: 'B'.repeat(400),
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'R'.repeat(400) },
    ];
    // A budget of 120 would admit the tool message alone (10 + 100 + 10), but
    // that start is not selectable; the next selectable start (the assistant)
    // costs 220 and does not fit, so nothing is returned.
    expect(selectPartialDistillationMessages(conversation, PROMPT, 120)).toBeNull();
    // Widened to 220, the selection lands on the assistant, carrying its tool
    // result with it.
    expect(selectPartialDistillationMessages(conversation, PROMPT, 220)).toEqual([
      conversation[0],
      conversation[2],
      conversation[3],
      PROMPT,
    ]);
  });

  it('returns null when not even the shortest suffix fits alongside the system head', () => {
    const conversation: ChatMessage[] = [
      { role: 'system', content: 'S'.repeat(4000) },
      { role: 'user', content: 'A'.repeat(40) },
    ];
    expect(selectPartialDistillationMessages(conversation, PROMPT, 100)).toBeNull();
  });

  it('can select the whole conversation when it fits, without duplicating the system head', () => {
    const conversation: ChatMessage[] = [
      { role: 'system', content: 'S'.repeat(40) },
      { role: 'user', content: 'A'.repeat(40) },
    ];
    expect(selectPartialDistillationMessages(conversation, PROMPT, 10_000)).toEqual([
      conversation[0],
      conversation[1],
      PROMPT,
    ]);
  });
});
