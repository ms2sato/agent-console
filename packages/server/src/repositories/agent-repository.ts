import type { AgentDefinition } from '@agent-console/shared';

/**
 * Repository interface for persisting custom agents.
 * Built-in agents are never persisted and are managed by AgentManager.
 */
export interface AgentRepository {
  /**
   * Retrieve all custom (non-built-in) agents.
   */
  findAll(): Promise<AgentDefinition[]>;

  /**
   * Find an agent by its ID.
   * @param id - The agent ID to search for
   * @returns The agent if found, null otherwise
   */
  findById(id: string): Promise<AgentDefinition | null>;

  /**
   * Save a custom agent.
   * Creates a new agent or updates an existing one with the same ID.
   * Built-in agents cannot be saved.
   * @param agent - The agent to save
   * @throws Error if attempting to save a built-in agent
   */
  save(agent: AgentDefinition): Promise<void>;

  /**
   * Delete an agent by its ID.
   * Built-in agents cannot be deleted - throws an error if attempted.
   * @param id - The agent ID to delete
   * @throws Error if attempting to delete a built-in agent
   */
  delete(id: string): Promise<void>;
}
