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

describe('reconstructConversation — context-handoff boundary', () => {
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
        content: 'This conversation continues from a previous one. Prior context summary: summary text',
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
      content: 'This conversation continues from a previous one. Prior context summary: second summary',
    });
    const flattened = JSON.stringify(outcome.conversation);
    expect(flattened).not.toContain('first summary');
    expect(flattened).not.toContain('middle');
  });
});

describe('reconstructConversation — no context-handoff in stream', () => {
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
