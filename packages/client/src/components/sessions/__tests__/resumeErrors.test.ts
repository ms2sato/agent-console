import { describe, it, expect } from 'bun:test';
import { isSessionOrphanedError } from '../resumeErrors';
import { ApiError } from '../../../lib/api';

describe('isSessionOrphanedError', () => {
  it('returns true for ApiError with status 409 and code session_orphaned', () => {
    const error = new ApiError('Cannot resume', 409, 'session_orphaned');
    expect(isSessionOrphanedError(error)).toBe(true);
  });

  it('returns false for ApiError with status 409 but different code', () => {
    const error = new ApiError('Conflict', 409, 'some_other_conflict');
    expect(isSessionOrphanedError(error)).toBe(false);
  });

  it('returns false for ApiError with code session_orphaned but non-409 status', () => {
    // Guard against the server changing the status but keeping the code.
    // Client callers should only treat 409 + session_orphaned as the documented contract.
    const error = new ApiError('Not found', 404, 'session_orphaned');
    expect(isSessionOrphanedError(error)).toBe(false);
  });

  it('returns false for ApiError without code', () => {
    const error = new ApiError('Generic error', 409);
    expect(isSessionOrphanedError(error)).toBe(false);
  });

  it('returns false for plain Error', () => {
    const error = new Error('session_orphaned');
    expect(isSessionOrphanedError(error)).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isSessionOrphanedError(null)).toBe(false);
    expect(isSessionOrphanedError(undefined)).toBe(false);
    expect(isSessionOrphanedError('session_orphaned')).toBe(false);
    expect(isSessionOrphanedError({ status: 409, code: 'session_orphaned' })).toBe(false);
  });
});
