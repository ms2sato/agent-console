/**
 * Signal 1 of window-declaration drift: when a provider rejects an over-window
 * request AND names its real cap, the `turn-error` the loop already emits says
 * so, naming both numbers.
 *
 * The carrier is deliberately an existing event's prose. `turn-error.message`
 * is display-only -- no layer parses it back -- which is what makes weaving a
 * sentence into it legitimate rather than a new string contract.
 *
 * **The cases are mostly about the annotation NOT appearing**, and that is the
 * design: this text tells an operator their configuration is wrong, so a false
 * one sends someone to edit a value that was correct. Every gate fails toward
 * silence.
 *
 * A consequence worth naming rather than discovering later: a SUCCESSFUL escape
 * emits no `turn-error`, so drift that the mid-turn compaction absorbs is not
 * reported here at all. That is what choosing an existing carrier costs; the
 * measured-reading signal on `context-usage` is what covers the quiet path.
 *
 * Measured reach, recorded by WHICH test failed (standing rule). Mutations
 * applied to `agent-loop.ts` / `context-overflow.ts` and this file re-run:
 *
 *   m-s1-1  report both directions (`declared <= stated` -> `declared ===
 *           stated`)
 *           -> 1 fail, alone: 'an UNDER-declared window is not reported'. That
 *              case is the only thing holding the asymmetry; nothing else in
 *              either file notices if the benign direction starts alarming
 *              operators.
 *   m-s1-2  annotate from a loose search of the message, without consulting
 *           the classifier
 *           -> 2 fail: 'no capture pattern changes nothing' and 'an error that
 *              is not a classified overflow is never annotated'.
 *
 *           Measured as 1 before the `unrelatedError` fixture was fixed. Its
 *           first wording -- borrowed from the sibling escape test -- was
 *           `temperature must be between 0 and 2`, which contains no number a
 *           loose search could find, so the mutation produced no annotation
 *           there and the assertion held for a reason unrelated to the gate it
 *           names. The fixture now carries a large number in prose while still
 *           matching no signature, which is what makes it a statement about
 *           the classifier gate.
 *   m-s1-3  absent `contextWindowTokens` read as unlimited
 *           (`?? Number.MAX_SAFE_INTEGER`)
 *           -> 1 fail, alone: 'no declared window means nothing to
 *              contradict'.
 *           Reading it as `?? 0` instead kills NOTHING, and that is correct
 *           rather than a gap: zero is below every stated limit, so it is an
 *           equivalent implementation of the same silence, not a defect the
 *           pin failed to see.
 */
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

type ScriptedResponse = { kind: 'events'; events: ProviderEvent[] } | { kind: 'throw'; error: unknown };

