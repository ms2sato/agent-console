/**
 * Tests for SharedAccountRegistry.
 *
 * The factory has three startup paths:
 *  1. username unset            → registry disabled, no upsert.
 *  2. username set + OS account → upsert into users table, cache the userId.
 *  3. username set + missing OS → factory throws (server fails fast).
 *
 * Tests inject a stub `lookupOsUser` so they don't depend on a real OS
 * account. The user repository is the real SQLite implementation against an
 * in-memory database, so the tests exercise the actual upsert path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Kysely } from 'kysely';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
import { SharedAccountRegistry, type LookupOsUserFn } from '../shared-account-registry.js';

describe('SharedAccountRegistry', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = await createDatabaseForTest();
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('disabled (username unset)', () => {
    it('returns a registry with no accounts when username is undefined', async () => {
      const userRepository = new SqliteUserRepository(db);
      const lookup: LookupOsUserFn = async () => {
        throw new Error('lookup should not be called when username is undefined');
      };

      const registry = await SharedAccountRegistry.create({
        username: undefined,
        userRepository,
        lookupOsUser: lookup,
      });

      expect(registry.isEnabled()).toBe(false);
      expect(registry.getDefaultUserId()).toBeNull();
      expect(registry.getDefaultUsername()).toBeNull();
    });

    it('does not insert any users row when disabled', async () => {
      const userRepository = new SqliteUserRepository(db);

      await SharedAccountRegistry.create({
        username: undefined,
        userRepository,
        lookupOsUser: async () => null,
      });

      const userCount = await db
        .selectFrom('users')
        .select(db.fn.count<number>('id').as('count'))
        .executeTakeFirstOrThrow();
      expect(userCount.count).toBe(0);
    });
  });

  describe('enabled (username set + OS account exists)', () => {
    it('upserts the shared account and exposes its users.id', async () => {
      const userRepository = new SqliteUserRepository(db);
      const lookup: LookupOsUserFn = async (username) => {
        expect(username).toBe('shared-user');
        return { uid: 1234, homeDir: '/home/shared-user' };
      };

      const registry = await SharedAccountRegistry.create({
        username: 'shared-user',
        userRepository,
        lookupOsUser: lookup,
      });

      expect(registry.isEnabled()).toBe(true);

      const sharedUserId = registry.getDefaultUserId();
      expect(sharedUserId).not.toBeNull();
      expect(registry.getDefaultUsername()).toBe('shared-user');

      // Verify the row exists in DB and matches the cached id.
      const dbUser = await userRepository.findById(sharedUserId!);
      expect(dbUser).not.toBeNull();
      expect(dbUser!.username).toBe('shared-user');
      expect(dbUser!.homeDir).toBe('/home/shared-user');

      // isSharedUserId discriminates correctly.
      expect(registry.isSharedUserId(sharedUserId!)).toBe(true);
      expect(registry.isSharedUserId('00000000-0000-0000-0000-000000000000')).toBe(false);
    });

    it('passes uid + homeDir from lookup to upsertByOsUid', async () => {
      const userRepository = new SqliteUserRepository(db);
      const lookup: LookupOsUserFn = async () => ({ uid: 9988, homeDir: '/Users/agent-console-shared' });

      await SharedAccountRegistry.create({
        username: 'agent-console-shared',
        userRepository,
        lookupOsUser: lookup,
      });

      const row = await db
        .selectFrom('users')
        .where('username', '=', 'agent-console-shared')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(row.os_uid).toBe(9988);
      expect(row.home_dir).toBe('/Users/agent-console-shared');
    });
  });

  describe('misconfigured (username set + OS account missing)', () => {
    it('throws a clear startup error referencing the configured username', async () => {
      const userRepository = new SqliteUserRepository(db);
      const lookup: LookupOsUserFn = async () => null;

      await expect(
        SharedAccountRegistry.create({
          username: 'no-such-user',
          userRepository,
          lookupOsUser: lookup,
        }),
      ).rejects.toThrow(/no-such-user/);

      await expect(
        SharedAccountRegistry.create({
          username: 'no-such-user',
          userRepository,
          lookupOsUser: lookup,
        }),
      ).rejects.toThrow(/does not resolve/);
    });

    it('does not create a users row when the OS account is missing', async () => {
      const userRepository = new SqliteUserRepository(db);
      const lookup: LookupOsUserFn = async () => null;

      try {
        await SharedAccountRegistry.create({
          username: 'no-such-user',
          userRepository,
          lookupOsUser: lookup,
        });
      } catch {
        // expected
      }

      const userCount = await db
        .selectFrom('users')
        .select(db.fn.count<number>('id').as('count'))
        .executeTakeFirstOrThrow();
      expect(userCount.count).toBe(0);
    });
  });
});
