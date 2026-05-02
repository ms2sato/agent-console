import { Kysely, sql } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import * as path from 'path';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as v from 'valibot';
import type { AgentDefinition } from '@agent-console/shared';
import { AgentDefinitionSchema } from '@agent-console/shared';
import type { Database } from './schema.js';
import type { PersistedSession, PersistedRepository } from '../services/persistence-service.js';
import { getConfigDir, getDbPath, getRepositoryDir } from '../lib/config.js';
import { getRemoteUrl, parseOrgRepo } from '../lib/git.js';
import { createLogger } from '../lib/logger.js';
import { isValidSlug } from '../lib/session-data-path.js';
import { toSessionRow, toWorkerRow, toRepositoryRow, toAgentRow } from './mappers.js';
import { addDatetime } from './schema-helpers.js';

const logger = createLogger('database');

/**
 * Check if an error is a SQLite "duplicate column name" error.
 * Used by migrations to make ALTER TABLE ADD COLUMN idempotent.
 */
function isDuplicateColumnError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('duplicate column name');
}

/**
 * Sentinel value used by callers (and tests) to opt out of pre-migration
 * backup. Matches the path that Bun SQLite uses for in-memory databases.
 */
const IN_MEMORY_DB_PATH = ':memory:';

/**
 * Create a sibling backup copy of the SQLite database file before running a
 * disruptive migration (e.g. table-recreation in v19).
 *
 * The backup file lives next to the database with a deterministic suffix that
 * encodes the version transition and a timestamp, e.g.:
 *   /path/to/agentconsole.db.bak.v18-to-v19.2026-04-25T20-39-00-000Z
 *
 * Behaviour:
 *   - In-memory databases (`:memory:`) are skipped — there is no file to copy.
 *     Returns `null` so callers can distinguish "skipped" from "succeeded".
 *   - On copy failure, the underlying error is re-thrown unchanged so the
 *     caller can abort the migration without bumping the schema version.
 *   - Colons and dots in the ISO-8601 timestamp are replaced with `-` so the
 *     filename is portable across filesystems.
 *
 * @returns The absolute path to the backup file, or `null` when skipped.
 */
