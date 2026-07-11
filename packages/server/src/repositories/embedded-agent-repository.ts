import type { EmbeddedAgentDefinition } from '@agent-console/shared';

/**
 * Repository interface for persisting embedded-agent definitions.
 *
 * Unlike AgentRepository, there is no built-in definition concept: the registry
 * starts empty and every definition is user-created.
 */
export interface EmbeddedAgentRepository {
  /**
   * Retrieve all embedded-agent definitions.
   */
  findAll(): Promise<EmbeddedAgentDefinition[]>;

  /**
   * Find an embedded-agent definition by its ID.
   * @param id - The definition ID to search for
   * @returns The definition if found, null otherwise
   */
  findById(id: string): Promise<EmbeddedAgentDefinition | null>;

  /**
   * Save an embedded-agent definition.
   * Creates a new definition or updates an existing one with the same ID.
   * @param def - The definition to save
   */
  save(def: EmbeddedAgentDefinition): Promise<void>;

  /**
   * Delete an embedded-agent definition by its ID.
   * Idempotent: deleting a non-existent definition is a no-op.
   * @param id - The definition ID to delete
   */
  delete(id: string): Promise<void>;
}
