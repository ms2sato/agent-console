import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import { SqliteRepositoryRepository } from '../sqlite-repository-repository.js';
import type { Database } from '../../database/schema.js';
import type { Repository } from '@agent-console/shared';

describe('SqliteRepositoryRepository', () => {
  let bunDb: BunDatabase;
  let db: Kysely<Database>;
  let repository: SqliteRepositoryRepository;

  beforeEach(async () => {
    // Create in-memory database
    bunDb = new BunDatabase(':memory:');
    bunDb.exec('PRAGMA foreign_keys = ON;');

    db = new Kysely<Database>({
      dialect: new BunSqliteDialect({ database: bunDb }),
    });

    // Create tables manually (v2 schema)
    await db.schema
      .createTable('repositories')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('path', 'text', (col) => col.notNull().unique())
      .addColumn('registered_at', 'text', (col) => col.notNull())
      .execute();

    repository = new SqliteRepositoryRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
    bunDb.close();
  });

  // ========== Helper Functions ==========

  function createRepository(overrides: Partial<Repository> = {}): Repository {
    return {
      id: overrides.id ?? 'test-repo-id',
      name: overrides.name ?? 'test-repo',
      path: overrides.path ?? '/test/path/repo',
      registeredAt: overrides.registeredAt ?? new Date().toISOString(),
    };
  }

  // ========== Test Suites ==========

  describe('findAll', () => {
    it('should return empty array when no repositories exist', async () => {
      const repositories = await repository.findAll();
      expect(repositories).toEqual([]);
    });

    it('should return all repositories', async () => {
      const repo1 = createRepository({ id: 'repo-1', path: '/path/1' });
      const repo2 = createRepository({ id: 'repo-2', path: '/path/2' });

      await repository.save(repo1);
      await repository.save(repo2);

      const repositories = await repository.findAll();

      expect(repositories.length).toBe(2);
      expect(repositories.map((r) => r.id).sort()).toEqual(['repo-1', 'repo-2']);
    });
  });

  describe('findById', () => {
    it('should return repository if exists', async () => {
      const repo = createRepository({ id: 'find-me', name: 'Find Me' });
      await repository.save(repo);

      const found = await repository.findById('find-me');

      expect(found).not.toBeNull();
      expect(found?.id).toBe('find-me');
      expect(found?.name).toBe('Find Me');
    });

    it('should return null if repository not found', async () => {
      const repo = createRepository({ id: 'existing' });
      await repository.save(repo);

      const found = await repository.findById('non-existent');

      expect(found).toBeNull();
    });

    it('should return null when no repositories exist', async () => {
      const found = await repository.findById('any-id');
      expect(found).toBeNull();
    });
  });

  describe('findByPath', () => {
    it('should return repository if path matches', async () => {
      const repo = createRepository({
        id: 'repo-by-path',
        path: '/projects/my-project',
      });
      await repository.save(repo);

      const found = await repository.findByPath('/projects/my-project');

      expect(found).not.toBeNull();
      expect(found?.id).toBe('repo-by-path');
      expect(found?.path).toBe('/projects/my-project');
    });

    it('should return null if path not found', async () => {
      const repo = createRepository({ path: '/projects/existing' });
      await repository.save(repo);

      const found = await repository.findByPath('/projects/not-existing');

      expect(found).toBeNull();
    });

    it('should be case-sensitive for paths', async () => {
      const repo = createRepository({ path: '/Projects/MyProject' });
      await repository.save(repo);

      const found = await repository.findByPath('/projects/myproject');

      expect(found).toBeNull();
    });
  });

  describe('save', () => {
    it('should insert new repository', async () => {
      const repo = createRepository({ id: 'new-repo', name: 'New Repository' });

      await repository.save(repo);

      const found = await repository.findById('new-repo');
      expect(found).not.toBeNull();
      expect(found?.name).toBe('New Repository');
    });

    it('should update existing repository', async () => {
      const repo = createRepository({ id: 'update-repo', name: 'Original' });
      await repository.save(repo);

      const updated = createRepository({ id: 'update-repo', name: 'Updated' });
      await repository.save(updated);

      const found = await repository.findById('update-repo');
      expect(found?.name).toBe('Updated');

      // Verify only one repository exists
      const all = await repository.findAll();
      expect(all.length).toBe(1);
    });

    it('should preserve all fields correctly', async () => {
      const registeredAt = '2024-01-15T10:30:00.000Z';
      const repo = createRepository({
        id: 'full-repo',
        name: 'Full Repository',
        path: '/home/user/projects/full-repo',
        registeredAt,
      });

      await repository.save(repo);

      const found = await repository.findById('full-repo');
      expect(found?.id).toBe('full-repo');
      expect(found?.name).toBe('Full Repository');
      expect(found?.path).toBe('/home/user/projects/full-repo');
      expect(found?.registeredAt).toBe(registeredAt);
    });
  });

  describe('delete', () => {
    it('should remove repository by id', async () => {
      const repos = [
        createRepository({ id: 'repo-1', path: '/path/1' }),
        createRepository({ id: 'repo-2', path: '/path/2' }),
        createRepository({ id: 'repo-3', path: '/path/3' }),
      ];

      for (const repo of repos) {
        await repository.save(repo);
      }

      await repository.delete('repo-2');

      const all = await repository.findAll();
      expect(all.length).toBe(2);
      expect(all.map((r) => r.id).sort()).toEqual(['repo-1', 'repo-3']);
    });

    it('should not fail if repository does not exist', async () => {
      await repository.save(createRepository({ id: 'existing', path: '/path' }));

      // Should not throw
      await expect(repository.delete('non-existent')).resolves.toBeUndefined();

      // Existing repository should still be there
      const found = await repository.findById('existing');
      expect(found).not.toBeNull();
    });

    it('should not affect other repositories', async () => {
      const repo1 = createRepository({
        id: 'repo-1',
        name: 'Repository One',
        path: '/path/1',
      });
      const repo2 = createRepository({
        id: 'repo-2',
        name: 'Repository Two',
        path: '/path/2',
      });

      await repository.save(repo1);
      await repository.save(repo2);

      await repository.delete('repo-1');

      const remaining = await repository.findById('repo-2');
      expect(remaining).not.toBeNull();
      expect(remaining?.name).toBe('Repository Two');
    });
  });

  describe('edge cases', () => {
    it('should handle paths with special characters', async () => {
      const repo = createRepository({
        id: 'special-path',
        path: '/path/with spaces/and-dashes/and_underscores',
      });

      await repository.save(repo);

      const found = await repository.findById('special-path');
      expect(found?.path).toBe('/path/with spaces/and-dashes/and_underscores');
    });

    it('should handle unicode in name', async () => {
      const repo = createRepository({
        id: 'unicode-repo',
        name: 'Repository with unicode: Hello World',
      });

      await repository.save(repo);

      const found = await repository.findById('unicode-repo');
      expect(found?.name).toBe('Repository with unicode: Hello World');
    });

    it('should enforce unique path constraint', async () => {
      const repo1 = createRepository({ id: 'repo-1', path: '/same/path' });
      const repo2 = createRepository({ id: 'repo-2', path: '/same/path' });

      await repository.save(repo1);

      // Second save with same path should fail
      await expect(repository.save(repo2)).rejects.toThrow();
    });
  });
});
