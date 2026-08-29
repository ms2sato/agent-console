import { readFileSync } from 'node:fs';
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

  it('RECONSTRUCTS a tool-call that opens a begun turn — this shape used to be asserted as a violation', () => {
    // CONTRACT CHANGE, and the sharpest evidence in this file that it was
    // needed: these exact events are the shape one engine actually writes --
    // a turn whose first act is a tool call, its empty assistant flush
    // following. The suite pinned it as an invariant VIOLATION, so the defect
    // was never uncovered; it was covered, and the coverage asserted the
    // wrong outcome for the right data.
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'user-message', id: 'm1', text: 'hi' },
      { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'run', args: {} },
    ];
    const out = reconstructConversation(linesOf(events), SYSTEM_PROMPT);
    expect(out.conversation.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    // The synthesised message carries the call, and mid-turn repair answers it
    // -- the reconstruction stays provider-valid.
    expect(toolCallsAnsweredImmediately(out.conversation)).toBe(true);
  });

  it('RECONSTRUCTS a second turn that opens with a tool call, after a user-message reset the pointer', () => {
    // Same contract change, one turn further in. The `user-message` resetting
    // `current` to null is what the old guard read as "no assistant message",
    // but it is also precisely what says a turn has begun -- so the reset that
    // used to condemn this window is now what licenses it.
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'reply1' },
      { v: 1, type: 'user-message', id: 'm2', text: 'next turn' },
      { v: 1, type: 'tool-call', turnId: 't2', callId: 'c1', name: 'run', args: {} },
    ];
    const out = reconstructConversation(linesOf(events), SYSTEM_PROMPT);
    expect(out.conversation.map((m) => m.role)).toEqual(['system', 'assistant', 'user', 'assistant', 'tool']);
    expect(toolCallsAnsweredImmediately(out.conversation)).toBe(true);
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
 * `restoredMessageCount` -- the count the client turns into both "Loading N
 * previous messages..." and the `> 0` gate on its "your conversation may not
 * have carried over" notice.
 *
 * Criterion under test: an entry counts if and only if its content
 * ORIGINATES FROM A LINE OF THE PERSISTED TRANSCRIPT. Replayed messages and
 * a compaction summary do; the synthetic system prompt and a Tier C repair
 * marker do not -- both are invented by the reconstruction so the provider
 * will accept the array.
 *
 * The synthetic entries differ per branch (a seed of one message with no
 * boundary, two past one; zero or more repair markers), which is exactly why
 * the count cannot be derived outside the module and why each case is pinned
 * separately below.
 */
