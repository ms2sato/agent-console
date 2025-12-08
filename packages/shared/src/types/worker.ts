export interface WorkerBase {
  id: string;
  name: string;
  createdAt: string;
}

export interface AgentWorker extends WorkerBase {
  type: 'agent';
  agentId: string;  // References AgentDefinition.id (e.g., 'claude-code-builtin')
}

export interface TerminalWorker extends WorkerBase {
  type: 'terminal';
}

export type Worker = AgentWorker | TerminalWorker;

// Agent activity state (detected by parsing output)
export type AgentActivityState =
  | 'active'    // Working (output continuing)
  | 'idle'      // Waiting (prompt displayed)
  | 'asking'    // Waiting for user input (question/permission)
  | 'unknown';  // Unknown (initial state)
