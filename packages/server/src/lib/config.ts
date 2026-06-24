import * as path from 'path';
import * as os from 'os';

/**
 * System-wide default data root used in multi-user mode.
 *
 * In multi-user mode the data root needs to be reachable by every logged-in
 * user's PTY (running as that user, not the service user). The service user's
 * HOME on Debian / Ubuntu defaults to mode 0750, which other users cannot
 * traverse, so the multi-user-mode default is relocated to a system-wide path
 * with group-writable permissions (see docs/design/multi-user-shared-setup.md).
 *
 * In single-user mode (AUTH_MODE=none), the historical default
 * `$HOME/.agent-console` is preserved to avoid regressing existing installs.
 */
const MULTI_USER_DEFAULT_DATA_ROOT = '/var/lib/agent-console';

/**
 * Get the configuration directory for agent-console.
 *
 * Resolution precedence:
 *   1. AGENT_CONSOLE_HOME environment variable, if set (any mode).
 *   2. AUTH_MODE=multi-user: system-wide `/var/lib/agent-console`.
 *   3. Otherwise (single-user): `~/.agent-console` under the server
 *      process user's HOME.
 *
 * The bootstrap script (`scripts/setup-multiuser-for-ubuntu.sh`) sets
 * AGENT_CONSOLE_HOME explicitly on the systemd unit, so production
 * multi-user deployments always go through path (1); path (2) is the
 * fallback for ad-hoc multi-user invocations without an explicit override.
 */
export function getConfigDir(): string {
  if (process.env.AGENT_CONSOLE_HOME) {
    return process.env.AGENT_CONSOLE_HOME;
  }
  if (process.env.AUTH_MODE === 'multi-user') {
    return MULTI_USER_DEFAULT_DATA_ROOT;
  }
  return path.join(os.homedir(), '.agent-console');
}

/**
 * Get the repositories base directory.
 * Structure: <config-dir>/repositories/
 */
export function getRepositoriesDir(): string {
  return path.join(getConfigDir(), 'repositories');
}

/**
 * Get the shared source-repos base directory where the clone-and-register
 * action (Issue #834) places new clones. The bootstrap script
 * (`scripts/setup-multiuser-for-ubuntu.sh`, Issue #833 / PR #849) creates this
 * directory at install time with owner `<service-user>:agent-console-users`
 * and mode `2775` so any interactive group member can `git clone` into it and
 * the service user can fetch / update refs.
 *
 * Resolution precedence (mirroring the bootstrap script's flag handling):
 *   1. `AGENT_CONSOLE_SOURCE_REPOS_DIR` environment variable, if set.
 *   2. `<config-dir>/source-repos` (the bootstrap script's default location).
 */
export function getSourceReposDir(): string {
  if (process.env.AGENT_CONSOLE_SOURCE_REPOS_DIR) {
    return process.env.AGENT_CONSOLE_SOURCE_REPOS_DIR;
  }
  return path.join(getConfigDir(), 'source-repos');
}

/**
 * Get the directory for a specific repository.
 * Structure: <config-dir>/repositories/{org}/{repo}/
 * @param orgRepo - Organization and repository name (e.g., "owner/repo-name")
 */
export function getRepositoryDir(orgRepo: string): string {
  return path.join(getRepositoriesDir(), orgRepo);
}

/**
 * Get the path to the SQLite database file.
 * Structure: <config-dir>/data.db
 */
export function getDbPath(): string {
  return path.join(getConfigDir(), 'data.db');
}

/**
 * Get the current server's PID for session ownership tracking.
 */
export function getServerPid(): number {
  return process.pid;
}
