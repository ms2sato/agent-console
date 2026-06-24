import { describe, it, expect } from 'bun:test';
import { CLONE_ERROR_CODES, type CloneErrorCode } from '@agent-console/shared';
import { formatCloneJobError } from '../clone-error-messages';

describe('formatCloneJobError', () => {
  it('returns a human-readable string for each classified code', () => {
    // `CLONE_ERROR_CODES` is exported as a keyed object in shared schemas
    // (e.g. `{ AUTH_FAILED: 'auth_failed', ... }`), so iterate the values
    // rather than the keys to get the wire-level codes.
    for (const code of Object.values(CLONE_ERROR_CODES)) {
      const out = formatCloneJobError({ code, message: 'raw' });
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it('falls back to the raw server message when code is unknown', () => {
    const message = 'rc=137; oom killed';
    expect(formatCloneJobError({ code: 'unknown', message })).toBe(message);
  });

  it('uses a generic fallback when an unknown code has an empty server message', () => {
    expect(
      formatCloneJobError({ code: 'unknown', message: '' })
    ).toBe('An unknown error occurred while cloning.');
  });

  it('maps known codes to deterministic copy', () => {
    expect(formatCloneJobError({ code: 'auth_failed', message: 'irrelevant' }))
      .toMatch(/Authentication failed/);
    expect(formatCloneJobError({ code: 'network_error', message: '' }))
      .toMatch(/Network error/);
    expect(formatCloneJobError({ code: 'repo_not_found', message: '' }))
      .toMatch(/not found/);
    expect(formatCloneJobError({ code: 'permission_denied', message: '' }))
      .toMatch(/Permission denied/);
    expect(formatCloneJobError({ code: 'name_conflict', message: '' }))
      .toMatch(/already exists/);
    expect(formatCloneJobError({ code: 'timeout', message: '' }))
      .toMatch(/took too long/);
    expect(formatCloneJobError({ code: 'validation_error', message: '' }))
      .toMatch(/invalid/);
  });

  it('defensive: a future server code we do not know about falls back to the server message', () => {
    // `as CloneErrorCode` simulates a server adding a new code that the
    // client has not been updated for yet.
    const futureCode = 'rate_limited' as CloneErrorCode;
    expect(
      formatCloneJobError({ code: futureCode, message: 'Slow down.' })
    ).toBe('Slow down.');
  });
});
