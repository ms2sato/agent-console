import { ForbiddenError } from './errors.js';

/**
 * Single writer of the "can this authenticated caller operate on this
 * session" predicate, extracted from the three sites in `routes/sessions.ts`
 * that previously each inlined the identical `isOwner`/`isSharedSession`
 * check (`PUT /:id/memo`, `POST /:id/orchestrator-designation`,
 * `DELETE /:id/orchestrator-designation`) -- see
 * `docs/design/session-worker-design.md#session-memo` (R5) for the full
 * ruling this codifies.
 *
 * The check is skipped entirely outside `AUTH_MODE === 'multi-user'`:
 * `createdBy` is nullable in the DB (legacy / creator-less sessions), so an
 * unconditional check would 403 the single-user owner on their own such
 * sessions.
 *
 * Returns `true` when the caller may operate the session, `false`
 * otherwise. `assertCanOperateSession` below is a thin wrapper that throws
 * instead of returning `false` -- use this predicate directly wherever the
 * caller needs to filter/omit rather than reject outright (e.g. scoping a
 * bulk operation to the sessions a caller may act on).
 */
export function canOperateSession(
  session: { createdBy?: string },
  userId: string,
  sharedAccountRegistry: { isSharedUserId(userId: string): boolean },
  authMode: 'none' | 'multi-user',
): boolean {
  if (authMode !== 'multi-user') return true;
  const isOwner = session.createdBy === userId;
  const isSharedSession = session.createdBy != null && sharedAccountRegistry.isSharedUserId(session.createdBy);
  return isOwner || isSharedSession;
}

/**
 * Thin wrapper around `canOperateSession` that throws instead of returning
 * `false`. See that function's doc comment for the full ruling.
 *
 * @throws {ForbiddenError} in `AUTH_MODE === 'multi-user'` when the caller
 * is neither the session's owner nor the shared account.
 */
export function assertCanOperateSession(
  session: { createdBy?: string },
  authUser: { id: string },
  sharedAccountRegistry: { isSharedUserId(userId: string): boolean },
  authMode: 'none' | 'multi-user',
  errorMessage: string,
): void {
  if (!canOperateSession(session, authUser.id, sharedAccountRegistry, authMode)) {
    throw new ForbiddenError(errorMessage);
  }
}
