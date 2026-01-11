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

export type Worker = AgentWorker | TerminalWorker | GitDiffWorker;

// Agent activity state (detected by parsing output)
export type AgentActivityState =
  | 'active'    // Working (output continuing)
  | 'idle'      // Waiting (prompt displayed)
  | 'asking'    // Waiting for user input (question/permission)
  | 'unknown';  // Unknown (initial state)
