import * as path from 'path';
import { getConfigDir } from '../../lib/config.js';
import type { SessionRepository } from '../../repositories/index.js';

/**
 * A JSON-file SessionRepository over `<configDir>/sessions.json`, for tests
 * that build a `SessionManager` without a database. `SessionManager` requires
 * its repository explicitly; production injects `SqliteSessionRepository`.
 *
 * The repositories module is imported lazily so it binds to whichever `fs`
 * mock is active when the first test needs it, the same timing the
 * manager's own import had before the option became required.
 */
export async function createTestSessionRepository(): Promise<SessionRepository> {
  const { JsonSessionRepository } = await import('../../repositories/index.js');
  return new JsonSessionRepository(path.join(getConfigDir(), 'sessions.json'));
}
