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
 * Get the repositories base directory.
 * Structure: ~/.agent-console/repositories/
 */
export function getRepositoriesDir(): string {
  return path.join(getConfigDir(), 'repositories');
}

/**
 * Get the directory for a specific repository.
 * Structure: ~/.agent-console/repositories/{org}/{repo}/
 * @param orgRepo - Organization and repository name (e.g., "owner/repo-name")
 */
export function getRepositoryDir(orgRepo: string): string {
  return path.join(getRepositoriesDir(), orgRepo);
}

/**
 * Get the current server's PID for session ownership tracking.
 */
export function getServerPid(): number {
  return process.pid;
}
