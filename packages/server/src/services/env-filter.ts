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
 * Identify environment variables that carry the PARENT process's Claude Code
 * session identity (`CLAUDECODE`, `CLAUDE_CODE_*`). These are set when the
 * server is launched from inside a Claude Code session and are never correct
 * for child PTY workers — a worker's own `claude` must establish its own
 * session identity. Leaking them makes a worker adopt the parent's
 * `CLAUDE_CODE_SESSION_ID`, append its conversation to the parent agent's
 * transcript file, and break `claude -c` restart-with-continue
 * ("No conversation found to continue").
 */
export function isInheritedClaudeSessionVar(key: string): boolean {
  return key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_');
}

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
    if (value !== undefined && !BLOCKED_ENV_VARS.includes(key) && !isInheritedClaudeSessionVar(key)) {
      env[key] = value;
    }
  }

  // Ensure color support for PTY processes
  env['TERM'] = 'xterm-256color';
  env['COLORTERM'] = 'truecolor';
  // FORCE_COLOR=3 instructs Node-based agents and chalk-style libraries to use
  // truecolor (24-bit) output. xterm.js renders truecolor end-to-end, so anything
  // less caps the color depth unnecessarily — including the Claude Code banner,
  // which renders white when the agent only sees 16- or 256-color support.
  env['FORCE_COLOR'] = '3';

  return env;
}

/**
 * Get shell command prefix to unset blocked environment variables.
 * This is needed because bun-pty merges parent process env with provided env.
 * Simply excluding variables from the env object doesn't work - they still
 * get inherited from the parent process.
 *
 * The concrete set of inherited Claude Code session vars depends on how the
 * server was launched, so they are resolved dynamically from process.env at
 * call time (there is no portable glob for `unset`). The dynamic part is
 * sorted for deterministic output.
 *
 * @returns Shell command prefix like "unset VAR1 VAR2; " or empty string if no vars to unset
 */
export function getUnsetEnvPrefix(): string {
  const inheritedClaudeVars = Object.keys(process.env)
    .filter(isInheritedClaudeSessionVar)
    .sort();
  const varsToUnset = Array.from(new Set([...BLOCKED_ENV_VARS, ...inheritedClaudeVars]));
  if (varsToUnset.length === 0) {
    return '';
  }
  return `unset ${varsToUnset.join(' ')}; `;
}

/**
 * Get child process environment with AGENT_CONSOLE_* variables stripped.
 * Prevents the parent process's AgentConsole context from leaking into
 * child PTY processes. The correct AGENT_CONSOLE_* values (if any) should
 * be layered on top by the caller.
 */
export function getCleanChildProcessEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(getChildProcessEnv()).filter(([key]) => !key.startsWith('AGENT_CONSOLE_'))
  );
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
