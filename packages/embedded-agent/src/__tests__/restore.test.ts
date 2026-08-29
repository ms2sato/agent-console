import { describe, it, expect } from 'bun:test';
import type { EmbeddedAgentStreamEvent } from '@agent-console/shared';
import type { ChatMessage } from '../providers/types.js';
import { reconstructConversation, RestoreReconstructionError, RESTORE_REPAIR_REASON } from '../restore.js';

const SYSTEM_PROMPT = 'You are a helpful assistant.';

function linesOf(events: EmbeddedAgentStreamEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

/**
 * Every assistant message with `tool_calls` is answered by an IMMEDIATELY
 * -following contiguous run of `{role:'tool'}` messages -- before the next
 * assistant/user message. Stricter than "answered somewhere later in the
 * array": the OpenAI Chat Completions "response group" contract requires
 * every tool_call_id to be closed before the NEXT assistant message, not
 * merely at some later point.
 */
function toolCallsAnsweredImmediately(messages: ChatMessage[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !msg.tool_calls || msg.tool_calls.length === 0) continue;
    const expectedIds = new Set(msg.tool_calls.map((tc) => tc.id));
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'tool') {
      const toolMsg = messages[j] as Extract<ChatMessage, { role: 'tool' }>;
      expectedIds.delete(toolMsg.tool_call_id);
      j++;
    }
    if (expectedIds.size > 0) return false;
  }
  return true;
}

const SEED_PREFIX =
  'Summary of the earlier part of this conversation, which has been compacted away: ';

describe('reconstructConversation — 4c total classification', () => {
  it('reconstructs only the four Mapped event kinds, in order, and skips every Noise kind', () => {
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'ready' },
      { v: 1, type: 'state', state: 'active' },
      { v: 1, type: 'user-message', id: 'm1', text: 'hello' },
      { v: 1, type: 'assistant-delta', turnId: 't1', text: 'par' },
      { v: 1, type: 'assistant-thinking-delta', turnId: 't1', text: 'thinking' },
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'reply' },
      { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'run', args: { a: 1 } },
      { v: 1, type: 'tool-result', turnId: 't1', callId: 'c1', ok: true, result: 'done' },
      { v: 1, type: 'context-usage', promptTokens: 10, estimated: false },
      { v: 1, type: 'turn-error', turnId: 't1', message: 'unrelated noise' },
      { v: 1, type: 'fatal', message: 'unrelated noise' },
      { v: 1, type: 'sdk-session-id', sdkSessionId: 'sdk-sess-1' },
      { v: 1, type: 'state', state: 'idle' },
      { v: 1, type: 'exited', code: 0 },
    ];

    const outcome = reconstructConversation(linesOf(events), SYSTEM_PROMPT);

    expect(outcome.conversation).toEqual([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: 'reply',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run', arguments: '{"a":1}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'done' },
    ]);
    expect(outcome.repairedToolCallIds).toEqual([]);
  });
});

/**
 * REGRESSION LOCK (#1401): `context-handoff` is retired as an EMISSION but
 * retained everywhere a persisted stream is read. `restore.ts` is the third
 * consumer of the retired event -- easy to miss next to the client store's
 * entry kind and the view's render case, and the most damaging to lose: a
 * worker whose stream still carries a handoff marker would replay its entire
 * pre-handoff history on every activation, resurrecting exactly the context
 * the handoff discarded.
 *
 * The reseed text these tests assert is today's COMPACTION wording, not the
 * retired handoff sentence. That is deliberate and is the single-writer
 * decision recorded in docs/design/embedded-agent-worker.md "Compaction
 * boundary": the seed is a prompt to the model, not a historical record.
 */
