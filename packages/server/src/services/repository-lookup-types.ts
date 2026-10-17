/**
 * Narrow interfaces exposing only what SessionManager needs from
 * RepositoryManager / related services. Keeping these interfaces thin makes
 * the contract explicit at construction time and removes the need for late
 * setters (`setRepositoryCallbacks`) and `isInitialized()` guards.
 *
 * See docs/design/session-data-path.md §5 for context.
 */

/**
 * Minimum interface needed to resolve a session's data-scope slug
 * (i.e. the slug used in `computeSessionDataBaseDir`).
 */
export interface RepositoryLookup {
  /**
   * Returns the slug for path purposes, or undefined if the repository is
   * not found. Async because the derivation may read the repository's git
   * remote (see `deriveRepositorySlug` in `lib/git.ts`).
   */
  getRepositorySlug(repositoryId: string): Promise<string | undefined>;

  /**
   * Run `fn` while holding the repository's lock, after re-reading that the
   * repository is still registered; rejects with `RepositoryNotFoundError`
   * otherwise. Session creation uses this so it serializes with
   * `RepositoryManager.unregisterRepository` (see the lock table in
   * `repository-manager.ts`). `fn` takes no argument: the registered
   * repository itself is not needed by the caller.
   */
  withRegisteredRepository<T>(repositoryId: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Minimum repository view needed for env-var resolution, PTY spawning context,
 * and converting a session to its public form (repositoryName + isMainWorktree).
 * Kept intentionally narrow — no registration, no mutation, no id generation.
 */
export interface RepositoryInfo {
  name: string;
  path: string;
  envVars?: string | null;
  /** Shell command run when a session in this repository is paused. */
  pauseCommand?: string | null;
  /** Shell command run when a session in this repository is resumed. */
  resumeCommand?: string | null;
}

/**
 * Callbacks used by SessionManager while resolving repository environment
 * variables and display info for worktree sessions. All methods are required
 * at SessionManager construction time — this replaces the old
 * `SessionRepositoryCallbacks` that was set via a late `setRepositoryCallbacks`
 * call (which produced an "uninitialized" window documented as scenario B in
 * the design doc).
 */
export interface RepositoryEnvLookup {
  /** Return full repository info (name + path + env vars) for a given id, or undefined. */
  getRepositoryInfo(repositoryId: string): RepositoryInfo | undefined;
  /** Resolve the worktree index number for a filesystem path. Used by template variables. */
  getWorktreeIndexNumber(worktreePath: string): Promise<number>;
}
