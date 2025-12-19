import { SERVER_ONLY_ENV_VARS } from '../lib/server-config.js';

/**
 * Environment variables that should NOT be passed to child PTY processes.
 * Auto-generated from server-config.ts to ensure single source of truth.
 */
const BLOCKED_ENV_VARS: readonly string[] = SERVER_ONLY_ENV_VARS;

/**
 * Filter environment variables for child PTY processes.
 * Removes server-specific variables that could interfere with child behavior.
 *
 * Note: Bun.Terminal merges the provided env with parent process env instead of replacing it.
 * To work around this, we explicitly set blocked variables to empty strings to override
 * the inherited values from the parent process.
 */
export function getChildProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !BLOCKED_ENV_VARS.includes(key)) {
      env[key] = value;
    }
  }

  // Explicitly set blocked env vars to empty string to override Bun.Terminal's
  // parent environment inheritance behavior
  for (const key of BLOCKED_ENV_VARS) {
    env[key] = '';
  }

  // Ensure color support for PTY processes
  env['TERM'] = 'xterm-256color';
  env['COLORTERM'] = 'truecolor';
  env['FORCE_COLOR'] = '1';

  return env;
}
