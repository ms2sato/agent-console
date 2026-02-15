/**
 * Domain record representing a registered worktree.
 */
export interface WorktreeRecord {
  id: string;
  repositoryId: string;
  path: string;
  indexNumber: number;
  createdAt: string;
}

/**
 * Repository interface for worktree persistence.
 */
export interface WorktreeRepository {
  /**
   * Find all worktrees belonging to a repository.
   * @param repositoryId - The repository ID to search for
   * @returns Array of worktree records (empty if none found)
   */
  findByRepositoryId(repositoryId: string): Promise<WorktreeRecord[]>;

  /**
   * Find a worktree by its path.
   * @param path - The absolute path to search for
   * @returns The worktree record if found, null otherwise
   */
  findByPath(path: string): Promise<WorktreeRecord | null>;

  /**
   * Save a worktree record.
   * @param record - The worktree record to save
   */
  save(record: WorktreeRecord): Promise<void>;

  /**
   * Delete a worktree by its path.
   * @param path - The absolute path of the worktree to delete
   */
  deleteByPath(path: string): Promise<void>;
}
