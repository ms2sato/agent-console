/**
 * The `Compact` tool -- the manual half of Compaction's user-facing contract
 * ("manual compaction is a request made to the agent"). See
 * docs/design/embedded-agent-worker.md "The `Compact` tool".
 *
 * This module holds ONLY the engine-neutral parts: the name, the published
 * schema, and the result strings. Each engine registers and executes it
 * itself, because the two do so through entirely different surfaces --
 * `AgentLoop` prepends the definition to the provider's tool list and
 * intercepts the call by name; the SDK engine serves it from an in-process
 * SDK MCP server.
 *
 * `Compact` is deliberately NOT a member of `EMBEDDED_AGENT_TOOL_NAMES` nor
 * of `BUILTIN_TOOLS`: it is the first member of the **self-management tool
 * class** -- owned by the engine, zero outward capability (no file, no
 * process, no network), and therefore outside `enabledTools`' reach by
 * construction rather than by a defaulting rule. There is no representable
 * configuration that removes it, and it never appears among the definition
 * form's tool checkboxes. A future tool-permission floor must not govern this
 * class with the mechanism it uses for capability tools: gating a
 * self-management tool buys no safety and costs the user the ability to
 * manage their own conversation.
 */

import type { ToolDefinition } from './providers/types.js';

/**
 * The model-visible name on the `openai-api` engine. The `claude-sdk` engine
 * necessarily namespaces it (`mcp__console__Compact`), because the SDK
 * namespaces every MCP tool; the contract -- no parameters, reservation
 * semantics, result wording -- is identical on both.
 */
export const COMPACT_TOOL_NAME = 'Compact';

export const COMPACT_TOOL_DESCRIPTION =
  'Compact this conversation: replace the earlier messages with a summary, keeping the ' +
  'conversation going. Use it when the context is filling up, or when the user asks you to ' +
  'compact. Takes no arguments. It runs once the current turn finishes, so anything you still ' +
  'need to say or do this turn is unaffected.';

/** Published to the provider. No parameters, and no additional ones accepted. */
export const compactToolDefinition: ToolDefinition = {
  name: COMPACT_TOOL_NAME,
  description: COMPACT_TOOL_DESCRIPTION,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

/**
 * Result returned when the reservation is taken. Says "when this turn
 * completes" rather than "now" because that is literally what happens:
 * compaction never runs mid-turn (splicing the conversation array while a
 * provider request is in flight would destroy the turn), so the call books it
 * for the turn boundary.
 */
export const COMPACT_TOOL_SCHEDULED_RESULT =
  'Compaction scheduled; runs when this turn completes.';

/**
 * Result for an engine whose compaction is automatic-only. Returned instead
 * of de-registering the tool: an accurate explanation is an honest
 * affordance, and a model that cannot see the tool cannot explain why it
 * cannot comply.
 */
export const COMPACT_TOOL_UNSUPPORTED_RESULT =
  'This agent compacts automatically and cannot be asked to compact on demand. ' +
  'Automatic compaction can be turned on or off for this worker.';
