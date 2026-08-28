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
}

export type Worker = AgentWorker | TerminalWorker | GitDiffWorker | EmbeddedAgentWorker;

/** Workers backed by a PTY: can receive injected input / [internal:*] notifications. */
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

// Agent activity state (detected by parsing output)
export type AgentActivityState =
  | 'active'    // Working (output continuing)
  | 'idle'      // Waiting (prompt displayed)
  | 'asking'    // Waiting for user input (question/permission)
  | 'unknown';  // Unknown (initial state)
