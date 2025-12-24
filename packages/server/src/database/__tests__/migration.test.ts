/**
 * Migration Integration Tests
 *
 * These tests verify the actual JSON to SQLite migration functions.
 * Uses real database initialization with temporary directories.
 *
 * Note: These tests set AGENT_CONSOLE_HOME to control where the database
 * and JSON files are created/read from.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuid } from 'uuid';
import { initializeDatabase, closeDatabase } from '../connection.js';

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
    registeredAt: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 'repo-2',
    name: 'another-project',
    path: '/path/to/another-project',
    registeredAt: '2024-01-02T00:00:00.000Z',
  },
];

const TEST_AGENTS = [
  {
    id: 'custom-agent-1',
    name: 'Custom Agent',
    commandTemplate: 'custom-agent {{prompt}}',  // Note: lowercase {{prompt}} required
    isBuiltIn: false,
    registeredAt: '2024-01-01T00:00:00.000Z',
    capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
  },
  // Built-in agent (should be skipped)
  {
    id: 'claude-code-builtin',
    name: 'Claude Code',
    commandTemplate: 'claude {{prompt}}',  // Note: lowercase {{prompt}} required
    isBuiltIn: true,
    registeredAt: '2024-01-01T00:00:00.000Z',
    capabilities: { supportsContinue: true, supportsHeadlessMode: true, supportsActivityDetection: true },
  },
];

/**
 * Create a unique temporary directory using Bun native APIs.
 */
function createTempDir(): string {
  const tmpBase = os.tmpdir();
  const uniqueDir = path.join(tmpBase, `agent-console-migration-test-${uuid()}`);
  Bun.spawnSync(['mkdir', '-p', uniqueDir]);
  return uniqueDir;
}

/**
 * Remove a directory recursively using Bun native APIs.
 */
function removeTempDir(dirPath: string): void {
  Bun.spawnSync(['rm', '-rf', dirPath]);
}

