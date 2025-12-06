import * as path from 'path';
import * as os from 'os';

/**
 * Get the configuration directory for agent-console.
 * Can be overridden with AGENT_CONSOLE_HOME environment variable.
 * Default: ~/.agent-console
 */
export function getConfigDir(): string {
  return process.env.AGENT_CONSOLE_HOME || path.join(os.homedir(), '.agent-console');
}

/**
 * Get the current server's PID for session ownership tracking.
 */
export function getServerPid(): number {
  return process.pid;
}
