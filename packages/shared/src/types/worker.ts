// Agent activity state (detected by parsing output)
export type AgentActivityState =
  | 'active'    // Working (output continuing)
  | 'idle'      // Waiting (prompt displayed)
  | 'asking'    // Waiting for user input (question/permission)
  | 'unknown';  // Unknown (initial state)

/**
 * Reason a worker's process exited.
 * - 'managed': a shutdown someone asked for (delete, restart, pause, explicit
 *   deactivate).
 * - 'unexpected': the process died on its own (crash, user exit, signal).
 * - 'evicted': the server dropped an idle worker's subprocess on purpose. The
 *   worker stays logically alive and the next message transparently wakes it,
 *   so the user is meant not to notice.
 *
 * `evicted` is a strict SUBSET of what used to be reported as `managed`:
 * eviction routes through the same deactivation path, so a worker being
 * evicted also has its shutdown-requested flag set and would have been
 * reported as `managed` before this value existed. Every consumer that
 * branches on `managed` must therefore be re-checked when this value is
 * introduced -- a branch that means "a human asked for this" now needs to
 * exclude `evicted`, while a branch that means "not a crash" does not.
 *
 * Lives here, beside {@link AgentActivityState}, because both describe a
 * worker's process: that one is what the worker is doing, this one is how its
 * process stopped. `WorkerServerMessage`'s exit member and the embedded-agent
 * event stream are consumers of the concept, not its owner -- it sat in
 * types/session.ts only because sessions needed it first. This module is the
 * concept's scope, not a dependency-graph workaround; do not move it back
 * next to one of its consumers.
 */
export type ExitReason = 'managed' | 'unexpected' | 'evicted';