export async function backupDatabaseFile(
  dbPath: string,
  fromVersion: number,
  toVersion: number
): Promise<string | null> {
  if (dbPath === IN_MEMORY_DB_PATH) {
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.bak.v${fromVersion}-to-v${toVersion}.${timestamp}`;

  await fsPromises.copyFile(dbPath, backupPath);

  return backupPath;
}

let db: Kysely<Database> | null = null;

/**
 * Promise-based mutex to ensure database is initialized only once.
 * Protects against race conditions when multiple calls happen concurrently.
 */
let initializationPromise: Promise<Kysely<Database>> | null = null;

/**
 * Get the database instance.
 * @throws Error if database is not initialized
 */
export function getDatabase(): Kysely<Database> {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
}

/**
 * Initialize the SQLite database.
 * Creates the database file if it doesn't exist and runs migrations.
 * Uses a Promise-based mutex to prevent race conditions from concurrent calls.
 * @param dbPath - Optional database path. Use ':memory:' for in-memory database (useful for tests).
 *                 If not specified, uses the default path in config directory.
 * @returns The initialized Kysely database instance
 */
export async function initializeDatabase(dbPath?: string): Promise<Kysely<Database>> {
  // Fast path: return existing instance (only for default path)
  if (db && !dbPath) return db;

  // If initialization is already in progress, wait for it (only for default path)
  if (initializationPromise && !dbPath) {
    return initializationPromise;
  }

  // Start initialization and store the promise for concurrent callers
  const promise = doInitializeDatabase(dbPath);

  // Only cache the promise for default path (production use)
  if (!dbPath) {
    initializationPromise = promise;
  }

  try {
    return await promise;
  } finally {
    // Clear the promise after completion (success or failure)
    // This allows retry on next call if initialization failed
    if (!dbPath) {
      initializationPromise = null;
    }
  }
}

/**
 * Internal function that performs the actual database initialization.
 * Should only be called from initializeDatabase() with proper mutex protection.
 * @param customDbPath - Optional custom database path. Use ':memory:' for in-memory database.
 */
async function doInitializeDatabase(customDbPath?: string): Promise<Kysely<Database>> {
  const isInMemory = customDbPath === ':memory:';
  const dbPath = customDbPath ?? getDbPath();

  // Ensure config directory exists (skip for in-memory database)
  if (!isInMemory) {
    const configDir = path.dirname(dbPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
  }

  logger.info({ dbPath }, 'Initializing SQLite database');

  const bunDb = new BunDatabase(dbPath);

  const database = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: bunDb }),
  });

  // Enable foreign key constraints (required for cascade deletes)
  await sql`PRAGMA foreign_keys = ON`.execute(database);

  // Run schema migrations
  await runMigrations(database, dbPath);

  // Migrate data from JSON (one-time, skip for in-memory database)
  if (!isInMemory) {
    await migrateFromJson(database);
  }

  // Set global db for default path OR in-memory database
  // In-memory is used for testing: test setup initializes once, and subsequent calls return it
  if (!customDbPath || isInMemory) {
    db = database;
  }

  return database;
}

/**
 * Close the database connection.
 * Should be called during server shutdown.
 */
export async function closeDatabase(): Promise<void> {
  if (db) {
    await db.destroy();
    db = null;
    logger.info('Database connection closed');
  }
}

/**
 * Get the global database instance (for comparison purposes).
 * @internal Used by AppContext to avoid double-destroy.
 */
export function getGlobalDatabase(): Kysely<Database> | null {
  return db;
}

/**
 * Create a standalone database for testing.
 * Uses an in-memory SQLite database with all migrations applied.
 * Does NOT modify the global `db` variable, ensuring test isolation.
 *
 * @returns A new Kysely database instance for testing
 */
export async function createDatabaseForTest(): Promise<Kysely<Database>> {
  logger.debug('Creating in-memory database for test');

  const bunDb = new BunDatabase(':memory:');

  const database = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: bunDb }),
  });

  // Enable foreign key constraints
  await sql`PRAGMA foreign_keys = ON`.execute(database);

  // Run schema migrations
  await runMigrations(database, IN_MEMORY_DB_PATH);

  return database;
}

/**
 * Run database migrations based on PRAGMA user_version.
 * Each migration increments the version number.
 *
 * @param dbPath - Filesystem path of the database, or `:memory:` for an
 *                 in-memory database. Migrations that need to take a
 *                 pre-flight backup (e.g. v19) use this to locate the file
 *                 and skip the backup for in-memory databases.
 */
async function runMigrations(database: Kysely<Database>, dbPath: string): Promise<void> {
  // Get current schema version using PRAGMA user_version
  const result = await sql<{ user_version: number }>`PRAGMA user_version`.execute(database);
  const currentVersion = result.rows[0]?.user_version ?? 0;

  logger.info({ currentVersion }, 'Current database schema version');

  // Run migrations based on current version
  if (currentVersion < 1) {
    await migrateToV1(database);
  }

  if (currentVersion < 2) {
    await migrateToV2(database);
  }

  if (currentVersion < 3) {
    await migrateToV3(database);
  }

  if (currentVersion < 4) {
    await migrateToV4(database);
  }

  if (currentVersion < 5) {
    await migrateToV5(database);
  }

  if (currentVersion < 6) {
    await migrateToV6(database);
  }

  if (currentVersion < 7) {
    await migrateToV7(database);
  }

  if (currentVersion < 8) {
    await migrateToV8(database);
  }

  if (currentVersion < 9) {
    await migrateToV9(database);
  }

  if (currentVersion < 10) {
    await migrateToV10(database);
  }

  if (currentVersion < 11) {
    await migrateToV11(database);
  }

  if (currentVersion < 12) {
    await migrateToV12(database);
  }

  if (currentVersion < 13) {
    await migrateToV13(database);
  }

  if (currentVersion < 14) {
    await migrateToV14(database);
  }

  if (currentVersion < 15) {
    await migrateToV15(database);
  }

  if (currentVersion < 16) {
    await migrateToV16(database);
  }

  if (currentVersion < 17) {
    await migrateToV17(database);
  }

  if (currentVersion < 18) {
    await migrateToV18(database);
  }

  if (currentVersion < 19) {
    await migrateToV19(database, dbPath);
  }

  if (currentVersion < 20) {
    await migrateToV20(database);
  }
}

/**
 * Migration v1: Create sessions and workers tables.
 */
async function migrateToV1(database: Kysely<Database>): Promise<void> {
  logger.info('Running migration to v1: Creating sessions and workers tables');

  // Create sessions table
  let sessionsTable = database.schema
    .createTable('sessions')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('location_path', 'text', (col) => col.notNull())
    .addColumn('server_pid', 'integer')
    .addColumn('initial_prompt', 'text')
    .addColumn('title', 'text')
    .addColumn('repository_id', 'text')
    .addColumn('worktree_id', 'text');
  sessionsTable = addDatetime(sessionsTable, 'sessions', 'created_at', (col) => col.notNull(), {
    defaultNow: true,
  });
  sessionsTable = addDatetime(sessionsTable, 'sessions', 'updated_at', (col) => col.notNull(), {
    defaultNow: true,
  });
  await sessionsTable.execute();

  // Create workers table
  let workersTable = database.schema
    .createTable('workers')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('session_id', 'text', (col) =>
      col.notNull().references('sessions.id').onDelete('cascade')
    )
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('pid', 'integer')
    .addColumn('agent_id', 'text')
    .addColumn('base_commit', 'text');
  workersTable = addDatetime(workersTable, 'workers', 'created_at', (col) => col.notNull(), {
    defaultNow: true,
  });
  workersTable = addDatetime(workersTable, 'workers', 'updated_at', (col) => col.notNull(), {
    defaultNow: true,
  });
  await workersTable.execute();

  // Create index for foreign key lookups
  await database.schema
    .createIndex('idx_workers_session_id')
    .ifNotExists()
    .on('workers')
    .column('session_id')
    .execute();

  // Update schema version
  await sql`PRAGMA user_version = 1`.execute(database);

  logger.info('Migration to v1 completed');
}

/**
 * Migration v2: Create repositories and agents tables.
 */
async function migrateToV2(database: Kysely<Database>): Promise<void> {
  logger.info('Running migration to v2: Creating repositories and agents tables');

  // Create repositories table
  let repositoriesTable = database.schema
    .createTable('repositories')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('path', 'text', (col) => col.notNull().unique());
  repositoriesTable = addDatetime(
    repositoriesTable,
    'repositories',
    'created_at',
    (col) => col.notNull(),
    { defaultNow: true }
  );
  repositoriesTable = addDatetime(
    repositoriesTable,
    'repositories',
    'updated_at',
    (col) => col.notNull(),
    { defaultNow: true }
  );
  await repositoriesTable.execute();

  // Create agents table
  let agentsTable = database.schema
    .createTable('agents')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('command_template', 'text', (col) => col.notNull())
    .addColumn('continue_template', 'text')
    .addColumn('headless_template', 'text')
    .addColumn('description', 'text')
    .addColumn('is_built_in', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('activity_patterns', 'text');
  agentsTable = addDatetime(agentsTable, 'agents', 'created_at', (col) => col.notNull(), {
    defaultNow: true,
  });
  agentsTable = addDatetime(agentsTable, 'agents', 'updated_at', (col) => col.notNull(), {
    defaultNow: true,
  });
  await agentsTable.execute();

  // Update schema version
  await sql`PRAGMA user_version = 2`.execute(database);

  logger.info('Migration to v2 completed');
}

/**
 * Migration v3: Create jobs table for local job queue.
 * This integrates the JobQueue schema into the main migration system.
 */
async function migrateToV3(database: Kysely<Database>): Promise<void> {
  logger.info('Running migration to v3: Creating jobs table');

  // Create jobs table with all columns matching JobQueue schema
  await database.schema
    .createTable('jobs')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('payload', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('pending'))
    .addColumn('priority', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('max_attempts', 'integer', (col) => col.notNull().defaultTo(5))
    .addColumn('next_retry_at', 'integer', (col) => col.notNull())
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('started_at', 'integer')
    .addColumn('completed_at', 'integer')
    .execute();

  // Create indexes for efficient job queue operations
  await database.schema
    .createIndex('idx_jobs_pending')
    .ifNotExists()
    .on('jobs')
    .columns(['status', 'priority', 'next_retry_at'])
    .execute();

  await database.schema
    .createIndex('idx_jobs_status')
    .ifNotExists()
    .on('jobs')
    .column('status')
    .execute();

  await database.schema
    .createIndex('idx_jobs_type')
    .ifNotExists()
    .on('jobs')
    .column('type')
    .execute();

  // Update schema version
  await sql`PRAGMA user_version = 3`.execute(database);

  logger.info('Migration to v3 completed');
}

/**
 * Migration v4: Add setup_command column to repositories table.
 * This column stores shell commands to run after creating worktrees.
 */
async function migrateToV4(database: Kysely<Database>): Promise<void> {
  logger.info('Running migration to v4: Adding setup_command column to repositories');

  // Add setup_command column to repositories table
  await database.schema
    .alterTable('repositories')
    .addColumn('setup_command', 'text')
    .execute();

  // Update schema version
  await sql`PRAGMA user_version = 4`.execute(database);

  logger.info('Migration to v4 completed');
}

/**
 * Migration v5: Add env_vars column to repositories table.
 * This column stores environment variables in .env format to apply to workers.
 */
async function migrateToV5(database: Kysely<Database>): Promise<void> {
  logger.info('Running migration to v5: Adding env_vars column to repositories');

  // Add env_vars column to repositories table
  await database.schema
    .alterTable('repositories')
    .addColumn('env_vars', 'text')
    .execute();

  // Update schema version
  await sql`PRAGMA user_version = 5`.execute(database);

  logger.info('Migration to v5 completed');
}

/**
 * Migration v6: Create repository_slack_integrations table.
 * Stores per-repository Slack integration settings for outbound notifications.
 */
async function migrateToV6(database: Kysely<Database>): Promise<void> {
  logger.info('Running migration to v6: Creating repository_slack_integrations table');

  // Create repository_slack_integrations table
  let integrationsTable = database.schema
    .createTable('repository_slack_integrations')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('repository_id', 'text', (col) =>
      col.notNull().unique().references('repositories.id').onDelete('cascade')
    )
    .addColumn('webhook_url', 'text', (col) => col.notNull())
    .addColumn('enabled', 'integer', (col) => col.notNull().defaultTo(1));
  integrationsTable = addDatetime(
    integrationsTable,
    'repository_slack_integrations',
    'created_at',
    (col) => col.notNull(),
    { defaultNow: true }
  );
  integrationsTable = addDatetime(
    integrationsTable,
    'repository_slack_integrations',
    'updated_at',
    (col) => col.notNull(),
    { defaultNow: true }
  );
  await integrationsTable.execute();

  // Create index for foreign key lookups
  await database.schema
    .createIndex('idx_repository_slack_integrations_repository_id')
    .ifNotExists()
    .on('repository_slack_integrations')
    .column('repository_id')
    .execute();

  // Update schema version
  await sql`PRAGMA user_version = 6`.execute(database);

  logger.info('Migration to v6 completed');
}

/**
 * Migration v7: Add description column to repositories table.
 * This column stores a brief description of the repository.
 */
async function migrateToV7(database: Kysely<Database>): Promise<void> {
  logger.info('Running migration to v7: Adding description column to repositories');

  // Add description column to repositories table
  await database.schema
    .alterTable('repositories')
    .addColumn('description', 'text')
    .execute();

  // Update schema version
  await sql`PRAGMA user_version = 7`.execute(database);

  logger.info('Migration to v7 completed');
}

/**
 * Migration v8: Create worktrees table.
 * Replaces the JSON-based worktree-indexes.json with a proper database table.
 */
async function migrateToV8(database: Kysely<Database>): Promise<void> {
  logger.info('Running migration to v8: Creating worktrees table');

  // Create worktrees table
  let worktreesTable = database.schema
    .createTable('worktrees')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('repository_id', 'text', (col) =>
      col.notNull().references('repositories.id').onDelete('cascade')
    )
    .addColumn('path', 'text', (col) => col.notNull().unique())
    .addColumn('index_number', 'integer', (col) => col.notNull());
  worktreesTable = addDatetime(worktreesTable, 'worktrees', 'created_at', (col) => col.notNull(), {
    defaultNow: true,
  });
  await worktreesTable.execute();

  // Create index for foreign key lookups
  await database.schema
    .createIndex('idx_worktrees_repository_id')
    .ifNotExists()
    .on('worktrees')
    .column('repository_id')
    .execute();

  // Update schema version
  await sql`PRAGMA user_version = 8`.execute(database);

  logger.info('Migration to v8 completed');
}

/**
 * Migration v9: Add cleanup_command column to repositories table.
 * This column stores shell commands to run before deleting worktrees.
 */
async function migrateToV9(database: Kysely<Database>): Promise<void> {
  logger.info('Running migration to v9: Adding cleanup_command column to repositories');

  // Add cleanup_command column to repositories table
  await database.schema
    .alterTable('repositories')
    .addColumn('cleanup_command', 'text')
    .execute();

  // Update schema version
  await sql`PRAGMA user_version = 9`.execute(database);

  logger.info('Migration to v9 completed');
}

/**
 * Migration v10: Persist built-in agent and add default_agent_id to repositories.
 */
async function migrateToV10(database: Kysely<Database>): Promise<void> {
  logger.info('Running migration to v10: Persisting built-in agent and adding default_agent_id to repositories');

  // Insert built-in agent (Claude Code) into agents table if not exists
  const now = new Date().toISOString();
  await database
    .insertInto('agents')
    .values({
      id: 'claude-code-builtin',
      name: 'Claude Code',
      command_template: 'claude {{prompt}}',
      continue_template: 'claude -c',
      headless_template: 'claude -p --output-format text {{prompt}}',
      description: 'Anthropic Claude Code - Interactive AI coding assistant',
      is_built_in: 1,
      created_at: new Date(0).toISOString(),
      updated_at: now,
      activity_patterns: null, // Will be synced from code on next startup
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  // Add default_agent_id column with FK constraint
  await sql`ALTER TABLE repositories ADD COLUMN default_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL`.execute(database);

  await sql`PRAGMA user_version = 10`.execute(database);
  logger.info('Migration to v10 completed');
}

/**
 * Migration v11: Create inbound_event_notifications table.
 * Tracks delivery of inbound events to session/worker targets for idempotency.
 */
async function migrateToV11(database: Kysely<Database>): Promise<void> {
  logger.info('Running migration to v11: Creating inbound_event_notifications table');

  await database.schema
    .createTable('inbound_event_notifications')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('job_id', 'text', (col) => col.notNull())
    .addColumn('session_id', 'text', (col) =>
      col.notNull().references('sessions.id').onDelete('cascade')
    )
    .addColumn('worker_id', 'text', (col) => col.notNull())
    .addColumn('handler_id', 'text', (col) => col.notNull())
    .addColumn('event_type', 'text', (col) => col.notNull())
    .addColumn('event_summary', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('pending'))
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('notified_at', 'text')
    .execute();

  await database.schema
    .createIndex('idx_inbound_notifications_job')
    .on('inbound_event_notifications')
    .column('job_id')
    .execute();

  await database.schema
    .createIndex('idx_inbound_notifications_session_worker')
    .on('inbound_event_notifications')
    .columns(['session_id', 'worker_id'])
    .execute();

  // Unique constraint for idempotency
  await database.schema
    .createIndex('idx_inbound_notifications_unique')
    .on('inbound_event_notifications')
    .columns(['job_id', 'session_id', 'worker_id', 'handler_id'])
    .unique()
    .execute();

  await sql`PRAGMA user_version = 11`.execute(database);
  logger.info('Migration to v11 completed');
}

/**
 * Migration v12: Add paused_at column to sessions table.
 * Tracks when a session was paused. NULL = not paused.
 */
async function migrateToV12(database: Kysely<Database>): Promise<void> {
  logger.info('Running migration to v12: Adding paused_at column to sessions');

  await database.schema
    .alterTable('sessions')
    .addColumn('paused_at', 'text')
    .execute();

  // Update schema version
  await sql`PRAGMA user_version = 12`.execute(database);

  logger.info('Migration to v12 completed');
}

/**
 * Migration v13: Add parent_session_id and parent_worker_id columns to sessions table.
 * Tracks which session/worker delegated the creation of this session.
 */
async function migrateToV13(database: Kysely<Database>): Promise<void> {
  logger.info('Running migration to v13: Adding parent_session_id and parent_worker_id to sessions');

  // Use try-catch for idempotency: if a column already exists from a partial
  // previous run, ignore the error and continue with the remaining columns.
  try {
    await database.schema
      .alterTable('sessions')
      .addColumn('parent_session_id', 'text')
      .execute();
  } catch (error) {
    if (!isDuplicateColumnError(error)) throw error;
    logger.info('Column parent_session_id already exists, skipping');
  }

  try {
    await database.schema
      .alterTable('sessions')
      .addColumn('parent_worker_id', 'text')
      .execute();
  } catch (error) {
    if (!isDuplicateColumnError(error)) throw error;
    logger.info('Column parent_worker_id already exists, skipping');
  }

  await sql`PRAGMA user_version = 13`.execute(database);

  logger.info('Migration to v13 completed');
}

/**
 * Migration v14: Create users table and add created_by column to sessions.
 * The users table provides stable UUID-based identity for session ownership.
 * created_by references users.id and is NULL for pre-multi-user sessions.
 */
async function migrateToV14(database: Kysely<Database>): Promise<void> {
  logger.info('Running migration to v14: Creating users table and adding created_by to sessions');

  // Create users table
  await database.schema
    .createTable('users')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('os_uid', 'integer')
    .addColumn('username', 'text', (col) => col.notNull())
    .addColumn('home_dir', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .execute();

  // Partial unique index: unique os_uid where not null
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_os_uid ON users(os_uid) WHERE os_uid IS NOT NULL`.execute(database);

  // Add created_by column to sessions (references users.id)
  try {
    await database.schema
      .alterTable('sessions')
      .addColumn('created_by', 'text')
      .execute();
  } catch (error) {
    if (!isDuplicateColumnError(error)) throw error;
    logger.info('Column created_by already exists, skipping');
  }

  await sql`PRAGMA user_version = 14`.execute(database);

  logger.info('Migration to v14 completed');
}

/**
 * Migration v15: Add base_agent_id column to agents table.
 * Supports agent presets that inherit properties from a base agent.
 */
async function migrateToV15(database: Kysely<Database>): Promise<void> {
  logger.info('Running migration to v15: Adding base_agent_id to agents');

  try {
    await database.schema
      .alterTable('agents')
      .addColumn('base_agent_id', 'text')
      .execute();
  } catch (error) {
    if (!isDuplicateColumnError(error)) throw error;
    logger.info('Column base_agent_id already exists, skipping');
  }

  await sql`PRAGMA user_version = 15`.execute(database);

  logger.info('Migration to v15 completed');
}

async function migrateToV16(database: Kysely<Database>): Promise<void> {
  logger.info('Running migration to v16: Creating timers table');

  await database.schema
    .createTable('timers')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('session_id', 'text', (col) => col.notNull())
    .addColumn('worker_id', 'text', (col) => col.notNull())
    .addColumn('interval_seconds', 'integer', (col) => col.notNull())
    .addColumn('action', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull())
    .execute();

  await database.schema
    .createIndex('idx_timers_session_id')
    .ifNotExists()
    .on('timers')
    .column('session_id')
    .execute();

  await sql`PRAGMA user_version = 16`.execute(database);

  logger.info('Migration to v16 completed');
}

/**
 * Migration v17: Create message_templates table.
 */
async function migrateToV17(database: Kysely<Database>): Promise<void> {
  logger.info('Running migration to v17: Creating message_templates table');

  await database.schema
    .createTable('message_templates')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('sort_order', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  await sql`PRAGMA user_version = 17`.execute(database);

  logger.info('Migration to v17 completed');
}

/**
 * Migration v18: Add session-data-path scope columns and orphan recovery state.
 *
 * Adds five new columns to the sessions table to support scope-based data path
 * resolution and explicit orphan recovery state. See docs/design/session-data-path.md.
 *
 * After adding columns, backfills existing rows within a single transaction:
 *   - type='quick'    -> data_scope='quick',      data_scope_slug=NULL
 *   - type='worktree' -> data_scope='repository', data_scope_slug=<repositories.name>
 *     (joined via sessions.repository_id), but only when the resolved name
 *     conforms to the slug grammar enforced by `session-data-path.ts`.
 *   - type='worktree' with an unresolvable repository_id -> recovery_state='orphaned',
 *     orphaned_at=<now>, orphaned_reason='migration_unresolved_repository'
 *   - type='worktree' whose joined repository name does not satisfy the slug
 *     grammar -> recovery_state='orphaned', orphaned_at=<now>,
 *     orphaned_reason='migration_invalid_slug'.
 *     Without this, an invalid name would be written verbatim and would later
 *     fail at runtime in `computeSessionDataBaseDir`, corrupting otherwise-
 *     healthy sessions.
 */
async function migrateToV18(database: Kysely<Database>): Promise<void> {
  logger.info('Running migration to v18: Adding session-data-path scope columns');

  // Idempotent ALTER TABLE ADD COLUMN for each new column.
  const addColumns: Array<{
    name: string;
    add: () => Promise<void>;
  }> = [
    {
      name: 'data_scope',
      add: async () => {
        await database.schema
          .alterTable('sessions')
          .addColumn('data_scope', 'text')
          .execute();
      },
    },
    {
      name: 'data_scope_slug',
      add: async () => {
        await database.schema
          .alterTable('sessions')
          .addColumn('data_scope_slug', 'text')
          .execute();
      },
    },
    {
      name: 'recovery_state',
      add: async () => {
        // NOT NULL with DEFAULT so existing rows receive 'healthy' automatically.
        await sql`ALTER TABLE sessions ADD COLUMN recovery_state TEXT NOT NULL DEFAULT 'healthy'`.execute(database);
      },
    },
    {
      name: 'orphaned_at',
      add: async () => {
        await database.schema
          .alterTable('sessions')
          .addColumn('orphaned_at', 'integer')
          .execute();
      },
    },
    {
      name: 'orphaned_reason',
      add: async () => {
        await database.schema
          .alterTable('sessions')
          .addColumn('orphaned_reason', 'text')
          .execute();
      },
    },
  ];

  for (const { name, add } of addColumns) {
    try {
      await add();
    } catch (error) {
      if (!isDuplicateColumnError(error)) throw error;
      logger.info({ column: name }, 'Column already exists, skipping');
    }
  }

  // Backfill existing rows.
  // Guard: only rows with data_scope IS NULL are touched so that re-running
  // the migration cannot re-orphan rows that were already backfilled, and
  // cannot un-orphan rows that were healthy-at-migration-time.
  const now = Date.now();
  let quickBackfilled = 0;
  let worktreeBackfilledHealthy = 0;
  let worktreeOrphanedUnresolved = 0;
  let worktreeOrphanedInvalidSlug = 0;

  await database.transaction().execute(async (trx) => {
    // Quick sessions: scope='quick', slug=NULL.
    const quickResult = await trx
      .updateTable('sessions')
      .set({ data_scope: 'quick', data_scope_slug: null })
      .where('type', '=', 'quick')
      .where('data_scope', 'is', null)
      .executeTakeFirst();
    quickBackfilled = Number(quickResult.numUpdatedRows ?? 0);

    // Worktree sessions with a resolvable repository: scope='repository', slug=<name>.
    // Load candidates (id + repository_id + repositories.name) first, then
    // partition into resolvable and unresolvable sets.
    const candidates = await trx
      .selectFrom('sessions')
      .leftJoin('repositories', 'repositories.id', 'sessions.repository_id')
      .select([
        'sessions.id as sessionId',
        'sessions.repository_id as repositoryId',
        'repositories.name as repositoryName',
      ])
      .where('sessions.type', '=', 'worktree')
      .where('sessions.data_scope', 'is', null)
      .execute();

    for (const row of candidates) {
      if (row.repositoryName === null || row.repositoryName === undefined) {
        await trx
          .updateTable('sessions')
          .set({
            data_scope: null,
            data_scope_slug: null,
            recovery_state: 'orphaned',
            orphaned_at: now,
            orphaned_reason: 'migration_unresolved_repository',
          })
          .where('id', '=', row.sessionId)
          .execute();
        worktreeOrphanedUnresolved++;
        continue;
      }

      // The repository name is what gets persisted as `data_scope_slug`. If
      // the name does not conform to the slug grammar, writing it verbatim
      // would silently succeed here but would later throw at runtime in
      // `computeSessionDataBaseDir`. Mark the session orphaned instead.
      if (!isValidSlug(row.repositoryName)) {
        await trx
          .updateTable('sessions')
          .set({
            data_scope: null,
            data_scope_slug: null,
            recovery_state: 'orphaned',
            orphaned_at: now,
            orphaned_reason: 'migration_invalid_slug',
          })
          .where('id', '=', row.sessionId)
          .execute();
        worktreeOrphanedInvalidSlug++;
        continue;
      }

      await trx
        .updateTable('sessions')
        .set({ data_scope: 'repository', data_scope_slug: row.repositoryName })
        .where('id', '=', row.sessionId)
        .execute();
      worktreeBackfilledHealthy++;
    }
  });

  await sql`PRAGMA user_version = 18`.execute(database);

  logger.info(
    {
      quickBackfilled,
      worktreeBackfilledHealthy,
      worktreeOrphanedUnresolved,
      worktreeOrphanedInvalidSlug,
    },
    'Migration to v18 completed'
  );
}

/**
 * Migration v19: Add FK constraint to sessions.created_by referencing users(id) ON DELETE SET NULL.
 *
 * SQLite does not support ALTER TABLE ADD CONSTRAINT, so we use the standard
 * table-recreation pattern (https://www.sqlite.org/lang_altertable.html#otheralter).
 * To avoid SQLite ≥ 3.25.0's default "ALTER TABLE RENAME also rewrites foreign-key
 * references in dependent tables" behavior — which would silently rewrite
 * `workers.session_id REFERENCES sessions(id)` to point at `sessions_old` and
 * leave the FK dangling after we drop `sessions_old` — we use the inverse
 * recreate pattern: build the new table under a temporary name, copy data,
 * drop the original table, then rename the new table into place. After the
 * final rename completes, dependent FK declarations still reference `sessions`
 * (the canonical name), and SQLite's RENAME-based FK rewrite leaves them alone
 * because no dependent table references `sessions_new`.
 *
 * Sequence:
 *   1. Pre-flight backup of the database file (skipped for `:memory:`).
 *      A backup failure aborts the migration before any schema change so the
 *      caller can recover from a known-good state.
 *   2. PRAGMA foreign_keys = OFF (must be outside transaction)
 *   3. Snapshot existing index/trigger DDL on the sessions table
 *   4. Inside a transaction:
 *      a. Create sessions_new with the FK constraint
 *      b. Copy all rows from sessions to sessions_new
 *      c. Drop sessions
 *      d. Rename sessions_new to sessions
 *      e. Recreate the captured indexes/triggers
 *      f. PRAGMA foreign_key_check (rolls back on violation)
 *      g. PRAGMA user_version = 19
 *   5. PRAGMA foreign_keys = ON
 *
 * Idempotent: if user_version is already >= 19 the function returns early.
 * pre-v14 NULL `created_by` rows are preserved as NULL — the FK is satisfied
 * by NULL.
 *
 * @param database - Kysely database handle to migrate.
 * @param dbPath   - Filesystem path of the database. Defaults to `:memory:`
 *                   so direct test invocations against an in-memory Kysely
 *                   instance opt out of the backup step automatically. When
 *                   called from `runMigrations` against a real file, the
 *                   real path is supplied and a backup is taken.
 *
 * @internal Exported for testing.
 */
export async function migrateToV19(
  database: Kysely<Database>,
  dbPath: string = IN_MEMORY_DB_PATH
): Promise<void> {
  // Idempotency guard: if the migration has already been applied (e.g. on
  // re-run against a v19+ database) return without touching the schema. The
  // production gate in `runMigrations` already prevents this, but the same
  // function is invoked from tests and should be safe to re-run.
  const versionResult = await sql<{ user_version: number }>`PRAGMA user_version`.execute(database);
  const currentVersion = versionResult.rows[0]?.user_version ?? 0;
  if (currentVersion >= 19) {
    logger.info({ currentVersion }, 'Skipping migration to v19: already applied');
    return;
  }

  // Take a pre-flight backup BEFORE any schema mutation. A copy failure
  // throws and aborts the migration so user_version stays at 18 and the
  // caller can investigate (disk full, permissions, etc.) without a
  // partially-rebuilt sessions table. Skipped for in-memory databases.
  const backupPath = await backupDatabaseFile(dbPath, 18, 19);
  if (backupPath !== null) {
    logger.info({ backupPath }, 'Database backup created');
  }

  logger.info('Running migration to v19: Adding FK constraint to sessions.created_by');

  // FK toggling cannot happen inside a transaction. Disable FK enforcement
  // for the duration of the rebuild so the rename/drop steps don't trip on
  // dependent constraints.
  await sql`PRAGMA foreign_keys = OFF`.execute(database);

  try {
    // Snapshot non-automatic indexes and triggers attached to the sessions
    // table BEFORE dropping it. SQLite drops these automatically when the
    // backing table is dropped, so we recreate them after the new table is in
    // place. `sqlite_autoindex%` are implicit (PRIMARY KEY/UNIQUE) and are
    // re-created automatically by the new CREATE TABLE.
    const objectsResult = await sql<{
      type: string;
      name: string;
      sql: string | null;
    }>`
      SELECT type, name, sql
      FROM sqlite_master
      WHERE tbl_name = 'sessions'
        AND type IN ('index', 'trigger')
        AND name NOT LIKE 'sqlite_autoindex%'
    `.execute(database);
    const objectsToRestore = objectsResult.rows.filter((row) => row.sql !== null);

    await database.transaction().execute(async (trx) => {
      // Step 1: create the new table under a temporary name. Column order
      // and types mirror the v18 schema; the only addition is the inline
      // FK clause on `created_by`.
      await sql`
        CREATE TABLE sessions_new (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          location_path TEXT NOT NULL,
          server_pid INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          initial_prompt TEXT,
          title TEXT,
          repository_id TEXT,
          worktree_id TEXT,
          paused_at TEXT,
          parent_session_id TEXT,
          parent_worker_id TEXT,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          data_scope TEXT,
          data_scope_slug TEXT,
          recovery_state TEXT NOT NULL DEFAULT 'healthy',
          orphaned_at INTEGER,
          orphaned_reason TEXT
        )
      `.execute(trx);

      // Step 2: copy data. Listing columns explicitly guards against any
      // future column-order drift between the old and new tables.
      await sql`
        INSERT INTO sessions_new (
          id, type, location_path, server_pid, created_at, updated_at,
          initial_prompt, title, repository_id, worktree_id, paused_at,
          parent_session_id, parent_worker_id, created_by, data_scope,
          data_scope_slug, recovery_state, orphaned_at, orphaned_reason
        )
        SELECT
          id, type, location_path, server_pid, created_at, updated_at,
          initial_prompt, title, repository_id, worktree_id, paused_at,
          parent_session_id, parent_worker_id, created_by, data_scope,
          data_scope_slug, recovery_state, orphaned_at, orphaned_reason
        FROM sessions
      `.execute(trx);

      // Step 3: drop the original table. Indexes and triggers attached to it
      // are dropped automatically by SQLite; we recreate them in step 5.
      await sql`DROP TABLE sessions`.execute(trx);

      // Step 4: rename the new table into place. After this rename, any
      // dependent FK declarations (e.g. workers.session_id) continue to
      // reference `sessions` because no dependent table references
      // `sessions_new` — so SQLite's FK-rewrite-on-rename has nothing to do.
      await sql`ALTER TABLE sessions_new RENAME TO sessions`.execute(trx);

      // Step 5: recreate captured indexes/triggers. Each row's `sql` is the
      // exact CREATE statement SQLite stored, so re-executing it restores the
      // object on the rebuilt table.
      for (const obj of objectsToRestore) {
        await sql.raw(obj.sql as string).execute(trx);
      }

      // Step 6: verify the rebuild left no dangling FK references. Performed
      // inside the transaction so any violation triggers a rollback rather
      // than leaving the database in a partially-committed state with a
      // bumped schema version. PRAGMA foreign_key_check is read-only and
      // safe to run within a transaction.
      const fkCheck = await sql<{ table: string; rowid: number; parent: string; fkid: number }>`
        PRAGMA foreign_key_check
      `.execute(trx);
      if (fkCheck.rows.length > 0) {
        throw new Error(
          `Foreign key check failed after v19 migration: ${JSON.stringify(fkCheck.rows)}`
        );
      }

      // Step 7: bump the schema version inside the transaction so that a
      // failure anywhere above leaves the version unchanged.
      await sql`PRAGMA user_version = 19`.execute(trx);
    });
  } finally {
    // Always re-enable FK enforcement, even if the migration failed.
    await sql`PRAGMA foreign_keys = ON`.execute(database);
  }

  logger.info('Migration to v19 completed');
}

/**
 * Migration v20: Add `initiated_by` column to sessions.
 *
 * For shared sessions, `created_by` is the shared account (whose OS identity
 * spawns the PTY), and `initiated_by` records the authenticated user who
 * actually clicked "Create shared session" — useful for audit. For personal
 * sessions, `initiated_by` is left NULL (it equals `created_by`, so the
 * distinction is observable in the DB).
 *
 * Nullable text, no FK (see docs/design/shared-orchestrator-session.md
 * §"Schema Notes" item 1).
 *
 * @internal Exported for testing.
 */
export async function migrateToV20(database: Kysely<Database>): Promise<void> {
  logger.info('Running migration to v20: Adding initiated_by column to sessions');

  try {
    await database.schema
      .alterTable('sessions')
      .addColumn('initiated_by', 'text')
      .execute();
  } catch (error) {
    if (!isDuplicateColumnError(error)) throw error;
    logger.info('Column initiated_by already exists, skipping');
  }

  await sql`PRAGMA user_version = 20`.execute(database);

  logger.info('Migration to v20 completed');
}

/**
 * Check if SQLite database exists.
 * Used for auto-detection during migration from JSON to SQLite.
 * Uses Bun's native file API to avoid issues with fs mocks in tests.
 * @returns Promise that resolves to true if database file exists
 */
export async function databaseExists(): Promise<boolean> {
  // Use Bun.file().exists() for reliable file existence check
  // This bypasses any fs module mocks that might be active in tests
  return Bun.file(getDbPath()).exists();
}

/**
 * Migrate all data from JSON files to SQLite database.
 * Calls individual migration functions for each data type.
 *
 * If any migration fails, the database file is deleted to allow
 * a clean retry on next startup. This prevents partial migration
 * states where some data is in SQLite and some remains in JSON.
 */
export async function migrateFromJson(database: Kysely<Database>): Promise<void> {
  const dbPath = getDbPath();

  try {
    await migrateSessionsFromJson(database);
    await migrateRepositoriesFromJson(database);
    await migrateAgentsFromJson(database);
    await migrateWorktreeIndexesFromJson(database);
  } catch (error) {
    logger.error({ err: error }, 'Migration from JSON failed');
    // Clean up database file for retry on next startup
    try {
      // CRITICAL: Set db = null BEFORE destroy() to prevent race conditions
      // where another caller might get a reference to a destroyed database
      db = null;
      await database.destroy();
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
        logger.info({ dbPath }, 'Deleted database file after failed migration');
      }
    } catch (cleanupError) {
      logger.error({ err: cleanupError }, 'Failed to clean up database after migration failure');
    }
    throw error;
  }
}

/**
 * Migrate existing sessions from JSON file to SQLite database.
 * This is a one-time migration on first startup after upgrade.
 *
 * If migration fails after starting to write to SQLite, the database file
 * is deleted to allow retry on next startup.
 */
async function migrateSessionsFromJson(database: Kysely<Database>): Promise<void> {
  const configDir = getConfigDir();
  const sessionsJsonPath = path.join(configDir, 'sessions.json');

  // Skip if JSON file doesn't exist
  if (!fs.existsSync(sessionsJsonPath)) {
    logger.debug('No sessions.json found, skipping JSON migration');
    return;
  }

  // Check if we already have data in SQLite
  const existingCount = await database
    .selectFrom('sessions')
    .select(database.fn.count<number>('id').as('count'))
    .executeTakeFirst();

  if (existingCount && existingCount.count > 0) {
    logger.debug({ count: existingCount.count }, 'SQLite already has sessions, skipping JSON migration');
    return;
  }

  // Read and migrate JSON data
  try {
    const jsonContent = fs.readFileSync(sessionsJsonPath, 'utf-8');
    const sessions = JSON.parse(jsonContent) as PersistedSession[];

    if (sessions.length === 0) {
      logger.info('sessions.json is empty, marking as migrated');
      fs.renameSync(sessionsJsonPath, `${sessionsJsonPath}.migrated`);
      return;
    }

    logger.info({ count: sessions.length }, 'Migrating sessions from JSON to SQLite');

    // Use transaction for atomic migration
    await database.transaction().execute(async (trx) => {
      for (const session of sessions) {
        // Insert session
        const sessionRow = toSessionRow(session);
        await trx.insertInto('sessions').values(sessionRow).execute();

        // Insert workers
        for (const worker of session.workers) {
          const workerRow = toWorkerRow(worker, session.id);
          await trx.insertInto('workers').values(workerRow).execute();
        }
      }
    });

    // Rename ONLY after successful transaction
    // If transaction fails, the file is not renamed, allowing retry on next startup
    fs.renameSync(sessionsJsonPath, `${sessionsJsonPath}.migrated`);

    logger.info({ count: sessions.length }, 'Successfully migrated sessions from JSON to SQLite');
  } catch (error) {
    logger.error({ err: error, path: sessionsJsonPath }, 'Failed to migrate sessions from JSON');
    // Let the parent migrateFromJson handle cleanup
    throw error;
  }
}

/**
 * Migrate existing repositories from JSON file to SQLite database.
 */
async function migrateRepositoriesFromJson(database: Kysely<Database>): Promise<void> {
  const configDir = getConfigDir();
  const repositoriesJsonPath = path.join(configDir, 'repositories.json');

  // Skip if JSON file doesn't exist
  if (!fs.existsSync(repositoriesJsonPath)) {
    logger.debug('No repositories.json found, skipping repositories JSON migration');
    return;
  }

  // Check if we already have data in SQLite
  const existingCount = await database
    .selectFrom('repositories')
    .select(database.fn.count<number>('id').as('count'))
    .executeTakeFirst();

  if (existingCount && existingCount.count > 0) {
    logger.debug({ count: existingCount.count }, 'SQLite already has repositories, skipping JSON migration');
    return;
  }

  // Read and migrate JSON data
  try {
    const jsonContent = fs.readFileSync(repositoriesJsonPath, 'utf-8');
    const rawRepositories = JSON.parse(jsonContent) as unknown[];

    if (rawRepositories.length === 0) {
      logger.info('repositories.json is empty, marking as migrated');
      fs.renameSync(repositoriesJsonPath, `${repositoriesJsonPath}.migrated`);
      return;
    }

    // Backward compatibility: transform old field names
    // - registeredAt -> createdAt (renamed in SQLite migration)
    const repositories = rawRepositories.map(
      (item) => transformLegacyFields(item) as PersistedRepository
    );

    logger.info({ count: repositories.length }, 'Migrating repositories from JSON to SQLite');

    // Use transaction for atomic migration
    await database.transaction().execute(async (trx) => {
      for (const repo of repositories) {
        const repoRow = toRepositoryRow(repo);
        await trx.insertInto('repositories').values(repoRow).execute();
      }
    });

    // Rename ONLY after successful transaction
    fs.renameSync(repositoriesJsonPath, `${repositoriesJsonPath}.migrated`);

    logger.info({ count: repositories.length }, 'Successfully migrated repositories from JSON to SQLite');
  } catch (error) {
    logger.error({ err: error, path: repositoriesJsonPath }, 'Failed to migrate repositories from JSON');
    // Let the parent migrateFromJson handle cleanup
    throw error;
  }
}

/**
 * Transform legacy field names for backward compatibility.
 * Used for both agents and repositories during JSON migration.
 * - registeredAt -> createdAt (renamed in SQLite migration)
 */
function transformLegacyFields(item: unknown): unknown {
  if (!item || typeof item !== 'object') {
    return item;
  }

  const obj = item as Record<string, unknown>;

  // Transform registeredAt -> createdAt if present
  if ('registeredAt' in obj && !('createdAt' in obj)) {
    const { registeredAt, ...rest } = obj;
    return { ...rest, createdAt: registeredAt };
  }

  return item;
}

/**
 * Migrate existing agents from JSON file to SQLite database.
 * Only custom (non-built-in) agents are migrated.
 */
async function migrateAgentsFromJson(database: Kysely<Database>): Promise<void> {
  const configDir = getConfigDir();
  const agentsJsonPath = path.join(configDir, 'agents.json');

  // Skip if JSON file doesn't exist
  if (!fs.existsSync(agentsJsonPath)) {
    logger.debug('No agents.json found, skipping agents JSON migration');
    return;
  }

  // Check if we already have custom agents in SQLite
  // Note: Built-in agents may already exist from schema migration (v10+),
  // so we only check for custom agents to determine if JSON migration was already done
  const existingCount = await database
    .selectFrom('agents')
    .select(database.fn.count<number>('id').as('count'))
    .where('is_built_in', '=', 0)
    .executeTakeFirst();

  if (existingCount && existingCount.count > 0) {
    logger.debug({ count: existingCount.count }, 'SQLite already has custom agents, skipping JSON migration');
    return;
  }

  // Read and migrate JSON data
  try {
    const jsonContent = fs.readFileSync(agentsJsonPath, 'utf-8');
    const rawAgents = JSON.parse(jsonContent) as unknown[];

    // Validate and filter agents
    const validAgents: AgentDefinition[] = [];
    for (const rawItem of rawAgents) {
      // Backward compatibility: transform old field names
      // - registeredAt -> createdAt (renamed in SQLite migration)
      const item = transformLegacyFields(rawItem);

      const result = v.safeParse(AgentDefinitionSchema, item);
      if (result.success) {
        const agent = result.output as AgentDefinition;
        // Skip built-in agents - they should never be persisted
        if (!agent.isBuiltIn) {
          validAgents.push(agent);
        }
      } else {
        const agentId = (item as { id?: string })?.id ?? 'unknown';
        logger.warn({ agentId, issues: v.flatten(result.issues) }, 'Skipping invalid agent during migration');
      }
    }

    if (validAgents.length === 0) {
      logger.info('agents.json has no valid custom agents, marking as migrated');
      fs.renameSync(agentsJsonPath, `${agentsJsonPath}.migrated`);
      return;
    }

    logger.info({ count: validAgents.length }, 'Migrating agents from JSON to SQLite');

    // Use transaction for atomic migration
    await database.transaction().execute(async (trx) => {
      for (const agent of validAgents) {
        const agentRow = toAgentRow(agent);
        await trx.insertInto('agents').values(agentRow).execute();
      }
    });

    // Rename ONLY after successful transaction
    fs.renameSync(agentsJsonPath, `${agentsJsonPath}.migrated`);

    logger.info({ count: validAgents.length }, 'Successfully migrated agents from JSON to SQLite');
  } catch (error) {
    logger.error({ err: error, path: agentsJsonPath }, 'Failed to migrate agents from JSON');
    // Let the parent migrateFromJson handle cleanup
    throw error;
  }
}

/**
 * Get org/repo string from a repository path, with fallback to directory basename.
 * Used during migration to locate worktree-indexes.json files.
 */
async function getOrgRepoForMigration(repoPath: string): Promise<string> {
  try {
    const remoteUrl = await getRemoteUrl(repoPath);
    if (remoteUrl) {
      const parsed = parseOrgRepo(remoteUrl);
      if (parsed) return parsed;
    }
  } catch {
    // fallback below
  }
  return path.basename(repoPath);
}

/**
 * Worktree indexes JSON file format.
 * Used for parsing worktree-indexes.json during migration.
 */
interface WorktreeIndexesJson {
  indexes: Record<string, number>;
}

/**
 * Migrate existing worktree indexes from JSON files to SQLite database.
 * Each repository may have its own worktree-indexes.json file.
 *
 * Unlike other migrations, this does not fail the entire migration if one
 * repository fails - it logs the error and continues with other repositories.
 */
async function migrateWorktreeIndexesFromJson(database: Kysely<Database>): Promise<void> {
  // Load all repositories from the database
  const repositories = await database
    .selectFrom('repositories')
    .selectAll()
    .execute();

  if (repositories.length === 0) {
    logger.debug('No repositories found, skipping worktree indexes JSON migration');
    return;
  }

  for (const repo of repositories) {
    try {
      // Per-repository idempotency check: skip if this repo already has worktrees in the DB
      const existingCount = await database
        .selectFrom('worktrees')
        .select(database.fn.count<number>('id').as('count'))
        .where('repository_id', '=', repo.id)
        .executeTakeFirst();

      if (existingCount && existingCount.count > 0) {
        logger.debug({ repositoryId: repo.id, count: existingCount.count }, 'SQLite already has worktrees for this repository, skipping JSON migration');
        continue;
      }

      // Determine org/repo to locate the JSON file
      const orgRepo = await getOrgRepoForMigration(repo.path);
      const worktreeIndexesPath = path.join(getRepositoryDir(orgRepo), 'worktrees', 'worktree-indexes.json');

      // Skip if JSON file doesn't exist for this repository
      if (!fs.existsSync(worktreeIndexesPath)) {
        logger.debug({ repositoryId: repo.id, path: worktreeIndexesPath }, 'No worktree-indexes.json found for repository');
        continue;
      }

      const jsonContent = fs.readFileSync(worktreeIndexesPath, 'utf-8');
      const data = JSON.parse(jsonContent) as WorktreeIndexesJson;

      const entries = Object.entries(data.indexes ?? {});

      if (entries.length === 0) {
        logger.info({ repositoryId: repo.id }, 'worktree-indexes.json is empty, marking as migrated');
        fs.renameSync(worktreeIndexesPath, `${worktreeIndexesPath}.migrated`);
        continue;
      }

      logger.info({ repositoryId: repo.id, count: entries.length }, 'Migrating worktree indexes from JSON to SQLite');

      // Use transaction per repository for atomicity
      await database.transaction().execute(async (trx) => {
        for (const [worktreePath, indexNumber] of entries) {
          await trx.insertInto('worktrees').values({
            id: crypto.randomUUID(),
            repository_id: repo.id,
            path: worktreePath,
            index_number: indexNumber,
          }).execute();
        }
      });

      // Rename ONLY after successful transaction
      fs.renameSync(worktreeIndexesPath, `${worktreeIndexesPath}.migrated`);

      logger.info({ repositoryId: repo.id, count: entries.length }, 'Successfully migrated worktree indexes from JSON to SQLite');
    } catch (error) {
      // Log error but continue with other repositories
      logger.error({ err: error, repositoryId: repo.id }, 'Failed to migrate worktree indexes for repository, continuing with others');
    }
  }
}