describe('reconstructConversation — legacy context-handoff boundary (retained, never emitted)', () => {
  it('starts reconstruction from the most recent context-handoff event, discarding everything before it', () => {
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'user-message', id: 'm1', text: 'before1' },
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'reply1' },
      { v: 1, type: 'context-handoff', distillation: 'summary text' },
      { v: 1, type: 'user-message', id: 'm2', text: 'after1' },
      { v: 1, type: 'assistant-message', turnId: 't2', text: 'reply2' },
    ];

    const outcome = reconstructConversation(linesOf(events), SYSTEM_PROMPT);

    expect(outcome.conversation).toEqual([
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${SEED_PREFIX}summary text`,
      },
      { role: 'user', content: 'after1' },
      { role: 'assistant', content: 'reply2' },
    ]);

    const flattened = JSON.stringify(outcome.conversation);
    expect(flattened).not.toContain('before1');
    expect(flattened).not.toContain('reply1');
  });

  it('uses only the LAST context-handoff event when multiple are present', () => {
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'context-handoff', distillation: 'first summary' },
      { v: 1, type: 'user-message', id: 'm1', text: 'middle' },
      { v: 1, type: 'context-handoff', distillation: 'second summary' },
      { v: 1, type: 'user-message', id: 'm2', text: 'after' },
    ];

    const outcome = reconstructConversation(linesOf(events), SYSTEM_PROMPT);

    expect(outcome.conversation[1]).toEqual({
      role: 'user',
      content: `${SEED_PREFIX}second summary`,
    });
    const flattened = JSON.stringify(outcome.conversation);
    expect(flattened).not.toContain('first summary');
    expect(flattened).not.toContain('middle');
  });
});

describe('reconstructConversation — context-compacted boundary', () => {
  it('starts reconstruction from the most recent context-compacted event, discarding everything before it', () => {
    // Without this the auto-compaction feature would undo itself: every
    // activation would replay the whole pre-compaction history back into the
    // conversation the compaction had just shortened.
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'user-message', id: 'm1', text: 'before1' },
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'reply1' },
      { v: 1, type: 'context-compacted', source: 'auto', summary: 'summary text' },
      { v: 1, type: 'user-message', id: 'm2', text: 'after1' },
      { v: 1, type: 'assistant-message', turnId: 't2', text: 'reply2' },
    ];

    const outcome = reconstructConversation(linesOf(events), SYSTEM_PROMPT);

    expect(outcome.conversation).toEqual([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${SEED_PREFIX}summary text` },
      { role: 'user', content: 'after1' },
      { role: 'assistant', content: 'reply2' },
    ]);

    const flattened = JSON.stringify(outcome.conversation);
    expect(flattened).not.toContain('before1');
    expect(flattened).not.toContain('reply1');
  });

  it('takes the most recent boundary of EITHER kind when both appear in one stream', () => {
    // A worker that lived across the swap: an old handoff, then a compaction.
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'context-handoff', distillation: 'old handoff summary' },
      { v: 1, type: 'user-message', id: 'm1', text: 'middle' },
      { v: 1, type: 'context-compacted', source: 'manual', summary: 'newer compaction summary' },
      { v: 1, type: 'user-message', id: 'm2', text: 'after' },
    ];

    const outcome = reconstructConversation(linesOf(events), SYSTEM_PROMPT);

    expect(outcome.conversation[1]).toEqual({
      role: 'user',
      content: `${SEED_PREFIX}newer compaction summary`,
    });
    const flattened = JSON.stringify(outcome.conversation);
    expect(flattened).not.toContain('old handoff summary');
    expect(flattened).not.toContain('middle');
  });

  it('takes a legacy context-handoff when it is the LATER of the two kinds', () => {
    // The mirror case, so the "most recent of either" rule is pinned in both
    // directions rather than incidentally passing because one kind always
    // happens to come last.
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'context-compacted', source: 'auto', summary: 'older compaction summary' },
      { v: 1, type: 'user-message', id: 'm1', text: 'middle' },
      { v: 1, type: 'context-handoff', distillation: 'newer handoff summary' },
      { v: 1, type: 'user-message', id: 'm2', text: 'after' },
    ];

    const outcome = reconstructConversation(linesOf(events), SYSTEM_PROMPT);

    expect(outcome.conversation[1]).toEqual({
      role: 'user',
      content: `${SEED_PREFIX}newer handoff summary`,
    });
    expect(JSON.stringify(outcome.conversation)).not.toContain('older compaction summary');
  });

  it('seeds an empty summary when a context-compacted event carries none', () => {
    // `summary` is optional on the wire because the claude-sdk engine may
    // have nothing to put there. The boundary still cuts; the seed is honest
    // about having nothing to carry forward rather than inventing something.
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'user-message', id: 'm1', text: 'before' },
      { v: 1, type: 'context-compacted', source: 'auto' },
      { v: 1, type: 'user-message', id: 'm2', text: 'after' },
    ];

    const outcome = reconstructConversation(linesOf(events), SYSTEM_PROMPT);

    expect(outcome.conversation).toEqual([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: SEED_PREFIX },
      { role: 'user', content: 'after' },
    ]);
    expect(JSON.stringify(outcome.conversation)).not.toContain('before');
  });
});

