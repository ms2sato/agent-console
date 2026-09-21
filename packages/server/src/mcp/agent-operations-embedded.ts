import type { AgentOperation, SurfaceExposure } from '@agent-console/shared';

/**
 * Single-writer exposure table for the embedded-agent-visible surface
 * (agent-surface migration PR-D).
 *
 * Embedded agents reach the same `/mcp` endpoint as any other MCP client
 * (authenticated via token, per the embedded-agent-worker design) and there
 * is no caller-specific tool filter applied to MOST of these operations.
 * This table is therefore expected to mirror `MCP_AGENT_OPERATIONS` exactly
 * on `exposed` -- the parity is structural, not coincidental -- EXCEPT for
 * a declared, permanent set of divergences where the tool itself refuses an
 * embedded caller regardless of endpoint visibility (epic #1636 Phase 5
 * PR-3a's `decideMcpServerPermissions`). The sibling test
 * `__tests__/agent-operations-embedded.test.ts` enforces the parity
 * mechanically for every operation NOT in that declared set, and separately
 * pins that every declared divergence is a real one, so an edit to one
 * table without the other (or a stale divergence entry) fails the test.
 */
export const EMBEDDED_AGENT_OPERATIONS = {
  listAgents: { exposed: true, via: 'MCP endpoint (shared) — list_agents' },
  resolveAgent: { exposed: true, via: 'MCP endpoint (shared) — delegate_to_worktree' },
  createSessionWithAgent: {
    exposed: true,
    via: 'MCP endpoint (shared) — delegate_to_worktree',
  },
  addWorkerToSession: {
    exposed: false,
    reason:
      'not-exposed via MCP: delegate model is one-worktree-one-session; adding workers to foreign sessions crosses the #878 auth boundary (same MCP endpoint, same restriction)',
  },
  manageDefinitions: {
    exposed: false,
    reason:
      'not-exposed via MCP: definition CRUD is an owner/console concern, not a delegation concern (same MCP endpoint, same restriction)',
  },
  restart: { exposed: true, via: 'MCP endpoint (shared) — restart_all_agents' },
  setWorkerParameters: { exposed: true, via: 'MCP endpoint (shared) — set_agent_parameters' },
  decideMcpServerPermissions: {
    exposed: false,
    reason:
      "not-exposed via MCP for embedded callers: set_mcp_server_permission refuses a caller whose token belongs to an embedded-agent worker -- an LLM must not grant its own or its delegates' project MCP servers; the decision belongs to the console operator (worker panel, PR-3b) or a TUI Orchestrator (this tool). Same MCP endpoint, enforced in the tool, not by visibility.",
  },
} satisfies Record<AgentOperation, SurfaceExposure>;
