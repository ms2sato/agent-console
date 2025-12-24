/**
 * Test utilities for Server Bridge Pattern tests.
 *
 * IMPORTANT: Importing this module sets up all required mocks (fs, pty, open, git, process, database).
 * The mock.module calls are executed when the helper modules are imported.
 *
 * @example
 * ```typescript
 * import { createTestApp, setupTestEnvironment, cleanupTestEnvironment } from '@agent-console/server/__tests__/test-utils';
 *
 * beforeEach(async () => {
 *   setupTestEnvironment();
 *   app = await createTestApp();
 * });
 *
 * afterEach(() => {
 *   cleanupTestEnvironment();
 * });
 * ```
 */
import { Hono } from 'hono';
import { mock } from 'bun:test';
import { Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import type { Database } from '../database/schema.js';
import { MockPty } from './utils/mock-pty.js';

// Import mock helpers - this sets up mock.module calls
import { setupMemfs, cleanupMemfs } from './utils/mock-fs-helper.js';
import { resetProcessMock } from './utils/mock-process-helper.js';

// =============================================================================
// PTY Mock (not in a separate helper file)
// =============================================================================

const mockPtyInstances: MockPty[] = [];
let nextPtyPid = 10000;

mock.module('../lib/pty-provider.js', () => ({
  bunPtyProvider: {
    spawn: () => {
      const pty = new MockPty(nextPtyPid++);
      mockPtyInstances.push(pty);
      return pty;
    },
  },
}));

// =============================================================================
// Database Mock
// =============================================================================

// Shared in-memory database for all tests using test-utils.
// This prevents tests from creating database files on disk while still
// allowing proper isolation with SQLite operations.
let sharedMockDb: Kysely<Database> | null = null;

/**
 * Creates or returns the shared in-memory mock database.
 * Creates all tables (v2 schema) if the database doesn't exist yet.
 */
async function getOrCreateMockDatabase(): Promise<Kysely<Database>> {
  // Return existing database if already created
  if (sharedMockDb) {
    return sharedMockDb;
  }

  const bunDb = new BunDatabase(':memory:');
  bunDb.exec('PRAGMA foreign_keys = ON;');

  sharedMockDb = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: bunDb }),
  });

  // Create all tables (v2 schema)
  await createMockTables(sharedMockDb);

  return sharedMockDb;
}

/**
 * Creates the database tables for the mock database.
 * Matches the v2 schema from connection.ts migrations.
 */
async function createMockTables(db: Kysely<Database>): Promise<void> {
  // Sessions table
  await db.schema
    .createTable('sessions')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('location_path', 'text', (col) => col.notNull())
    .addColumn('server_pid', 'integer')
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('initial_prompt', 'text')
    .addColumn('title', 'text')
    .addColumn('repository_id', 'text')
    .addColumn('worktree_id', 'text')
    .execute();

  // Workers table
  await db.schema
    .createTable('workers')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('session_id', 'text', (col) =>
      col.notNull().references('sessions.id').onDelete('cascade')
    )
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('pid', 'integer')
    .addColumn('agent_id', 'text')
    .addColumn('base_commit', 'text')
    .execute();

  // Repositories table
  await db.schema
    .createTable('repositories')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('path', 'text', (col) => col.notNull().unique())
    .addColumn('registered_at', 'text', (col) => col.notNull())
    .execute();

  // Agents table
  await db.schema
    .createTable('agents')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('command_template', 'text', (col) => col.notNull())
    .addColumn('continue_template', 'text')
    .addColumn('headless_template', 'text')
    .addColumn('description', 'text')
    .addColumn('is_built_in', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('registered_at', 'text')
    .addColumn('activity_patterns', 'text')
    .execute();
}

/**
 * Clears all data from the mock database tables.
 * Can be used between tests if explicit database cleanup is needed.
 * Note: With cache-busted imports, fresh service instances typically provide
 * sufficient isolation without needing to clear the database.
 */
export async function clearMockDatabase(): Promise<void> {
  if (!sharedMockDb) return;

  // Delete in order to respect foreign key constraints
  await sharedMockDb.deleteFrom('workers').execute();
  await sharedMockDb.deleteFrom('sessions').execute();
  await sharedMockDb.deleteFrom('repositories').execute();
  await sharedMockDb.deleteFrom('agents').execute();
}

// Mock the database connection module
mock.module('../database/connection.js', () => ({
  initializeDatabase: async () => {
    return getOrCreateMockDatabase();
  },
  getDatabase: () => {
    if (!sharedMockDb) {
      throw new Error('Database not initialized');
    }
    return sharedMockDb;
  },
  closeDatabase: async () => {
    // Don't actually close - let it persist for other tests using cache-busted imports
  },
  databaseExists: async () => true,
  migrateFromJson: async () => {},
}));

// =============================================================================
// Open Mock
// =============================================================================

export const mockOpen = mock(async () => {});
mock.module('open', () => ({
  default: mockOpen,
}));

// =============================================================================
// Test Environment Setup
// =============================================================================

const TEST_CONFIG_DIR = '/test/config';
let importCounter = 0;

/**
 * Sets up the test environment with memfs and required mocks.
 */
export function setupTestEnvironment(): void {
  setupMemfs({
    [`${TEST_CONFIG_DIR}/.keep`]: '',
    [`${TEST_CONFIG_DIR}/agents.json`]: JSON.stringify([]),
    [`${TEST_CONFIG_DIR}/sessions.json`]: JSON.stringify([]),
    [`${TEST_CONFIG_DIR}/repositories.json`]: JSON.stringify([]),
  });
  process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

  // Reset PTY tracking
  mockPtyInstances.length = 0;
  nextPtyPid = 10000;

  // Reset process tracking
  resetProcessMock();

  // Reset open mock
  mockOpen.mockClear();
}

/**
 * Cleans up the test environment.
 */
export function cleanupTestEnvironment(): void {
  cleanupMemfs();
}

/**
 * Creates a fresh Hono app instance with all routes configured.
 * Uses cache-busting import to ensure fresh service instances.
 */
export async function createTestApp(): Promise<Hono> {
  const suffix = `?v=${++importCounter}`;
  const { api } = await import(`../routes/api.js${suffix}`);
  const { onApiError } = await import(`../lib/error-handler.js${suffix}`);

  const app = new Hono();
  app.onError(onApiError);
  app.route('/api', api);
  return app;
}

/**
 * Gets the test config directory path.
 */
export function getTestConfigDir(): string {
  return TEST_CONFIG_DIR;
}
