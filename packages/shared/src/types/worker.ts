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
}

export type Worker = AgentWorker | TerminalWorker | GitDiffWorker | EmbeddedAgentWorker;

/** Workers backed by a PTY: can receive injected input / [internal:*] notifications. */
export function isPtyBackedWorker(w: Worker): w is AgentWorker | TerminalWorker {
  return w.type === 'agent' || w.type === 'terminal';
}

/** Workers that can be the target of send_session_message in the current implementation. */
export function canReceiveSessionMessages(w: Worker): w is AgentWorker {
  return w.type === 'agent';
}

// Agent activity state (detected by parsing output)
export type AgentActivityState =
  | 'active'    // Working (output continuing)
  | 'idle'      // Waiting (prompt displayed)
  | 'asking'    // Waiting for user input (question/permission)
  | 'unknown';  // Unknown (initial state)
