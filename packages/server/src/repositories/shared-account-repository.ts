/**
 * Server-internal shared-account row: the registered account's `users.id`,
 * its resolved `username` (joined from `users`), registration metadata, and
 * who registered it.
 *
 * This is the row shape the routes layer composes `GET /api/shared-accounts`
 * responses from; per-account counts (`boundRepositoryCount`,
 * `sessionCount`) are NOT part of this shape -- they are computed
 * separately via `countBoundRepositories` / `countSessions` and composed at
 * the route layer, since those counts require their own queries rather than
 * a join that belongs on every `list()` call.
 */
export interface SharedAccountRow {
  /** `users.id` this shared account resolves to. */
  userId: string;
  /** Resolved OS username (joined from `users`). */
  username: string;
  /** Registration timestamp as ISO 8601 string. */
  createdAt: string;
  /** `users.id` of the user who registered this account, or null. */
  createdBy: string | null;
}

/**
 * Repository for the shared-account SET (Release 1 of the shared-accounts
 * design): which OS accounts an operator has registered as usable shared
 * execution identities. Storage only -- not consulted by session creation
 * or access control (see `migrateToV47`'s doc comment in
 * `packages/server/src/database/connection.ts`).
 */
export interface SharedAccountRepository {
  /**
   * List every registered shared account, joined with the resolved
   * username.
   */
  list(): Promise<SharedAccountRow[]>;

  /**
   * Register `userId` as a shared account.
   * @param userId - The `users.id` to register.
   * @param createdBy - The registering user's `users.id`, or null.
   */
  register(userId: string, createdBy: string | null): Promise<void>;

  /**
   * Unregister a shared account.
   *
   * Does NOT catch a foreign-key-constraint error: when `userId` is
   * currently bound to a repository (`repositories.shared_account_user_id`),
   * the underlying delete throws (`ON DELETE RESTRICT`) and that throw IS
   * the contract -- callers that need a friendlier 409 translate it at
   * their own layer.
   *
   * @returns `true` when a row was deleted, `false` when `userId` was not registered.
   */
  unregister(userId: string): Promise<boolean>;

  /** Count repositories currently bound to this shared account. */
  countBoundRepositories(userId: string): Promise<number>;

  /** Count sessions whose `created_by` is this shared account. */
  countSessions(userId: string): Promise<number>;
}
