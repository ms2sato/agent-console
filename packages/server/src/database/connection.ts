import { Kysely, sql } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import * as path from 'path';
import * as fs from 'fs';
import * as v from 'valibot';
import type { AgentDefinition } from '@agent-console/shared';
import { AgentDefinitionSchema } from '@agent-console/shared';
import type { Database } from './schema.js';
import type { PersistedSession, PersistedRepository } from '../services/persistence-service.js';
import { getConfigDir } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import { toSessionRow, toWorkerRow, toRepositoryRow, toAgentRow } from './mappers.js';

const logger = createLogger('database');

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
 * @returns The initialized Kysely database instance
 */
export async function initializeDatabase(): Promise<Kysely<Database>> {
  // Fast path: return existing instance
  if (db) return db;

  // If initialization is already in progress, wait for it
  if (initializationPromise) {
    return initializationPromise;
  }

  // Start initialization and store the promise for concurrent callers
  initializationPromise = doInitializeDatabase();

  try {
    return await initializationPromise;
  } finally {
    // Clear the promise after completion (success or failure)
    // This allows retry on next call if initialization failed
    initializationPromise = null;
  }
}

/**
 * Internal function that performs the actual database initialization.
 * Should only be called from initializeDatabase() with proper mutex protection.
 */
async function doInitializeDatabase(): Promise<Kysely<Database>> {
  const configDir = getConfigDir();
  const dbPath = path.join(configDir, 'data.db');

  // Ensure config directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  logger.info({ dbPath }, 'Initializing SQLite database');

  const bunDb = new BunDatabase(dbPath);

  db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: bunDb }),
  });

  // Enable foreign key constraints (required for cascade deletes)
  await sql`PRAGMA foreign_keys = ON`.execute(db);

  // Run schema migrations
  await runMigrations(db);

  // Migrate data from JSON (one-time)
  await migrateFromJson(db);

  return db;
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
 * Run database migrations based on PRAGMA user_version.
 * Each migration increments the version number.
 */
async function runMigrations(database: Kysely<Database>): Promise<void> {
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
}

/**
 * Migration v1: Create sessions and workers tables.
 */
async function migrateToV1(database: Kysely<Database>): Promise<void> {
  logger.info('Running migration to v1: Creating sessions and workers tables');

  // Create sessions table
  await database.schema
    .createTable('sessions')
    .ifNotExists()
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

  // Create workers table
  await database.schema
    .createTable('workers')
    .ifNotExists()
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
  await database.schema
    .createTable('repositories')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('path', 'text', (col) => col.notNull().unique())
    .addColumn('registered_at', 'text', (col) => col.notNull())
    .execute();

  // Create agents table
  await database.schema
    .createTable('agents')
    .ifNotExists()
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

  // Update schema version
  await sql`PRAGMA user_version = 2`.execute(database);

  logger.info('Migration to v2 completed');
}

/**
 * Check if SQLite database exists.
 * Used for auto-detection during migration from JSON to SQLite.
 * Uses Bun's native file API to avoid issues with fs mocks in tests.
 * @returns Promise that resolves to true if database file exists
 */
export async function databaseExists(): Promise<boolean> {
  const configDir = getConfigDir();
  const dbPath = path.join(configDir, 'data.db');
  // Use Bun.file().exists() for reliable file existence check
  // This bypasses any fs module mocks that might be active in tests
  return Bun.file(dbPath).exists();
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
  const configDir = getConfigDir();
  const dbPath = path.join(configDir, 'data.db');

  try {
    await migrateSessionsFromJson(database);
    await migrateRepositoriesFromJson(database);
    await migrateAgentsFromJson(database);
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
    const repositories = JSON.parse(jsonContent) as PersistedRepository[];

    if (repositories.length === 0) {
      logger.info('repositories.json is empty, marking as migrated');
      fs.renameSync(repositoriesJsonPath, `${repositoriesJsonPath}.migrated`);
      return;
    }

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

  // Check if we already have data in SQLite
  const existingCount = await database
    .selectFrom('agents')
    .select(database.fn.count<number>('id').as('count'))
    .executeTakeFirst();

  if (existingCount && existingCount.count > 0) {
    logger.debug({ count: existingCount.count }, 'SQLite already has agents, skipping JSON migration');
    return;
  }

  // Read and migrate JSON data
  try {
    const jsonContent = fs.readFileSync(agentsJsonPath, 'utf-8');
    const rawAgents = JSON.parse(jsonContent) as unknown[];

    // Validate and filter agents
    const validAgents: AgentDefinition[] = [];
    for (const item of rawAgents) {
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
