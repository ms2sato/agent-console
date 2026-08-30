/**
 * The mid-turn context-overflow escape: a classified over-window response
 * forces one partial compaction inside the live turn and retries the provider
 * call exactly once.
 *
 * The five paths below are the AC's verification set. What ties them together
 * is a single asymmetry: **not escaping is always safe, escaping wrongly is
 * not.** Four of the five are therefore about the escape NOT firing, or firing
 * and then getting out of the way.
 *
 * Measured reach, recorded by WHICH test failed (standing rule). Mutations
 * applied to `agent-loop.ts` and this file re-run:
 *
 *   e1  drop the `!escapeUsed` guard (allow unlimited escapes)
 *       -> 1 fail, alone: 'a second overflow after the escape ends the turn'.
 *          Without it that case loops compact/retry/overflow rather than
 *          ending -- the crash-loop the guard exists for, arriving through a
 *          door `runProviderWithRetries`' own retry bound does not watch,
 *          because a non-retryable 400 returns without burning its attempts.
 *       Measured only after this test was REBUILT. The first version scripted
 *       the provider to end on an overflow, and the script's last entry
 *       repeats -- so every later distillation failed too, and a guardless
 *       implementation also landed on one compaction and one turn-error. The
 *       assertion could not tell the two worlds apart and the mutation killed
 *       nothing. The script now lets the distillation keep succeeding, which
 *       is what makes "exactly one compaction" a statement about the guard.
 *   e2  the escape emits its own `turn-error` when the distillation fails
 *       -> 2 fail: 'a failed escape emits exactly one turn-error' and the
 *          cancel case. The count is the whole assertion; both worlds emit at
 *          least one, so only counting distinguishes them.
 *   e3  ignore the classifier (escape on any provider error)
 *       -> 1 fail, alone: 'an unclassified provider error is untouched'.
 *          This is the false-positive direction, and only this case sees it.
 *
 *   e5  remove the `contextWindowTokens === undefined` guard
 *       -> 1 fail, alone: 'is inert when no context window is declared'.
 *
 *       This one first measured as ZERO, and the zero was false. The string
 *       `if (windowTokens === undefined) return false;` occurs TWICE in this
 *       file, and a replace-first-occurrence mutation was removing the other
 *       one -- in a different method entirely. The harness asserted that the
 *       source changed, which was true, and said nothing about WHERE.
 *
 *       Confirming a mutation applied is not confirming it applied to the
 *       site under test. When a mutation reports zero reach, suspect the
 *       mutation before the pin: locate the target by its enclosing function,
 *       not by a string that may not be unique.
 *
 *   r1  fire the escape from inside the tool loop, so the marker lands
 *       BETWEEN a `tool_call` and its `tool-result`
 *       -> 1 fail, alone: 'the transcript the escape writes is replayable'.
 *
 *       The first attempt at this mutation measured ZERO, and was wrong: it
 *       emitted the orphaned `tool-call` before the marker, so the replay
 *       window simply cut it out. The shape that matters is call BEFORE the
 *       marker and result AFTER it -- which is what the wrong placement
 *       actually persists. A mutation has to reproduce the defect, not merely
 *       perturb the code near it.
 *
 *   e6  fold `'canceled'` back into `'failed'` at the call site, so a cancel
 *       during the escape is reported as an error ending (the shape this PR
 *       shipped before review)
 *       -> 1 fail, alone: 'a cancel during the escape issues NO provider
 *          request after it'. It fails as **4 provider calls instead of 3** --
 *          the fourth being `compact('manual')`, fired because
 *          `settleCompactionAtTurnBoundary` discards a booked reservation
 *          only on 'canceled'. That is the billed request, observed rather
 *          than argued.
 *
 *          The pin is deliberately on the CONSEQUENCE, not the ending label.
 *          The label is a proxy: assert it alone and the test stays green if
 *          the boundary's ordering ever changes while the same request still
 *          goes out.
 *
 * Measurement note: match the failure marker anywhere in the line, not at
 * line start; confirm the mutation applied to the SITE UNDER TEST (a string
 * may not be unique -- see e5); and confirm it reproduces the defect's shape
 * rather than something adjacent (see r1). Each of those three produced a
 * false zero in this PR.
 */
