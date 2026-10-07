/**
 * Tests for SharedAccountRegistry.
 *
 * Release 2 (docs/design/shared-orchestrator-session.md §"Shared-Account Set
 * and Per-Repository Binding (DB-backed)"): the registry is built from the
 * DB-backed shared-account SET via `createFromDb`, which lists rows from a
 * `SharedAccountRepository` and resolves each against the OS. Unlike the
 * removed Release 1 `create()` factory, an unresolvable account never fails
 * the whole registry build -- it is kept as a `resolvable: false` entry (one
 * WARN, boot continues).
 *
 * Tests inject a stub `lookupOsUser` so they don't depend on a real OS
 * account, and a fake `SharedAccountRepository` so they don't depend on
 * `shared_accounts` migration/table details. The user repository is the real
 * SQLite implementation against an in-memory database, so the tests exercise
 * the actual upsert/refresh path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Kysely } from 'kysely';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
import type { SharedAccountRepository, SharedAccountRow } from '../../repositories/shared-account-repository.js';
import { SharedAccountRegistry, type LookupOsUserFn } from '../shared-account-registry.js';

/** A fake `SharedAccountRepository` whose `list()` returns a fixed set of rows. */
function fakeSharedAccountRepository(rows: SharedAccountRow[]): SharedAccountRepository {
  return {
    list: async () => rows,
    register: async () => {},
    unregister: async () => true,
    countBoundRepositories: async () => 0,
    countSessions: async () => 0,
  };
}

