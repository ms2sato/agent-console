/**
 * Transcript Restore (#1123) — mandatory design-time polarity signal (AC 5).
 *
 * See docs/design/embedded-agent-worker.md "Transcript Restore" §
 * "Testing (design-time polarity signal -- AC 5)": a restored conversation
 * with a dangling `tool_call_id` must never reach the provider unrepaired.
 * Both directions are asserted against a REAL `AgentLoop` instance driven
 * through `runTurn`, not merely against `reconstructConversation`'s return
 * value in isolation — the audited property is what the provider actually
 * receives on the wire, exactly as `workflow.md`'s TDD polarity discipline
 * requires.
 */
import { describe, it, expect } from 'bun:test';
import type { EmbeddedAgentEvent, EmbeddedAgentStreamEvent } from '@agent-console/shared';
import { AgentLoop, type AgentLoopDeps } from '../agent-loop.js';
import type { ToolCallOutcome, ToolExecutor } from '../mcp.js';
import {
  ProviderError,
  type ChatMessage,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderRunRequest,
} from '../providers/types.js';
import { reconstructConversation } from '../restore.js';

const SYSTEM_PROMPT = 'You are a helpful assistant.';

function linesOf(events: EmbeddedAgentStreamEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

/** Every tool_call in an assistant message has a matching tool-role response
 * later in the array — the real OpenAI Chat Completions constraint. */
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

/**
 * Fake ProviderAdapter reproducing the real OpenAI-Chat-Completions 400
 * constraint: rejects any request whose `messages` array contains an
 * assistant message with `tool_calls` not immediately followed, for every
 * one of those `tool_call_id`s, by a matching `tool`-role message.
 */
class DanglingToolCallRejectingAdapter implements ProviderAdapter {
  capturedMessages: ChatMessage[][] = [];

  async *run(req: ProviderRunRequest): AsyncIterable<ProviderEvent> {
    this.capturedMessages.push([...req.messages]);
    if (!everyToolCallAnswered(req.messages)) {
      throw new ProviderError('400: messages contain an unresponded tool_call_id', { retryable: false });
    }
    yield { type: 'text-delta', text: 'ok, continuing' };
    yield { type: 'done', finishReason: 'stop' };
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

function makeDeps(
  adapter: ProviderAdapter,
  restoredConversation: ChatMessage[],
): { deps: AgentLoopDeps; events: EmbeddedAgentEvent[] } {
  const events: EmbeddedAgentEvent[] = [];
  const deps: AgentLoopDeps = {
    adapter,
    model: 'm',
    tools: [],
    executor: new StubExecutor(),
    emit: (event) => events.push(event),
    systemPrompt: SYSTEM_PROMPT,
    maxToolIterations: 25,
    sleep: async () => {},
    reassembleSystemPrompt: async () => SYSTEM_PROMPT,
    loadHandoffPrompt: async () => 'DISTILL_PROMPT',
    restoredConversation,
  };
  return { deps, events };
}

// The fixture: a persisted NDJSON log fragment ending in a `tool-call` event
// with no matching `tool-result` (simulating a crash between tool-call
// emission and tool execution completing).
const fixtureEvents: EmbeddedAgentStreamEvent[] = [
  { v: 1, type: 'user-message', id: 'm1', text: 'hi' },
  { v: 1, type: 'assistant-message', turnId: 't1', text: 'reply' },
  { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'run', args: {} },
];

describe('Restore-time repair polarity (mandatory, AC 5)', () => {
  it('Direction 1 (repair NOT applied): a dangling tool_call_id reaches the provider and the turn fails', async () => {
    // Build the array exactly as 4c ALONE would produce it (no 4d repair
    // applied) -- the pre-repair shape 4c hands to 4d.
    const preRepairConversation: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'reply',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run', arguments: '{}' } }],
      },
    ];
    expect(everyToolCallAnswered(preRepairConversation)).toBe(false);

    const adapter = new DanglingToolCallRejectingAdapter();
    const { deps, events } = makeDeps(adapter, preRepairConversation);
    const loop = new AgentLoop(deps);

    await loop.runTurn('t2', 'continue');

    // The fake provider saw (and rejected) the dangling tool_call_id.
    expect(everyToolCallAnswered(adapter.capturedMessages[0]!)).toBe(false);
    expect(events.find((e) => e.type === 'turn-error')).toBeDefined();
    expect(events.find((e) => e.type === 'assistant-message' && e.text === 'ok, continuing')).toBeUndefined();
  });

  it('Direction 2 (repair applied): the reconstructed conversation closes the dangling tool_call_id and the turn succeeds', async () => {
    // The FULL reconstructConversation output (4a-4d), used as-is.
    const outcome = reconstructConversation(linesOf(fixtureEvents), SYSTEM_PROMPT);
    expect(outcome.repairedToolCallIds).toEqual(['c1']);
    expect(everyToolCallAnswered(outcome.conversation)).toBe(true);

    const adapter = new DanglingToolCallRejectingAdapter();
    const { deps, events } = makeDeps(adapter, outcome.conversation);
    const loop = new AgentLoop(deps);

    await loop.runTurn('t2', 'continue');

    // The fake provider accepted the request -- every tool_call_id was closed.
    expect(everyToolCallAnswered(adapter.capturedMessages[0]!)).toBe(true);
    expect(events.find((e) => e.type === 'turn-error')).toBeUndefined();
    expect(events.find((e) => e.type === 'assistant-message' && e.text === 'ok, continuing')).toBeDefined();
  });
});
