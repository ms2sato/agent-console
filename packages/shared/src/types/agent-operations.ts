/**
 * Cross-surface agent operation parity types (agent-surface migration PR-D).
 *
 * AGENT_OPERATIONS is the single writer of every cross-surface agent
 * operation: an operation belongs here when a user or agent can perform it
 * against "an agent" through more than one surface, or when its absence
 * from a surface must be an explicit recorded decision rather than silence.
 *
 * Each surface (UI, MCP, embedded-visible) owns one exposure table keyed by
 * AgentOperation and typed `satisfies Record<AgentOperation, SurfaceExposure>`
 * -- adding a new operation here is a compile error in every surface's table
 * until that table records an explicit exposed/not-exposed decision for it.
 *
 * See docs/design/agent-surface.md "Mechanism 3" for the normative spec.
 */

export const AGENT_OPERATIONS = [
  'listAgents', // enumerate selectable agents
  'resolveAgent', // ref (id/name) -> definition, incl. ambiguity handling
  'createSessionWithAgent', // new worktree session with an initial agent worker
  'addWorkerToSession', // add an agent worker to an existing session
  'manageDefinitions', // CRUD on agent definitions
] as const;
export type AgentOperation = (typeof AGENT_OPERATIONS)[number];

export type SurfaceExposure =
  | { exposed: true; via: string } // entry point, human-locatable
  | { exposed: false; reason: string }; // explicit opt-out with rationale
