/**
 * Migration Integration Tests
 *
 * These tests verify the actual JSON to SQLite migration functions.
 * Uses in-memory SQLite database and memfs for JSON files.
 *
 * Note: These tests use migrateFromJson directly with ':memory:' database
 * because initializeDatabase(':memory:') skips JSON migration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { initializeDatabase, closeDatabase, migrateFromJson } from '../connection.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { mockGit } from '../../__tests__/utils/mock-git-helper.js';

const TEST_CONFIG_DIR = '/test/config';

// Test fixtures
const TEST_SESSIONS = [
  {
    id: 'session-1',
    type: 'worktree' as const,
    locationPath: '/path/to/worktree1',
    repositoryId: 'repo-1',
    worktreeId: 'feature-branch',
    createdAt: '2024-01-01T00:00:00.000Z',
    workers: [
      {
        id: 'worker-1',
        type: 'agent' as const,
        name: 'Claude',
        agentId: 'claude-code-builtin',
        pid: 1234,
        createdAt: '2024-01-01T00:00:00.000Z',
      },
    ],
  },
  {
    id: 'session-2',
    type: 'quick' as const,
    locationPath: '/path/to/quick',
    createdAt: '2024-01-02T00:00:00.000Z',
    workers: [],
  },
];

const TEST_REPOSITORIES = [
  {
    id: 'repo-1',
    name: 'my-project',
    path: '/path/to/my-project',
    createdAt: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 'repo-2',
    name: 'another-project',
    path: '/path/to/another-project',
    createdAt: '2024-01-02T00:00:00.000Z',
  },
];

const TEST_AGENTS = [
  {
    id: 'custom-agent-1',
    name: 'Custom Agent',
    commandTemplate: 'custom-agent {{prompt}}', // Note: lowercase {{prompt}} required
    isBuiltIn: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
  },
  // Built-in agent (should be skipped)
  {
    id: 'claude-code-builtin',
    name: 'Claude Code',
    commandTemplate: 'claude {{prompt}}', // Note: lowercase {{prompt}} required
    isBuiltIn: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    capabilities: { supportsContinue: true, supportsHeadlessMode: true, supportsActivityDetection: true },
  },
];

describe('migration', () => {
  beforeEach(async () => {
    // Close any existing database connection from previous tests
    await closeDatabase();

    // Setup memfs with config directory
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    // Reset git mocks for worktree migration tests
    mockGit.getRemoteUrl.mockReset();
    mockGit.parseOrgRepo.mockReset();
  });

  afterEach(async () => {
    await closeDatabase();
    cleanupMemfs();
  });

  describe('migrateRepositoriesFromJson (via migrateFromJson)', () => {
    it('should migrate valid repositories from JSON to SQLite', async () => {
      // Create repositories.json before initializing database
      const reposJsonPath = path.join(TEST_CONFIG_DIR, 'repositories.json');
      fs.writeFileSync(reposJsonPath, JSON.stringify(TEST_REPOSITORIES));

      // Initialize in-memory database
      const db = await initializeDatabase(':memory:');

      // Manually trigger JSON migration (skipped for :memory: in initializeDatabase)
      await migrateFromJson(db);

      // Verify data was migrated
      const rows = await db.selectFrom('repositories').selectAll().execute();
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe('repo-1');
      expect(rows[0].name).toBe('my-project');
      expect(rows[1].id).toBe('repo-2');

      // Verify JSON file was renamed
      expect(fs.existsSync(reposJsonPath)).toBe(false);
      expect(fs.existsSync(`${reposJsonPath}.migrated`)).toBe(true);
    });

    it('should skip if no repositories.json exists', async () => {
      // Ensure no JSON file exists
      const reposJsonPath = path.join(TEST_CONFIG_DIR, 'repositories.json');
      expect(fs.existsSync(reposJsonPath)).toBe(false);

      // Initialize database
      const db = await initializeDatabase(':memory:');
      await migrateFromJson(db);

      // Verify no data in database
      const rows = await db.selectFrom('repositories').selectAll().execute();
      expect(rows).toHaveLength(0);
    });

    it('should skip if SQLite already has data', async () => {
      // First initialize database and add some data
      const db = await initializeDatabase(':memory:');
      await db
        .insertInto('repositories')
        .values({
          id: 'existing-repo',
          name: 'Existing',
          path: '/existing',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      // Create repositories.json
      const reposJsonPath = path.join(TEST_CONFIG_DIR, 'repositories.json');
      fs.writeFileSync(reposJsonPath, JSON.stringify(TEST_REPOSITORIES));

      // Trigger migration - should skip because data exists
      await migrateFromJson(db);

      // Verify only existing data remains
      const rows = await db.selectFrom('repositories').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('existing-repo');

      // JSON file should not be renamed (migration was skipped)
      expect(fs.existsSync(reposJsonPath)).toBe(true);
    });

    it('should transform legacy registeredAt field to createdAt', async () => {
      // Create repositories.json with legacy 'registeredAt' field (old format before SQLite migration)
      const legacyRepositories = [
        {
          id: 'legacy-repo',
          name: 'Legacy Repository',
          path: '/path/to/legacy-repo',
          registeredAt: '2023-06-15T10:30:00.000Z', // old field name
        },
      ];
      const reposJsonPath = path.join(TEST_CONFIG_DIR, 'repositories.json');
      fs.writeFileSync(reposJsonPath, JSON.stringify(legacyRepositories));

      // Initialize database
      const db = await initializeDatabase(':memory:');
      await migrateFromJson(db);

      // Verify repository was migrated with createdAt field
      const rows = await db.selectFrom('repositories').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('legacy-repo');
      expect(rows[0].name).toBe('Legacy Repository');
      expect(rows[0].created_at).toBe('2023-06-15T10:30:00.000Z');

      // Verify JSON file was renamed
      expect(fs.existsSync(reposJsonPath)).toBe(false);
      expect(fs.existsSync(`${reposJsonPath}.migrated`)).toBe(true);
    });

    it('should prefer createdAt over registeredAt for repositories when both exist', async () => {
      // Edge case: repository has both fields (should use createdAt)
      const mixedRepositories = [
        {
          id: 'mixed-repo',
          name: 'Mixed Repository',
          path: '/path/to/mixed-repo',
          createdAt: '2024-01-01T00:00:00.000Z', // new field
          registeredAt: '2023-06-15T10:30:00.000Z', // old field (should be ignored)
        },
      ];
      const reposJsonPath = path.join(TEST_CONFIG_DIR, 'repositories.json');
      fs.writeFileSync(reposJsonPath, JSON.stringify(mixedRepositories));

      // Initialize database
      const db = await initializeDatabase(':memory:');
      await migrateFromJson(db);

      // Verify repository uses createdAt (not registeredAt)
      const rows = await db.selectFrom('repositories').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].created_at).toBe('2024-01-01T00:00:00.000Z');
    });
  });

  describe('migrateAgentsFromJson (via migrateFromJson)', () => {
    it('should migrate custom agents from JSON to SQLite', async () => {
      // Create agents.json with only custom agent
      const customAgents = TEST_AGENTS.filter((a) => !a.isBuiltIn);
      const agentsJsonPath = path.join(TEST_CONFIG_DIR, 'agents.json');
      fs.writeFileSync(agentsJsonPath, JSON.stringify(customAgents));

      // Initialize database (v10 migration inserts built-in agent)
      const db = await initializeDatabase(':memory:');
      await migrateFromJson(db);

      // Verify custom agent was migrated (built-in agent already exists from v10 migration)
      const customRows = await db.selectFrom('agents').selectAll().where('is_built_in', '=', 0).execute();
      expect(customRows).toHaveLength(1);
      expect(customRows[0].id).toBe('custom-agent-1');
      expect(customRows[0].is_built_in).toBe(0);

      // Verify JSON file was renamed
      expect(fs.existsSync(agentsJsonPath)).toBe(false);
      expect(fs.existsSync(`${agentsJsonPath}.migrated`)).toBe(true);
    });

    it('should skip built-in agents during JSON migration', async () => {
      // Create agents.json with both custom and built-in
      const agentsJsonPath = path.join(TEST_CONFIG_DIR, 'agents.json');
      fs.writeFileSync(agentsJsonPath, JSON.stringify(TEST_AGENTS));

      // Initialize database (v10 migration inserts built-in agent)
      const db = await initializeDatabase(':memory:');
      await migrateFromJson(db);

      // Verify only custom agent was migrated from JSON (built-in was filtered by JSON migration)
      // Built-in agent exists from v10 schema migration, not from JSON migration
      const customRows = await db.selectFrom('agents').selectAll().where('is_built_in', '=', 0).execute();
      expect(customRows).toHaveLength(1);
      expect(customRows[0].id).toBe('custom-agent-1');
    });

    it('should validate agent schema and skip invalid agents', async () => {
      // Create agents.json with an invalid agent
      const invalidAgents = [
        {
          id: 'valid-agent',
          name: 'Valid Agent',
          commandTemplate: 'valid {{prompt}}', // lowercase {{prompt}} required
          isBuiltIn: false,
          createdAt: '2024-01-01T00:00:00.000Z',
          capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
        },
        {
          // Missing required fields - should be skipped
          id: 'invalid-agent',
          // name is missing
          // commandTemplate is missing
        },
      ];
      const agentsJsonPath = path.join(TEST_CONFIG_DIR, 'agents.json');
      fs.writeFileSync(agentsJsonPath, JSON.stringify(invalidAgents));

      // Initialize database (v10 migration inserts built-in agent)
      const db = await initializeDatabase(':memory:');
      await migrateFromJson(db);

      // Verify only valid custom agent was migrated
      const customRows = await db.selectFrom('agents').selectAll().where('is_built_in', '=', 0).execute();
      expect(customRows).toHaveLength(1);
      expect(customRows[0].id).toBe('valid-agent');
    });

    it('should transform legacy registeredAt field to createdAt', async () => {
      // Create agents.json with legacy 'registeredAt' field (old format before SQLite migration)
      const legacyAgents = [
        {
          id: 'legacy-agent',
          name: 'Legacy Agent',
          commandTemplate: 'legacy {{prompt}}',
          isBuiltIn: false,
          registeredAt: '2023-06-15T10:30:00.000Z', // old field name
          capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
        },
      ];
      const agentsJsonPath = path.join(TEST_CONFIG_DIR, 'agents.json');
      fs.writeFileSync(agentsJsonPath, JSON.stringify(legacyAgents));

      // Initialize database (v10 migration inserts built-in agent)
      const db = await initializeDatabase(':memory:');
      await migrateFromJson(db);

      // Verify agent was migrated with createdAt field
      const customRows = await db.selectFrom('agents').selectAll().where('is_built_in', '=', 0).execute();
      expect(customRows).toHaveLength(1);
      expect(customRows[0].id).toBe('legacy-agent');
      expect(customRows[0].name).toBe('Legacy Agent');
      expect(customRows[0].created_at).toBe('2023-06-15T10:30:00.000Z');

      // Verify JSON file was renamed
      expect(fs.existsSync(agentsJsonPath)).toBe(false);
      expect(fs.existsSync(`${agentsJsonPath}.migrated`)).toBe(true);
    });

    it('should prefer createdAt over registeredAt when both exist', async () => {
      // Edge case: agent has both fields (should use createdAt)
      const mixedAgents = [
        {
          id: 'mixed-agent',
          name: 'Mixed Agent',
          commandTemplate: 'mixed {{prompt}}',
          isBuiltIn: false,
          createdAt: '2024-01-01T00:00:00.000Z', // new field
          registeredAt: '2023-06-15T10:30:00.000Z', // old field (should be ignored)
          capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
        },
      ];
      const agentsJsonPath = path.join(TEST_CONFIG_DIR, 'agents.json');
      fs.writeFileSync(agentsJsonPath, JSON.stringify(mixedAgents));

      // Initialize database (v10 migration inserts built-in agent)
      const db = await initializeDatabase(':memory:');
      await migrateFromJson(db);

      // Verify custom agent uses createdAt (not registeredAt)
      const customRows = await db.selectFrom('agents').selectAll().where('is_built_in', '=', 0).execute();
      expect(customRows).toHaveLength(1);
      expect(customRows[0].created_at).toBe('2024-01-01T00:00:00.000Z');
    });

    it('should skip if no agents.json exists', async () => {
      // Ensure no JSON file exists
      const agentsJsonPath = path.join(TEST_CONFIG_DIR, 'agents.json');
      expect(fs.existsSync(agentsJsonPath)).toBe(false);

      // Initialize database (v10 migration inserts built-in agent)
      const db = await initializeDatabase(':memory:');
      await migrateFromJson(db);

      // Verify only built-in agent exists (from v10 migration), no custom agents
      const customRows = await db.selectFrom('agents').selectAll().where('is_built_in', '=', 0).execute();
      expect(customRows).toHaveLength(0);
    });
  });

  describe('migrateSessionsFromJson (via migrateFromJson)', () => {
    it('should migrate valid sessions from JSON to SQLite', async () => {
      // Create sessions.json
      const sessionsJsonPath = path.join(TEST_CONFIG_DIR, 'sessions.json');
      fs.writeFileSync(sessionsJsonPath, JSON.stringify(TEST_SESSIONS));

      // Initialize database
      const db = await initializeDatabase(':memory:');
      await migrateFromJson(db);

      // Verify sessions were migrated
      const sessions = await db.selectFrom('sessions').selectAll().execute();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe('session-1');
      expect(sessions[0].type).toBe('worktree');
      expect(sessions[1].id).toBe('session-2');
      expect(sessions[1].type).toBe('quick');

      // Verify workers were migrated
      const workers = await db.selectFrom('workers').selectAll().execute();
      expect(workers).toHaveLength(1);
      expect(workers[0].id).toBe('worker-1');
      expect(workers[0].session_id).toBe('session-1');

      // Verify JSON file was renamed
      expect(fs.existsSync(sessionsJsonPath)).toBe(false);
      expect(fs.existsSync(`${sessionsJsonPath}.migrated`)).toBe(true);
    });

    it('should skip if no sessions.json exists', async () => {
      const sessionsJsonPath = path.join(TEST_CONFIG_DIR, 'sessions.json');
      expect(fs.existsSync(sessionsJsonPath)).toBe(false);

      // Initialize database
      const db = await initializeDatabase(':memory:');
      await migrateFromJson(db);

      // Verify no data in database
      const rows = await db.selectFrom('sessions').selectAll().execute();
      expect(rows).toHaveLength(0);
    });

    it('should skip if SQLite already has data', async () => {
      // First initialize database and add some data
      const db = await initializeDatabase(':memory:');
      await db
        .insertInto('sessions')
        .values({
          id: 'existing-session',
          type: 'quick',
          location_path: '/existing',
          created_at: '2024-01-01T00:00:00.000Z',
          server_pid: null,
          initial_prompt: null,
          title: null,
          repository_id: null,
          worktree_id: null,
        })
        .execute();

      // Create sessions.json
      const sessionsJsonPath = path.join(TEST_CONFIG_DIR, 'sessions.json');
      fs.writeFileSync(sessionsJsonPath, JSON.stringify(TEST_SESSIONS));

      // Trigger migration - should skip
      await migrateFromJson(db);

      // Verify only existing session remains
      const rows = await db.selectFrom('sessions').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('existing-session');
    });
  });

  describe('schema migration v4: setup_command column', () => {
    it('should add setup_command column to repositories table', async () => {
      const db = await initializeDatabase(':memory:');

      await db
        .insertInto('repositories')
        .values({
          id: 'repo-setup',
          name: 'Setup Repo',
          path: '/test/setup',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
          setup_command: 'npm install && npm run build',
        })
        .execute();

      const rows = await db.selectFrom('repositories').selectAll().execute();

      expect(rows).toHaveLength(1);
      expect(rows[0].setup_command).toBe('npm install && npm run build');
    });

    it('should allow null setup_command values', async () => {
      const db = await initializeDatabase(':memory:');

      await db
        .insertInto('repositories')
        .values({
          id: 'repo-no-setup',
          name: 'No Setup Repo',
          path: '/test/no-setup',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      const rows = await db.selectFrom('repositories').selectAll().execute();

      expect(rows).toHaveLength(1);
      expect(rows[0].setup_command).toBeNull();
    });
  });

  describe('schema migration v5: env_vars column', () => {
    it('should add env_vars column to repositories table', async () => {
      const db = await initializeDatabase(':memory:');

      await db
        .insertInto('repositories')
        .values({
          id: 'repo-env',
          name: 'Env Repo',
          path: '/test/env',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
          env_vars: 'NODE_ENV=production\nAPI_KEY=secret',
        })
        .execute();

      const rows = await db.selectFrom('repositories').selectAll().execute();

      expect(rows).toHaveLength(1);
      expect(rows[0].env_vars).toBe('NODE_ENV=production\nAPI_KEY=secret');
    });

    it('should allow null env_vars values', async () => {
      const db = await initializeDatabase(':memory:');

      await db
        .insertInto('repositories')
        .values({
          id: 'repo-no-env',
          name: 'No Env Repo',
          path: '/test/no-env',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      const rows = await db.selectFrom('repositories').selectAll().execute();

      expect(rows).toHaveLength(1);
      expect(rows[0].env_vars).toBeNull();
    });
  });

  describe('schema migration v6: repository_slack_integrations table', () => {
    it('should create repository_slack_integrations table with correct columns', async () => {
      const db = await initializeDatabase(':memory:');

      await db
        .insertInto('repositories')
        .values({
          id: 'repo-slack',
          name: 'Slack Repo',
          path: '/test/slack',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      await db
        .insertInto('repository_slack_integrations')
        .values({
          id: 'slack-1',
          repository_id: 'repo-slack',
          webhook_url: 'https://hooks.slack.com/services/T00/B00/xxx',
          enabled: 1,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      const rows = await db.selectFrom('repository_slack_integrations').selectAll().execute();

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('slack-1');
      expect(rows[0].repository_id).toBe('repo-slack');
      expect(rows[0].webhook_url).toBe('https://hooks.slack.com/services/T00/B00/xxx');
      expect(rows[0].enabled).toBe(1);
    });

    it('should cascade delete integrations when repository is deleted', async () => {
      const db = await initializeDatabase(':memory:');

      await db
        .insertInto('repositories')
        .values({
          id: 'repo-cascade',
          name: 'Cascade Repo',
          path: '/test/cascade',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      await db
        .insertInto('repository_slack_integrations')
        .values({
          id: 'slack-cascade',
          repository_id: 'repo-cascade',
          webhook_url: 'https://hooks.slack.com/services/T00/B00/yyy',
          enabled: 1,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      await db.deleteFrom('repositories').where('id', '=', 'repo-cascade').execute();

      const rows = await db.selectFrom('repository_slack_integrations').selectAll().execute();
      expect(rows).toHaveLength(0);
    });

    it('should enforce unique constraint on repository_id', async () => {
      const db = await initializeDatabase(':memory:');

      await db
        .insertInto('repositories')
        .values({
          id: 'repo-unique',
          name: 'Unique Repo',
          path: '/test/unique',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      await db
        .insertInto('repository_slack_integrations')
        .values({
          id: 'slack-unique-1',
          repository_id: 'repo-unique',
          webhook_url: 'https://hooks.slack.com/services/T00/B00/first',
          enabled: 1,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      await expect(
        db
          .insertInto('repository_slack_integrations')
          .values({
            id: 'slack-unique-2',
            repository_id: 'repo-unique',
            webhook_url: 'https://hooks.slack.com/services/T00/B00/second',
            enabled: 1,
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          })
          .execute()
      ).rejects.toThrow();
    });
  });

  describe('schema migration v7: description column', () => {
    it('should add description column to repositories table when migrating from v6', async () => {
      // Initialize database (runs all migrations up to current version)
      const db = await initializeDatabase(':memory:');

      // Verify the schema version is the latest (9)
      const { sql } = await import('kysely');
      const result = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
      expect(result.rows[0]?.user_version).toBe(10);

      // Verify description column exists by inserting and reading a repository with description
      await db
        .insertInto('repositories')
        .values({
          id: 'test-repo',
          name: 'Test Repo',
          path: '/test/path',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
          description: 'A test repository description',
        })
        .execute();

      const rows = await db
        .selectFrom('repositories')
        .selectAll()
        .execute();

      expect(rows).toHaveLength(1);
      expect(rows[0].description).toBe('A test repository description');
    });

    it('should allow null description values', async () => {
      const db = await initializeDatabase(':memory:');

      // Insert a repository without description
      await db
        .insertInto('repositories')
        .values({
          id: 'test-repo-no-desc',
          name: 'No Description Repo',
          path: '/test/no-desc',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      const rows = await db
        .selectFrom('repositories')
        .selectAll()
        .execute();

      expect(rows).toHaveLength(1);
      expect(rows[0].description).toBeNull();
    });

    it('should default description to null for rows inserted without it, then allow update', async () => {
      const db = await initializeDatabase(':memory:');

      // Insert a repository without specifying description (simulates pre-v7 data)
      await db
        .insertInto('repositories')
        .values({
          id: 'repo-pre-v7',
          name: 'Pre-v7 Repo',
          path: '/test/pre-v7',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      // Verify description defaults to null
      const beforeUpdate = await db
        .selectFrom('repositories')
        .selectAll()
        .where('id', '=', 'repo-pre-v7')
        .executeTakeFirstOrThrow();
      expect(beforeUpdate.description).toBeNull();

      // Update to add a description
      await db
        .updateTable('repositories')
        .set({ description: 'Added after migration' })
        .where('id', '=', 'repo-pre-v7')
        .execute();

      // Verify the description is now set
      const afterUpdate = await db
        .selectFrom('repositories')
        .selectAll()
        .where('id', '=', 'repo-pre-v7')
        .executeTakeFirstOrThrow();
      expect(afterUpdate.description).toBe('Added after migration');
    });
  });

  describe('schema migration v8: worktrees table', () => {
    it('should create worktrees table with correct columns', async () => {
      const db = await initializeDatabase(':memory:');

      // Verify the schema version is 9
      const { sql } = await import('kysely');
      const result = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
      expect(result.rows[0]?.user_version).toBe(10);

      // First create a repository (foreign key dependency)
      await db
        .insertInto('repositories')
        .values({
          id: 'repo-wt',
          name: 'Worktree Repo',
          path: '/test/worktree-repo',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      // Insert a worktree record
      await db
        .insertInto('worktrees')
        .values({
          id: 'wt-1',
          repository_id: 'repo-wt',
          path: '/test/worktrees/feature-1',
          index_number: 1,
        })
        .execute();

      const rows = await db.selectFrom('worktrees').selectAll().execute();

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('wt-1');
      expect(rows[0].repository_id).toBe('repo-wt');
      expect(rows[0].path).toBe('/test/worktrees/feature-1');
      expect(rows[0].index_number).toBe(1);
      expect(rows[0].created_at).toBeDefined();
    });

    it('should enforce unique path constraint', async () => {
      const db = await initializeDatabase(':memory:');

      await db
        .insertInto('repositories')
        .values({
          id: 'repo-unique-path',
          name: 'Unique Path Repo',
          path: '/test/unique-path',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      await db
        .insertInto('worktrees')
        .values({
          id: 'wt-dup-1',
          repository_id: 'repo-unique-path',
          path: '/test/worktrees/same-path',
          index_number: 1,
        })
        .execute();

      await expect(
        db
          .insertInto('worktrees')
          .values({
            id: 'wt-dup-2',
            repository_id: 'repo-unique-path',
            path: '/test/worktrees/same-path',
            index_number: 2,
          })
          .execute()
      ).rejects.toThrow();
    });

    it('should cascade delete worktrees when repository is deleted', async () => {
      const db = await initializeDatabase(':memory:');

      await db
        .insertInto('repositories')
        .values({
          id: 'repo-cascade-wt',
          name: 'Cascade Repo',
          path: '/test/cascade-wt',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      await db
        .insertInto('worktrees')
        .values({
          id: 'wt-cascade',
          repository_id: 'repo-cascade-wt',
          path: '/test/worktrees/cascade-1',
          index_number: 1,
        })
        .execute();

      // Delete the parent repository
      await db.deleteFrom('repositories').where('id', '=', 'repo-cascade-wt').execute();

      // Worktree should be cascade-deleted
      const rows = await db.selectFrom('worktrees').selectAll().execute();
      expect(rows).toHaveLength(0);
    });
  });

  describe('migrateWorktreeIndexesFromJson (via migrateFromJson)', () => {
    it('should migrate worktree indexes from JSON to SQLite for a single repo', async () => {
      const db = await initializeDatabase(':memory:');

      // Pre-insert a repository
      await db
        .insertInto('repositories')
        .values({
          id: 'repo-1',
          name: 'my-project',
          path: '/path/to/my-project',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      // Mock git to resolve org/repo
      mockGit.getRemoteUrl.mockImplementation(() =>
        Promise.resolve('git@github.com:owner/my-project.git')
      );
      mockGit.parseOrgRepo.mockImplementation(() => 'owner/my-project');

      // Create worktree-indexes.json at the expected path
      const worktreeIndexesPath = path.join(
        TEST_CONFIG_DIR, 'repositories', 'owner', 'my-project', 'worktrees', 'worktree-indexes.json'
      );
      fs.mkdirSync(path.dirname(worktreeIndexesPath), { recursive: true });
      fs.writeFileSync(
        worktreeIndexesPath,
        JSON.stringify({ indexes: { '/path/to/wt-1': 1, '/path/to/wt-2': 2 } })
      );

      await migrateFromJson(db);

      // Verify data was migrated
      const rows = await db.selectFrom('worktrees').selectAll().execute();
      expect(rows).toHaveLength(2);

      const paths = rows.map(r => r.path).sort();
      expect(paths).toEqual(['/path/to/wt-1', '/path/to/wt-2']);

      const indexes = rows.map(r => r.index_number).sort();
      expect(indexes).toEqual([1, 2]);

      // All rows should reference repo-1
      for (const row of rows) {
        expect(row.repository_id).toBe('repo-1');
      }

      // Verify JSON file was renamed
      expect(fs.existsSync(worktreeIndexesPath)).toBe(false);
      expect(fs.existsSync(`${worktreeIndexesPath}.migrated`)).toBe(true);
    });

    it('should rename JSON file but insert no data when indexes is empty', async () => {
      const db = await initializeDatabase(':memory:');

      await db
        .insertInto('repositories')
        .values({
          id: 'repo-1',
          name: 'my-project',
          path: '/path/to/my-project',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      mockGit.getRemoteUrl.mockImplementation(() =>
        Promise.resolve('git@github.com:owner/my-project.git')
      );
      mockGit.parseOrgRepo.mockImplementation(() => 'owner/my-project');

      const worktreeIndexesPath = path.join(
        TEST_CONFIG_DIR, 'repositories', 'owner', 'my-project', 'worktrees', 'worktree-indexes.json'
      );
      fs.mkdirSync(path.dirname(worktreeIndexesPath), { recursive: true });
      fs.writeFileSync(worktreeIndexesPath, JSON.stringify({ indexes: {} }));

      await migrateFromJson(db);

      const rows = await db.selectFrom('worktrees').selectAll().execute();
      expect(rows).toHaveLength(0);

      // JSON file should still be renamed to .migrated
      expect(fs.existsSync(worktreeIndexesPath)).toBe(false);
      expect(fs.existsSync(`${worktreeIndexesPath}.migrated`)).toBe(true);
    });

    it('should skip silently when no JSON file exists', async () => {
      const db = await initializeDatabase(':memory:');

      await db
        .insertInto('repositories')
        .values({
          id: 'repo-1',
          name: 'my-project',
          path: '/path/to/my-project',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      mockGit.getRemoteUrl.mockImplementation(() =>
        Promise.resolve('git@github.com:owner/my-project.git')
      );
      mockGit.parseOrgRepo.mockImplementation(() => 'owner/my-project');

      // Do NOT create any worktree-indexes.json

      await migrateFromJson(db);

      const rows = await db.selectFrom('worktrees').selectAll().execute();
      expect(rows).toHaveLength(0);
    });

    it('should skip repo that already has worktrees in the DB (per-repo idempotency)', async () => {
      const db = await initializeDatabase(':memory:');

      // Pre-insert repository
      await db
        .insertInto('repositories')
        .values({
          id: 'repo-1',
          name: 'my-project',
          path: '/path/to/my-project',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      // Pre-insert existing worktree record (simulates previous migration)
      await db
        .insertInto('worktrees')
        .values({
          id: 'existing-wt',
          repository_id: 'repo-1',
          path: '/existing/worktree',
          index_number: 5,
        })
        .execute();

      mockGit.getRemoteUrl.mockImplementation(() =>
        Promise.resolve('git@github.com:owner/my-project.git')
      );
      mockGit.parseOrgRepo.mockImplementation(() => 'owner/my-project');

      // Create JSON with different data that should NOT be applied
      const worktreeIndexesPath = path.join(
        TEST_CONFIG_DIR, 'repositories', 'owner', 'my-project', 'worktrees', 'worktree-indexes.json'
      );
      fs.mkdirSync(path.dirname(worktreeIndexesPath), { recursive: true });
      fs.writeFileSync(
        worktreeIndexesPath,
        JSON.stringify({ indexes: { '/path/to/wt-new': 10 } })
      );

      await migrateFromJson(db);

      // Original record should remain unchanged
      const rows = await db.selectFrom('worktrees').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('existing-wt');
      expect(rows[0].path).toBe('/existing/worktree');
      expect(rows[0].index_number).toBe(5);

      // JSON file should NOT be renamed (migration was skipped)
      expect(fs.existsSync(worktreeIndexesPath)).toBe(true);
    });

    it('should continue with other repos when one fails (partial failure)', async () => {
      const db = await initializeDatabase(':memory:');

      // Pre-insert two repositories
      await db
        .insertInto('repositories')
        .values({
          id: 'repo-1',
          name: 'good-project',
          path: '/path/to/good-project',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();
      await db
        .insertInto('repositories')
        .values({
          id: 'repo-2',
          name: 'bad-project',
          path: '/path/to/bad-project',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      // Mock git to return different org/repo based on repo path
      mockGit.getRemoteUrl.mockImplementation((cwd: string) => {
        if (cwd === '/path/to/good-project') {
          return Promise.resolve('git@github.com:owner/good-project.git');
        }
        return Promise.resolve('git@github.com:owner/bad-project.git');
      });
      mockGit.parseOrgRepo.mockImplementation((remoteUrl: string) => {
        if (remoteUrl.includes('good-project')) return 'owner/good-project';
        return 'owner/bad-project';
      });

      // Create valid JSON for repo-1
      const goodPath = path.join(
        TEST_CONFIG_DIR, 'repositories', 'owner', 'good-project', 'worktrees', 'worktree-indexes.json'
      );
      fs.mkdirSync(path.dirname(goodPath), { recursive: true });
      fs.writeFileSync(goodPath, JSON.stringify({ indexes: { '/wt/good-1': 1 } }));

      // Create invalid/corrupt JSON for repo-2
      const badPath = path.join(
        TEST_CONFIG_DIR, 'repositories', 'owner', 'bad-project', 'worktrees', 'worktree-indexes.json'
      );
      fs.mkdirSync(path.dirname(badPath), { recursive: true });
      fs.writeFileSync(badPath, 'not valid json {{{');

      // migrateFromJson should NOT throw - individual repo errors are caught
      await migrateFromJson(db);

      // repo-1 data should be migrated
      const rows = await db.selectFrom('worktrees').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].path).toBe('/wt/good-1');
      expect(rows[0].repository_id).toBe('repo-1');

      // Good JSON renamed, bad JSON still present (migration failed for that repo)
      expect(fs.existsSync(goodPath)).toBe(false);
      expect(fs.existsSync(`${goodPath}.migrated`)).toBe(true);
      expect(fs.existsSync(badPath)).toBe(true);
    });

    it('should fall back to basename when git remote fails', async () => {
      const db = await initializeDatabase(':memory:');

      await db
        .insertInto('repositories')
        .values({
          id: 'repo-1',
          name: 'my-project',
          path: '/repos/my-project',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      // Mock getRemoteUrl to throw (simulates no git remote)
      mockGit.getRemoteUrl.mockImplementation(() => {
        throw new Error('fatal: not a git repository');
      });

      // When fallback occurs, orgRepo = basename of path = 'my-project'
      // So JSON path is: $AGENT_CONSOLE_HOME/repositories/my-project/worktrees/worktree-indexes.json
      const worktreeIndexesPath = path.join(
        TEST_CONFIG_DIR, 'repositories', 'my-project', 'worktrees', 'worktree-indexes.json'
      );
      fs.mkdirSync(path.dirname(worktreeIndexesPath), { recursive: true });
      fs.writeFileSync(
        worktreeIndexesPath,
        JSON.stringify({ indexes: { '/repos/my-project/wt-1': 1 } })
      );

      await migrateFromJson(db);

      const rows = await db.selectFrom('worktrees').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].path).toBe('/repos/my-project/wt-1');
      expect(rows[0].index_number).toBe(1);
      expect(rows[0].repository_id).toBe('repo-1');

      // Verify JSON file was renamed
      expect(fs.existsSync(worktreeIndexesPath)).toBe(false);
      expect(fs.existsSync(`${worktreeIndexesPath}.migrated`)).toBe(true);
    });
  });

  describe('schema migration v9: cleanup_command column', () => {
    it('should add cleanup_command column to repositories table', async () => {
      const db = await initializeDatabase(':memory:');

      await db
        .insertInto('repositories')
        .values({
          id: 'repo-cleanup',
          name: 'Cleanup Repo',
          path: '/test/cleanup',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
          cleanup_command: 'docker compose down',
        })
        .execute();

      const rows = await db.selectFrom('repositories').selectAll().execute();

      expect(rows).toHaveLength(1);
      expect(rows[0].cleanup_command).toBe('docker compose down');
    });

    it('should allow null cleanup_command values', async () => {
      const db = await initializeDatabase(':memory:');

      await db
        .insertInto('repositories')
        .values({
          id: 'repo-no-cleanup',
          name: 'No Cleanup Repo',
          path: '/test/no-cleanup',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      const rows = await db.selectFrom('repositories').selectAll().execute();

      expect(rows).toHaveLength(1);
      expect(rows[0].cleanup_command).toBeNull();
    });
  });

  describe('schema migration v10: built-in agent persistence and default_agent_id column', () => {
    it('should insert built-in agent into agents table', async () => {
      const db = await initializeDatabase(':memory:');

      const rows = await db
        .selectFrom('agents')
        .selectAll()
        .where('id', '=', 'claude-code-builtin')
        .execute();

      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Claude Code');
      expect(rows[0].is_built_in).toBe(1);
    });

    it('should add default_agent_id column to repositories table', async () => {
      const db = await initializeDatabase(':memory:');

      // First insert a built-in agent (already done by migration)
      // Then insert a repository with default_agent_id
      await db
        .insertInto('repositories')
        .values({
          id: 'repo-default-agent',
          name: 'Default Agent Repo',
          path: '/test/default-agent',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
          default_agent_id: 'claude-code-builtin',
        })
        .execute();

      const rows = await db.selectFrom('repositories').selectAll().execute();

      expect(rows).toHaveLength(1);
      expect(rows[0].default_agent_id).toBe('claude-code-builtin');
    });

    it('should allow null default_agent_id values', async () => {
      const db = await initializeDatabase(':memory:');

      await db
        .insertInto('repositories')
        .values({
          id: 'repo-no-default-agent',
          name: 'No Default Agent Repo',
          path: '/test/no-default-agent',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      const rows = await db.selectFrom('repositories').selectAll().execute();

      expect(rows).toHaveLength(1);
      expect(rows[0].default_agent_id).toBeNull();
    });

    it('should set default_agent_id to null when referenced agent is deleted', async () => {
      const db = await initializeDatabase(':memory:');

      // Insert a custom agent
      await db
        .insertInto('agents')
        .values({
          id: 'custom-agent-for-fk',
          name: 'Custom Agent',
          command_template: 'custom {{prompt}}',
          is_built_in: 0,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      // Insert a repository referencing this agent
      await db
        .insertInto('repositories')
        .values({
          id: 'repo-fk-test',
          name: 'FK Test Repo',
          path: '/test/fk-test',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
          default_agent_id: 'custom-agent-for-fk',
        })
        .execute();

      // Delete the agent
      await db.deleteFrom('agents').where('id', '=', 'custom-agent-for-fk').execute();

      // default_agent_id should be set to null (ON DELETE SET NULL)
      const rows = await db.selectFrom('repositories').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].default_agent_id).toBeNull();
    });
  });

  describe('migrateFromJson error handling', () => {
    it('should handle unparseable JSON gracefully', async () => {
      // Create an invalid sessions.json with malformed JSON
      const sessionsJsonPath = path.join(TEST_CONFIG_DIR, 'sessions.json');
      fs.writeFileSync(sessionsJsonPath, 'not valid json {{{');

      // Initialize database
      const db = await initializeDatabase(':memory:');

      // migrateFromJson should fail due to JSON parse error
      await expect(migrateFromJson(db)).rejects.toThrow();
    });

    it('should handle empty sessions.json as migrated', async () => {
      // Create empty sessions array
      const sessionsJsonPath = path.join(TEST_CONFIG_DIR, 'sessions.json');
      fs.writeFileSync(sessionsJsonPath, JSON.stringify([]));

      // Initialize database
      const db = await initializeDatabase(':memory:');
      await migrateFromJson(db);

      // Verify JSON file was renamed to .migrated
      expect(fs.existsSync(sessionsJsonPath)).toBe(false);
      expect(fs.existsSync(`${sessionsJsonPath}.migrated`)).toBe(true);
    });
  });
});