describe('reconstructConversation — no boundary event of either kind in stream', () => {
  it('reconstructs [system, ...everything replayed] when no handoff marker exists', () => {
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'user-message', id: 'm1', text: 'hi' },
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'hello there' },
    ];

    const outcome = reconstructConversation(linesOf(events), SYSTEM_PROMPT);

    expect(outcome.conversation).toEqual([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello there' },
    ]);
  });

  it('reconstructs just the system message for an empty stream', () => {
    const outcome = reconstructConversation('', SYSTEM_PROMPT);
    expect(outcome.conversation).toEqual([{ role: 'system', content: SYSTEM_PROMPT }]);
    expect(outcome.repairedToolCallIds).toEqual([]);
  });
});

describe('reconstructConversation — Tier C mid-turn repair (4d)', () => {
  it('repairs a dangling tool-call with no matching tool-result', () => {
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'user-message', id: 'm1', text: 'hi' },
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'reply' },
      { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'run', args: {} },
    ];

    const outcome = reconstructConversation(linesOf(events), SYSTEM_PROMPT);

    expect(outcome.repairedToolCallIds).toEqual(['c1']);
    expect(outcome.conversation.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: `Error: ${RESTORE_REPAIR_REASON}`,
    });
  });

  it('repairs multiple dangling tool-calls from the same assistant-message', () => {
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'user-message', id: 'm1', text: 'hi' },
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'reply' },
      { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'run', args: {} },
      { v: 1, type: 'tool-call', turnId: 't1', callId: 'c2', name: 'run2', args: {} },
    ];

    const outcome = reconstructConversation(linesOf(events), SYSTEM_PROMPT);

    expect(outcome.repairedToolCallIds).toEqual(['c1', 'c2']);
  });

  it('positions a repeated-restore repair immediately after its owning turn, not after a LATER completed turn (CodeRabbit MAJOR)', () => {
    // Simulates the on-disk log shape a REPEATED restore replays: Turn 1's
    // dangling tool-call is never healed on disk (repairs are in-memory
    // only, never persisted back to the log per the design), so Turn 2's
    // complete events are appended after it in the SAME raw log. A naive
    // "append repairs to the tail of the whole array" implementation would
    // place Turn 1's synthetic repair AFTER Turn 2's assistant message,
    // violating the provider's structural contract.
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'user-message', id: 'm1', text: 'turn1 msg' },
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'turn1 reply' },
      { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'run', args: {} },
      { v: 1, type: 'user-message', id: 'm2', text: 'turn2 msg' },
      { v: 1, type: 'assistant-message', turnId: 't2', text: 'turn2 reply' },
    ];

    const outcome = reconstructConversation(linesOf(events), SYSTEM_PROMPT);

    expect(outcome.repairedToolCallIds).toEqual(['c1']);

    const turn2UserIndex = outcome.conversation.findIndex(
      (m) => m.role === 'user' && m.content === 'turn2 msg',
    );
    const repairIndex = outcome.conversation.findIndex(
      (m) => m.role === 'tool' && m.tool_call_id === 'c1',
    );
    expect(turn2UserIndex).toBeGreaterThan(-1);
    expect(repairIndex).toBeGreaterThan(-1);
    expect(repairIndex).toBeLessThan(turn2UserIndex);

    expect(toolCallsAnsweredImmediately(outcome.conversation)).toBe(true);
  });

  it('does not repair a tool-call whose tool-result is present (no-repair-needed)', () => {
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'user-message', id: 'm1', text: 'hi' },
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'reply' },
      { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'run', args: {} },
      { v: 1, type: 'tool-result', turnId: 't1', callId: 'c1', ok: true, result: 'ok' },
    ];

    const outcome = reconstructConversation(linesOf(events), SYSTEM_PROMPT);

    expect(outcome.repairedToolCallIds).toEqual([]);
    expect(outcome.conversation.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ok' });
  });
});

