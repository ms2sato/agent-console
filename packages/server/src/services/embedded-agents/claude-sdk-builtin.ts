/**
 * Claude (SDK) built-in embedded-agent definition — SDK Engine Phase 1.
 *
 * Mirrors `services/agents/claude-code.ts`'s built-in-definition pattern for
 * the terminal `AgentManager`, adapted to embedded agents: a fixed
 * definition registered by `EmbeddedAgentManager.initialize()` on every
 * startup, never user-created and never modifiable/deletable
 * (`EmbeddedAgentManager.updateEmbeddedAgent`/`deleteEmbeddedAgent` reject
 * when `isBuiltIn`). This is the ONLY `claude-sdk` engine definition in
 * Phase 1 -- the REST create route always produces `engine: 'native-loop'`
 * (`EmbeddedAgentManager.createEmbeddedAgent`), so the SDK engine is
 * reachable exclusively through this builtin.
 *
 * See docs/design/embedded-agent-sdk-engine.md §3.1 "Engine selection: a
 * structural discriminant, never inference" (the user-facing choice is
 * WHICH agent definition to pick, not a raw engine toggle) and §3.2
 * (no provider secret crosses the server for this engine).
 */
import { type EmbeddedAgentDefinition } from '@agent-console/shared';

export const CLAUDE_SDK_AGENT_ID = 'claude-sdk-builtin';

/**
 * Sentinel `createdBy` value for this builtin. `EmbeddedAgentDefinition.createdBy`
 * is NOT NULL at the DB level and required by the type (unlike the terminal
 * `AgentDefinition`, which has no `createdBy` field at all), so a builtin
 * with no real creating user needs SOME value. `'system'` is a stable,
 * human-legible placeholder that can never collide with a real `users.id`
 * UUID -- flagged as a judgment call in the introducing PR, since no prior
 * convention in this codebase covers "definition with no human creator".
 */
export const CLAUDE_SDK_AGENT_CREATED_BY = 'system';

export const claudeSdkAgent: EmbeddedAgentDefinition = {
  id: CLAUDE_SDK_AGENT_ID,
  name: 'Claude',
  description: 'Anthropic Claude via the Claude Agent SDK — runs as the executing user, using that user\'s own claude authentication (no API key configuration).',
  engine: 'claude-sdk',
  provider: { model: 'claude-sonnet-5' },
  isBuiltIn: true,
  createdBy: CLAUDE_SDK_AGENT_CREATED_BY,
  createdAt: new Date(0).toISOString(), // Epoch time for built-in, matching claude-code.ts's convention
  updatedAt: new Date(0).toISOString(),
};