import { describe, it, expect } from 'bun:test';
import type { EmbeddedAgentEvent } from '@agent-console/shared';
import { AgentLoop, type AgentLoopDeps } from '../agent-loop.js';
import { reconstructConversation } from '../restore.js';
import { COMPACT_TOOL_NAME } from '../compact-tool.js';
import type { ToolCallOutcome, ToolExecutor } from '../mcp.js';
import {
  ProviderError,
  type ChatMessage,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderRunRequest,
} from '../providers/types.js';

type ScriptedResponse = { kind: 'events'; events: ProviderEvent[] } | { kind: 'throw'; error: unknown };

class ScriptedAdapter implements ProviderAdapter {
  calls = 0;
  capturedMessages: ChatMessage[][] = [];
  constructor(private readonly script: ScriptedResponse[]) {}
  async *run(req: ProviderRunRequest): AsyncIterable<ProviderEvent> {
    const idx = this.calls;
    this.calls++;
    this.capturedMessages.push([...req.messages]);
    const resp = this.script[Math.min(idx, this.script.length - 1)];
    if (resp.kind === 'throw') throw resp.error;
    for (const event of resp.events) yield event;
  }
}

class StubExecutor implements ToolExecutor {
  async listTools() {
    return [];
  }
  async callTool(): Promise<ToolCallOutcome> {
    return { ok: true, result: '' };
  }
}

const textResponse = (text: string): ScriptedResponse => ({
  kind: 'events',
  events: [{ type: 'text-delta', text }, { type: 'done', finishReason: 'stop' }],
});

/** The measured qwen3.8-flash overflow: HTTP 400, generic type, length message. */
const overflowError = (): ProviderError =>
  new ProviderError('provider responded with HTTP 400: Range of input length should be [1, 983616]', {
    retryable: false,
    status: 400,
    detail: { message: 'Range of input length should be [1, 983616]', type: 'invalid_parameter_error' },
  });

/** Same shape, same status, NOT an overflow -- the false-positive hazard. */
const unrelatedError = (): ProviderError =>
  new ProviderError('provider responded with HTTP 400: Value of temperature must be between 0 and 2', {
    retryable: false,
    status: 400,
    detail: { message: 'Value of temperature must be between 0 and 2', type: 'invalid_parameter_error' },
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
    compaction: { auto: false, contextWindowTokens: 12_000 },
    ...overrides,
  };
  return { deps, events };
}

const typesOf = (events: EmbeddedAgentEvent[]): string[] => events.map((e) => e.type);
const countOf = (events: EmbeddedAgentEvent[], type: string): number =>
  events.filter((e) => e.type === type).length;

