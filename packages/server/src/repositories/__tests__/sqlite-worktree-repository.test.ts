import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Kysely, sql } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import { SqliteWorktreeRepository } from '../sqlite-worktree-repository.js';
import type { Database } from '../../database/schema.js';
import type { WorktreeRecord } from '../worktree-repository.js';

const NOW_ISO8601 = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

describe('SqliteWorktreeRepository', () => {
  let bunDb: BunDatabase;
  let db: Kysely<Database>;
  let repository: SqliteWorktreeRepository;

  beforeEach(async () => {
    // Create in-memory database
    bunDb = new BunDatabase(':memory:');
    bunDb.exec('PRAGMA foreign_keys = ON;');

    db = new Kysely<Database>({
      dialect: new BunSqliteDialect({ database: bunDb }),
    });

    // Create repositories table (required for foreign key)
    await db.schema
      .createTable('repositories')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('path', 'text', (col) => col.notNull().unique())
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(NOW_ISO8601))
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(NOW_ISO8601))
      .addColumn('setup_command', 'text')
      .addColumn('env_vars', 'text')
      .addColumn('description', 'text')
      .execute();

    // Create worktrees table
    await db.schema
      .createTable('worktrees')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('repository_id', 'text', (col) =>
        col.notNull().references('repositories.id').onDelete('cascade')
      )
      .addColumn('path', 'text', (col) => col.notNull().unique())
      .addColumn('index_number', 'integer', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(NOW_ISO8601))
      .execute();

    repository = new SqliteWorktreeRepository(db);

    // Insert a default repository for foreign key references
    await db
      .insertInto('repositories')
      .values({
        id: 'repo-1',
        name: 'Test Repository',
        path: '/test/repo',
      })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
    bunDb.close();
  });

  // ========== Helper Functions ==========

  function createWorktreeRecord(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
    return {
      id: overrides.id ?? 'wt-test-id',
      repositoryId: overrides.repositoryId ?? 'repo-1',
      path: overrides.path ?? '/test/repo/worktrees/wt-001',
      indexNumber: overrides.indexNumber ?? 1,
      createdAt: overrides.createdAt ?? new Date().toISOString(),
    };
  }

  async function insertRepository(id: string, path: string): Promise<void> {
    await db
      .insertInto('repositories')
      .values({
        id,
        name: `Repository ${id}`,
        path,
      })
      .execute();
  }

  // ========== Test Suites ==========

  describe('save and findByPath', () => {
    it('should save a worktree and find it by path', async () => {
      const record = createWorktreeRecord({
        id: 'wt-1',
        path: '/test/repo/worktrees/wt-001',
        indexNumber: 1,
      });

      await repository.save(record);

      const found = await repository.findByPath('/test/repo/worktrees/wt-001');

      expect(found).not.toBeNull();
      expect(found?.id).toBe('wt-1');
      expect(found?.repositoryId).toBe('repo-1');
      expect(found?.path).toBe('/test/repo/worktrees/wt-001');
      expect(found?.indexNumber).toBe(1);
      expect(found?.createdAt).toBe(record.createdAt);
    });

    it('should return null for non-existent path', async () => {
      const found = await repository.findByPath('/non/existent/path');
      expect(found).toBeNull();
    });

    it('should return null when no worktrees exist', async () => {
      const found = await repository.findByPath('/any/path');
      expect(found).toBeNull();
    });

    it('should enforce unique path constraint', async () => {
      const record1 = createWorktreeRecord({ id: 'wt-1', path: '/same/path' });
      await repository.save(record1);

      const record2 = createWorktreeRecord({ id: 'wt-2', path: '/same/path' });
      await expect(repository.save(record2)).rejects.toThrow();
    });
  });

  describe('save and findByRepositoryId', () => {
    it('should find all worktrees belonging to a repository', async () => {
      const wt1 = createWorktreeRecord({
        id: 'wt-1',
        path: '/test/worktrees/wt-001',
        indexNumber: 1,
      });
      const wt2 = createWorktreeRecord({
        id: 'wt-2',
        path: '/test/worktrees/wt-002',
        indexNumber: 2,
      });

      await repository.save(wt1);
      await repository.save(wt2);

      const found = await repository.findByRepositoryId('repo-1');

      expect(found.length).toBe(2);
      expect(found.map((w) => w.id).sort()).toEqual(['wt-1', 'wt-2']);
    });

    it('should return empty array when repository has no worktrees', async () => {
      const found = await repository.findByRepositoryId('repo-1');
      expect(found).toEqual([]);
    });

    it('should return empty array for non-existent repository', async () => {
      const found = await repository.findByRepositoryId('non-existent');
      expect(found).toEqual([]);
    });

    it('should only return worktrees for the specified repository', async () => {
      await insertRepository('repo-2', '/test/repo-2');

      const wt1 = createWorktreeRecord({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/test/repo/worktrees/wt-001',
        indexNumber: 1,
      });
      const wt2 = createWorktreeRecord({
        id: 'wt-2',
        repositoryId: 'repo-2',
        path: '/test/repo-2/worktrees/wt-001',
        indexNumber: 1,
      });

      await repository.save(wt1);
      await repository.save(wt2);

      const repo1Worktrees = await repository.findByRepositoryId('repo-1');
      expect(repo1Worktrees.length).toBe(1);
      expect(repo1Worktrees[0].id).toBe('wt-1');

      const repo2Worktrees = await repository.findByRepositoryId('repo-2');
      expect(repo2Worktrees.length).toBe(1);
      expect(repo2Worktrees[0].id).toBe('wt-2');
    });
  });

  describe('deleteByPath', () => {
    it('should remove the worktree record', async () => {
      const record = createWorktreeRecord({
        id: 'wt-1',
        path: '/test/worktrees/wt-001',
      });
      await repository.save(record);

      await repository.deleteByPath('/test/worktrees/wt-001');

      const found = await repository.findByPath('/test/worktrees/wt-001');
      expect(found).toBeNull();
    });

    it('should not fail when path does not exist', async () => {
      await expect(repository.deleteByPath('/non/existent/path')).resolves.toBeUndefined();
    });

    it('should not affect other worktrees', async () => {
      const wt1 = createWorktreeRecord({
        id: 'wt-1',
        path: '/test/worktrees/wt-001',
        indexNumber: 1,
      });
      const wt2 = createWorktreeRecord({
        id: 'wt-2',
        path: '/test/worktrees/wt-002',
        indexNumber: 2,
      });

      await repository.save(wt1);
      await repository.save(wt2);

      await repository.deleteByPath('/test/worktrees/wt-001');

      const remaining = await repository.findByPath('/test/worktrees/wt-002');
      expect(remaining).not.toBeNull();
      expect(remaining?.id).toBe('wt-2');

      const allForRepo = await repository.findByRepositoryId('repo-1');
      expect(allForRepo.length).toBe(1);
    });
  });

  describe('CASCADE delete', () => {
    it('should delete worktrees when parent repository is deleted', async () => {
      const wt1 = createWorktreeRecord({
        id: 'wt-1',
        path: '/test/worktrees/wt-001',
        indexNumber: 1,
      });
      const wt2 = createWorktreeRecord({
        id: 'wt-2',
        path: '/test/worktrees/wt-002',
        indexNumber: 2,
      });

      await repository.save(wt1);
      await repository.save(wt2);

      // Verify worktrees exist
      const beforeDelete = await repository.findByRepositoryId('repo-1');
      expect(beforeDelete.length).toBe(2);

      // Delete the parent repository
      await db.deleteFrom('repositories').where('id', '=', 'repo-1').execute();

      // Worktrees should be cascade-deleted
      const afterDelete = await repository.findByRepositoryId('repo-1');
      expect(afterDelete).toEqual([]);

      const wt1Found = await repository.findByPath('/test/worktrees/wt-001');
      expect(wt1Found).toBeNull();

      const wt2Found = await repository.findByPath('/test/worktrees/wt-002');
      expect(wt2Found).toBeNull();
    });

    it('should not affect worktrees of other repositories', async () => {
      await insertRepository('repo-2', '/test/repo-2');

      const wt1 = createWorktreeRecord({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/test/repo/worktrees/wt-001',
        indexNumber: 1,
      });
      const wt2 = createWorktreeRecord({
        id: 'wt-2',
        repositoryId: 'repo-2',
        path: '/test/repo-2/worktrees/wt-001',
        indexNumber: 1,
      });

      await repository.save(wt1);
      await repository.save(wt2);

      // Delete repo-1
      await db.deleteFrom('repositories').where('id', '=', 'repo-1').execute();

      // repo-2's worktree should still exist
      const repo2Worktrees = await repository.findByRepositoryId('repo-2');
      expect(repo2Worktrees.length).toBe(1);
      expect(repo2Worktrees[0].id).toBe('wt-2');
    });
  });

  describe('edge cases', () => {
    it('should handle paths with special characters', async () => {
      const record = createWorktreeRecord({
        id: 'wt-special',
        path: '/path/with spaces/and-dashes/and_underscores',
      });

      await repository.save(record);

      const found = await repository.findByPath('/path/with spaces/and-dashes/and_underscores');
      expect(found?.path).toBe('/path/with spaces/and-dashes/and_underscores');
    });

    it('should preserve all fields correctly', async () => {
      const createdAt = '2024-03-15T12:00:00.000Z';
      const record = createWorktreeRecord({
        id: 'wt-full',
        repositoryId: 'repo-1',
        path: '/test/worktrees/wt-042',
        indexNumber: 42,
        createdAt,
      });

      await repository.save(record);

      const found = await repository.findByPath('/test/worktrees/wt-042');
      expect(found?.id).toBe('wt-full');
      expect(found?.repositoryId).toBe('repo-1');
      expect(found?.path).toBe('/test/worktrees/wt-042');
      expect(found?.indexNumber).toBe(42);
      expect(found?.createdAt).toBe(createdAt);
    });

    it('should reject worktree with non-existent repository_id', async () => {
      const record = createWorktreeRecord({
        id: 'wt-orphan',
        repositoryId: 'non-existent-repo',
        path: '/test/worktrees/wt-orphan',
      });

      await expect(repository.save(record)).rejects.toThrow();
    });
  });
});
