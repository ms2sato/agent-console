/**
 * Resolve the OS username for PTY spawning from a session's createdBy field.
 *
 * Extracted from SessionManager to enable direct unit testing without
 * re-implementing logic in test closures.
 *
 * Resolution paths:
 * 1. createdBy is undefined → server process username (os.userInfo().username)
 * 2. createdBy is set but no userRepository → server process username (with warning)
 * 3. createdBy is set, user not found in DB → server process username
 * 4. createdBy is set, user found in DB → that user's username
 */

import * as os from 'os';
import type { UserRepository } from '../repositories/user-repository.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('resolve-spawn-username');

export async function resolveSpawnUsername(
  createdBy: string | undefined,
  userRepository: UserRepository | null,
): Promise<string> {
  if (createdBy && !userRepository) {
    logger.warn({ createdBy }, 'Session has createdBy but no userRepository configured');
  }

  if (!createdBy || !userRepository) {
    return os.userInfo().username;
  }

  const user = await userRepository.findById(createdBy);
  return user?.username ?? os.userInfo().username;
}
