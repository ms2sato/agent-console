export interface WorkerBase {
  id: string;
  name: string;
  createdAt: string;
}

export interface AgentWorker extends WorkerBase {
  type: 'agent';
  agentId: string;  // References AgentDefinition.id (e.g., 'claude-code-builtin')
  activated: boolean;  // Whether the PTY is running (false when hibernated)
}

export interface TerminalWorker extends WorkerBase {
  type: 'terminal';
  activated: boolean;  // Whether the PTY is running (false when hibernated)
}

export interface GitDiffWorker extends WorkerBase {
  type: 'git-diff';
  baseCommit: string;  // Comparison base commit hash (calculated at creation)
}

export interface EmbeddedAgentWorker extends WorkerBase {
  type: 'embedded-agent';
  /** References EmbeddedAgentDefinition.id (NOT AgentDefinition.id). */
  embeddedAgentId: string;
  /** Whether the agent subprocess is running (false after server restart until reactivated). */
  activated: boolean;
  /**
   * Compaction's automatic-firing toggle. Deliberately per-WORKER, not per
   * definition: two workers built from the same embedded agent can differ,
   * because the decision belongs to the conversation in front of the user.
   * Defaults ON (`workers.auto_compaction NOT NULL DEFAULT 1`), including
   * for rows that predate the column.
   *
   * Crossing the wire requires the matching field on
   * `EmbeddedAgentWorkerSchema` (schemas/app-server-message.ts) -- that
   * schema is a `strictObject`, so a type-only addition here would be
   * silently stripped at the boundary.
   */
  autoCompaction: boolean;
  /**
   * Effective context-window token denominator for the compaction usage
   * gauge, resolved server-side (single writer:
   * `resolveEffectiveContextWindow` in
   * `packages/server/src/services/embedded-agent-context-window.ts`).
   * `undefined` when the underlying definition declares no window (or the
   * definition is missing) -- the gauge must render indeterminate in that
   * case, never inherit a stale or unrelated value.
   *
   * Crossing the wire requires the matching field on
   * `EmbeddedAgentWorkerSchema` (schemas/app-server-message.ts) -- that
   * schema is a `strictObject`, so a type-only addition here would be
   * silently stripped at the boundary.
   */
  contextWindowTokens?: number;
}

export type Worker = AgentWorker | TerminalWorker | GitDiffWorker | EmbeddedAgentWorker;

/**
 * Workers backed by a PTY: can receive raw injected input / [internal:*]
 * notifications written directly to a terminal. This predicate is about the
 * DELIVERY MECHANISM (a PTY write), not about which worker kinds are
 * eligible to be a notification target -- see {@link canReceiveNotifications}
 * for that. After the notification delivery seam (SessionManager.
 * deliverWorkerNotification) was introduced, this predicate has two
 * remaining production consumers outside its own definition: that seam's
 * own internal PTY-vs-embedded branch, and send_session_message's
 * explicit-target guard in mcp-server.ts (which combines it with
 * {@link canReceiveSessionMessages} so terminal workers stay valid explicit
 * targets).
 */
export function isPtyBackedWorker(w: Worker): w is AgentWorker | TerminalWorker {
  return w.type === 'agent' || w.type === 'terminal';
}

/**
 * Workers that can be the target of send_session_message in the current
 * implementation. Terminal workers are intentionally excluded (a pre-existing,
 * unrelated asymmetry -- out of scope here). Embedded-agent workers can
 * receive session messages despite having no PTY: delivery routes through
 * EmbeddedAgentWorkerService.sendUserMessage rather than a PTY write, so
 * they are NOT PTY-backed (see isPtyBackedWorker above) but ARE a valid
 * send_session_message target.
 */
export function canReceiveSessionMessages(w: Worker): w is AgentWorker | EmbeddedAgentWorker {
  return w.type === 'agent' || w.type === 'embedded-agent';
}

/**
 * Workers that can be the target of a `create_timer` / `create_conditional_wakeup`
 * notification (delivered via SessionManager.deliverWorkerNotification).
 * Broader than {@link isPtyBackedWorker}: an embedded-agent worker has no
 * PTY at all, but the delivery seam routes to it through
 * EmbeddedAgentWorkerService.sendSystemNotification instead of a PTY write,
 * so it is eligible here even though isPtyBackedWorker(w) is false for it.
 * git-diff workers remain excluded -- they represent no running process.
 */
export function canReceiveNotifications(w: Worker): w is AgentWorker | TerminalWorker | EmbeddedAgentWorker {
  return w.type === 'agent' || w.type === 'terminal' || w.type === 'embedded-agent';
}

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
