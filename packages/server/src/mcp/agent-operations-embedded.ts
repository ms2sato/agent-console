import type { AgentOperation, SurfaceExposure } from '@agent-console/shared';

/**
 * Single-writer exposure table for the embedded-agent-visible surface
 * (agent-surface migration PR-D).
 *
 * Embedded agents reach the same `/mcp` endpoint as any other MCP client
 * (authenticated via token, per the embedded-agent-worker design) and there
 * is no caller-specific tool filter applied to these operations. This
 * table is therefore expected to mirror `MCP_AGENT_OPERATIONS` exactly on
 * `exposed` -- the parity is structural, not coincidental. The sibling test
 * `__tests__/agent-operations-embedded.test.ts` enforces this parity
 * mechanically, so an edit to one table without the other fails the test.
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
} satisfies Record<AgentOperation, SurfaceExposure>;
