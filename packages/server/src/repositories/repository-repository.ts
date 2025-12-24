import type { Repository } from '@agent-console/shared';

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
   * Delete a repository by its ID.
   * @param id - The repository ID to delete
   */
  delete(id: string): Promise<void>;
}
