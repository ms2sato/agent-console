import type { ChatMessage } from './providers/types.js';

/**
 * Push a synthetic {role:'tool'} response for one unresponded tool_call_id.
 * Shared by AgentLoop's runtime abort-repair (agent-loop.ts's
 * fillPendingToolResponses) and the restore module's Tier C repair --
 * Mid-turn Repair (docs/design/embedded-agent-worker.md glossary) is ONE
 * mechanism used at two call sites with different detection surfaces; this
 * is the shared insertion primitive both sites push through.
 */
export function pushSyntheticToolError(conversation: ChatMessage[], toolCallId: string, reason: string): void {
  conversation.push({ role: 'tool', tool_call_id: toolCallId, content: `Error: ${reason}` });
}