describe('reconstructConversation — restoredMessageCount', () => {
  it('counts the replayed messages and NOT the system prompt (seed of 1)', () => {
    // Mutation reach: returning `conversation.length` (the pre-fix
    // behaviour) gives 3; dropping the replay gives 0.
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'user-message', id: 'm1', text: 'hi' },
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'hello there' },
    ];

    const outcome = reconstructConversation(linesOf(events), SYSTEM_PROMPT);

    expect(outcome.conversation.length).toBe(3); // [system, user, assistant]
    expect(outcome.restoredMessageCount).toBe(2);
  });

  it('counts the compaction summary as restored content (seed of 2)', () => {
    // The summary is reconstructed FROM the persisted log -- it is restored
    // content, unlike the system prompt which is reassembled fresh from the
    // agent definition on every activation. Mutation reach: subtracting the
    // whole seed (`- 2` past a boundary) gives 2 here instead of 3.
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'user-message', id: 'm0', text: 'pre-boundary, discarded' },
      { v: 1, type: 'context-compacted', source: 'auto', summary: 'summary text' },
      { v: 1, type: 'user-message', id: 'm1', text: 'after1' },
      { v: 1, type: 'assistant-message', turnId: 't2', text: 'after2' },
    ];

    const outcome = reconstructConversation(linesOf(events), SYSTEM_PROMPT);

    // [system, summary, user, assistant] -- summary + the 2 replayed = 3.
    expect(outcome.conversation.length).toBe(4);
    expect(outcome.restoredMessageCount).toBe(3);
  });

  it('reports 1 -- not 0 -- for a boundary with NOTHING replayed after it', () => {
    // THE CORRECTED EDGE. An earlier definition said "exclude the seed: 1
    // normally, 2 past a boundary", which reports 0 here -- a worker killed
    // immediately after a compaction, before saying anything else.
    //
    // What the user would have seen under that definition: no "may not have
    // carried over" notice at all, because the client gates it on `> 0` --
    // and yet the transcript holds a whole compacted-away history that a
    // model which failed to resume knows nothing about. The notice would
    // disappear at precisely the moment it is most needed.
    //
    // Mutation reach: `- 2` in the boundary branch gives 0 and fails; so
    // does dropping the summary from the seed.
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'user-message', id: 'm0', text: 'pre-boundary, discarded' },
      { v: 1, type: 'assistant-message', turnId: 't0', text: 'also discarded' },
      { v: 1, type: 'context-compacted', source: 'auto', summary: 'a rich history, compacted' },
    ];

    const outcome = reconstructConversation(linesOf(events), SYSTEM_PROMPT);

    expect(outcome.conversation.length).toBe(2); // [system, summary]
    expect(outcome.restoredMessageCount).toBe(1);
  });

  /**
   * 0 must be REACHABLE. This is the whole defect: with the count taken as
   * `conversation.length`, the seed alone floors it at 1, the client's `> 0`
   * gate always fires, and a worker that was activated but never spoken to
   * tells the user their conversation may not have carried over -- when
   * there was no conversation. A false warning of that kind trains the user
   * to ignore it, right before it becomes true.
   *
   * Each absence assertion here is paired with a PRESENCE CONTROL in the
   * same block: "the count was 0" cannot distinguish "nothing was restored"
   * from "the count is broken and always 0" without one.
   */
  describe('reachability of 0 (with presence controls)', () => {
    it('reports 0 for an empty transcript', () => {
      const outcome = reconstructConversation('', SYSTEM_PROMPT);
      expect(outcome.conversation).toEqual([{ role: 'system', content: SYSTEM_PROMPT }]);
      expect(outcome.restoredMessageCount).toBe(0);
    });

    it('reports 0 for a transcript of nothing but Noise events (activated, never spoken to)', () => {
      // The production shape of the empty case: an activated worker's log is
      // never literally empty (the server treats an empty read as an I/O
      // failure) -- it holds lifecycle rows that carry no conversation.
      const events: EmbeddedAgentStreamEvent[] = [
        { v: 1, type: 'ready' },
        { v: 1, type: 'state', state: 'idle' },
        { v: 1, type: 'context-usage', promptTokens: 12, estimated: false },
        { v: 1, type: 'exited', code: 0 },
      ];

      const outcome = reconstructConversation(linesOf(events), SYSTEM_PROMPT);

      expect(outcome.restoredMessageCount).toBe(0);
    });

    it('PRESENCE CONTROL: the same call reports non-zero the moment one real message exists', () => {
      // Without this, both assertions above are satisfied by a broken
      // implementation that returns 0 unconditionally.
      const events: EmbeddedAgentStreamEvent[] = [
        { v: 1, type: 'ready' },
        { v: 1, type: 'user-message', id: 'm1', text: 'hi' },
        { v: 1, type: 'exited', code: 0 },
      ];

      const outcome = reconstructConversation(linesOf(events), SYSTEM_PROMPT);

      expect(outcome.restoredMessageCount).toBe(1);
    });

    it('PRESENCE CONTROL: a compaction boundary alone is non-zero even with nothing after it', () => {
      // The other direction of the same control: 0 must not be reachable by
      // a stream that DOES carry restored content.
      const outcome = reconstructConversation(
        linesOf([{ v: 1, type: 'context-compacted', source: 'manual', summary: 'carried forward' }]),
        SYSTEM_PROMPT,
      );

      expect(outcome.restoredMessageCount).toBe(1);
    });
  });

  it('does NOT count a Tier C synthetic repair marker', () => {
    // A transcript whose tail stops mid-tool-call: the `tool-call` row has no
    // matching `tool-result`, so Tier C really fires and inserts a marker.
    //
    // The marker originates in no transcript line -- it is invented here so
    // the provider will accept the array -- so the criterion excludes it.
    // Counting it would double-count an interaction the user sees once: the
    // tool call is already counted as the assistant message it arrived in.
    //
    // Kept as a dedicated named test so the exclusion set cannot be silently
    // re-widened. The count is taken BEFORE the repair runs, which is exactly
    // the kind of ordering a later reader can "simplify" away by reading the
    // repair's output array instead.
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'user-message', id: 'm1', text: 'hi' },
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'reply' },
      { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'run', args: {} },
    ];

    const outcome = reconstructConversation(linesOf(events), SYSTEM_PROMPT);

    // LOAD-BEARING. Without it, a fixture that produced no repair at all
    // would satisfy the count assertion below for the wrong reason -- passing
    // by a mechanism other than the one under test.
    expect(outcome.repairedToolCallIds).toEqual(['c1']);
    // [system, user, assistant(+tool_calls), synthetic tool result]
    expect(outcome.conversation.length).toBe(4);
    // user + assistant only. Mutation reach: taking the count after the
    // repair (the behaviour this replaces) gives 3.
    expect(outcome.restoredMessageCount).toBe(2);
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
/**
 * Either write order reconstructs, and debris still does not.
 *
 * WHY THE FIXTURES ARE FILES AND NOT ARRAYS. The two engines disagree about
 * where a turn's `assistant-message` sits relative to its first `tool-call`,
 * and the reader was written against one of them. Every existing layer passed
 * for a single reason: **the array a test author writes is the array the
 * reader already expects.** So the two order fixtures here are copied
 * byte-for-byte from real persisted streams rather than assembled -- one of
 * them is the `.restore-failed.log` sidecar the failure itself produced, i.e.
 * the exact bytes the reader choked on, since a sidecar is an `fs.rename` of
 * the live file and not a re-serialisation.
 *
 * Provenance, and one caution for anyone regenerating them: a sidecar is
 * SINGLE-SLOT per worker -- the next restore failure on that worker renames
 * over it. These survived only because they were copied out to a QA artifacts
 * directory, and were then renamed away from the worker's UUID. A search for
 * one wants the right roots as much as the right glob.
 *
 * MEASURED REACH (mutation, run -- not predicted):
 *
 *   m1  remove the `turnBegun` guard, so a leading `tool-call` always opens
 *       an implicit assistant
 *       -> 1 fails: 'debris before any user-message still throws'. That test
 *          is the only thing keeping a TRUNCATED window from being presented
 *          as a whole one, and it is what leaves the truncated-window
 *          question to the design decision that owns it.
 *   m2  drop the `implicitAssistantOpen` merge, so the engine's own flush
 *       pushes a second assistant message
 *       -> 3 fail, all in this describe:
 *            'reconstructs the claude-sdk order, where the tool-call precedes
 *             its assistant-message'
 *            'does not split one assistant turn into two'
 *            'reconstructs BOTH orders of the same conversation identically'
 *          The reconstruction still SUCCEEDS under this mutation -- it just
 *          splits one assistant turn into two -- which is why all three
 *          compare whole conversations rather than asserting no throw. A pin
 *          that only checked "did not throw" would pass here.
 *   m5  close the merge on an intervening `tool-result` -- the tidy-looking
 *       refinement a future reader is most likely to attempt
 *       -> 1 fail, alone:
 *            'folds the third interleaving -- tool-call, tool-result, THEN
 *             the flush -- into one turn'
 *          Nothing else catches it, because both FILE fixtures happen to
 *          interleave the other way. That pin exists only because a live
 *          smoke run produced the third order and the engine's own comment
 *          explained it as a fast-tool race.
 *   m3  make the implicit open unconditional (drop `current === null`)
 *       -> 5 fail. NOTE the count was recorded as 4 when first measured and
 *          was stale by the time it was read: the equivalence pin below was
 *          added AFTER that run, and it catches this mutation too. A mutation
 *          record is a measurement with a timestamp, and adding a test
 *          invalidates every earlier record without touching one -- re-run
 *          before trusting a count you did not just produce.
 *          The five, one of them in this describe:
 *            4c total classification >
 *              'reconstructs only the four Mapped event kinds, in order, and
 *               skips every Noise kind'
 *            wire-faithful tool_calls.arguments reconstruction >
 *              'JSON-stringifies a plain-object args field'
 *              'uses an already-capped string args field verbatim'
 *            restoredMessageCount >
 *              'does NOT count a Tier C synthetic repair marker'
 *            either engine write order (this describe) >
 *              'reconstructs BOTH orders of the same conversation identically'
 *          Wider than predicted, and the width is the point: `current ===
 *          null` is load bearing for the ORDINARY path, not only for this
 *          fixture -- which is why the four that catch it are the ones this
 *          change never went near.
 */
