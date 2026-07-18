import type { AgentOperation, SurfaceExposure } from '@agent-console/shared';

/**
 * SINGLE WRITER of the UI surface's cross-surface agent operation exposure
 * table (agent-surface migration PR-D).
 *
 * `satisfies Record<AgentOperation, SurfaceExposure>` is the compile-time
 * exhaustiveness gate: adding a 6th `AgentOperation` to
 * `packages/shared/src/types/agent-operations.ts` fails the build here
 * until this table records an explicit exposed/not-exposed decision for it.
 *
 * The `via` strings name real component/page locations for each exposed
 * operation. Unlike the MCP surface's table (server-side sibling of this
 * PR), which is cross-checked against the real MCP tool registry, these
 * claims are checked by review rather than mechanically -- keep them
 * accurate, but a rename elsewhere in the tree will not fail CI here.
 *
 * See docs/design/agent-surface.md "Mechanism 3" for the normative spec.
 */
export const UI_AGENT_OPERATIONS = {
  listAgents: { exposed: true, via: 'pickers + /agents page' },
  resolveAgent: { exposed: true, via: 'picker selection' },
  createSessionWithAgent: { exposed: true, via: 'CreateWorktreeForm' },
  addWorkerToSession: { exposed: true, via: 'AddAgentWorkerMenu' },
  manageDefinitions: { exposed: true, via: '/agents page + settings' },
} satisfies Record<AgentOperation, SurfaceExposure>;
