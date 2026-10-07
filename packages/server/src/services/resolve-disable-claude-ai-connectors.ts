/**
 * Resolve a user's `disableClaudeAiConnectors` preference (the per-user
 * claude.ai connectors toggle) for a `claude-sdk` embedded-agent worker
 * activation.
 *
 * Extracted from EmbeddedAgentWorkerService to enable direct unit testing
 * without re-implementing logic in test closures, mirroring
 * `resolve-spawn-username.ts`'s shape.
 *
 * Resolution paths:
 * 1. userRepository is null -> false (with warning) -- `userRepository` is
 *    null only when the service is constructed without one (e.g. in unit
 *    tests); both production modes (single-user and multi-user) always
 *    supply a real `SqliteUserRepository`, so this branch is not a
 *    production single-user-mode path.
 * 2. userId resolves to no row in `getPreferences` -> false (with warning)
 *    -- a missing row is treated as "never opted in", the same default a
 *    pre-migration user would read as.
 * 3. userId resolves to a row -> that row's `disableClaudeAiConnectors`
 *    value (no warning).
 *
 * A THROWING `getPreferences` call is NEVER caught here -- it propagates to
 * the caller so activation fails loudly instead of silently defaulting to
 * "connectors on" on a genuine repository error. Only a missing row (a
 * `null` return, not an exception) resolves to `false`.
 */

import type { UserRepository } from '../repositories/user-repository.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('resolve-disable-claude-ai-connectors');

export async function resolveDisableClaudeAiConnectors(
  userId: string,
  userRepository: UserRepository | null,
): Promise<boolean> {
  if (!userRepository) {
    logger.warn({ userId }, 'No userRepository configured; defaulting disableClaudeAiConnectors to false');
    return false;
  }

  const preferences = await userRepository.getPreferences(userId);
  if (!preferences) {
    logger.warn({ userId }, 'User has no preferences row; defaulting disableClaudeAiConnectors to false');
    return false;
  }

  return preferences.disableClaudeAiConnectors;
}
