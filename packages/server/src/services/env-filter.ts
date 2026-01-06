import { SERVER_ONLY_ENV_VARS } from '../lib/server-config.js';

/**
 * Environment variables that should NOT be passed to child PTY processes.
 * Auto-generated from server-config.ts to ensure single source of truth.
 */
const BLOCKED_ENV_VARS: readonly string[] = SERVER_ONLY_ENV_VARS;

/**
 * Environment variables that should NOT be overridden by repository config.
 * These are either:
 * - Security-sensitive (could be used for code injection)
 * - System-critical (could break the shell environment)
 */
const PROTECTED_ENV_VARS: readonly string[] = [
  // Security-sensitive: could be used for code injection
  'LD_PRELOAD',           // Linux: preload shared library
  'LD_LIBRARY_PATH',      // Linux: library search path
  'DYLD_INSERT_LIBRARIES', // macOS: preload dynamic library
  'DYLD_LIBRARY_PATH',    // macOS: library search path
  'DYLD_FRAMEWORK_PATH',  // macOS: framework search path
  // System-critical: could break the shell environment
  'PATH',                 // Command search path
  'HOME',                 // User home directory
  'USER',                 // Current user name
  'SHELL',                // Default shell
  'TERM',                 // Terminal type (we explicitly set this)
  'COLORTERM',            // Color terminal support (we explicitly set this)
];

/**
 * Filter environment variables for child PTY processes.
 * Removes server-specific variables that could interfere with child behavior.
 *
 * Note: bun-pty merges parent process env with the provided env option,
 * so excluding variables here alone is NOT sufficient to prevent inheritance.
 * The actual removal is done via shell `unset` commands (see getUnsetEnvPrefix).
 * This function still excludes blocked vars to avoid explicitly passing them.
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

/**
 * Filter repository environment variables to remove protected/dangerous variables.
 * This prevents repository configs from overriding security-sensitive variables
 * like LD_PRELOAD, PATH, HOME, etc.
 *
 * @param envVars - Environment variables from repository config
 * @returns Filtered environment variables with protected vars removed
 */
export function filterRepositoryEnvVars(envVars: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};

  for (const [key, value] of Object.entries(envVars)) {
    if (!PROTECTED_ENV_VARS.includes(key)) {
      filtered[key] = value;
    }
  }

  return filtered;
}