class ScriptedAdapter implements ProviderAdapter {
  calls = 0;
  constructor(private readonly script: ScriptedResponse[]) {}
  async *run(_req: ProviderRunRequest): AsyncIterable<ProviderEvent> {
    const idx = this.calls;
    this.calls++;
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

/** The provider's real cap, as named inside the measured rejection below. */
const PROVIDER_STATED_LIMIT = 983_616;

/** Measured 2026-08-29, opencode zen go/v1, `qwen3.8-flash`. */
const overflowNamingItsLimit = (): ProviderError =>
  new ProviderError('provider responded with HTTP 400: Range of input length should be [1, 983616]', {
    retryable: false,
    status: 400,
    detail: { message: 'Range of input length should be [1, 983616]', type: 'invalid_parameter_error' },
  });

/** A classified overflow whose signature carries NO measured capture pattern. */
const overflowNamingNothing = (): ProviderError =>
  new ProviderError('provider responded with HTTP 400: context length exceeded', {
    retryable: false,
    status: 400,
    detail: { message: "This model's maximum context length is 983616 tokens.", code: 'context_length_exceeded' },
  });

/**
 * Same status and family, not an overflow -- and deliberately carrying a large
 * number in its prose.
 *
 * The sibling escape test's version of this fixture reads `temperature must be
 * between 0 and 2`, which has no number a loose search could find. Measured:
 * against a mutation that annotates WITHOUT consulting the classifier, that
 * wording passes, because there is nothing to extract either way. The
 * assertion would have been true for a reason unrelated to the gate it names.
 */
const unrelatedError = (): ProviderError =>
  new ProviderError('provider responded with HTTP 400: Value of max_tokens must be between 1 and 983616', {
    retryable: false,
    status: 400,
    detail: { message: 'Value of max_tokens must be between 1 and 983616', type: 'invalid_parameter_error' },
  });

/** Fails the escape's distillation, so the ORIGINAL overflow reaches turn-error. */
const distillationFailure = (): ProviderError =>
  new ProviderError('provider responded with HTTP 503: upstream unavailable', {
    retryable: false,
    status: 503,
    detail: { message: 'upstream unavailable', type: 'server_error' },
  });

/**
 * One turn whose provider call fails with `first`, and whose escape then fails
 * too -- the shape that lets the ORIGINAL error reach `turn-error`, which is
 * where signal 1 writes.
 */
function runWith(
  first: ProviderError,
  contextWindowTokens: number | undefined,
): Promise<EmbeddedAgentEvent[]> {
  const events: EmbeddedAgentEvent[] = [];
  const adapter = new ScriptedAdapter([
    { kind: 'throw', error: first },
    { kind: 'throw', error: distillationFailure() },
  ]);
  const deps: AgentLoopDeps = {
    model: 'm',
    tools: [],
    executor: new StubExecutor(),
    emit: (event) => events.push(event),
    systemPrompt: 'SYS',
    maxToolIterations: 25,
    sleep: async () => {},
    reassembleSystemPrompt: async () => 'SYS',
    loadCompactionPrompt: async () => 'DISTILL_PROMPT',
    adapter,
    compaction: { auto: false, contextWindowTokens },
  };
  const loop = new AgentLoop(deps);
  return loop.runTurn('t1', 'a question').then(() => events);
}

/** The turn's single `turn-error` message, asserting there is exactly one. */
const turnErrorMessage = (events: EmbeddedAgentEvent[]): string => {
  const errors = events.filter((e): e is Extract<EmbeddedAgentEvent, { type: 'turn-error' }> => e.type === 'turn-error');
  expect(errors).toHaveLength(1);
  return errors[0].message;
};

describe('signal 1: the turn-error states the declared-vs-stated contradiction', () => {
  it('an over-declared window is reported, naming both numbers', async () => {
    const declared = 1_000_000;
    const message = turnErrorMessage(await runWith(overflowNamingItsLimit(), declared));

    // Both operands, formatted as the operator sees them.
    expect(message).toContain(declared.toLocaleString('en-US'));
    expect(message).toContain(PROVIDER_STATED_LIMIT.toLocaleString('en-US'));
    // The provider's own message survives ahead of the annotation: the
    // contradiction is added to the error, never substituted for it.
    expect(message).toContain('Range of input length should be [1, 983616]');
  });

  it('an UNDER-declared window is not reported, though the same number is extracted', async () => {
    // The asymmetry, pinned. Under-declaration compacts early: it costs
    // fidelity and wedges nothing. Reporting it would spend the operator's
    // attention on the harmless direction, and this is the only case that
    // notices if that judgment is ever dropped from the code.
    const message = turnErrorMessage(await runWith(overflowNamingItsLimit(), 12_000));

    expect(message).toBe('provider responded with HTTP 400: Range of input length should be [1, 983616]');
  });

  it('a classified overflow whose signature has no capture pattern changes nothing', async () => {
    // Fail-toward-nothing, end to end: the verdict fires (an escape is
    // attempted), no number is extracted, and the message is untouched even
    // though the prose visibly contains one.
    const message = turnErrorMessage(await runWith(overflowNamingNothing(), 1_000_000));

    expect(message).toBe('provider responded with HTTP 400: context length exceeded');
    expect(message).not.toContain('1,000,000');
  });

  it('no declared window means nothing to contradict', async () => {
    const message = turnErrorMessage(await runWith(overflowNamingItsLimit(), undefined));

    expect(message).toBe('provider responded with HTTP 400: Range of input length should be [1, 983616]');
  });

  it('an error that is not a classified overflow is never annotated', async () => {
    // The extraction is gated on the verdict, so an unrelated fault carrying a
    // number in its prose cannot acquire a drift claim.
    const message = turnErrorMessage(await runWith(unrelatedError(), 1_000_000));

    expect(message).toBe('provider responded with HTTP 400: Value of max_tokens must be between 1 and 983616');
  });
});

describe('signal 3: an absorbed overflow carries the stated limit on its boundary marker', () => {
  /*
   * The path signal 1 structurally cannot reach. A SUCCESSFUL escape emits no
   * `turn-error` at all, so without this the drift a working escape absorbs
   * would go unreported every time -- and the better the escape works, the
   * more reliably it would be absorbed. That is the whole reason this carrier
   * exists.
   *
   * Measured reach, recorded by WHICH test failed (standing rule):
   *
   *   m-s3-1  drop `providerStatedWindowTokens` from the `context-compacted`
   *           emit
   *           -> 1 fail, alone: 'the boundary marker carries the number the
   *              provider stated'.
   *   m-s3-2  pass the limit unconditionally from the turn-boundary caller
   *           too (`compact()`'s distillation)
   *           -> 1 fail, alone: 'an ordinary turn-boundary compaction carries
   *              no stated limit'. That case is the only thing separating
   *              "the escape observed a rejection" from "a compaction
   *              happened".
   */
  const runEscape = async (first: ProviderError): Promise<EmbeddedAgentEvent[]> => {
    const events: EmbeddedAgentEvent[] = [];
    // Overflow, then a successful distillation, then a successful retry --
    // the shape where no turn-error is emitted at all.
    const adapter = new ScriptedAdapter([
      { kind: 'throw', error: first },
      { kind: 'events', events: [{ type: 'text-delta', text: 'SUMMARY' }, { type: 'done', finishReason: 'stop' }] },
      { kind: 'events', events: [{ type: 'text-delta', text: 'the answer' }, { type: 'done', finishReason: 'stop' }] },
    ]);
    const deps: AgentLoopDeps = {
      model: 'm',
      tools: [],
      executor: new StubExecutor(),
      emit: (event) => events.push(event),
      systemPrompt: 'SYS',
      maxToolIterations: 25,
      sleep: async () => {},
      reassembleSystemPrompt: async () => 'SYS',
      loadCompactionPrompt: async () => 'DISTILL_PROMPT',
      adapter,
      compaction: { auto: false, contextWindowTokens: 1_000_000 },
    };
    await new AgentLoop(deps).runTurn('t1', 'a question');
    return events;
  };

  /** The boundary markers emitted during the run, narrowed to their member. */
  const compacted = (events: EmbeddedAgentEvent[]) =>
    events.filter((e): e is Extract<EmbeddedAgentEvent, { type: 'context-compacted' }> => e.type === 'context-compacted');

  it('the boundary marker carries the number the provider stated, and the turn reports no error', async () => {
    const events = await runEscape(overflowNamingItsLimit());

    // The precondition that makes this carrier necessary: nothing else in
    // this turn says anything to the user about the drift.
    expect(events.filter((e) => e.type === 'turn-error')).toHaveLength(0);

    const markers = compacted(events);
    expect(markers).toHaveLength(1);
    expect(markers[0].providerStatedWindowTokens).toBe(PROVIDER_STATED_LIMIT);
  });

  it('an overflow whose signature yields no number leaves the marker unannotated', async () => {
    // Fail-toward-nothing on this carrier too: the escape still fires, the
    // compaction still happens, and the marker simply says nothing extra.
    const events = await runEscape(overflowNamingNothing());

    const markers = compacted(events);
    expect(markers).toHaveLength(1);
    expect(markers[0].providerStatedWindowTokens).toBeUndefined();
  });

  it('an ordinary turn-boundary compaction carries no stated limit', async () => {
    // No rejection behind it, so there is nothing a provider stated. This is
    // what keeps the field meaning "a provider said this" rather than
    // "a compaction occurred".
    const events: EmbeddedAgentEvent[] = [];
    const adapter = new ScriptedAdapter([
      { kind: 'events', events: [{ type: 'text-delta', text: 'SUMMARY' }, { type: 'done', finishReason: 'stop' }] },
    ]);
    const deps: AgentLoopDeps = {
      model: 'm',
      tools: [],
      executor: new StubExecutor(),
      emit: (event) => events.push(event),
      systemPrompt: 'SYS',
      maxToolIterations: 25,
      sleep: async () => {},
      reassembleSystemPrompt: async () => 'SYS',
      loadCompactionPrompt: async () => 'DISTILL_PROMPT',
      adapter,
      compaction: { auto: false, contextWindowTokens: 1_000_000 },
    };
    await new AgentLoop(deps).compact('manual');

    const markers = compacted(events);
    expect(markers).toHaveLength(1);
    expect(markers[0].providerStatedWindowTokens).toBeUndefined();
  });
});

describe('signal 2: a clamped reading reaches the emitted context-usage event', () => {
  /*
   * THE CASE THIS PR SHIPPED WITHOUT, and the reason it is written at the loop
   * rather than at the predicate: `window-drift.test.ts` measured that the
   * predicate answers correctly, and could not notice that nothing called it.
   * Detection existed, the field existed, the client rendered it, its reach
   * was measured by mutation, and the browser showed it -- because the QA stub
   * injected the flag, standing in for exactly the missing wiring. Every
   * instrument pointed at the predicate; none pointed at the call.
   *
   * So these assert the EMITTED EVENT. A unit test proves a condition is
   * right; only this shape proves the condition is used.
   *
   *   m-s2-1  never evaluate the detector at the usage site
   *           -> 1 fail, alone: 'the emitted event carries the flag'. This is
   *              the mutation that reproduces the shipped defect exactly.
   *   m-s2-2  set the flag unconditionally on every measured reading
   *           -> 1 fail, alone: 'an ordinary reading emits no flag'.
   */
  const usageEvents = (events: EmbeddedAgentEvent[]) =>
    events.filter((e): e is Extract<EmbeddedAgentEvent, { type: 'context-usage' }> => e.type === 'context-usage');

  /**
   * One turn, one provider reply, whose reported prompt tokens the caller
   * chooses. `question` sizes the request: the predicate needs our own
   * estimate of what was sent to exceed the provider's number.
   */
  const runTurnReporting = async (
    promptTokens: number,
    question: string,
    contextWindowTokens: number | undefined,
  ): Promise<EmbeddedAgentEvent[]> => {
    const events: EmbeddedAgentEvent[] = [];
    const adapter = new ScriptedAdapter([
      {
        kind: 'events',
        events: [
          { type: 'text-delta', text: 'ok' },
          {
            type: 'done',
            finishReason: 'stop',
            usage: { promptTokens, completionTokens: 1, totalTokens: promptTokens + 1 },
          },
        ],
      },
    ]);
    const deps: AgentLoopDeps = {
      model: 'm',
      tools: [],
      executor: new StubExecutor(),
      emit: (event) => events.push(event),
      systemPrompt: 'SYS',
      maxToolIterations: 25,
      sleep: async () => {},
      reassembleSystemPrompt: async () => 'SYS',
      loadCompactionPrompt: async () => 'DISTILL_PROMPT',
      adapter,
      compaction: { auto: false, contextWindowTokens },
    };
    await new AgentLoop(deps).runTurn('t1', question);
    return events;
  };

  // Four chars per estimated token, so this is worth ~50,000 to the estimator
  // -- comfortably above the 4,096-aligned reading below it, which is what the
  // predicate's fourth condition requires.
  const LARGE_QUESTION = 'x'.repeat(200_000);

  it('the emitted event carries the flag when the reading bears the marks of a clamp', async () => {
    const events = await runTurnReporting(8_192, LARGE_QUESTION, 1_000_000);

    const usage = usageEvents(events);
    expect(usage.length).toBeGreaterThan(0);
    expect(usage[usage.length - 1].appearsClamped).toBe(true);
  });

  it('an ordinary reading emits no flag', async () => {
    // Same shape, a reading that is not 4,096-aligned. The negative half: with
    // the flag set unconditionally, the case above passes in both worlds.
    const events = await runTurnReporting(8_190, LARGE_QUESTION, 1_000_000);

    const usage = usageEvents(events);
    expect(usage.length).toBeGreaterThan(0);
    expect(usage[usage.length - 1].appearsClamped).toBeUndefined();
  });

  it('no declared window means no flag, even on a reading that otherwise fits', async () => {
    const events = await runTurnReporting(8_192, LARGE_QUESTION, undefined);

    const usage = usageEvents(events);
    expect(usage.length).toBeGreaterThan(0);
    expect(usage[usage.length - 1].appearsClamped).toBeUndefined();
  });
});
