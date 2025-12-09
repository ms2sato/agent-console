/**
 * Agent-specific patterns for activity detection
 */
export interface AgentActivityPatterns {
  /** Regex patterns (as strings) that indicate "asking" state */
  askingPatterns?: string[];
}

/**
 * How to pass the initial prompt to the agent
 * - 'stdin': Write the prompt to stdin after the agent starts (default)
 * - 'arg': Pass as command line argument
 */
export type InitialPromptMode = 'stdin' | 'arg';

/**
 * Agent definition - stored and managed by AgentManager
 */
export interface AgentDefinition {
  id: string;
  name: string;
  command: string;
  description?: string;
  icon?: string;
  isBuiltIn: boolean;
  registeredAt: string;
  activityPatterns?: AgentActivityPatterns;
  /** Arguments to append when continuing conversation (e.g., ['-c'] for Claude Code) */
  continueArgs?: string[];
  /** How to pass the initial prompt to the agent (default: 'stdin') */
  initialPromptMode?: InitialPromptMode;
  /**
   * Delay in milliseconds before sending the initial prompt via stdin.
   * This gives the agent time to initialize. Default: 1000ms
   */
  initialPromptDelayMs?: number;
}

/**
 * Request to create a new agent
 */
export interface CreateAgentRequest {
  name: string;
  command: string;
  description?: string;
  icon?: string;
  activityPatterns?: AgentActivityPatterns;
  continueArgs?: string[];
  initialPromptMode?: InitialPromptMode;
  initialPromptDelayMs?: number;
}

/**
 * Request to update an existing agent
 */
export interface UpdateAgentRequest {
  name?: string;
  command?: string;
  description?: string;
  icon?: string;
  activityPatterns?: AgentActivityPatterns;
  continueArgs?: string[];
  initialPromptMode?: InitialPromptMode;
  initialPromptDelayMs?: number;
}
