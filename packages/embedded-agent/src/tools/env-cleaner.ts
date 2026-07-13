/**
 * Strips AGENT_CONSOLE_*-prefixed environment variables from the source env
 * before handing it to a Bash child process.
 *
 * The loop process's own env may carry these server-context variables: when
 * the server spawns the loop subprocess in single-user / non-elevated mode,
 * `spawnAsUser`'s non-elevated branch inherits the full parent `process.env`
 * unchanged (packages/server/src/services/privilege-elevation.ts — no
 * `opts.env` is passed by `EmbeddedAgentWorkerService`, so Bun's spawn does
 * not layer/filter anything). This strip is the Bash tool's own boundary
 * check, applied immediately before spawning.
 */
export function buildBashEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;
    if (key.startsWith('AGENT_CONSOLE_')) continue;
    env[key] = value;
  }
  return env;
}
