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
   * Add `sessionId` to the repository's designated-Orchestrator SET
   * (see docs/design/shared-orchestrator-session.md, "Designation in multi-user"). No holder check anywhere: any session may add itself,
   * and nobody's designation is changed by anyone else's add. Idempotent --
   * adding a pair that already exists is a no-op (`added: false`).
   * `repository: null` when the repository row does not exist.
   */
  addOrchestratorSession(
    id: string,
    sessionId: string
  ): Promise<{ added: boolean; repository: Repository | null }>;

  /**
   * Remove `sessionId` from the repository's designated-Orchestrator SET.
   * No holder check anywhere: any session may remove itself (or be removed
   * as part of session deletion cascade), and nobody's designation is
   * changed by anyone else's remove. Idempotent -- removing a pair that is
   * not present is a no-op (`removed: false`).
   */
  removeOrchestratorSession(
    id: string,
    sessionId: string
  ): Promise<{ removed: boolean; repository: Repository | null }>;

  /**
   * List the repository's designated-Orchestrator session ids, ordered by
   * designation time then session id (`created_at ASC, session_id ASC`) for
   * a deterministic wire representation.
   */
  listOrchestratorSessionIds(id: string): Promise<string[]>;
}
