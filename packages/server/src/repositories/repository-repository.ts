import type { Repository } from '@agent-console/shared';

/**
 * Updates that can be applied to a repository.
 */
export interface RepositoryUpdates {
  setupCommand?: string | null;
  cleanupCommand?: string | null;
  envVars?: string | null;
  description?: string | null;
  defaultAgentId?: string | null;
  issueTriggerLabels?: string | null;
}

/**
 * Repository interface for persisting git repositories.
 * Provides an abstraction layer for repository storage operations.
 */
export interface RepositoryRepository {
  /**
   * Retrieve all registered repositories.
   */
  findAll(): Promise<Repository[]>;

  /**
   * Find a repository by its ID.
   * @param id - The repository ID to search for
   * @returns The repository if found, null otherwise
   */
  findById(id: string): Promise<Repository | null>;

  /**
   * Find a repository by its path.
   * @param path - The absolute path to search for
   * @returns The repository if found, null otherwise
   */
  findByPath(path: string): Promise<Repository | null>;

  /**
   * Save a single repository.
   * Creates a new repository or updates an existing one with the same ID.
   * @param repository - The repository to save
   */
  save(repository: Repository): Promise<void>;

  /**
   * Update specific fields of a repository.
   * @param id - The repository ID to update
   * @param updates - The fields to update
   * @returns The updated repository if found, null otherwise
   */
  update(id: string, updates: RepositoryUpdates): Promise<Repository | null>;

  /**
   * Delete a repository by its ID.
   * @param id - The repository ID to delete
   */
  delete(id: string): Promise<void>;

  /**
   * Set (or move) the repository's designated-Orchestrator session pointer
   * unconditionally. A repository has exactly one nullable column, so
   * "raising the flag on another session" needs no separate "lower the old
   * one" step.
   */
  setOrchestratorSessionId(id: string, sessionId: string): Promise<Repository | null>;

  /**
   * Clear the designated-Orchestrator pointer, but ONLY if it currently
   * equals `expectedSessionId` -- a stale clear call (e.g. from a session
   * that no longer holds the flag) must not clobber a session that has
   * since taken over. Returns whether the clear actually happened.
   */
  clearOrchestratorSessionId(
    id: string,
    expectedSessionId: string
  ): Promise<{ cleared: boolean; repository: Repository | null }>;
}
