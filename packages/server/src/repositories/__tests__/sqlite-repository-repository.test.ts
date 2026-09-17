import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Kysely, sql } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import { SqliteRepositoryRepository } from '../sqlite-repository-repository.js';
import type { Database } from '../../database/schema.js';
import type { Repository } from '@agent-console/shared';
import { createDatabaseForTest } from '../../database/connection.js';

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

    // Create tables manually (v10 schema)
    await db.schema
      .createTable('repositories')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('path', 'text', (col) => col.notNull().unique())
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(NOW_ISO8601))
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(NOW_ISO8601))
      .addColumn('setup_command', 'text')
      .addColumn('cleanup_command', 'text')
      .addColumn('env_vars', 'text')
      .addColumn('description', 'text')
      .addColumn('default_agent_id', 'text')
      .addColumn('orchestrator_session_id', 'text')
      .addColumn('issue_trigger_labels', 'text')
      .execute();

    // Modeled on migration v41's shape (Issue #1716), minus the two FK
    // declarations -- this manually-built schema (unlike
    // `createDatabaseForTest()`) never declares FKs anywhere else either
    // (see `repositories` above, whose `orchestrator_session_id` column has
    // no `REFERENCES` clause). The primary key constraint IS declared: the
    // add-idempotent tests below rely on `onConflict` resolving against a
    // real unique constraint.
    await db.schema
      .createTable('repository_orchestrator_sessions')
      .addColumn('repository_id', 'text', (col) => col.notNull())
      .addColumn('session_id', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(NOW_ISO8601))
      .addPrimaryKeyConstraint('repository_orchestrator_sessions_pk', ['repository_id', 'session_id'])
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
      cleanupCommand: overrides.cleanupCommand,
      description: overrides.description ?? null,
      defaultAgentId: overrides.defaultAgentId ?? null,
      // `save()` never writes this (Issue #1716: designations are managed
      // only through add/remove); present only to satisfy the required
      // `Repository.orchestratorSessionIds` field shape.
      orchestratorSessionIds: overrides.orchestratorSessionIds ?? [],
      issueTriggerLabels: overrides.issueTriggerLabels ?? null,
      clonedSourceRepoPath: overrides.clonedSourceRepoPath ?? null,
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

    describe('cleanupCommand', () => {
      it('should update cleanupCommand from null to string', async () => {
        const repo = createRepository({ id: 'repo-cleanup', name: 'Repo Cleanup' });
        await repository.save(repo);

        // Verify cleanupCommand is initially null
        const before = await repository.findById('repo-cleanup');
        expect(before?.cleanupCommand).toBeNull();

        // Update cleanupCommand
        const updated = await repository.update('repo-cleanup', {
          cleanupCommand: 'docker compose down',
        });

        expect(updated).not.toBeNull();
        expect(updated?.cleanupCommand).toBe('docker compose down');
      });

      it('should update cleanupCommand to null when given empty string', async () => {
        const repo = createRepository({
          id: 'repo-clear-cleanup',
          name: 'Repo Clear Cleanup',
          cleanupCommand: 'docker compose down',
        });
        await repository.save(repo);

        // Verify initial cleanupCommand
        const before = await repository.findById('repo-clear-cleanup');
        expect(before?.cleanupCommand).toBe('docker compose down');

        // Update with empty string should clear the command
        const updated = await repository.update('repo-clear-cleanup', {
          cleanupCommand: '',
        });

        expect(updated).not.toBeNull();
        expect(updated?.cleanupCommand).toBeNull();

        // Double check via direct DB query
        const row = await db
          .selectFrom('repositories')
          .where('id', '=', 'repo-clear-cleanup')
          .select('cleanup_command')
          .executeTakeFirst();
        expect(row?.cleanup_command).toBeNull();
      });
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

  describe('defaultAgentId', () => {
    it('should update defaultAgentId from null to a valid agent ID', async () => {
      const repo = createRepository({ id: 'repo-default-agent', name: 'Repo Default Agent' });
      await repository.save(repo);

      // Verify defaultAgentId is initially null
      const before = await repository.findById('repo-default-agent');
      expect(before?.defaultAgentId).toBeNull();

      // Update defaultAgentId
      const updated = await repository.update('repo-default-agent', {
        defaultAgentId: 'agent-123',
      });

      expect(updated).not.toBeNull();
      expect(updated?.defaultAgentId).toBe('agent-123');
    });

    it('should clear defaultAgentId when given empty string', async () => {
      const repo = createRepository({
        id: 'repo-clear-agent',
        name: 'Repo Clear Agent',
        defaultAgentId: 'agent-123',
      });
      await repository.save(repo);

      // Verify initial defaultAgentId
      const before = await repository.findById('repo-clear-agent');
      expect(before?.defaultAgentId).toBe('agent-123');

      // Update with empty string should clear the defaultAgentId
      const updated = await repository.update('repo-clear-agent', {
        defaultAgentId: '',
      });

      expect(updated).not.toBeNull();
      expect(updated?.defaultAgentId).toBeNull();

      // Double check via direct DB query
      const row = await db
        .selectFrom('repositories')
        .where('id', '=', 'repo-clear-agent')
        .select('default_agent_id')
        .executeTakeFirst();
      expect(row?.default_agent_id).toBeNull();
    });

    it('should clear defaultAgentId when given null', async () => {
      const repo = createRepository({
        id: 'repo-null-agent',
        name: 'Repo Null Agent',
        defaultAgentId: 'agent-456',
      });
      await repository.save(repo);

      // Verify initial defaultAgentId
      const before = await repository.findById('repo-null-agent');
      expect(before?.defaultAgentId).toBe('agent-456');

      // Update with null should clear the defaultAgentId
      const updated = await repository.update('repo-null-agent', {
        defaultAgentId: null,
      });

      expect(updated).not.toBeNull();
      expect(updated?.defaultAgentId).toBeNull();

      // Double check via direct DB query
      const row = await db
        .selectFrom('repositories')
        .where('id', '=', 'repo-null-agent')
        .select('default_agent_id')
        .executeTakeFirst();
      expect(row?.default_agent_id).toBeNull();
    });

    it('should include defaultAgentId in findById results', async () => {
      const repo = createRepository({
        id: 'repo-findbyid-agent',
        defaultAgentId: 'agent-for-findbyid',
      });
      await repository.save(repo);

      const found = await repository.findById('repo-findbyid-agent');
      expect(found?.defaultAgentId).toBe('agent-for-findbyid');
    });

    it('should include defaultAgentId in findAll results', async () => {
      const repo = createRepository({
        id: 'repo-findall-agent',
        path: '/path/findall-agent',
        defaultAgentId: 'agent-for-findall',
      });
      await repository.save(repo);

      const repos = await repository.findAll();
      const found = repos.find((r) => r.id === 'repo-findall-agent');
      expect(found?.defaultAgentId).toBe('agent-for-findall');
    });
  });

  describe('orchestrator-session designations (Issue #1716)', () => {
    it('hydrates orchestratorSessionIds to [] when the repository has no designations', async () => {
      const repo = createRepository({ id: 'repo-no-designations' });
      await repository.save(repo);

      const found = await repository.findById('repo-no-designations');
      // reach: reading the second argument as `?? ['stale']` (or any
      // non-empty fallback) fails this test.
      expect(found?.orchestratorSessionIds).toEqual([]);
    });

    it('add() is idempotent: a second add of the same pair reports added:false and leaves the list unchanged', async () => {
      const repo = createRepository({ id: 'repo-idempotent-add' });
      await repository.save(repo);

      const first = await repository.addOrchestratorSession('repo-idempotent-add', 'session-a');
      expect(first.added).toBe(true);
      expect(first.repository?.orchestratorSessionIds).toEqual(['session-a']);

      const second = await repository.addOrchestratorSession('repo-idempotent-add', 'session-a');
      // reach: an add that always reports `added: true` (or that inserts a
      // duplicate row instead of relying on `onConflict ... doNothing()`)
      // fails this test.
      expect(second.added).toBe(false);
      expect(second.repository?.orchestratorSessionIds).toEqual(['session-a']);
    });

    it('add() returns repository:null when the target repository does not exist', async () => {
      const result = await repository.addOrchestratorSession('does-not-exist', 'session-a');
      expect(result.added).toBe(false);
      expect(result.repository).toBeNull();
    });

    it('adding two different sessions to the same repository accumulates a set, not a single pointer', async () => {
      const repo = createRepository({ id: 'repo-multi-designation' });
      await repository.save(repo);

      await repository.addOrchestratorSession('repo-multi-designation', 'session-a');
      const result = await repository.addOrchestratorSession('repo-multi-designation', 'session-b');

      expect(result.added).toBe(true);
      expect(new Set(result.repository?.orchestratorSessionIds)).toEqual(new Set(['session-a', 'session-b']));
    });

    it('remove() is idempotent: removing an absent pair reports removed:false and leaves the list untouched', async () => {
      const repo = createRepository({ id: 'repo-idempotent-remove' });
      await repository.save(repo);
      await repository.addOrchestratorSession('repo-idempotent-remove', 'session-a');

      const result = await repository.removeOrchestratorSession('repo-idempotent-remove', 'session-does-not-exist');

      // reach: a remove that reports `removed: true` unconditionally (or
      // that deletes an unrelated row) fails this test.
      expect(result.removed).toBe(false);
      expect(result.repository?.orchestratorSessionIds).toEqual(['session-a']);
    });

    it('remove() removes exactly the targeted (repository, session) pair, leaving other designations of the same repository intact', async () => {
      const repo = createRepository({ id: 'repo-remove-one-of-two' });
      await repository.save(repo);
      await repository.addOrchestratorSession('repo-remove-one-of-two', 'session-a');
      await repository.addOrchestratorSession('repo-remove-one-of-two', 'session-b');

      const result = await repository.removeOrchestratorSession('repo-remove-one-of-two', 'session-a');

      expect(result.removed).toBe(true);
      expect(result.repository?.orchestratorSessionIds).toEqual(['session-b']);
    });

    it('lists orchestratorSessionIds ordered by created_at then session_id (deterministic wire order)', async () => {
      const repo = createRepository({ id: 'repo-ordering' });
      await repository.save(repo);

      // Insert directly via raw SQL with explicit, out-of-insertion-order
      // `created_at` values so the returned order can only be explained by
      // the ORDER BY clause, not by insertion order.
      await sql`
        INSERT INTO repository_orchestrator_sessions (repository_id, session_id, created_at)
        VALUES
          (${'repo-ordering'}, ${'session-later'}, ${'2024-06-01T00:00:00.000Z'}),
          (${'repo-ordering'}, ${'session-earlier'}, ${'2024-01-01T00:00:00.000Z'})
      `.execute(db);

      const ids = await repository.listOrchestratorSessionIds('repo-ordering');

      // reach: an unordered (or insertion-order) `SELECT` fails this test.
      expect(ids).toEqual(['session-earlier', 'session-later']);
    });

    it('orders by session_id as a tiebreaker when created_at is equal', async () => {
      const repo = createRepository({ id: 'repo-tie-ordering' });
      await repository.save(repo);

      const sameTimestamp = '2024-03-01T00:00:00.000Z';
      await sql`
        INSERT INTO repository_orchestrator_sessions (repository_id, session_id, created_at)
        VALUES
          (${'repo-tie-ordering'}, ${'session-z'}, ${sameTimestamp}),
          (${'repo-tie-ordering'}, ${'session-a'}, ${sameTimestamp})
      `.execute(db);

      const ids = await repository.listOrchestratorSessionIds('repo-tie-ordering');

      expect(ids).toEqual(['session-a', 'session-z']);
    });

    it('save() does not touch the designation table (designations are managed only through add/remove)', async () => {
      const repo = createRepository({ id: 'repo-save-preserves-designations' });
      await repository.save(repo);
      await repository.addOrchestratorSession('repo-save-preserves-designations', 'session-a');

      // Re-save (the onConflict upsert path) with an unrelated field
      // changed -- the designation must survive untouched.
      await repository.save({ ...repo, description: 'updated via a second save()' });

      const found = await repository.findById('repo-save-preserves-designations');
      // reach: a `save()` that writes to `repository_orchestrator_sessions`
      // (e.g. clearing it, or re-deriving it from the Repository argument)
      // fails this test.
      expect(found?.orchestratorSessionIds).toEqual(['session-a']);
      expect(found?.description).toBe('updated via a second save()');
    });

    it('findAll hydrates each repository with its own designation set', async () => {
      const repoA = createRepository({ id: 'repo-findall-a', path: '/path/findall-a' });
      const repoB = createRepository({ id: 'repo-findall-b', path: '/path/findall-b' });
      await repository.save(repoA);
      await repository.save(repoB);

      await repository.addOrchestratorSession('repo-findall-a', 'session-a1');
      await repository.addOrchestratorSession('repo-findall-a', 'session-a2');
      await repository.addOrchestratorSession('repo-findall-b', 'session-b1');

      const all = await repository.findAll();
      const foundA = all.find((r) => r.id === 'repo-findall-a');
      const foundB = all.find((r) => r.id === 'repo-findall-b');

      // reach: a `findAll()` that hydrates every repository with the SAME
      // (e.g. the first repository's, or a concatenated) designation set
      // fails this test.
      expect(foundA?.orchestratorSessionIds).toEqual(['session-a1', 'session-a2']);
      expect(foundB?.orchestratorSessionIds).toEqual(['session-b1']);
    });
  });

  describe('orchestrator-session designation CASCADE (Issue #1716, real migrated DB)', () => {
    // Unlike this file's other describes, CASCADE behavior needs REAL
    // foreign-key constraints -- the manually-built schema above declares
    // none (mirroring `repositories.orchestrator_session_id`'s own lack of
    // a `REFERENCES` clause in this file). `createDatabaseForTest()` runs
    // the real migration chain (FK-declared table, `PRAGMA foreign_keys =
    // ON`), so it is the only fixture in this file that can prove CASCADE.
    let cascadeDb: Kysely<Database>;
    let cascadeRepository: SqliteRepositoryRepository;

    beforeEach(async () => {
      cascadeDb = await createDatabaseForTest();
      cascadeRepository = new SqliteRepositoryRepository(cascadeDb);
    });

    afterEach(async () => {
      await cascadeDb.destroy();
    });

    async function insertMinimalSession(id: string): Promise<void> {
      await cascadeDb.insertInto('sessions').values({ id, type: 'quick', location_path: '/tmp/cascade-test' }).execute();
    }

    it('a deleted session removes its designation row (ON DELETE CASCADE on session_id)', async () => {
      await cascadeRepository.save(createRepository({ id: 'repo-cascade-session', path: '/path/cascade-session' }));
      await insertMinimalSession('session-cascade-target');
      await cascadeRepository.addOrchestratorSession('repo-cascade-session', 'session-cascade-target');

      await cascadeDb.deleteFrom('sessions').where('id', '=', 'session-cascade-target').execute();

      // reach: dropping `ON DELETE CASCADE` on the `session_id` foreign key
      // fails this test (the designation row would survive as an orphan).
      const ids = await cascadeRepository.listOrchestratorSessionIds('repo-cascade-session');
      expect(ids).toEqual([]);
    });

    it('a deleted repository removes its designation rows (ON DELETE CASCADE on repository_id)', async () => {
      await cascadeRepository.save(createRepository({ id: 'repo-cascade-repo', path: '/path/cascade-repo' }));
      await insertMinimalSession('session-survives-repo-delete');
      await cascadeRepository.addOrchestratorSession('repo-cascade-repo', 'session-survives-repo-delete');

      await cascadeRepository.delete('repo-cascade-repo');

      // reach: dropping `ON DELETE CASCADE` on the `repository_id` foreign
      // key fails this test (the row would survive, orphaned).
      const orphanRows = await cascadeDb
        .selectFrom('repository_orchestrator_sessions')
        .selectAll()
        .where('repository_id', '=', 'repo-cascade-repo')
        .execute();
      expect(orphanRows).toEqual([]);
    });
  });

  describe('issueTriggerLabels', () => {
    it('should round-trip issueTriggerLabels through save() and findById()', async () => {
      const repo = createRepository({
        id: 'repo-issue-labels-save',
        issueTriggerLabels: 'bug, needs-triage',
      });
      await repository.save(repo);

      const found = await repository.findById('repo-issue-labels-save');
      expect(found?.issueTriggerLabels).toBe('bug, needs-triage');
    });

    it('should default issueTriggerLabels to null when not provided', async () => {
      const repo = createRepository({ id: 'repo-no-issue-labels' });
      await repository.save(repo);

      const found = await repository.findById('repo-no-issue-labels');
      expect(found?.issueTriggerLabels).toBeNull();
    });

    it('should set issueTriggerLabels via update()', async () => {
      const repo = createRepository({ id: 'repo-update-issue-labels' });
      await repository.save(repo);

      const before = await repository.findById('repo-update-issue-labels');
      expect(before?.issueTriggerLabels).toBeNull();

      const updated = await repository.update('repo-update-issue-labels', {
        issueTriggerLabels: 'bug, needs-triage',
      });

      expect(updated).not.toBeNull();
      expect(updated?.issueTriggerLabels).toBe('bug, needs-triage');
    });

    it('should clear issueTriggerLabels via update() when given empty string', async () => {
      const repo = createRepository({
        id: 'repo-clear-issue-labels',
        issueTriggerLabels: 'bug, needs-triage',
      });
      await repository.save(repo);

      const updated = await repository.update('repo-clear-issue-labels', {
        issueTriggerLabels: '',
      });

      expect(updated).not.toBeNull();
      expect(updated?.issueTriggerLabels).toBeNull();

      const row = await db
        .selectFrom('repositories')
        .where('id', '=', 'repo-clear-issue-labels')
        .select('issue_trigger_labels')
        .executeTakeFirst();
      expect(row?.issue_trigger_labels).toBeNull();
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
