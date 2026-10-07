import * as v from 'valibot';

/**
 * Request-body schema for `POST /api/shared-accounts` (register a shared
 * account). `username` is the OS account name; resolution against the host
 * OS and the "already has personal sessions" / "cannot register yourself"
 * guards are the route handler's job, not this schema's.
 */
export const RegisterSharedAccountRequestSchema = v.strictObject({
  username: v.pipe(v.string(), v.trim(), v.minLength(1, 'username is required')),
});

export type RegisterSharedAccountRequest = v.InferOutput<typeof RegisterSharedAccountRequestSchema>;

/**
 * Wire shape for a single registered shared account, as returned by
 * `GET /api/shared-accounts`.
 */
export const SharedAccountSummarySchema = v.strictObject({
  username: v.string(),
  registeredAt: v.string(),
  boundRepositoryCount: v.number(),
  sessionCount: v.number(),
  /**
   * Whether this account's OS account currently resolves (read-time join
   * against the in-memory `SharedAccountRegistry`, same check
   * `isSharedUserId` and session-creation's binding resolution use -- see
   * docs/design/shared-orchestrator-session.md §"Shared-Account Set and
   * Per-Repository Binding (DB-backed)"). `false` means the account is still
   * a registered member of the SET (existing sessions/bindings stay valid)
   * but cannot be used to spawn a NEW shared session until the OS account is
   * restored.
   */
  resolvable: v.boolean(),
});

export type SharedAccountSummary = v.InferOutput<typeof SharedAccountSummarySchema>;

/**
 * Response schema for `GET /api/shared-accounts`.
 */
export const ListSharedAccountsResponseSchema = v.strictObject({
  accounts: v.array(SharedAccountSummarySchema),
});

export type ListSharedAccountsResponse = v.InferOutput<typeof ListSharedAccountsResponseSchema>;
