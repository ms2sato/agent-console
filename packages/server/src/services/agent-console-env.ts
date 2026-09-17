/**
 * `AgentConsoleContext` -> `AGENT_CONSOLE_*` environment mapping.
 *
 * Single writer of the context-to-env mapping. Three spawn sites consume it,
 * so a terminal agent and an embedded-agent loop subprocess carry the SAME
 * identity keys with the same shape:
 *
 * - terminal direct spawn (`user-mode.ts`'s `spawnDirectPty`), where the
 *   result is layered over `getCleanChildProcessEnv()` as spawn-option env;
 * - terminal elevated spawn (`user-mode.ts`'s `spawnSudoPty`), where the
 *   result is exported inside the inner login-shell command via
 *   `buildElevationArgs`;
 * - embedded-agent spawn (`embedded-agent-worker-service.ts`), where the
 *   result is `spawnAsUser`'s `env` on both of ITS branches (spawn-option
 *   env over a clean `baseEnv` when non-elevated, exported inside the inner
 *   command when elevated).
 *
 * The key set is `AGENT_CONSOLE_IDENTITY_ENV_KEYS` (packages/shared): the
 * embedded-agent `Bash` tool's `buildBashEnv` keeps exactly those keys, so
 * adding a key here without adding it there would have the Bash child strip
 * it again.
 */
import {
  AGENT_CONSOLE_IDENTITY_ENV_KEYS,
  type AgentConsoleIdentityEnvKey,
} from '@agent-console/shared';

/**
 * A worker's own identity as agent-console knows it: what the worker needs
 * to call back into this instance (`baseUrl`), to name itself on MCP tools
 * that take a `sessionId` / `fromSessionId` (`sessionId`, `workerId`), and
 * -- for a delegated session -- to inherit identity from its parent
 * (`parentSessionId`, `parentWorkerId`, both required by
 * `delegate_to_worktree`). Set once at spawn time and inherited by every
 * descendant process; the orphan-process sweep relies on
 * `AGENT_CONSOLE_SESSION_ID` being present tree-wide.
 */
export interface AgentConsoleContext {
  /** Origin the worker dials back to (`http://localhost:<PORT>`, no path). */
  baseUrl: string;
  sessionId: string;
  workerId: string;
  repositoryId?: string;
  parentSessionId?: string;
  parentWorkerId?: string;
}

/**
 * Convert an `AgentConsoleContext` to `AGENT_CONSOLE_*` env vars. Optional
 * fields are included only when present (never an `undefined` value, never
 * an empty string), so a session without a parent has NO
 * `AGENT_CONSOLE_PARENT_*` keys at all -- callers layer this over a base
 * that has already had the server's own identity stripped, so an absent key
 * stays absent.
 */
export function buildAgentConsoleEnv(ctx: AgentConsoleContext): Record<string, string> {
  const env: Partial<Record<AgentConsoleIdentityEnvKey, string>> = {
    AGENT_CONSOLE_BASE_URL: ctx.baseUrl,
    AGENT_CONSOLE_SESSION_ID: ctx.sessionId,
    AGENT_CONSOLE_WORKER_ID: ctx.workerId,
    ...(ctx.repositoryId && { AGENT_CONSOLE_REPOSITORY_ID: ctx.repositoryId }),
    ...(ctx.parentSessionId && { AGENT_CONSOLE_PARENT_SESSION_ID: ctx.parentSessionId }),
    ...(ctx.parentWorkerId && { AGENT_CONSOLE_PARENT_WORKER_ID: ctx.parentWorkerId }),
  };
  const result: Record<string, string> = {};
  for (const key of AGENT_CONSOLE_IDENTITY_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}
