/**
 * Migration Integration Tests
 *
 * These tests verify the actual JSON to SQLite migration functions.
 * Uses in-memory SQLite database and memfs for JSON files.
 *
 * Note: These tests use migrateFromJson directly with ':memory:' database
 * because createDb() skips JSON migration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import type { Kysely } from 'kysely';
import type { Database } from '../schema.js';
import { createDatabaseForTest, migrateFromJson } from '../connection.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';

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
  let db: Kysely<Database> | null = null;

  async function createDb(): Promise<Kysely<Database>> {
    db = await createDatabaseForTest();
    return db;
  }

  beforeEach(async () => {
    // Setup memfs with config directory
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
  });

  afterEach(async () => {
    if (db) {
      await db.destroy();
      db = null;
    }
    cleanupMemfs();
  });

  describe('migrateRepositoriesFromJson (via migrateFromJson)', () => {
    it('should migrate valid repositories from JSON to SQLite', async () => {
      // Create repositories.json before initializing database
      const reposJsonPath = path.join(TEST_CONFIG_DIR, 'repositories.json');
      fs.writeFileSync(reposJsonPath, JSON.stringify(TEST_REPOSITORIES));

      // Initialize in-memory database
      const db = await createDb();

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
      const db = await createDb();
      await migrateFromJson(db);

      // Verify no data in database
      const rows = await db.selectFrom('repositories').selectAll().execute();
      expect(rows).toHaveLength(0);
    });

    it('should skip if SQLite already has data', async () => {
      // First initialize database and add some data
      const db = await createDb();
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
      const db = await createDb();
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
      const db = await createDb();
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

      // Initialize database
      const db = await createDb();
      await migrateFromJson(db);

      // Verify only custom agent was migrated
      const rows = await db.selectFrom('agents').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('custom-agent-1');
      expect(rows[0].is_built_in).toBe(0);

      // Verify JSON file was renamed
      expect(fs.existsSync(agentsJsonPath)).toBe(false);
      expect(fs.existsSync(`${agentsJsonPath}.migrated`)).toBe(true);
    });

    it('should skip built-in agents during migration', async () => {
      // Create agents.json with both custom and built-in
      const agentsJsonPath = path.join(TEST_CONFIG_DIR, 'agents.json');
      fs.writeFileSync(agentsJsonPath, JSON.stringify(TEST_AGENTS));

      // Initialize database
      const db = await createDb();
      await migrateFromJson(db);

      // Verify only custom agent was migrated (built-in was filtered)
      const rows = await db.selectFrom('agents').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('custom-agent-1');
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

      // Initialize database
      const db = await createDb();
      await migrateFromJson(db);

      // Verify only valid agent was migrated
      const rows = await db.selectFrom('agents').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('valid-agent');
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

      // Initialize database
      const db = await createDb();
      await migrateFromJson(db);

      // Verify agent was migrated with createdAt field
      const rows = await db.selectFrom('agents').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('legacy-agent');
      expect(rows[0].name).toBe('Legacy Agent');
      expect(rows[0].created_at).toBe('2023-06-15T10:30:00.000Z');

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

      // Initialize database
      const db = await createDb();
      await migrateFromJson(db);

      // Verify agent uses createdAt (not registeredAt)
      const rows = await db.selectFrom('agents').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].created_at).toBe('2024-01-01T00:00:00.000Z');
    });

    it('should skip if no agents.json exists', async () => {
      // Ensure no JSON file exists
      const agentsJsonPath = path.join(TEST_CONFIG_DIR, 'agents.json');
      expect(fs.existsSync(agentsJsonPath)).toBe(false);

      // Initialize database
      const db = await createDb();
      await migrateFromJson(db);

      // Verify no data in database
      const rows = await db.selectFrom('agents').selectAll().execute();
      expect(rows).toHaveLength(0);
    });
  });

  describe('migrateSessionsFromJson (via migrateFromJson)', () => {
    it('should migrate valid sessions from JSON to SQLite', async () => {
      // Create sessions.json
      const sessionsJsonPath = path.join(TEST_CONFIG_DIR, 'sessions.json');
      fs.writeFileSync(sessionsJsonPath, JSON.stringify(TEST_SESSIONS));

      // Initialize database
      const db = await createDb();
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
      const db = await createDb();
      await migrateFromJson(db);

      // Verify no data in database
      const rows = await db.selectFrom('sessions').selectAll().execute();
      expect(rows).toHaveLength(0);
    });

    it('should skip if SQLite already has data', async () => {
      // First initialize database and add some data
      const db = await createDb();
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

  describe('migrateFromJson error handling', () => {
    it('should handle unparseable JSON gracefully', async () => {
      // Create an invalid sessions.json with malformed JSON
      const sessionsJsonPath = path.join(TEST_CONFIG_DIR, 'sessions.json');
      fs.writeFileSync(sessionsJsonPath, 'not valid json {{{');

      // Initialize database
      const db = await createDb();

      // migrateFromJson should fail due to JSON parse error
      await expect(migrateFromJson(db)).rejects.toThrow();
    });

    it('should handle empty sessions.json as migrated', async () => {
      // Create empty sessions array
      const sessionsJsonPath = path.join(TEST_CONFIG_DIR, 'sessions.json');
      fs.writeFileSync(sessionsJsonPath, JSON.stringify([]));

      // Initialize database
      const db = await createDb();
      await migrateFromJson(db);

      // Verify JSON file was renamed to .migrated
      expect(fs.existsSync(sessionsJsonPath)).toBe(false);
      expect(fs.existsSync(`${sessionsJsonPath}.migrated`)).toBe(true);
    });
  });
});
