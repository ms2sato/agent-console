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
});

export type SharedAccountSummary = v.InferOutput<typeof SharedAccountSummarySchema>;

/**
 * Response schema for `GET /api/shared-accounts`.
 */
export const ListSharedAccountsResponseSchema = v.strictObject({
  accounts: v.array(SharedAccountSummarySchema),
});

export type ListSharedAccountsResponse = v.InferOutput<typeof ListSharedAccountsResponseSchema>;