describe('migration', () => {
  let testConfigDir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    // Close any existing database connection from previous tests
    await closeDatabase();

    // Create a unique test directory
    testConfigDir = createTempDir();
    originalEnv = process.env.AGENT_CONSOLE_HOME;
    process.env.AGENT_CONSOLE_HOME = testConfigDir;
  });

  afterEach(async () => {
    await closeDatabase();
    process.env.AGENT_CONSOLE_HOME = originalEnv;
    removeTempDir(testConfigDir);
  });

  describe('migrateRepositoriesFromJson (via initializeDatabase)', () => {
    it('should migrate valid repositories from JSON to SQLite', async () => {
      // Create repositories.json before initializing database
      const reposJsonPath = path.join(testConfigDir, 'repositories.json');
      fs.writeFileSync(reposJsonPath, JSON.stringify(TEST_REPOSITORIES));

      // Initialize database - this triggers migrations including JSON migration
      const db = await initializeDatabase();

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
      const reposJsonPath = path.join(testConfigDir, 'repositories.json');
      expect(fs.existsSync(reposJsonPath)).toBe(false);

      // Initialize database
      const db = await initializeDatabase();

      // Verify no data in database
      const rows = await db.selectFrom('repositories').selectAll().execute();
      expect(rows).toHaveLength(0);
    });

    it('should skip if SQLite already has data', async () => {
      // First initialize database and add some data
      let db = await initializeDatabase();
      await db
        .insertInto('repositories')
        .values({
          id: 'existing-repo',
          name: 'Existing',
          path: '/existing',
          registered_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();

      // Close and reinitialize (to test migration skip)
      await closeDatabase();

      // Create repositories.json
      const reposJsonPath = path.join(testConfigDir, 'repositories.json');
      fs.writeFileSync(reposJsonPath, JSON.stringify(TEST_REPOSITORIES));

      // Reinitialize - migration should skip because data exists
      db = await initializeDatabase();

      // Verify only existing data remains
      const rows = await db.selectFrom('repositories').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('existing-repo');

      // JSON file should not be renamed (migration was skipped)
      expect(fs.existsSync(reposJsonPath)).toBe(true);
    });
  });

  describe('migrateAgentsFromJson (via initializeDatabase)', () => {
    it('should migrate custom agents from JSON to SQLite', async () => {
      // Create agents.json with only custom agent
      const customAgents = TEST_AGENTS.filter((a) => !a.isBuiltIn);
      const agentsJsonPath = path.join(testConfigDir, 'agents.json');
      fs.writeFileSync(agentsJsonPath, JSON.stringify(customAgents));

      // Initialize database
      const db = await initializeDatabase();

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
      const agentsJsonPath = path.join(testConfigDir, 'agents.json');
      fs.writeFileSync(agentsJsonPath, JSON.stringify(TEST_AGENTS));

      // Initialize database
      const db = await initializeDatabase();

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
          commandTemplate: 'valid {{prompt}}',  // lowercase {{prompt}} required
          isBuiltIn: false,
          registeredAt: '2024-01-01T00:00:00.000Z',
          capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
        },
        {
          // Missing required fields - should be skipped
          id: 'invalid-agent',
          // name is missing
          // commandTemplate is missing
        },
      ];
      const agentsJsonPath = path.join(testConfigDir, 'agents.json');
      fs.writeFileSync(agentsJsonPath, JSON.stringify(invalidAgents));

      // Initialize database
      const db = await initializeDatabase();

      // Verify only valid agent was migrated
      const rows = await db.selectFrom('agents').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('valid-agent');
    });

    it('should skip if no agents.json exists', async () => {
      // Ensure no JSON file exists
      const agentsJsonPath = path.join(testConfigDir, 'agents.json');
      expect(fs.existsSync(agentsJsonPath)).toBe(false);

      // Initialize database
      const db = await initializeDatabase();

      // Verify no data in database
      const rows = await db.selectFrom('agents').selectAll().execute();
      expect(rows).toHaveLength(0);
    });
  });

  describe('migrateSessionsFromJson (via initializeDatabase)', () => {
    it('should migrate valid sessions from JSON to SQLite', async () => {
      // Create sessions.json
      const sessionsJsonPath = path.join(testConfigDir, 'sessions.json');
      fs.writeFileSync(sessionsJsonPath, JSON.stringify(TEST_SESSIONS));

      // Initialize database
      const db = await initializeDatabase();

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
      const sessionsJsonPath = path.join(testConfigDir, 'sessions.json');
      expect(fs.existsSync(sessionsJsonPath)).toBe(false);

      // Initialize database
      const db = await initializeDatabase();

      // Verify no data in database
      const rows = await db.selectFrom('sessions').selectAll().execute();
      expect(rows).toHaveLength(0);
    });

    it('should skip if SQLite already has data', async () => {
      // First initialize database and add some data
      let db = await initializeDatabase();
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

      // Close and reinitialize
      await closeDatabase();

      // Create sessions.json
      const sessionsJsonPath = path.join(testConfigDir, 'sessions.json');
      fs.writeFileSync(sessionsJsonPath, JSON.stringify(TEST_SESSIONS));

      // Reinitialize - migration should skip
      db = await initializeDatabase();

      // Verify only existing session remains
      const rows = await db.selectFrom('sessions').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('existing-session');
    });
  });

  describe('migrateFromJson error handling', () => {
    it('should handle unparseable JSON gracefully', async () => {
      // Create an invalid sessions.json with malformed JSON
      const sessionsJsonPath = path.join(testConfigDir, 'sessions.json');
      fs.writeFileSync(sessionsJsonPath, 'not valid json {{{');

      // Initialize database should fail due to JSON parse error
      await expect(initializeDatabase()).rejects.toThrow();

      // Verify database file was cleaned up
      const dbPath = path.join(testConfigDir, 'data.db');
      expect(fs.existsSync(dbPath)).toBe(false);

      // Verify we can retry after cleanup
      // Remove the broken JSON file
      fs.unlinkSync(sessionsJsonPath);

      // Now initialization should succeed
      const db = await initializeDatabase();
      expect(db).toBeDefined();
    });

    it('should handle empty sessions.json as migrated', async () => {
      // Create empty sessions array
      const sessionsJsonPath = path.join(testConfigDir, 'sessions.json');
      fs.writeFileSync(sessionsJsonPath, JSON.stringify([]));

      // Initialize database should succeed
      const db = await initializeDatabase();
      expect(db).toBeDefined();

      // Verify JSON file was renamed to .migrated
      expect(fs.existsSync(sessionsJsonPath)).toBe(false);
      expect(fs.existsSync(`${sessionsJsonPath}.migrated`)).toBe(true);
    });
  });
});
