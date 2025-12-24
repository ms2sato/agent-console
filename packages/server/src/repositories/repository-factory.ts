import * as path from 'path';
import type { SessionRepository } from './session-repository.js';
import { JsonSessionRepository } from './json-session-repository.js';
import { SqliteSessionRepository } from './sqlite-session-repository.js';
import { databaseExists, initializeDatabase } from '../database/index.js';
import { getConfigDir } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('repository-factory');

/**
 * Create the appropriate SessionRepository based on configuration.
 *
 * Strategy:
 * - If data.db exists, use SQLite
 * - Otherwise, use JSON and prepare for SQLite migration on next restart
 */
export async function createSessionRepository(): Promise<SessionRepository> {
  const configDir = getConfigDir();

  // Check if SQLite database already exists
  if (await databaseExists()) {
    logger.info('Using SQLite session repository (existing database)');
    const db = await initializeDatabase();
    return new SqliteSessionRepository(db);
  }

  // Check if there's an existing sessions.json to migrate
  const sessionsJsonPath = path.join(configDir, 'sessions.json');
  const sessionsJsonExists = await Bun.file(sessionsJsonPath).exists();

  if (sessionsJsonExists) {
    // Migrate to SQLite
    logger.info('Migrating from JSON to SQLite session repository');
    const db = await initializeDatabase();
    return new SqliteSessionRepository(db);
  }

  // Fresh install - use SQLite from the start
  logger.info('Using SQLite session repository (fresh install)');
  const db = await initializeDatabase();
  return new SqliteSessionRepository(db);
}

/**
 * For testing: create a JSON-based repository
 */
export function createJsonSessionRepository(filePath?: string): SessionRepository {
  const configDir = getConfigDir();
  const path_ = filePath ?? path.join(configDir, 'sessions.json');
  return new JsonSessionRepository(path_);
}