describe('SharedAccountRegistry', () => {
  let db: Kysely<Database>;
  let userRepository: SqliteUserRepository;

  beforeEach(async () => {
    db = await createDatabaseForTest();
    userRepository = new SqliteUserRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('createDisabled', () => {
    it('returns a registry with no accounts', () => {
      const registry = SharedAccountRegistry.createDisabled();

      expect(registry.isEnabled()).toBe(false);
      expect(registry.isSharedUserId('any-id')).toBe(false);
      expect(registry.getEntry('any-id')).toBeUndefined();
    });
  });

  describe('createFromDb (empty set)', () => {
    it('returns a disabled registry when the repository lists no rows', async () => {
      const lookup: LookupOsUserFn = async () => {
        throw new Error('lookup should not be called when there are no rows');
      };

      const registry = await SharedAccountRegistry.createFromDb({
        sharedAccountRepository: fakeSharedAccountRepository([]),
        userRepository,
        lookupOsUser: lookup,
      });

      expect(registry.isEnabled()).toBe(false);
    });
  });

  describe('createFromDb (OS account resolves)', () => {
    it('refreshes the users row and exposes a resolvable entry', async () => {
      const authUser = await userRepository.upsertByOsUid(1234, 'shared-user', '/home/shared-user');
      const lookup: LookupOsUserFn = async (username) => {
        expect(username).toBe('shared-user');
        return { uid: 1234, homeDir: '/home/shared-user' };
      };

      const registry = await SharedAccountRegistry.createFromDb({
        sharedAccountRepository: fakeSharedAccountRepository([
          { userId: authUser.id, username: 'shared-user', createdAt: new Date().toISOString(), createdBy: null },
        ]),
        userRepository,
        lookupOsUser: lookup,
      });

      expect(registry.isEnabled()).toBe(true);
      expect(registry.isSharedUserId(authUser.id)).toBe(true);
      expect(registry.isSharedUserId('00000000-0000-0000-0000-000000000000')).toBe(false);

      const entry = registry.getEntry(authUser.id);
      expect(entry).toEqual({ username: 'shared-user', resolvable: true });
    });

    it('passes uid + homeDir from lookup to the users row refresh', async () => {
      // Same os_uid as the lookup below so upsertByOsUid's ON CONFLICT hits
      // this same row (refresh), not a newly inserted one -- the users.id
      // referenced by the shared_accounts row must stay stable across a
      // refresh when the OS account is unchanged.
      const authUser = await userRepository.upsertByOsUid(9988, 'agent-console-shared', '/Users/old-home');
      const lookup: LookupOsUserFn = async () => ({ uid: 9988, homeDir: '/Users/agent-console-shared' });

      await SharedAccountRegistry.createFromDb({
        sharedAccountRepository: fakeSharedAccountRepository([
          { userId: authUser.id, username: 'agent-console-shared', createdAt: new Date().toISOString(), createdBy: null },
        ]),
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

  describe('createFromDb (OS account missing)', () => {
    it('keeps the entry (so isSharedUserId still recognizes it) marked unresolvable, and never throws', async () => {
      const lookup: LookupOsUserFn = async () => null;

      const registry = await SharedAccountRegistry.createFromDb({
        sharedAccountRepository: fakeSharedAccountRepository([
          { userId: 'preexisting-user-id', username: 'no-such-user', createdAt: new Date().toISOString(), createdBy: null },
        ]),
        userRepository,
        lookupOsUser: lookup,
      });

      expect(registry.isEnabled()).toBe(true);
      expect(registry.isSharedUserId('preexisting-user-id')).toBe(true);
      expect(registry.getEntry('preexisting-user-id')).toEqual({ username: 'no-such-user', resolvable: false });
    });

    it('does not upsert a users row when the OS account is missing', async () => {
      const lookup: LookupOsUserFn = async () => null;

      await SharedAccountRegistry.createFromDb({
        sharedAccountRepository: fakeSharedAccountRepository([
          { userId: 'preexisting-user-id', username: 'no-such-user', createdAt: new Date().toISOString(), createdBy: null },
        ]),
        userRepository,
        lookupOsUser: lookup,
      });

      const userCount = await db
        .selectFrom('users')
        .select(db.fn.count<number>('id').as('count'))
        .executeTakeFirstOrThrow();
      expect(userCount.count).toBe(0);
    });
  });

  describe('createFromDb (lookup implementation throws)', () => {
    it('treats the entry as unresolvable rather than failing the whole registry build', async () => {
      const underlyingError = new Error('getent: command not found');
      const lookup: LookupOsUserFn = async () => {
        throw underlyingError;
      };

      const registry = await SharedAccountRegistry.createFromDb({
        sharedAccountRepository: fakeSharedAccountRepository([
          { userId: 'preexisting-user-id', username: 'shared-user', createdAt: new Date().toISOString(), createdBy: null },
        ]),
        userRepository,
        lookupOsUser: lookup,
      });

      expect(registry.getEntry('preexisting-user-id')).toEqual({ username: 'shared-user', resolvable: false });
    });

    it('does not upsert a users row when the lookup throws', async () => {
      const lookup: LookupOsUserFn = async () => {
        throw new Error('getent: command not found');
      };

      await SharedAccountRegistry.createFromDb({
        sharedAccountRepository: fakeSharedAccountRepository([
          { userId: 'preexisting-user-id', username: 'shared-user', createdAt: new Date().toISOString(), createdBy: null },
        ]),
        userRepository,
        lookupOsUser: lookup,
      });

      const userCount = await db
        .selectFrom('users')
        .select(db.fn.count<number>('id').as('count'))
        .executeTakeFirstOrThrow();
      expect(userCount.count).toBe(0);
    });
  });

  describe('register / unregister (no server restart)', () => {
    it('register adds an entry immediately usable by getEntry/isSharedUserId', () => {
      const registry = SharedAccountRegistry.createDisabled();
      expect(registry.isEnabled()).toBe(false);

      registry.register({ userId: 'new-user-id', username: 'newly-registered', resolvable: true });

      expect(registry.isEnabled()).toBe(true);
      expect(registry.isSharedUserId('new-user-id')).toBe(true);
      expect(registry.getEntry('new-user-id')).toEqual({ username: 'newly-registered', resolvable: true });
    });

    it('unregister removes an entry immediately', () => {
      const registry = SharedAccountRegistry.createDisabled();
      registry.register({ userId: 'new-user-id', username: 'newly-registered', resolvable: true });

      registry.unregister('new-user-id');

      expect(registry.isEnabled()).toBe(false);
      expect(registry.isSharedUserId('new-user-id')).toBe(false);
      expect(registry.getEntry('new-user-id')).toBeUndefined();
    });
  });
});
