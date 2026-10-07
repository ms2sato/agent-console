/**
 * Client-Server Boundary Test: auth preferences REST contract
 *
 * Exercises the real client functions `fetchCurrentUser()` / `updateAuthPreferences()`
 * -> `GET /api/auth/me` / `PATCH /api/auth/me/preferences` server handlers ->
 * real `SqliteUserRepository` against a real in-memory SQLite DB -> JSON
 * response round-trip. Unit tests on either side alone cannot catch schema
 * drift, field-name mismatches, or a route silently reading a mutation it
 * never wrote -- this boundary test locks the full wire contract.
 *
 * `asAppContext`'s default (packages/server/src/__tests__/test-utils.ts)
 * does NOT wire a `userRepository` -- `routes/auth.ts` needs a REAL one to
 * read/write preferences, so every `createTestApp` call here passes one
 * explicitly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Hono } from 'hono';

import {
  createTestApp,
  setupTestEnvironment,
  cleanupTestEnvironment,
  TEST_AUTH_USER,
} from '@agent-console/server/src/__tests__/test-utils';
import type { AppBindings } from '@agent-console/server/src/app-context';
import { getDatabase } from '@agent-console/server/src/database/connection';
import { SqliteUserRepository } from '@agent-console/server/src/repositories/sqlite-user-repository';
import { SingleUserMode } from '@agent-console/server/src/services/user-mode';
import { bunPtyProvider } from '@agent-console/server/src/lib/pty-provider';

import { fetchCurrentUser, updateAuthPreferences, ApiError } from '@agent-console/client/src/lib/api';
import type { CurrentUserResponse, UpdateUserPreferencesResponse } from '@agent-console/shared';

import { createFetchBridge, findRequest } from './test-utils';

describe('Client-Server Boundary: auth preferences REST contract', () => {
  let app: Hono<AppBindings>;
  let bridge: ReturnType<typeof createFetchBridge>;
  let userRepository: SqliteUserRepository;

  beforeEach(async () => {
    await setupTestEnvironment();
    // `setupTestEnvironment()` already seeds a `users` row for
    // `TEST_AUTH_USER.id` via `ensureTestAuthUser` -- cases (a)/(b) work
    // against the default authenticated identity with no extra setup.
    userRepository = new SqliteUserRepository(getDatabase());
    app = await createTestApp({ userRepository });
    bridge = createFetchBridge(app);
  });

  afterEach(async () => {
    bridge.restore();
    await cleanupTestEnvironment();
  });

  it('(a) GET /me returns preferences with the migration default when never PATCHed', async () => {
    const result: CurrentUserResponse = await fetchCurrentUser();

    const request = findRequest(bridge.capturedRequests, 'GET', '/api/auth/me');
    expect(request).toBeDefined();
    expect(request!.method).toBe('GET');

    expect(result.user).not.toBeNull();
    expect(result.user!.id).toBe(TEST_AUTH_USER.id);
    expect(result.preferences).toBeDefined();
    expect(result.preferences!.disableClaudeAiConnectors).toBe(false);
  });

  it('(b) PATCH true then GET round-trips through the real SqliteUserRepository against the real in-memory DB', async () => {
    const patchResult: UpdateUserPreferencesResponse = await updateAuthPreferences({
      disableClaudeAiConnectors: true,
    });

    const patchRequest = findRequest(bridge.capturedRequests, 'PATCH', '/api/auth/me/preferences');
    expect(patchRequest).toBeDefined();
    expect(patchRequest!.body).toEqual({ disableClaudeAiConnectors: true });
    expect(patchResult.preferences.disableClaudeAiConnectors).toBe(true);

    // The real round trip: a SEPARATE GET must read back the same value from
    // the DB the PATCH wrote to, not merely echo the PATCH's own response.
    const getResult = await fetchCurrentUser();
    expect(getResult.preferences!.disableClaudeAiConnectors).toBe(true);

    // POLARITY MEASURED: with routes/auth.ts's `setPreferences` call
    // replaced by `const updated = true;` (the route accepts the PATCH,
    // returns 200, but never actually writes), this test failed at
    // `expect(patchResult.preferences.disableClaudeAiConnectors).toBe(true)`
    // -- Expected: true, Received: false. The route's own post-write
    // `getPreferences` read-back (used to build the PATCH response) truthfully
    // reported the never-written migration default, so the failure surfaced
    // on the PATCH response itself before the test even reached the separate
    // GET round trip below -- a stronger polarity signal than the one
    // originally anticipated, since it proves the SAME read-after-write path
    // the GET assertion also depends on. Restored immediately after;
    // `git diff --stat packages/server/src/routes/auth.ts` showed no diff
    // against the prior commit.
  });

  it('(c) PATCH for an authenticated identity with no users row -> client rejects with a 404 ApiError', async () => {
    // A SEPARATE createTestApp/bridge pointed at a userMode whose cached
    // user id was never inserted into `users` -- `ensureTestAuthUser` only
    // seeds TEST_AUTH_USER.id, never this one.
    const ghostApp = await createTestApp({
      userMode: new SingleUserMode(bunPtyProvider, {
        id: 'no-such-user-id',
        username: 'ghost',
        homeDir: '/home/ghost',
      }),
      userRepository,
    });
    bridge.restore();
    bridge = createFetchBridge(ghostApp);

    let caught: unknown;
    try {
      await updateAuthPreferences({ disableClaudeAiConnectors: true });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(404);
    expect((caught as ApiError).message).toBe('No user row for the authenticated user');
  });

  it('(d) a schema-forbidden body (unknown key) is rejected with 400 at the real wire boundary', async () => {
    // The typed client function's signature will not let us construct an
    // invalid body directly, so this drives the SAME bridged app one layer
    // below the typed client, mirroring create-agent-worker-boundary.test.ts's
    // pattern for exercising a schema-rejection case at this boundary layer.
    const res = await fetch('/api/auth/me/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disableClaudeAiConnectors: true, extraKey: 'nope' }),
    });

    expect(res.status).toBe(400);
  });
});
