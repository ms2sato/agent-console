import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Kysely, sql } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import { SqliteRepositoryRepository } from '../sqlite-repository-repository.js';
import type { Database } from '../../database/schema.js';
import type { Repository } from '@agent-console/shared';

const NOW_ISO8601 = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

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

    // Create tables manually (v7 schema)
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
      createdAt: overrides.createdAt ?? new Date().toISOString(),
      setupCommand: overrides.setupCommand,
      description: overrides.description ?? null,
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

    it('should preserve created_at and update updated_at on update', async () => {
      const originalCreatedAt = '2024-01-01T00:00:00.000Z';
      const repo = createRepository({
        id: 'timestamp-test',
        name: 'Original',
        path: '/timestamp/test',
        createdAt: originalCreatedAt,
      });
      await repository.save(repo);

      // Get the original timestamps from database directly
      const originalRow = await db
        .selectFrom('repositories')
        .where('id', '=', 'timestamp-test')
        .select(['created_at', 'updated_at'])
        .executeTakeFirst();

      expect(originalRow?.created_at).toBe(originalCreatedAt);
      const originalUpdatedAt = originalRow?.updated_at;

      // Wait a bit to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Update with a different createdAt (simulating real-world scenario)
      const updated = createRepository({
        id: 'timestamp-test',
        name: 'Updated',
        path: '/timestamp/test',
        createdAt: '2024-06-01T00:00:00.000Z', // Different createdAt
      });
      await repository.save(updated);

      // Get timestamps after update
      const updatedRow = await db
        .selectFrom('repositories')
        .where('id', '=', 'timestamp-test')
        .select(['created_at', 'updated_at'])
        .executeTakeFirst();

      // created_at should NOT change
      expect(updatedRow?.created_at).toBe(originalCreatedAt);

      // updated_at should change
      expect(updatedRow?.updated_at).not.toBe(originalUpdatedAt);
    });

    it('should preserve all fields correctly', async () => {
      const createdAt = '2024-01-15T10:30:00.000Z';
      const repo = createRepository({
        id: 'full-repo',
        name: 'Full Repository',
        path: '/home/user/projects/full-repo',
        createdAt,
      });

      await repository.save(repo);

      const found = await repository.findById('full-repo');
      expect(found?.id).toBe('full-repo');
      expect(found?.name).toBe('Full Repository');
      expect(found?.path).toBe('/home/user/projects/full-repo');
      expect(found?.createdAt).toBe(createdAt);
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

  describe('update', () => {
    it('should update setupCommand from null to string', async () => {
      const repo = createRepository({ id: 'repo-setup', name: 'Repo Setup' });
      await repository.save(repo);

      // Verify setupCommand is initially null
      const before = await repository.findById('repo-setup');
      expect(before?.setupCommand).toBeNull();

      // Update setupCommand
      const updated = await repository.update('repo-setup', {
        setupCommand: 'npm install',
      });

      expect(updated).not.toBeNull();
      expect(updated?.setupCommand).toBe('npm install');
    });

    it('should update setupCommand from string to new string', async () => {
      const repo = createRepository({
        id: 'repo-update-cmd',
        name: 'Repo Update Cmd',
        setupCommand: 'npm install',
      });
      await repository.save(repo);

      // Verify initial setupCommand
      const before = await repository.findById('repo-update-cmd');
      expect(before?.setupCommand).toBe('npm install');

      // Update to new command
      const updated = await repository.update('repo-update-cmd', {
        setupCommand: 'bun install && bun run build',
      });

      expect(updated).not.toBeNull();
      expect(updated?.setupCommand).toBe('bun install && bun run build');
    });

    it('should update setupCommand to null when given empty string', async () => {
      const repo = createRepository({
        id: 'repo-clear-cmd',
        name: 'Repo Clear Cmd',
        setupCommand: 'npm install',
      });
      await repository.save(repo);

      // Verify initial setupCommand
      const before = await repository.findById('repo-clear-cmd');
      expect(before?.setupCommand).toBe('npm install');

      // Update with empty string should clear the command
      const updated = await repository.update('repo-clear-cmd', {
        setupCommand: '',
      });

      expect(updated).not.toBeNull();
      expect(updated?.setupCommand).toBeNull();

      // Double check via direct DB query
      const row = await db
        .selectFrom('repositories')
        .where('id', '=', 'repo-clear-cmd')
        .select('setup_command')
        .executeTakeFirst();
      expect(row?.setup_command).toBeNull();
    });

    it('should return null for non-existent repository', async () => {
      const updated = await repository.update('non-existent-id', {
        setupCommand: 'some command',
      });

      expect(updated).toBeNull();
    });

    it('should update updated_at but keep created_at unchanged', async () => {
      const originalCreatedAt = '2024-01-01T00:00:00.000Z';
      const repo = createRepository({
        id: 'repo-timestamps',
        name: 'Repo Timestamps',
        path: '/path/timestamps',
        createdAt: originalCreatedAt,
      });
      await repository.save(repo);

      // Get original timestamps
      const originalRow = await db
        .selectFrom('repositories')
        .where('id', '=', 'repo-timestamps')
        .select(['created_at', 'updated_at'])
        .executeTakeFirst();

      expect(originalRow?.created_at).toBe(originalCreatedAt);
      const originalUpdatedAt = originalRow?.updated_at;

      // Wait a bit to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Perform update
      await repository.update('repo-timestamps', {
        setupCommand: 'new command',
      });

      // Get updated timestamps
      const updatedRow = await db
        .selectFrom('repositories')
        .where('id', '=', 'repo-timestamps')
        .select(['created_at', 'updated_at'])
        .executeTakeFirst();

      // created_at should NOT change
      expect(updatedRow?.created_at).toBe(originalCreatedAt);

      // updated_at should change
      expect(updatedRow?.updated_at).not.toBe(originalUpdatedAt);
    });

    it('should not modify other fields when updating setupCommand', async () => {
      const repo = createRepository({
        id: 'repo-preserve-fields',
        name: 'Original Name',
        path: '/original/path',
      });
      await repository.save(repo);

      await repository.update('repo-preserve-fields', {
        setupCommand: 'npm install',
      });

      const updated = await repository.findById('repo-preserve-fields');
      expect(updated?.name).toBe('Original Name');
      expect(updated?.path).toBe('/original/path');
      expect(updated?.setupCommand).toBe('npm install');
    });

    it('should update setupCommand with template variables', async () => {
      const repo = createRepository({ id: 'repo-template' });
      await repository.save(repo);

      const commandWithTemplate = 'export PORT={{WORKTREE_NUM + 3000}} && npm start';
      const updated = await repository.update('repo-template', {
        setupCommand: commandWithTemplate,
      });

      expect(updated?.setupCommand).toBe(commandWithTemplate);
    });
  });

  describe('description', () => {
    it('should update description from null to string', async () => {
      const repo = createRepository({ id: 'repo-desc', name: 'Repo Desc' });
      await repository.save(repo);

      // Verify description is initially null
      const before = await repository.findById('repo-desc');
      expect(before?.description).toBeNull();

      // Update description
      const updated = await repository.update('repo-desc', {
        description: 'A test repository',
      });

      expect(updated).not.toBeNull();
      expect(updated?.description).toBe('A test repository');
    });

    it('should update description from string to new string', async () => {
      const repo = createRepository({
        id: 'repo-update-desc',
        name: 'Repo Update Desc',
        description: 'Original description',
      });
      await repository.save(repo);

      // Verify initial description
      const before = await repository.findById('repo-update-desc');
      expect(before?.description).toBe('Original description');

      // Update to new description
      const updated = await repository.update('repo-update-desc', {
        description: 'Updated description with more details',
      });

      expect(updated).not.toBeNull();
      expect(updated?.description).toBe('Updated description with more details');
    });

    it('should update description to null when given empty string', async () => {
      const repo = createRepository({
        id: 'repo-clear-desc',
        name: 'Repo Clear Desc',
        description: 'Will be cleared',
      });
      await repository.save(repo);

      // Verify initial description
      const before = await repository.findById('repo-clear-desc');
      expect(before?.description).toBe('Will be cleared');

      // Update with empty string should clear the description
      const updated = await repository.update('repo-clear-desc', {
        description: '',
      });

      expect(updated).not.toBeNull();
      expect(updated?.description).toBeNull();

      // Double check via direct DB query
      const row = await db
        .selectFrom('repositories')
        .where('id', '=', 'repo-clear-desc')
        .select('description')
        .executeTakeFirst();
      expect(row?.description).toBeNull();
    });

    it('should include description in findAll results', async () => {
      const repo = createRepository({
        id: 'repo-findall-desc',
        path: '/path/findall-desc',
        description: 'Visible in findAll',
      });
      await repository.save(repo);

      const repos = await repository.findAll();
      const found = repos.find((r) => r.id === 'repo-findall-desc');
      expect(found?.description).toBe('Visible in findAll');
    });

    it('should include description in findById results', async () => {
      const repo = createRepository({
        id: 'repo-findbyid-desc',
        description: 'Visible in findById',
      });
      await repository.save(repo);

      const found = await repository.findById('repo-findbyid-desc');
      expect(found?.description).toBe('Visible in findById');
    });

    it('should preserve description on save with onConflict upsert', async () => {
      const repo = createRepository({
        id: 'repo-upsert-desc',
        name: 'Original',
        description: 'Original description',
      });
      await repository.save(repo);

      // Save again with updated description
      const updated = createRepository({
        id: 'repo-upsert-desc',
        name: 'Updated',
        description: 'Updated description',
      });
      await repository.save(updated);

      const found = await repository.findById('repo-upsert-desc');
      expect(found?.name).toBe('Updated');
      expect(found?.description).toBe('Updated description');

      // Verify only one repository exists
      const all = await repository.findAll();
      const matching = all.filter((r) => r.id === 'repo-upsert-desc');
      expect(matching.length).toBe(1);
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
