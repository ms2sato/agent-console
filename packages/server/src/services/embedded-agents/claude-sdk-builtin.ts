/**
 * Claude (SDK) built-in embedded-agent definition — SDK Engine Phase 1.
 *
 * Mirrors `services/agents/claude-code.ts`'s built-in-definition pattern for
 * the terminal `AgentManager`, adapted to embedded agents: a fixed
 * definition registered by `EmbeddedAgentManager.initialize()` on every
 * startup, never user-created and never modifiable/deletable
 * (`EmbeddedAgentManager.updateEmbeddedAgent`/`deleteEmbeddedAgent` reject
 * when `isBuiltIn`). This is the ONLY `claude-sdk` engine definition in
 * Phase 1 -- the REST create route always produces `engine: 'openai-api'`
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
  // No `instructions[]` opt-in entry (Phase A, R1). Before this
  // PR, this builtin baked `instructions: ['CLAUDE.md']` because that was the
  // ONLY way project-instruction content reached this engine's context --
  // the SDK's own native discovery is disabled via `settingSources: []` (see
  // docs/design/embedded-agent-sdk-engine.md §4.2), and this engine's init
  // arm resolved only that one opt-in file. As of Phase A, `main.ts`'s
  // `claude-sdk` init arm calls the SAME `loadInstructions` the openai-api
  // engine uses -- global layer, the git-root-to-cwd AGENTS.md/CLAUDE.md
  // chain, and the `.claude/rules` layer -- so CLAUDE.md (and AGENTS.md) are
  // now discovered automatically without needing a per-definition opt-in
  // entry. A worktree with no CLAUDE.md/AGENTS.md is handled gracefully by
  // that loader either way.
  //
  // Explicit `enabledTools`, opting into Write/Edit (epic 1636 Phase 2). This
  // builtin used to carry no `enabledTools` at all, which fell back to
  // `DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS` (Read/Glob/Grep/TodoWrite, no
  // Write/Edit) -- so the memory layer's WRITE half was unreachable on the
  // only production `claude-sdk` engine definition. Measured 2026-09-17 in
  // the memory-layer smoke (check-embedded-agent-memory-layer.ts) run 4: the
  // SDK answered a `Write` tool call with "No such tool available: Write"
  // and the model fell back to writing through the `run_process` MCP tool
  // instead. Owner decision 2026-09-17 authorizes this opt-in. Written as a
  // literal array rather than spreading `DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS`
  // -- per that constant's own doc comment, an explicit array is a pinned
  // snapshot that never tracks the default again, so a future default change
  // is a conscious edit here, not something inherited silently. `TodoWrite`
  // stays (dropping it would silently remove the Orchestrator's todo tool on
  // this engine -- see sdk-engine.ts, which registers the in-process MCP
  // TodoWrite tool only when `TodoWrite` is present in `enabledTools`).
  // `Bash` deliberately stays OFF -- see Issue 1045 for the MCP
  // `run_process` sandboxing route, out of scope here.
  enabledTools: ['Read', 'Glob', 'Grep', 'TodoWrite', 'Write', 'Edit'],
};
