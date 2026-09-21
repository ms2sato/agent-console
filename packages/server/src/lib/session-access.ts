import { ForbiddenError } from './errors.js';

/**
 * Single writer of the "can this authenticated caller operate on this
 * session" gate, extracted from the three sites in `routes/sessions.ts`
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
  const isOwner = session.createdBy === authUser.id;
  const isSharedSession = session.createdBy != null && sharedAccountRegistry.isSharedUserId(session.createdBy);
  if (authMode === 'multi-user' && !isOwner && !isSharedSession) {
    throw new ForbiddenError(errorMessage);
  }
}