describe('replayWindow — either engine write order (#1457 fixtures)', () => {
  const fixture = (name: string) =>
    readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf-8');

  it('reconstructs the claude-sdk order, where the tool-call precedes its assistant-message', () => {
    // Against the reader as shipped this threw RestoreReconstructionError and
    // the worker fell to the destructive reset.
    const out = reconstructConversation(fixture('restore-claude-sdk-tool-first.ndjson'), SYSTEM_PROMPT);
    expect(out.conversation.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    expect(toolCallsAnsweredImmediately(out.conversation)).toBe(true);
  });

  it('does not split one assistant turn into two', () => {
    // The engine's own (empty) flush arrives AFTER the call it belongs with.
    // Adopting it into the message the call opened is what makes the two
    // orders agree; pushing a second message would also "succeed".
    const out = reconstructConversation(fixture('restore-claude-sdk-tool-first.ndjson'), SYSTEM_PROMPT);
    const assistants = out.conversation.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(2);
    const [withCall] = assistants;
    expect(withCall.role === 'assistant' && withCall.tool_calls).toHaveLength(1);
  });

  it('reconstructs the openai-api order unchanged — the shape the reader was written against', () => {
    const out = reconstructConversation(fixture('restore-openai-api-assistant-first.ndjson'), SYSTEM_PROMPT);
    expect(out.conversation[0].role).toBe('system');
    expect(toolCallsAnsweredImmediately(out.conversation)).toBe(true);
    expect(out.conversation.some((m) => m.role === 'tool')).toBe(true);
  });

  it('reconstructs BOTH orders of the same conversation identically', () => {
    // AC pin: the equivalence itself, which is what stops a future change
    // fixing one order by breaking the other.
    //
    // The second order is DERIVED from the artifact rather than typed out --
    // the claude-sdk stream with its `tool-call` and the empty
    // `assistant-message` that follows it transposed, which is exactly the
    // openai-api shape. Deriving it keeps the comparison anchored to real
    // bytes on both sides; writing the second array by hand would reintroduce
    // the very thing these fixtures exist to avoid.
    const lines = fixture('restore-claude-sdk-tool-first.ndjson').split('\n').filter((l) => l.trim() !== '');
    const types = lines.map((l) => JSON.parse(l).type as string);
    const call = types.indexOf('tool-call');
    const flush = types.indexOf('assistant-message', call);
    expect(call).toBeGreaterThanOrEqual(0);
    expect(flush).toBe(call + 1); // the shape this transposition assumes

    const transposed = [...lines];
    [transposed[call], transposed[flush]] = [transposed[flush], transposed[call]];

    const fromSdkOrder = reconstructConversation(lines.join('\n'), SYSTEM_PROMPT);
    const fromApiOrder = reconstructConversation(transposed.join('\n'), SYSTEM_PROMPT);

    expect(fromApiOrder.conversation).toEqual(fromSdkOrder.conversation);
    expect(fromApiOrder.restoredMessageCount).toBe(fromSdkOrder.restoredMessageCount);
  });

  it('folds the third interleaving — tool-call, tool-result, THEN the flush — into one turn', () => {
    // Observed live: the fatal-replacement smoke's planting turn emitted
    // `tool-call, tool-result, assistant-message`, a different order from
    // either fixture. `sdk-engine`'s own comment explains it -- the call is
    // emitted on observation, so for a FAST tool the iteration's
    // `assistant-message` can land after the result rather than before it.
    //
    // It is still that iteration's flush, so it must fold into the message the
    // call opened. The merge therefore must NOT be closed by an intervening
    // `tool-result`: doing so would look like a tidy refinement and would
    // split the turn in exactly the case the race produces. Nothing else here
    // pins that, because both file fixtures happen to interleave the other way.
    const events: EmbeddedAgentStreamEvent[] = [
      { v: 1, type: 'user-message', id: 'm1', text: 'read the note' },
      { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'Read', args: { path: 'qa-note.txt' } },
      { v: 1, type: 'tool-result', turnId: 't1', callId: 'c1', ok: true, result: 'PELICAN-7731' },
      { v: 1, type: 'assistant-message', turnId: 't1', text: '' },
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'The word is PELICAN-7731.' },
    ];
    const out = reconstructConversation(linesOf(events), SYSTEM_PROMPT);
    expect(out.conversation.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    expect(toolCallsAnsweredImmediately(out.conversation)).toBe(true);
  });

  it('debris before any user-message still throws', () => {
    // A window whose cut fell inside a turn: the call's own user-message is on
    // the far side of the cut, so nothing here says a turn began. Tolerating
    // this would present a TRUNCATED conversation as a whole one, silently.
    const debris = [
      JSON.stringify({ v: 1, type: 'tool-call', turnId: 't0', callId: 'orphaned', name: 'Read', args: {} }),
      JSON.stringify({ v: 1, type: 'user-message', id: 'm2', text: 'a later turn' }),
    ].join('\n');
    expect(() => reconstructConversation(debris, SYSTEM_PROMPT)).toThrow(RestoreReconstructionError);
  });
});

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
