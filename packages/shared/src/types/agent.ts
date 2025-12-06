/**
 * Agent-specific patterns for activity detection
 */
export interface AgentActivityPatterns {
  /** Regex patterns (as strings) that indicate "asking" state */
  askingPatterns?: string[];
}

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
}
