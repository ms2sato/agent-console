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

  describe('createFromDb (OS account resolves to the SAME uid it was registered with)', () => {
    it('refreshes username/homeDir but keeps the ORIGINAL persisted userId', async () => {
      const authUser = await userRepository.upsertByOsUid(5050, 'shared-bot', '/home/shared-bot');
      const lookup: LookupOsUserFn = async () => ({ uid: 5050, homeDir: '/home/shared-bot-new' });

      const registry = await SharedAccountRegistry.createFromDb({
        sharedAccountRepository: fakeSharedAccountRepository([
          { userId: authUser.id, username: 'shared-bot-renamed', createdAt: new Date().toISOString(), createdBy: null },
        ]),
        userRepository,
        lookupOsUser: lookup,
      });

      expect(registry.getEntry(authUser.id)).toEqual({ username: 'shared-bot-renamed', resolvable: true });

      const row = await db
        .selectFrom('users')
        .where('id', '=', authUser.id)
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(row.username).toBe('shared-bot-renamed');
      expect(row.home_dir).toBe('/home/shared-bot-new');
      expect(row.os_uid).toBe(5050);
    });
  });

  describe('createFromDb (OS account now resolves to a DIFFERENT, REASSIGNED uid)', () => {
    it('marks the entry unresolvable, keeps the ORIGINAL persisted userId, and never touches the unrelated row now holding that uid', async () => {
      // The shared account's ORIGINAL users row, persisted at uid 5959 --
      // a genuinely existing row, so getOsUidById(originalAuthUser.id)
      // resolves to 5959 (not undefined), exercising the uid-MISMATCH
      // comparison branch (persistedOsUid !== osInfo.uid) specifically,
      // not the separate "row gone" branch covered by the test below.
      const originalAuthUser = await userRepository.upsertByOsUid(5959, 'shared-bot', '/home/shared-bot');

      // Seed a SEPARATE, pre-existing, unrelated users row at the uid the
      // lookup will now return for the shared account's username --
      // simulating "this uid now belongs to someone else" (e.g. the shared
      // account's OS account was deleted and its uid recycled to a real
      // human user).
      const unrelatedHuman = await userRepository.upsertByOsUid(6060, 'some-human', '/home/some-human');

      const lookup: LookupOsUserFn = async () => ({ uid: 6060, homeDir: '/home/some-human' });

      const registry = await SharedAccountRegistry.createFromDb({
        sharedAccountRepository: fakeSharedAccountRepository([
          { userId: originalAuthUser.id, username: 'shared-bot', createdAt: new Date().toISOString(), createdBy: null },
        ]),
        userRepository,
        lookupOsUser: lookup,
      });

      // (a) resolvable: false, with the ORIGINAL persisted userId -- never
      // the unrelated row's id.
      expect(registry.isSharedUserId(originalAuthUser.id)).toBe(true);
      expect(registry.getEntry(originalAuthUser.id)).toEqual({ username: 'shared-bot', resolvable: false });
      expect(registry.isSharedUserId(unrelatedHuman.id)).toBe(false);

      // (b) the unrelated row is verifiably untouched.
      const row = await db
        .selectFrom('users')
        .where('id', '=', unrelatedHuman.id)
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(row.username).toBe('some-human');
      expect(row.home_dir).toBe('/home/some-human');
      expect(row.os_uid).toBe(6060);
    });
  });

  describe('createFromDb (persisted user row no longer exists)', () => {
    it('marks the entry unresolvable and does not throw, even though this should be unreachable in practice', async () => {
      const lookup: LookupOsUserFn = async () => ({ uid: 7070, homeDir: '/home/ghost' });

      const registry = await SharedAccountRegistry.createFromDb({
        sharedAccountRepository: fakeSharedAccountRepository([
          { userId: 'row-does-not-exist-id', username: 'ghost-bot', createdAt: new Date().toISOString(), createdBy: null },
        ]),
        userRepository,
        lookupOsUser: lookup,
      });

      expect(registry.getEntry('row-does-not-exist-id')).toEqual({ username: 'ghost-bot', resolvable: false });
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
