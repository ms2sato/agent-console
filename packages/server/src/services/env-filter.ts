/**
 * Environment variables that should NOT be passed to child PTY processes.
 * These are server-specific settings that would interfere with child process behavior.
 */
const BLOCKED_ENV_VARS = [
  'NODE_ENV',      // Server's NODE_ENV should not affect child processes
  'PORT',          // Server's port binding
  'HOST',          // Server's host binding
];

/**
 * Filter environment variables for child PTY processes.
 * Removes server-specific variables that could interfere with child behavior.
 *
 * Note: bun-pty merges the provided env with parent process env instead of replacing it.
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

  // Explicitly set blocked env vars to empty string to override bun-pty's
  // parent environment inheritance behavior
  for (const key of BLOCKED_ENV_VARS) {
    env[key] = '';
  }

  // Ensure color support for PTY processes (required for bun-pty)
  env['TERM'] = 'xterm-256color';
  env['COLORTERM'] = 'truecolor';
  env['FORCE_COLOR'] = '1';

  return env;
}
