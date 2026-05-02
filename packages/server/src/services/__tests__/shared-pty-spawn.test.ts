/**
 * Integration confidence test: per-user PTY spawn for shared sessions.
 *
 * The existing `resolveSpawnUsername` function takes a session's `createdBy`
 * (a users.id UUID) and resolves it to the OS username used for sudo. Shared
 * sessions store the shared account's users.id in `created_by`, so the
 * existing resolver should naturally hand back the shared account's
 * username when invoked. This test pins that expectation so a future change
 * to the resolver does not silently break shared-session PTY spawning.
 *
 * See docs/design/shared-orchestrator-session.md §"Session Creation Flow"
 * step 5 ("server uses sudo -u <shared-account-name>").
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createDatabaseForTest } from '../../database/connection.js';
import type { Kysely } from 'kysely';
import type { Database } from '../../database/schema.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
import { resolveSpawnUsername } from '../resolve-spawn-username.js';

describe('shared-account PTY spawn integration (resolveSpawnUsername)', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = await createDatabaseForTest();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('resolves a session.createdBy pointing at the shared account to the shared username', async () => {
    const userRepository = new SqliteUserRepository(db);

    // Simulate startup upserting the shared account row (the registry does
    // this in production via SharedAccountRegistry.create).
    const sharedAccount = await userRepository.upsertByOsUid(
      4242,
      'shared-user',
      '/home/shared-user',
    );

    // A session whose createdBy is the shared account's users.id (the
    // route-handler invariant for `shared: true` requests).
    const username = await resolveSpawnUsername(sharedAccount.id, userRepository);

    expect(username).toBe('shared-user');
  });
});
