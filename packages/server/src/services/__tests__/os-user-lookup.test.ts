/**
 * Tests for the standalone OS user lookup helper.
 *
 * The helper shells out via `Bun.spawn` to platform-native tools
 * (`dscl` on macOS, `id`/`getent` on Linux). These tests exercise
 * "doesn't crash on unknown user" behavior using a clearly fake
 * username; the production code is expected to resolve to null
 * without throwing on any platform.
 *
 * Detailed Bun.spawn argument-shape coverage lives in
 * `user-mode.test.ts` ("MultiUserMode" suite).
 */
import { describe, it, expect } from 'bun:test';
import * as os from 'os';
import * as crypto from 'crypto';
import { lookupOsUser, type LookupOsUserFn, type OsUserInfo } from '../os-user-lookup.js';

const platform = os.platform();
const isSupported = platform === 'darwin' || platform === 'linux';

describe('lookupOsUser', () => {
  it('is exported as a callable function', () => {
    expect(typeof lookupOsUser).toBe('function');
  });

  it('matches the LookupOsUserFn signature', () => {
    // Compile-time assertion: assignability of `lookupOsUser` to `LookupOsUserFn`
    // is the actual check; the `_assignable` reference forces TS to evaluate it
    // even though the value isn't used at runtime.
    const _assignable: LookupOsUserFn = lookupOsUser;
    expect(_assignable).toBe(lookupOsUser);
  });

  // Skip on unsupported platforms — the function returns null without
  // shelling out, so there is no behavior worth asserting.
  it.skipIf(!isSupported)('returns null for an unknown user without throwing', async () => {
    const fakeUsername = `nonexistent-user-${crypto.randomBytes(8).toString('hex')}-zzz`;

    const result: OsUserInfo | null = await lookupOsUser(fakeUsername);
    expect(result).toBeNull();
  });
});
