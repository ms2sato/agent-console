/**
 * Transcript Restore reconstitution (#1123).
 *
 * Reconstructs the LLM-facing ChatMessage[] conversation array from a
 * worker's persisted NDJSON output log, replacing v1's unconditional
 * fresh-epoch-and-truncate activation reset. Pure over already-fetched
 * data: the caller (EmbeddedAgentWorkerService) reads the persisted stream
 * and reassembles the system prompt (loadInstructions + assembleSystemPrompt
 * -- identical regardless of whether a context-handoff boundary exists); this
 * module never touches the filesystem.
 *
 * See docs/design/embedded-agent-worker.md "Transcript Restore":
 * - "Restore trigger & activation flow" steps 4a-4d
 * - "Runtime abort-repair vs. restore-time repair: parts cross-reference"
 * - "Context-handoff boundary"
 */
import * as v from 'valibot';
import { EmbeddedAgentStreamEventSchema, type EmbeddedAgentStreamEvent } from '@agent-console/shared';
import type { ChatMessage, ToolCall } from './providers/types.js';
import { buildHandoffSeedMessages } from './conversation-seed.js';
import { pushSyntheticToolError } from './tool-call-repair.js';

/** Row 4 of the parts cross-reference table: the restore-specific repair reason string. */
export const RESTORE_REPAIR_REASON =
  'tool call not completed: worker restarted before this response was recorded';

/** Thrown on any 4a-4c invariant violation (unparseable stream, schema-invalid line, a tool-call with no owning assistant-message). Caller must catch this and fall back to v1 reset (spec "Failure invariant (restore)"). */
export class RestoreReconstructionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreReconstructionError';
  }
}

export interface RestoreOutcome {
  conversation: ChatMessage[];
  /** Tool-call ids repaired by Tier C mid-turn repair (4d); empty when none needed. */
  repairedToolCallIds: string[];
}

/**
 * 4a (parse) + 4b (locate context-handoff boundary) + 4c (total
 * classification/replay) + 4d (Tier C mid-turn repair). `systemPrompt` is
 * the caller's already-reassembled prompt.
 */
export function reconstructConversation(streamText: string, systemPrompt: string): RestoreOutcome {
  const events = parseStreamEvents(streamText);

  const handoffIndex = findLastContextHandoffIndex(events);
  let conversation: ChatMessage[];
  let windowEvents: EmbeddedAgentStreamEvent[];
  if (handoffIndex === -1) {
    conversation = [{ role: 'system', content: systemPrompt }];
    windowEvents = events;
  } else {
    const handoffEvent = events[handoffIndex] as Extract<EmbeddedAgentStreamEvent, { type: 'context-handoff' }>;
    conversation = buildHandoffSeedMessages(systemPrompt, handoffEvent.distillation);
    windowEvents = events.slice(handoffIndex + 1);
  }

  replayWindow(conversation, windowEvents);
  const repairResult = repairDanglingToolCalls(conversation);

  return { conversation: repairResult.conversation, repairedToolCallIds: repairResult.repairedToolCallIds };
}

function parseStreamEvents(streamText: string): EmbeddedAgentStreamEvent[] {
  const events: EmbeddedAgentStreamEvent[] = [];
  for (const rawLine of streamText.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new RestoreReconstructionError(
        `Unparseable line in persisted stream: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const result = v.safeParse(EmbeddedAgentStreamEventSchema, parsed);
    if (!result.success) {
      throw new RestoreReconstructionError('Persisted stream line failed EmbeddedAgentStreamEvent schema validation');
    }
    events.push(result.output);
  }
  return events;
}

function findLastContextHandoffIndex(events: EmbeddedAgentStreamEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'context-handoff') return i;
  }
  return -1;
}

/**
 * 4c: total classification over all 13 EmbeddedAgentStreamEvent union
 * members (mutates `conversation` in place). Mapped (4): user-message,
 * assistant-message, tool-call, tool-result. Noise (8, skipped):
 * assistant-delta, assistant-thinking-delta, state, context-usage, ready,
 * exited, turn-error, fatal. Boundary (1, never reached here -- already
 * sliced out by 4b): context-handoff.
 */
function replayWindow(conversation: ChatMessage[], events: EmbeddedAgentStreamEvent[]): void {
  let current: Extract<ChatMessage, { role: 'assistant' }> | null = null;

  for (const event of events) {
    switch (event.type) {
      case 'user-message':
        conversation.push({ role: 'user', content: event.text });
        current = null;
        break;
      case 'assistant-message': {
        const message: Extract<ChatMessage, { role: 'assistant' }> = { role: 'assistant', content: event.text };
        conversation.push(message);
        current = message;
        break;
      }
      case 'tool-call': {
        if (current === null) {
          throw new RestoreReconstructionError(
            `tool-call event (callId=${event.callId}) with no preceding assistant-message in the restore window`,
          );
        }
        const toolCall: ToolCall = {
          id: event.callId,
          type: 'function',
          function: {
            name: event.name,
            arguments: typeof event.args === 'string' ? event.args : JSON.stringify(event.args),
          },
        };
        current.tool_calls = [...(current.tool_calls ?? []), toolCall];
        break;
      }
      case 'tool-result':
        conversation.push({ role: 'tool', tool_call_id: event.callId, content: event.result });
        break;
      case 'assistant-delta':
      case 'assistant-thinking-delta':
      case 'state':
      case 'context-usage':
      case 'ready':
      case 'exited':
      case 'turn-error':
      case 'fatal':
        // Noise: replay-only, contributes nothing to the conversation array.
        break;
      case 'context-handoff':
        // Boundary: unreachable here -- 4b already excluded it from `events`.
        break;
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  }
}

/**
 * 4d: Tier C mid-turn repair, applied to the fully reconstructed array.
 * Returns a NEW array (does not mutate `conversation` in place) with a
 * synthetic repair inserted immediately after each assistant message that
 * has a dangling tool_call_id -- positioned there (not appended to the tail
 * of the whole array) so repeated restores across multiple turns cannot
 * place a repair AFTER a later turn's messages, which would violate the
 * provider's structural contract (every tool_call_id must be answered
 * before the NEXT assistant message, not merely "somewhere in the array").
 */
function repairDanglingToolCalls(conversation: ChatMessage[]): { conversation: ChatMessage[]; repairedToolCallIds: string[] } {
  const responded = new Set<string>();
  for (const msg of conversation) {
    if (msg.role === 'tool') responded.add(msg.tool_call_id);
  }
  const repaired: string[] = [];
  const result: ChatMessage[] = [];
  for (const msg of conversation) {
    result.push(msg);
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (!responded.has(tc.id)) {
          pushSyntheticToolError(result, tc.id, RESTORE_REPAIR_REASON);
          repaired.push(tc.id);
        }
      }
    }
  }
  return { conversation: result, repairedToolCallIds: repaired };
}
