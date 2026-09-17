/**
 * Builds the environment handed to a Bash child process: a key ALLOWLIST for
 * the `AGENT_CONSOLE_*` namespace.
 *
 * The loop process's env carries the worker's OWN identity, injected at spawn
 * by `EmbeddedAgentWorkerService` through the same single writer the
 * terminal agents use (`buildAgentConsoleEnv`, packages/server/src/services/
 * agent-console-env.ts): `AGENT_CONSOLE_BASE_URL` / `SESSION_ID` /
 * `WORKER_ID`, plus `REPOSITORY_ID` / `PARENT_SESSION_ID` /
 * `PARENT_WORKER_ID` when the session has them. Those six keys --
 * `AGENT_CONSOLE_IDENTITY_ENV_KEYS`, the shared constant -- pass through
 * unchanged, so `env | grep AGENT_CONSOLE_` inside the tool names THIS
 * worker and the model can source `fromSessionId` / `parentSessionId` from
 * it the way the message-callback instructions assume.
 *
 * Every OTHER `AGENT_CONSOLE_*` key is stripped. This is defence in depth
 * for the non-elevated spawn branch: the server already layers the identity
 * over `getCleanChildProcessEnv()` (which strips its own inherited
 * `AGENT_CONSOLE_*` such as `AGENT_CONSOLE_HOME` or a terminal arm's
 * `AGENT_CONSOLE_MCP_TOKEN_FILE`), and this strip is the Bash tool's own
 * boundary check, applied immediately before spawning, so a key the server
 * never meant to forward cannot reach a child even if the base env changes.
 * Secrets never travel as env vars on this arm at all (token and provider
 * key are stdin-only), so the allowlist is about identity hygiene, not
 * secret containment.
 */
import { AGENT_CONSOLE_ENV_PREFIX, isAgentConsoleIdentityEnvKey } from '@agent-console/shared';

export function buildBashEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;
    if (key.startsWith(AGENT_CONSOLE_ENV_PREFIX) && !isAgentConsoleIdentityEnvKey(key)) continue;
    env[key] = value;
  }
  return env;
}
