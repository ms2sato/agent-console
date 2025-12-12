// Import types for local use
import type { AgentActivityPatterns, InitialPromptMode } from '../schemas/agent.js';

// Re-export schema-derived types
export type {
  AgentActivityPatterns,
  InitialPromptMode,
  CreateAgentRequest,
  UpdateAgentRequest,
} from '../schemas/agent.js';

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
  /**
   * Arguments for non-interactive "print" mode (e.g., ['-p', '--output-format', 'text'] for Claude Code).
   * The prompt will be appended as the last argument.
   * If not set, the agent does not support non-interactive mode.
   */
  printModeArgs?: string[];
}
