/**
 * Synthesizes a deterministic, unique tool-call id when a provider returns an
 * EMPTY `callId` (`""`). Some providers (observed: `opencode-go` /
 * `qwen3.8-flash`) omit the id on one or more tool calls in a turn; when two
 * such calls land in the same iteration, a downstream consumer keyed by
 * `callId` (e.g. the client's `toolCallIndexByCallId` map) cannot tell them
 * apart, and because ids are persisted, the ambiguity survives into restore.
 *
 * Called exactly once per provider iteration, in `AgentLoop.runUserTurn`,
 * before any consumer reads `outcome.toolCalls` -- see
 * docs/design/embedded-agent-worker.md "Provider adapter & tool-call
 * normalization" for the full rationale and the id scheme.
 */

import type { ProviderToolCall } from './agent-loop.js';

/**
 * Only an EMPTY `callId` is replaced. A provider-supplied (non-empty) id
 * passes through byte-identical, however unusual it looks -- duplicate
 * NON-EMPTY ids from a provider are a different defect with a different fix
 * and are out of scope here; this function neither detects nor repairs them.
 */
export function assignSyntheticToolCallIds(
  toolCalls: ProviderToolCall[],
  turnId: string,
  iteration: number,
): ProviderToolCall[] {
  return toolCalls.map((call, index) =>
    call.callId === ''
      ? { ...call, callId: `synthetic:${turnId}:${iteration}:${index}` }
      : call,
  );
}
