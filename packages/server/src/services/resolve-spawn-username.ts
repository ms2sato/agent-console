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

/**
 * MCP / route variant: returns `null` on miss (with structured warn), distinct
 * from {@link resolveSpawnUsername} which falls back to the server-process
 * user. Both helpers serve the same upstream input (`session.createdBy`) but
 * different downstream contracts:
 *
 * - {@link resolveSpawnUsername} returns `Promise<string>` and always
 *   produces a usable username. Right for PTY-spawn callers (worker
 *   lifecycle, session pause/resume) which always pass *something* to
 *   `Bun.spawn` / `runAsUser`.
 * - {@link resolveRequestUsername} returns `Promise<string | null>` and
 *   lets `null` propagate as an explicit "no elevation" signal. Right for
 *   MCP / route callers that hand the resolved value straight to
 *   {@link import('./privilege-elevation.js').runAsUser} /
 *   {@link import('./privilege-elevation.js').spawnAsUser} -- the
 *   helper's own null-bypass short-circuits elevation downstream
 *   (`shouldElevateForUser` returns `false` on null/undefined).
 *
 * Extracted in PR #889 to deduplicate three inline blocks in
 * `mcp/mcp-server.ts` (`delegate_to_worktree`, `run_process`,
 * `create_conditional_wakeup`) per
 * `.claude/rules/elevation-helpers.md` "One-PR multi-callsite" trigger
 * applied at the file boundary (mcp-server.ts itself is the consolidating
 * context). All three callers preserved their `createdBy` log payload via
 * the merged `{ createdBy, ...context }` shape; the
 * `toolName`-distinguished warning replaces the prior tool-specific
 * wording (the structured `toolName` field carries the disambiguation,
 * the message body no longer has to).
 *
 * Resolution paths:
 * 1. createdBy is undefined → null (silent — caller intentionally has no
 *    owner; elevation is correctly bypassed downstream)
 * 2. userRepository is null → null (silent — single-user mode has no user
 *    DB; elevation is correctly bypassed downstream)
 * 3. createdBy is set, user not found in DB → null + structured warn (the
 *    only path that produces a log line; the "createdBy was set but did
 *    not resolve" signal is preserved from the inline duplicates)
 * 4. createdBy is set, user found in DB → user.username (no warn)
 */
/**
 * Subset of Pino's `Logger` shape that `resolveRequestUsername` actually
 * uses (`warn` only). Declaring an explicit interface lets tests inject a
 * recording stub without depending on Pino types or `mock.module`
 * (which is process-global in bun:test and pollutes other test files
 * mocking the same module -- see `.claude/rules/testing.md` Anti-Pattern
 * #2: "Prefer dependency injection over module mocking for
 * cross-cutting concerns").
 */
export interface ResolveRequestUsernameLogger {
  warn: (payload: unknown, message: string) => void;
}

export async function resolveRequestUsername(
  createdBy: string | undefined,
  userRepository: UserRepository | null,
  context: { toolName: string } & Record<string, unknown>,
  opts: { logger?: ResolveRequestUsernameLogger } = {},
): Promise<string | null> {
  const log = opts.logger ?? logger;
  if (!createdBy || !userRepository) {
    return null;
  }
  const user = await userRepository.findById(createdBy);
  if (!user) {
    log.warn(
      { createdBy, ...context },
      `${context.toolName}: createdBy does not resolve to a user; running without elevation`,
    );
    return null;
  }
  return user.username;
}
