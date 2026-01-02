import { SERVER_ONLY_ENV_VARS } from '../lib/server-config.js';

/**
 * Environment variables that should NOT be passed to child PTY processes.
 * Auto-generated from server-config.ts to ensure single source of truth.
 */
export const BLOCKED_ENV_VARS: readonly string[] = SERVER_ONLY_ENV_VARS;

/**
 * Filter environment variables for child PTY processes.
 * Removes server-specific variables that could interfere with child behavior.
 *
 * Note: bun-pty only passes the env we explicitly provide - it does NOT merge
 * with the parent process environment. Therefore, BLOCKED_ENV_VARS are simply
 * excluded from the returned object (not passed to the child process at all).
 */
export function getChildProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !BLOCKED_ENV_VARS.includes(key)) {
      env[key] = value;
    }
  }

  // Ensure color support for PTY processes
  env['TERM'] = 'xterm-256color';
  env['COLORTERM'] = 'truecolor';
  env['FORCE_COLOR'] = '1';

  return env;
}

/**
 * Get shell command prefix to unset blocked environment variables.
 * This is needed because bun-pty merges parent process env with provided env.
 * Simply excluding variables from the env object doesn't work - they still
 * get inherited from the parent process.
 *
 * @returns Shell command prefix like "unset VAR1 VAR2; " or empty string if no vars to unset
 */
export function getUnsetEnvPrefix(): string {
  if (BLOCKED_ENV_VARS.length === 0) {
    return '';
  }
  return `unset ${BLOCKED_ENV_VARS.join(' ')}; `;
}