describe('reconstructConversation — invariant violations (4f fallback trigger)', () => {
  it('throws RestoreReconstructionError on an unparseable line', () => {
    expect(() => reconstructConversation('{not valid json', SYSTEM_PROMPT)).toThrow(RestoreReconstructionError);
  });

  it('throws RestoreReconstructionError on a schema-invalid known-type line', () => {
    // 'user-message' requires id + text; omit text.
    const badLine = JSON.stringify({ v: 1, type: 'user-message', id: 'm1' });
    expect(() => reconstructConversation(badLine, SYSTEM_PROMPT)).toThrow(RestoreReconstructionError);
  });

  it('throws RestoreReconstructionError on an unrecognized event type', () => {
    const badLine = JSON.stringify({ v: 1, type: 'not-a-real-event' });
    expect(() => reconstructConversation(badLine, SYSTEM_PROMPT)).toThrow(RestoreReconstructionError);
  });

  it('throws RestoreReconstructionError when a tool-call has no preceding assistant-message in the window', () => {
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'user-message', id: 'm1', text: 'hi' },
      { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'run', args: {} },
    ];
    expect(() => reconstructConversation(linesOf(events), SYSTEM_PROMPT)).toThrow(RestoreReconstructionError);
  });

  it('throws RestoreReconstructionError when a tool-call follows a user-message that reset the current assistant pointer', () => {
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'reply1' },
      { v: 1, type: 'user-message', id: 'm2', text: 'next turn' },
      { v: 1, type: 'tool-call', turnId: 't2', callId: 'c1', name: 'run', args: {} },
    ];
    expect(() => reconstructConversation(linesOf(events), SYSTEM_PROMPT)).toThrow(RestoreReconstructionError);
  });

  it('throws RestoreReconstructionError on an orphan tool-result with no owning tool-call in the window (R1, #1202 rotation-truncated window)', () => {
    // Simulates a window that starts mid-turn because the owning tool-call
    // (and its assistant-message) got archived out by a rotation, per the
    // known #1202 limitation (restore only reads the LIVE output window).
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'tool-result', turnId: 't1', callId: 'orphan', ok: true, result: 'done' },
    ];
    expect(() => reconstructConversation(linesOf(events), SYSTEM_PROMPT)).toThrow(RestoreReconstructionError);
  });

  it('throws RestoreReconstructionError on an orphan tool-result appearing in-window AFTER a context-handoff boundary', () => {
    // Unrelated content before the handoff marker is correctly ignored (4b
    // already excludes it); the orphan tool-result inside the post-handoff
    // window must still trip the guard.
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'user-message', id: 'm1', text: 'before handoff' },
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'reply1' },
      { v: 1, type: 'tool-call', turnId: 't1', callId: 'discarded', name: 'run', args: {} },
      { v: 1, type: 'context-handoff', distillation: 'summary text' },
      { v: 1, type: 'tool-result', turnId: 't2', callId: 'orphan', ok: true, result: 'done' },
    ];
    expect(() => reconstructConversation(linesOf(events), SYSTEM_PROMPT)).toThrow(RestoreReconstructionError);
  });
});

describe('reconstructConversation — wire-faithful tool_calls.arguments reconstruction', () => {
  it('JSON-stringifies a plain-object args field', () => {
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'reply' },
      { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'run', args: { path: 'a.ts', limit: 5 } },
      { v: 1, type: 'tool-result', turnId: 't1', callId: 'c1', ok: true, result: 'ok' },
    ];

    const outcome = reconstructConversation(linesOf(events), SYSTEM_PROMPT);

    const assistant = outcome.conversation.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    if (assistant && assistant.role === 'assistant') {
      expect(assistant.tool_calls?.[0]?.function.arguments).toBe(JSON.stringify({ path: 'a.ts', limit: 5 }));
    }
  });

  it('uses an already-capped string args field verbatim', () => {
    const cappedArgsString = '{"truncated":"...(capped)"}';
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'reply' },
      { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'run', args: cappedArgsString },
      { v: 1, type: 'tool-result', turnId: 't1', callId: 'c1', ok: true, result: 'ok' },
    ];

    const outcome = reconstructConversation(linesOf(events), SYSTEM_PROMPT);

    const assistant = outcome.conversation.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    if (assistant && assistant.role === 'assistant') {
      expect(assistant.tool_calls?.[0]?.function.arguments).toBe(cappedArgsString);
    }
  });
});

