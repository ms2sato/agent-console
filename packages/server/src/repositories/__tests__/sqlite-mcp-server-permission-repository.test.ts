/**
 * Sibling test for `SqliteMcpServerPermissionRepository`.
 *
 * Pure in-memory-DB test, no real filesystem needed -- same shape as
 * `sqlite-bookmark-repository.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Kysely } from 'kysely';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteMcpServerPermissionRepository } from '../sqlite-mcp-server-permission-repository.js';

describe('SqliteMcpServerPermissionRepository', () => {
  let db: Kysely<Database>;
  let repository: SqliteMcpServerPermissionRepository;

  beforeEach(async () => {
    db = await createDatabaseForTest();
    repository = new SqliteMcpServerPermissionRepository(db);

    const now = new Date().toISOString();
    for (const id of ['repo-1', 'repo-2']) {
      await db
        .insertInto('repositories')
        .values({ id, name: id, path: `/tmp/${id}`, created_at: now, updated_at: now })
        .execute();
    }
    for (const id of ['user-1', 'user-2']) {
      await db
        .insertInto('users')
        .values({ id, os_uid: null, username: id, home_dir: `/home/${id}`, created_at: now, updated_at: now })
        .execute();
    }
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('upsert', () => {
    it('inserts a new row and returns it', async () => {
      const row = await repository.upsert({
        repositoryId: 'repo-1',
        serverName: 'chrome-devtools',
        configHash: 'hash-1',
        decision: 'allow',
        decidedBy: 'user-1',
      });

      expect(row.repositoryId).toBe('repo-1');
      expect(row.serverName).toBe('chrome-devtools');
      expect(row.configHash).toBe('hash-1');
      expect(row.decision).toBe('allow');
      expect(row.decidedBy).toBe('user-1');
      expect(row.id).toBeTruthy();
      expect(row.createdAt).toBeTruthy();
      expect(row.decidedAt).toBeTruthy();
    });

    it('overwrites decision/decidedBy/decidedAt on a repeat upsert against the same key, keeping the same id and createdAt', async () => {
      const first = await repository.upsert({
        repositoryId: 'repo-1',
        serverName: 'chrome-devtools',
        configHash: 'hash-1',
        decision: 'deny',
        decidedBy: 'user-1',
      });

      // Force a real time gap so decidedAt is verifiably moved forward, not
      // merely re-asserted with the same millisecond value.
      await new Promise((resolve) => setTimeout(resolve, 5));

      const second = await repository.upsert({
        repositoryId: 'repo-1',
        serverName: 'chrome-devtools',
        configHash: 'hash-1',
        decision: 'allow',
        decidedBy: 'user-2',
      });

      expect(second.id).toBe(first.id);
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.decision).toBe('allow');
      expect(second.decidedBy).toBe('user-2');
      expect(second.decidedAt).not.toBe(first.decidedAt);
      expect(new Date(second.decidedAt).getTime()).toBeGreaterThan(new Date(first.decidedAt).getTime());

      const rows = await repository.listByRepository('repo-1');
      expect(rows).toHaveLength(1);
    });

    it('gives a second, distinct key its own id', async () => {
      const first = await repository.upsert({
        repositoryId: 'repo-1',
        serverName: 'chrome-devtools',
        configHash: 'hash-1',
        decision: 'allow',
        decidedBy: 'user-1',
      });
      const second = await repository.upsert({
        repositoryId: 'repo-1',
        serverName: 'other-server',
        configHash: 'hash-2',
        decision: 'deny',
        decidedBy: 'user-1',
      });

      expect(second.id).not.toBe(first.id);

      const rows = await repository.listByRepository('repo-1');
      expect(rows).toHaveLength(2);
    });

    it('treats a changed configHash under the same server name as a distinct key', async () => {
      const first = await repository.upsert({
        repositoryId: 'repo-1',
        serverName: 'chrome-devtools',
        configHash: 'hash-1',
        decision: 'allow',
        decidedBy: 'user-1',
      });
      const second = await repository.upsert({
        repositoryId: 'repo-1',
        serverName: 'chrome-devtools',
        configHash: 'hash-2',
        decision: 'allow',
        decidedBy: 'user-1',
      });

      expect(second.id).not.toBe(first.id);
      const rows = await repository.listByRepository('repo-1');
      expect(rows).toHaveLength(2);
    });
  });

  describe('listByRepository', () => {
    it('scopes to the given repository, no cross-contamination', async () => {
      await repository.upsert({
        repositoryId: 'repo-1',
        serverName: 'chrome-devtools',
        configHash: 'hash-1',
        decision: 'allow',
        decidedBy: 'user-1',
      });
      await repository.upsert({
        repositoryId: 'repo-2',
        serverName: 'chrome-devtools',
        configHash: 'hash-1',
        decision: 'deny',
        decidedBy: 'user-1',
      });

      const repo1Rows = await repository.listByRepository('repo-1');
      const repo2Rows = await repository.listByRepository('repo-2');

      expect(repo1Rows).toHaveLength(1);
      expect(repo1Rows[0]?.decision).toBe('allow');
      expect(repo2Rows).toHaveLength(1);
      expect(repo2Rows[0]?.decision).toBe('deny');
    });

    it('returns an empty array for a repository with no rows', async () => {
      const rows = await repository.listByRepository('repo-2');
      expect(rows).toEqual([]);
    });
  });

  describe('get', () => {
    it('returns null for a nonexistent key', async () => {
      const row = await repository.get('repo-1', 'chrome-devtools', 'hash-1');
      expect(row).toBeNull();
    });

    it('returns the row for an existing key', async () => {
      await repository.upsert({
        repositoryId: 'repo-1',
        serverName: 'chrome-devtools',
        configHash: 'hash-1',
        decision: 'allow',
        decidedBy: 'user-1',
      });

      const row = await repository.get('repo-1', 'chrome-devtools', 'hash-1');
      expect(row?.decision).toBe('allow');
    });
  });

  describe('CASCADE behavior', () => {
    it('removes the row when its repository is deleted', async () => {
      await repository.upsert({
        repositoryId: 'repo-1',
        serverName: 'chrome-devtools',
        configHash: 'hash-1',
        decision: 'allow',
        decidedBy: 'user-1',
      });

      await db.deleteFrom('repositories').where('id', '=', 'repo-1').execute();

      const rows = await repository.listByRepository('repo-1');
      expect(rows).toEqual([]);
    });

    it('removes the row when its decidedBy user is deleted', async () => {
      await repository.upsert({
        repositoryId: 'repo-1',
        serverName: 'chrome-devtools',
        configHash: 'hash-1',
        decision: 'allow',
        decidedBy: 'user-1',
      });

      await db.deleteFrom('users').where('id', '=', 'user-1').execute();

      const rows = await repository.listByRepository('repo-1');
      expect(rows).toEqual([]);
    });
  });
});
