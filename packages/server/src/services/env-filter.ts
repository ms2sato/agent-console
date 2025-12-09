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
 */
export function getChildProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !BLOCKED_ENV_VARS.includes(key)) {
      env[key] = value;
    }
  }

  // Ensure color support for PTY processes (required for bun-pty)
  env['TERM'] = 'xterm-256color';
  env['COLORTERM'] = 'truecolor';
  env['FORCE_COLOR'] = '1';

  return env;
}
