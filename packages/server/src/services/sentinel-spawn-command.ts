/**
 * Pure builders for the login-shell sentinel spawn commands. Extracted so
 * production (`user-mode.ts`) and the post-deploy smoke script
 * (`scripts/smoke/check-login-shell-sentinel.ts`) share a single source of
 * truth for the command shape -- drift between what production spawns and
 * what smoke verifies is impossible by construction. No I/O, no side effects.
 */

/**
 * Direct path (SingleUserMode / MultiUserMode elevation-skip): wraps the
 * sentinel echo in a login shell; the interactive shell that follows is the
 * one the worker-manager injects the agent command into.
 */
export function buildDirectSentinelShellCommand(sentinel: string, unsetPrefix: string): string {
  return `${unsetPrefix}exec $SHELL -l -c 'echo ${sentinel}; exec $SHELL'`;
}

/**
 * Elevated path (MultiUserMode.spawnSudoPty): the elevation chain's login
 * shell provides login init, so the inner command only echoes the sentinel
 * and execs the interactive shell.
 */
export function buildElevatedSentinelCommand(sentinel: string): string {
  return `echo ${sentinel}; exec $SHELL`;
}
