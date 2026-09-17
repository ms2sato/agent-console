/**
 * The `AGENT_CONSOLE_*` environment keys that carry a worker's OWN identity
 * into its process tree -- the same six keys for a terminal agent (set at
 * PTY spawn) and for an embedded-agent loop subprocess (set at
 * `spawnAsUser` time). Single writer of the key set: the server's
 * `buildAgentConsoleEnv` (packages/server/src/services/agent-console-env.ts)
 * emits exactly these keys from an `AgentConsoleContext`, and the
 * embedded-agent `Bash` tool's `buildBashEnv`
 * (packages/embedded-agent/src/tools/env-cleaner.ts) keeps exactly these
 * keys and strips every other `AGENT_CONSOLE_*` key.
 *
 * Identity, not secrets: the MCP bearer token and the provider key never
 * travel as env vars on the embedded arm (stdin init line only), and
 * `AGENT_CONSOLE_MCP_TOKEN_FILE` (terminal arm only) is deliberately NOT in
 * this list.
 */
export const AGENT_CONSOLE_IDENTITY_ENV_KEYS = [
  'AGENT_CONSOLE_BASE_URL',
  'AGENT_CONSOLE_SESSION_ID',
  'AGENT_CONSOLE_WORKER_ID',
  'AGENT_CONSOLE_REPOSITORY_ID',
  'AGENT_CONSOLE_PARENT_SESSION_ID',
  'AGENT_CONSOLE_PARENT_WORKER_ID',
] as const;

export type AgentConsoleIdentityEnvKey = (typeof AGENT_CONSOLE_IDENTITY_ENV_KEYS)[number];

/** Prefix shared by every agent-console-owned environment variable. */
export const AGENT_CONSOLE_ENV_PREFIX = 'AGENT_CONSOLE_';

export function isAgentConsoleIdentityEnvKey(key: string): key is AgentConsoleIdentityEnvKey {
  return (AGENT_CONSOLE_IDENTITY_ENV_KEYS as readonly string[]).includes(key);
}
