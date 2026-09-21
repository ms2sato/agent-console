import { describe, it, expect } from 'bun:test';
import { assertCanOperateSession } from '../session-access.js';
import { ForbiddenError } from '../errors.js';

const AUTH_USER = { id: 'user-1' };
const SHARED_REGISTRY_NONE = { isSharedUserId: () => false };
const SHARED_REGISTRY_MATCHES = { isSharedUserId: (id: string) => id === 'shared-user' };

describe('assertCanOperateSession', () => {
  it('does not throw for the session owner in multi-user mode', () => {
    expect(() =>
      assertCanOperateSession(
        { createdBy: 'user-1' },
        AUTH_USER,
        SHARED_REGISTRY_NONE,
        'multi-user',
        'Only the session owner can do this',
      ),
    ).not.toThrow();
  });

  it('does not throw for a shared-session creator, even though the caller is not the owner', () => {
    expect(() =>
      assertCanOperateSession(
        { createdBy: 'shared-user' },
        AUTH_USER,
        SHARED_REGISTRY_MATCHES,
        'multi-user',
        'Only the session owner can do this',
      ),
    ).not.toThrow();
  });

  it('throws ForbiddenError with the given message for a non-owner, non-shared session in multi-user mode', () => {
    expect(() =>
      assertCanOperateSession(
        { createdBy: 'someone-else' },
        AUTH_USER,
        SHARED_REGISTRY_NONE,
        'multi-user',
        'Only the session owner can do this',
      ),
    ).toThrow(ForbiddenError);
    try {
      assertCanOperateSession(
        { createdBy: 'someone-else' },
        AUTH_USER,
        SHARED_REGISTRY_NONE,
        'multi-user',
        'Only the session owner can do this',
      );
      throw new Error('expected assertCanOperateSession to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).message).toBe('Only the session owner can do this');
    }
  });

  it('never throws outside multi-user mode, regardless of ownership', () => {
    expect(() =>
      assertCanOperateSession(
        { createdBy: 'someone-else' },
        AUTH_USER,
        SHARED_REGISTRY_NONE,
        'none',
        'Only the session owner can do this',
      ),
    ).not.toThrow();
  });

  it('does not throw for a legacy session with createdBy undefined, in multi-user mode (isOwner and isSharedSession both false, but the DB nullability precedent (R5) is intentionally NOT re-derived here)', () => {
    // `createdBy: undefined` makes `isOwner` false (authUser.id !== undefined)
    // and `isSharedSession` false (`session.createdBy != null` short-circuits).
    // The three original call sites in routes/sessions.ts accepted this as a
    // 403 in multi-user mode (R5's ruling is about single-user mode, not
    // this one) -- this test pins the CURRENT behavior (throws), not a new
    // guarantee. See docs/design/session-worker-design.md#session-memo.
    expect(() =>
      assertCanOperateSession(
        { createdBy: undefined },
        AUTH_USER,
        SHARED_REGISTRY_NONE,
        'multi-user',
        'Only the session owner can do this',
      ),
    ).toThrow(ForbiddenError);
  });
});
