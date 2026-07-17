import type { AgentOperation, SurfaceExposure } from '@agent-console/shared';

/**
 * Single-writer exposure table for the MCP surface (agent-surface migration
 * PR-D).
 *
 * Every `AgentOperation` must have an explicit exposed/not-exposed entry
 * here -- the `satisfies Record<AgentOperation, SurfaceExposure>` clause
 * makes adding a new operation to `AGENT_OPERATIONS` a compile error in
 * this table until that decision is recorded.
 *
 * The `via` strings for exposed operations are cross-checked mechanically
 * against the real registered MCP tool names in `mcp-server.ts` by the
 * sibling test `__tests__/agent-operations-mcp.test.ts`, so a renamed or
 * removed tool fails the test instead of silently drifting from reality.
 */
export const MCP_AGENT_OPERATIONS = {
  listAgents: { exposed: true, via: 'list_agents (both kinds after PR-A)' },
  resolveAgent: { exposed: true, via: 'delegate_to_worktree agentId/agentName' },
  createSessionWithAgent: { exposed: true, via: 'delegate_to_worktree' },
  addWorkerToSession: {
    exposed: false,
    reason:
      'delegate model is one-worktree-one-session; adding workers to foreign sessions crosses the #878 auth boundary',
  },
  manageDefinitions: {
    exposed: false,
    reason: 'definition CRUD is an owner/console concern, not a delegation concern',
  },
} satisfies Record<AgentOperation, SurfaceExposure>;