describe('mid-turn context-overflow escape', () => {
  it('a classified overflow forces one compaction and the retry succeeds, with no turn-error at all', async () => {
    // The whole point of placing the escape before the turn's ending is
    // decided: a successful escape is INVISIBLE. The user sees a normal turn.
    const adapter = new ScriptedAdapter([
      { kind: 'throw', error: overflowError() }, // the turn's provider call overflows
      textResponse('DISTILLED SUMMARY'), //          the distillation
      textResponse('the real answer'), //            the single retry
    ]);
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'a question');

    expect(countOf(events, 'context-compacted')).toBe(1);
    expect(countOf(events, 'turn-error')).toBe(0);
    expect(typesOf(events)).toContain('assistant-message');
    // The retry re-read the spliced conversation rather than the old one.
    const retryMessages = adapter.capturedMessages[2];
    expect(retryMessages.some((m) => String(m.content).includes('DISTILLED SUMMARY'))).toBe(true);
  });

  it('an unclassified provider error is untouched: no compaction, and the turn ends exactly as it does today', async () => {
    // The false-positive direction. Same status, same generic type, different
    // message -- a real provider fault must not become a compaction.
    const adapter = new ScriptedAdapter([{ kind: 'throw', error: unrelatedError() }]);
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'a question');

    expect(countOf(events, 'context-compacted')).toBe(0);
    expect(countOf(events, 'turn-error')).toBe(1);
    // Exactly one provider call: nothing was retried.
    expect(adapter.calls).toBe(1);
  });

  it('a second overflow after the escape ends the turn, rather than compacting again', async () => {
    // The crash-loop guard. `runProviderWithRetries` returns immediately on a
    // non-retryable 400 without burning its attempts, so the escape's retry is
    // an independent second mechanism that the existing bound does not cover.
    // The script must let the distillation KEEP succeeding while the provider
    // keeps overflowing. With a script that ends on an overflow, the repeat
    // makes every subsequent distillation fail too, so a guardless
    // implementation also lands on one compaction and one turn-error -- the
    // assertion cannot tell the two apart. Measured: the earlier script left
    // this test green with the guard removed.
    const adapter = new ScriptedAdapter([
      { kind: 'throw', error: overflowError() }, // first overflow
      textResponse('DISTILLED SUMMARY'), //          distillation succeeds
      { kind: 'throw', error: overflowError() }, // retry still overflows
      textResponse('DISTILLED AGAIN'), //            a guardless loop would take this
      { kind: 'throw', error: overflowError() }, // ...and this, and so on
      textResponse('AND AGAIN'),
    ]);
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'a question');

    // EXACTLY one. Without the guard the loop compacts on every iteration
    // until `maxToolIterations` runs out -- the crash-loop shape.
    expect(countOf(events, 'context-compacted')).toBe(1);
    expect(countOf(events, 'turn-error')).toBe(1);
  });

  it('a failed escape emits exactly one turn-error -- the original overflow, not a second one', async () => {
    // Condition 5. The count is the assertion: a turn emits one turn-error,
    // never two, so the distillation's own failure must not surface.
    const adapter = new ScriptedAdapter([
      { kind: 'throw', error: overflowError() }, // the overflow
      { kind: 'throw', error: new Error('distillation is down') }, // 3 attempts
      { kind: 'throw', error: new Error('distillation is down') },
      { kind: 'throw', error: new Error('distillation is down') },
    ]);
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'a question');

    expect(countOf(events, 'turn-error')).toBe(1);
    expect(countOf(events, 'context-compacted')).toBe(0);
    const turnError = events.find((e) => e.type === 'turn-error') as { message: string } | undefined;
    // The surviving error is the ORIGINAL overflow, not the distillation's.
    expect(turnError?.message ?? '').toContain('Range of input length');
  });

  it('a cancel during the escape is respected: the distillation stops and the turn ends canceled', async () => {
    // The corollary of the escape not owning a controller. It runs on the
    // turn's signal, so `cancel()` reaches it; an escape with its own
    // controller would also null `currentAbort` on the way out and leave the
    // turn uncancellable afterwards.
    let loop: AgentLoop | undefined;
    const adapter = new ScriptedAdapter([
      { kind: 'throw', error: overflowError() },
      // Cancel lands while the distillation request is in flight.
      {
        kind: 'events',
        events: [{ type: 'text-delta', text: 'partial distill' }, { type: 'done', finishReason: 'stop' }],
      },
    ]);
    const cancelling: ProviderAdapter = {
      async *run(req: ProviderRunRequest) {
        if (adapter.calls >= 1) loop?.cancel();
        yield* adapter.run(req);
      },
    };
    const { deps, events } = makeDeps({ adapter: cancelling });
    loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'a question');

    // Whatever else happened, the conversation was NOT replaced under a cancel.
    expect(countOf(events, 'context-compacted')).toBe(0);
    expect(countOf(events, 'turn-error')).toBe(1);
  });

  it('the transcript the escape writes is replayable: its marker is a valid restore boundary', () => {
    // The bridge the two restore-level pins cannot cross on their own.
    //
    // `restore.test.ts` proves what reconstruction does with a given
    // transcript, but it never runs `agent-loop`, so moving the escape's
    // firing point could not fail it. This test takes the events the loop
    // ACTUALLY emitted and replays them, which is what makes the placement
    // measurable rather than argued.
    const adapter = new ScriptedAdapter([
      { kind: 'throw', error: overflowError() },
      textResponse('DISTILLED SUMMARY'),
      textResponse('the real answer'),
    ]);
    const { deps, events } = makeDeps({ adapter });
    const loop = new AgentLoop(deps);

    return loop.runTurn('t1', 'a question').then(() => {
      const stream = events
        .filter((e) => e.type !== 'state' && e.type !== 'assistant-delta')
        .map((e) => JSON.stringify({ ...e, v: 1 }))
        .join('\n');

      // Reconstruction must SUCCEED. The marker landed at the top of an
      // iteration, where every issued tool_call already had its result, so
      // the post-boundary window is self-contained. An escape fired from
      // inside the tool loop would split a pair and throw here.
      const outcome = reconstructConversation(stream, 'SYS', false);
      expect(outcome.conversation.some((m) => String(m.content).includes('DISTILLED SUMMARY'))).toBe(true);
    });
  });

  it('a cancel during the escape issues NO provider request after it -- not merely the right ending label', async () => {
    // The consequence, pinned directly. The ending label is a PROXY for it:
    // `settleCompactionAtTurnBoundary` discards a `Compact` reservation only
    // on 'canceled', so an 'error' ending leaves it booked and the boundary
    // runs `compact('manual')` -- a provider request issued after the user
    // cancelled, and billed.
    //
    // Asserting the label alone would stay green if that ordering ever
    // changed while the same request still went out. Counting requests after
    // the cancel cannot.
    let loop: AgentLoop | undefined;
    let cancelledAtCall = -1;

    const script: ScriptedResponse[] = [
      // 1: the turn books a Compact reservation via the builtin tool.
      {
        kind: 'events',
        events: [
          { type: 'tool-call', callId: 'c1', name: COMPACT_TOOL_NAME, argsJson: '{}' },
          { type: 'done', finishReason: 'tool_calls' },
        ] as ProviderEvent[],
      },
      // 2: the next provider call overflows, so the escape fires.
      { kind: 'throw', error: overflowError() },
      // 3: the distillation -- cancelled while in flight.
      textResponse('NEVER LANDS'),
      // 4+: anything after this point is a request made AFTER the cancel.
      textResponse('THIS MUST NOT BE REQUESTED'),
    ];

    const inner = new ScriptedAdapter(script);
    const adapter: ProviderAdapter = {
      async *run(req: ProviderRunRequest) {
        // Cancel lands while the distillation (call #3) is in flight.
        if (inner.calls === 2) {
          cancelledAtCall = inner.calls;
          loop?.cancel();
        }
        yield* inner.run(req);
      },
    };

    const { deps, events } = makeDeps({ adapter });
    loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'a question');

    expect(cancelledAtCall).toBe(2);
    // THE ASSERTION. Three calls: the tool turn, the overflow, the cancelled
    // distillation. A fourth would be the post-cancel manual compaction.
    expect(inner.calls).toBe(3);
    expect(countOf(events, 'context-compacted')).toBe(0);
  });

  it('is inert when no context window is declared', async () => {
    // Boundary: with no `W` there is no budget to shrink toward, so the escape
    // cannot fire and behaviour is unchanged.
    const adapter = new ScriptedAdapter([{ kind: 'throw', error: overflowError() }]);
    const { deps, events } = makeDeps({ adapter, compaction: { auto: false } });
    const loop = new AgentLoop(deps);

    await loop.runTurn('t1', 'a question');

    expect(countOf(events, 'context-compacted')).toBe(0);
    expect(countOf(events, 'turn-error')).toBe(1);
    expect(adapter.calls).toBe(1);
  });
});