describe('reconstructConversation — R1 events are Noise (#1410)', () => {
  // `turn-interrupted` and `sdk-resume-failed` say something about the
  // PROCESS's history, not about what was said. Both must be classified as
  // Noise: feeding either into the reconstructed conversation would put a
  // claim in front of the model that no participant ever made.
  //
  // `turn-interrupted` matters most. It describes a turn that WAS cut off,
  // which is also what Mid-turn Repair acts on -- so if it leaked into the
  // array it would become a second, contradictory writer of the same repair.
  it('ignores turn-interrupted and sdk-resume-failed entirely', () => {
    const withoutR1 = reconstructConversation(
      linesOf([
        { v: 1, type: 'user-message', id: 'u1', text: 'hello' },
        { v: 1, type: 'assistant-message', turnId: 'u1', text: 'hi' },
      ]),
      SYSTEM_PROMPT,
    );
    const withR1 = reconstructConversation(
      linesOf([
        { v: 1, type: 'sdk-resume-failed', requestedSdkSessionId: 'sess-gone', reason: 'not-found' },
        { v: 1, type: 'user-message', id: 'u1', text: 'hello' },
        { v: 1, type: 'turn-interrupted', turnId: 'u1' },
        { v: 1, type: 'assistant-message', turnId: 'u1', text: 'hi' },
      ]),
      SYSTEM_PROMPT,
    );

    // Byte-identical to the same stream without them: the strongest form of
    // "contributes nothing", and it fails if either event ever starts
    // producing a message, changing ordering, or tripping the repair.
    expect(withR1.conversation).toEqual(withoutR1.conversation);
    expect(withR1.repairedToolCallIds).toEqual([]);
  });

  it('does not treat a turn-interrupted row as an unanswered tool call', () => {
    // Adversarial placement: immediately after an assistant message carrying
    // a tool call, which is exactly where Tier C looks for a dangling call.
    const outcome = reconstructConversation(
      linesOf([
        { v: 1, type: 'user-message', id: 'u1', text: 'do a thing' },
        { v: 1, type: 'assistant-message', turnId: 'u1', text: 'reading it now' },
        { v: 1, type: 'tool-call', turnId: 'u1', callId: 'c1', name: 'Read', args: '{}' },
        { v: 1, type: 'turn-interrupted', turnId: 'u1' },
      ]),
      SYSTEM_PROMPT,
    );
    // The dangling call IS repaired -- by Mid-turn Repair, on its own terms.
    // What must not happen is the marker adding a message of its own.
    expect(outcome.repairedToolCallIds).toEqual(['c1']);
    expect(outcome.conversation.some((m) => JSON.stringify(m).includes('turn-interrupted'))).toBe(false);
  });
});

/**
 * Issue #1419 seed extraction. The unit under test is the rule "the newest
 * authoritative reading, and never one from before the last boundary" -- the
 * number that replaces the estimator as the restore-boundary compaction
 * check's input.
 *
 * MEASURED REACH (mutation, per the standing requirement -- a pin is not
 * believed until something that should break it does). Each row is a run, not
 * a prediction; two of the four counts came out higher than the author's
 * guess, which is the reason the requirement exists.
 *
 *   m1  `findRestoredUsageSeed` returns undefined unconditionally
 *       -> 6 of 8 fail. The 2 survivors are the two "no reading" cases, which
 *          assert undefined; they are load-bearing for the FALLBACK, not for
 *          extraction, and m3 is what measures them.
 *   m2  drop the `i > boundaryIndex` guard to `i >= 0` (scan the whole
 *       stream, ignoring the boundary) -- the exact defect the AC names
 *       -> 3 fail: 'ignores a reading from BEFORE the last boundary',
 *          'reports a boundary postTokens seed as an estimate', and 'yields
 *          nothing when the only boundary carries no postTokens'. The 'mixed'
 *          case does NOT fail under m2 and never could: its newest reading is
 *          post-boundary and last in the stream either way, so it pins the
 *          preference order and not the boundary guard.
 *   m3  return `{ promptTokens: 0, estimated: true }` instead of undefined
 *       when no reading exists
 *       -> 2 fail, both "no reading" cases. Without m3 those two assertions
 *          would be satisfied by any implementation that never finds
 *          anything, including m1's.
 *   m4  return `estimated: false` for the postTokens branch
 *       -> 3 fail. Pins that a compaction's own post-size is the loop's
 *          chars/4 estimate of the seed it built, and must not arrive at the
 *          next incarnation claiming to be a provider measurement.
 */
