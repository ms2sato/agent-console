/**
 * Sibling test for `SqliteSharedAccountRepository`.
 *
 * Uses the real migration chain (`createDatabaseForTest`) so `shared_accounts`
 * and its foreign keys (`users`, `repositories`) exist exactly as migration
 * v47 defines them -- no hand-rolled schema duplication.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Kysely } from 'kysely';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteSharedAccountRepository } from '../sqlite-shared-account-repository.js';
import { SqliteRepositoryRepository } from '../sqlite-repository-repository.js';

async function insertUser(db: Kysely<Database>, id: string, username = id): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto('users')
    .values({ id, os_uid: null, username, home_dir: `/home/${username}`, created_at: now, updated_at: now })
    .execute();
}

describe('SqliteSharedAccountRepository', () => {
  let db: Kysely<Database>;
  let repository: SqliteSharedAccountRepository;

  beforeEach(async () => {
    db = await createDatabaseForTest();
    repository = new SqliteSharedAccountRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('register + list', () => {
    it('lists a registered account with the resolved username', async () => {
      await insertUser(db, 'user-shared', 'shared-bot');
      await insertUser(db, 'user-admin', 'admin');

      await repository.register('user-shared', 'user-admin');

      const accounts = await repository.list();
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        userId: 'user-shared',
        username: 'shared-bot',
        createdBy: 'user-admin',
      });
      expect(typeof accounts[0]?.createdAt).toBe('string');
    });

    it('registers with createdBy null (e.g. import-env self-registration)', async () => {
      await insertUser(db, 'user-shared', 'shared-bot');

      await repository.register('user-shared', null);

      const accounts = await repository.list();
      expect(accounts[0]?.createdBy).toBeNull();
    });

    it('returns an empty list when nothing is registered', async () => {
      expect(await repository.list()).toEqual([]);
    });
  });

  describe('unregister', () => {
    it('removes a registered account and returns true', async () => {
      await insertUser(db, 'user-shared');
      await repository.register('user-shared', null);

      const result = await repository.unregister('user-shared');
      expect(result).toBe(true);
      expect(await repository.list()).toEqual([]);
    });

    it('returns false for an unknown id', async () => {
      const result = await repository.unregister('nonexistent-user');
      expect(result).toBe(false);
    });

    it('rejects when the account is bound to a repository (ON DELETE RESTRICT)', async () => {
      await insertUser(db, 'user-shared');
      await repository.register('user-shared', null);

      const repoRepository = new SqliteRepositoryRepository(db);
      await repoRepository.save({
        id: 'repo-1',
        name: 'repo-1',
        path: '/tmp/repo-1',
        createdAt: new Date().toISOString(),
        orchestratorSessionIds: [],
        clonedSourceRepoPath: null,
      });
      await repoRepository.update('repo-1', { sharedAccountUserId: 'user-shared' });

      // Deliberately does NOT swallow the FK error -- proving the repository
      // layer lets the RESTRICT throw propagate, per its own contract.
      await expect(repository.unregister('user-shared')).rejects.toThrow();

      // The row must still exist -- the failed delete must not have removed it.
      expect(await repository.list()).toHaveLength(1);
    });
  });

  describe('countBoundRepositories', () => {
    it('is 0 before any binding', async () => {
      await insertUser(db, 'user-shared');
      await repository.register('user-shared', null);

      expect(await repository.countBoundRepositories('user-shared')).toBe(0);
    });

    it('counts repositories bound to the account', async () => {
      await insertUser(db, 'user-shared');
      await repository.register('user-shared', null);

      const repoRepository = new SqliteRepositoryRepository(db);
      for (const id of ['repo-a', 'repo-b']) {
        await repoRepository.save({
          id,
          name: id,
          path: `/tmp/${id}`,
          createdAt: new Date().toISOString(),
          orchestratorSessionIds: [],
          clonedSourceRepoPath: null,
        });
        await repoRepository.update(id, { sharedAccountUserId: 'user-shared' });
      }

      expect(await repository.countBoundRepositories('user-shared')).toBe(2);
    });
  });

  describe('countSessions', () => {
    it('is 0 before any session exists', async () => {
      await insertUser(db, 'user-shared');
      await repository.register('user-shared', null);

      expect(await repository.countSessions('user-shared')).toBe(0);
    });

    it('counts sessions created by the account', async () => {
      await insertUser(db, 'user-shared');
      await repository.register('user-shared', null);

      await db
        .insertInto('sessions')
        .values({
          id: 'session-1',
          type: 'quick',
          location_path: '/tmp/quick-1',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          server_pid: null,
          initial_prompt: null,
          title: null,
          repository_id: null,
          worktree_id: null,
          created_by: 'user-shared',
        })
        .execute();

      expect(await repository.countSessions('user-shared')).toBe(1);
    });
  });
});