describe('findRestoredUsageSeed — the newest authoritative reading (#1419)', () => {
  const usage = (promptTokens: number, estimated = false): EmbeddedAgentStreamEvent =>
    ({ v: 1, type: 'context-usage', promptTokens, estimated });
  const turn = (n: string): EmbeddedAgentStreamEvent[] => [
    { v: 1, type: 'user-message', id: n, text: `q${n}` },
    { v: 1, type: 'assistant-message', turnId: n, text: `a${n}` },
  ];

  function seedOf(events: EmbeddedAgentStreamEvent[]) {
    return reconstructConversation(linesOf(events), SYSTEM_PROMPT).usageSeed;
  }

  it('takes the LAST context-usage when the log has only readings', () => {
    expect(seedOf([...turn('1'), usage(4000), ...turn('2'), usage(6722)])).toEqual({
      promptTokens: 6722,
      estimated: false,
    });
  });

  it('carries the reading’s own `estimated` flag rather than recomputing it', () => {
    // A previous incarnation whose provider never sent `usage` fell back to
    // the estimator. That reading is still the newest one, but it must not
    // arrive at the next incarnation dressed as a measurement.
    expect(seedOf([...turn('1'), usage(1102, true)])).toEqual({
      promptTokens: 1102,
      estimated: true,
    });
  });

  it('ignores a reading from BEFORE the last boundary and uses postTokens instead', () => {
    // The pre-boundary 90000 measures a conversation the compaction then
    // discarded; seeding from it would overstate what remains by nearly
    // everything the compaction removed.
    expect(
      seedOf([
        ...turn('1'),
        usage(90000),
        { v: 1, type: 'context-compacted', source: 'auto', summary: 's', preTokens: 90000, postTokens: 2700 },
      ]),
    ).toEqual({ promptTokens: 2700, estimated: true });
  });

  it('reports a boundary postTokens seed as an estimate, never as a measurement', () => {
    const seed = seedOf([
      ...turn('1'),
      usage(90000),
      { v: 1, type: 'context-compacted', source: 'auto', postTokens: 2700 },
    ]);
    // postTokens is estimateTokensFromChars(seed) inside compact() -- the
    // loop's own chars/4 number, never a provider one.
    expect(seed?.estimated).toBe(true);
  });

  it('mixed: prefers a reading that lands AFTER the boundary over that boundary’s postTokens', () => {
    expect(
      seedOf([
        ...turn('1'),
        usage(90000),
        { v: 1, type: 'context-compacted', source: 'auto', postTokens: 2700 },
        ...turn('2'),
        usage(9100),
      ]),
    ).toEqual({ promptTokens: 9100, estimated: false });
  });

  it('yields nothing when the log holds no reading at all', () => {
    // A worker killed before completing any turn. Legitimate state, not a
    // fault: the subprocess falls back to the estimator, bias and all.
    expect(seedOf([...turn('1')])).toBeUndefined();
  });

  it('yields nothing when the only boundary carries no postTokens', () => {
    // The legacy `context-handoff` never had a post-size, and a
    // `context-compacted` from an engine that cannot supply one is the same
    // shape. Neither is a reading.
    expect(
      seedOf([...turn('1'), usage(90000), { v: 1, type: 'context-handoff', distillation: 'd' }]),
    ).toBeUndefined();
  });

  it('takes the boundary postTokens when the boundary is the very last event', () => {
    expect(
      seedOf([
        ...turn('1'),
        { v: 1, type: 'context-compacted', source: 'auto', postTokens: 512 },
      ]),
    ).toEqual({ promptTokens: 512, estimated: true });
  });
});
