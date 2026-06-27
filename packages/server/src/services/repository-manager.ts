import * as fs from 'fs';
import { access, lstat } from 'fs/promises';
import * as path from 'path';
import type { Repository } from '@agent-console/shared';
import { getRepositoryDir, getSourceReposDir } from '../lib/config.js';
import { isUnderSourceReposDir } from '../lib/repository-remote.js';
import { getOrgRepoFromPath as gitGetOrgRepoFromPath } from '../lib/git.js';
import { createLogger } from '../lib/logger.js';
import { initializeDatabase } from '../database/connection.js';
import type { RepositoryRepository, RepositoryUpdates } from '../repositories/repository-repository.js';
import { SqliteRepositoryRepository } from '../repositories/sqlite-repository-repository.js';
import { JOB_TYPES, type JobQueue } from '../jobs/index.js';
import { runAsUser, shellEscape } from './privilege-elevation.js';

const logger = createLogger('service:repository-manager');

/**
 * Default shared group used by the multi-user bootstrap
 * (`scripts/setup-multiuser-for-ubuntu.sh`). Overridable via
 * `AGENT_CONSOLE_SERVICE_GROUP` so deployments that customized the group
 * during bootstrap pick up the same name here at runtime.
 */
const DEFAULT_SHARED_GROUP = 'agent-console-users';

/**
 * Timeout for the multi-user `.git/` config apply. The chain is local-only
 * (no network, no remote fetch); 30s is generous even for a very large
 * `.git/` tree.
 */
const SHARED_REPO_APPLY_TIMEOUT_MS = 30000;

/**
 * Timeout for the server-side `safe.directory` bootstrap (Issue #853). Short --
 * the command is a pure local gitconfig write with no network or fs traversal.
 * Mirrors `SAFE_DIRECTORY_BOOTSTRAP_TIMEOUT_MS` in `worktree-service.ts`, which
 * implements the per-user side of the same idempotent bootstrap pattern
 * (Issue #838 / PR #843).
 */
const SAFE_DIRECTORY_BOOTSTRAP_TIMEOUT_MS = 10000;

/**
 * Type of the privilege-elevation helper, exposed for dependency injection
 * in tests. Production code uses the real `runAsUser` import.
 * @internal Exported for testing.
 */
export type RunAsUserFn = typeof runAsUser;

function getSharedGroupName(): string {
  return process.env.AGENT_CONSOLE_SERVICE_GROUP || DEFAULT_SHARED_GROUP;
}

/**
 * Build the manual remediation commands documented in
 * `docs/multi-user-setup-guide.md` "Source Repo Group-Writability" as the
 * fallback when the auto-apply step cannot complete. Embedded in the WARN
 * log so an operator can copy-paste them, and exported so tests can assert
 * the exact shape without depending on log capture.
 *
 * @internal Exported for testing.
 */
export function buildManualFallbackCommands(
  repoPath: string,
  sharedGroup: string,
): string[] {
  return [
    `sudo -u agentconsole bash -lc 'cd ${repoPath} && git config core.sharedRepository group'`,
    `sudo find ${repoPath}/.git -type d -exec chmod g+rwxs {} +`,
    `sudo chmod -R g+rw ${repoPath}/.git`,
    `sudo chgrp -R ${sharedGroup} ${repoPath}/.git`,
  ];
}

/**
 * Callbacks for resolving dependencies without circular imports.
 * Injected by index.ts after both SessionManager and RepositoryManager are initialized.
 */
export interface RepositoryDependencyCallbacks {
  getSessionsUsingRepository: (repositoryId: string) => { id: string; title?: string }[];
}

/**
 * Extract org/repo from git remote URL
 * Falls back to directory name if no remote
 */
async function getOrgRepoFromPath(repoPath: string): Promise<string> {
  const orgRepo = await gitGetOrgRepoFromPath(repoPath);
  return orgRepo ?? path.basename(repoPath);
}

export interface RepositoryLifecycleCallbacks {
  onRepositoryCreated: (repository: Repository) => void | Promise<void>;
  onRepositoryUpdated: (repository: Repository) => void | Promise<void>;
  onRepositoryDeleted: (repositoryId: string) => void;
}

export class RepositoryManager {
  private repositories: Map<string, Repository> = new Map();
  private repository: RepositoryRepository;
  private lifecycleCallbacks: RepositoryLifecycleCallbacks | null = null;
  private dependencyCallbacks: RepositoryDependencyCallbacks | null = null;
  private jobQueue: JobQueue | null = null;
  /**
   * Indirection so tests can capture / fake the privilege-elevation helper
   * used by the multi-user shared-repo apply step. Production defaults to
   * the real `runAsUser`.
   */
  private readonly _runAsUser: RunAsUserFn;

  /**
   * Create a RepositoryManager instance with async initialization.
   * This is the preferred way to create a RepositoryManager.
   */
  static async create(options?: {
    repository?: RepositoryRepository;
    jobQueue?: JobQueue | null;
    /**
     * Test-only injection point for `runAsUser`. Production omits this and
     * the real helper is used.
     */
    runAsUserImpl?: RunAsUserFn;
  }): Promise<RepositoryManager> {
    const repo = options?.repository ?? new SqliteRepositoryRepository(await initializeDatabase());
    const manager = new RepositoryManager(
      repo,
      options?.jobQueue ?? null,
      options?.runAsUserImpl ?? runAsUser,
    );
    await manager.initialize();
    return manager;
  }

  /**
   * Private constructor - use RepositoryManager.create() for async initialization.
   */
  private constructor(
    repository: RepositoryRepository,
    jobQueue: JobQueue | null = null,
    runAsUserImpl: RunAsUserFn = runAsUser,
  ) {
    this.repository = repository;
    this.jobQueue = jobQueue;
    this._runAsUser = runAsUserImpl;
  }

  /**
   * Set the job queue for background task processing.
   * @internal For testing only. In production, pass jobQueue to RepositoryManager.create().
   */
  setJobQueue(jobQueue: JobQueue): void {
    this.jobQueue = jobQueue;
  }

  /**
   * Set callbacks for repository lifecycle events (for WebSocket broadcasting)
   */
  setLifecycleCallbacks(callbacks: RepositoryLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
  }

  /**
   * Set callbacks for resolving dependencies without circular imports.
   * Must be called after both SessionManager and RepositoryManager are initialized.
   */
  setDependencyCallbacks(callbacks: RepositoryDependencyCallbacks): void {
    this.dependencyCallbacks = callbacks;
  }

  /**
   * Initialize by loading repositories from the database.
   */
  private async initialize(): Promise<void> {
    const persisted = await this.repository.findAll();
    for (const repo of persisted) {
      // Validate that the path still exists
      if (fs.existsSync(repo.path)) {
        this.repositories.set(repo.id, repo);
        logger.info({ repositoryId: repo.id, name: repo.name }, 'Loaded repository');
      } else {
        logger.warn({ repositoryId: repo.id, name: repo.name, path: repo.path }, 'Skipped missing repository');
      }
    }
  }

  async registerRepository(repoPath: string, options?: { description?: string }): Promise<Repository> {
    // Resolve to absolute path
    const absolutePath = path.resolve(repoPath);

    // Check if path exists
    try {
      await access(absolutePath);
    } catch {
      throw new Error(`Path does not exist: ${absolutePath}`);
    }

    // Check if it's a git repository
    const gitDir = path.join(absolutePath, '.git');
    try {
      await access(gitDir);
    } catch {
      throw new Error(`Not a git repository: ${absolutePath}`);
    }

    // Check if already registered
    for (const repo of this.repositories.values()) {
      if (repo.path === absolutePath) {
        throw new Error(`Repository already registered: ${absolutePath}`);
      }
    }

    // In multi-user mode, ensure the source repo's `.git/` is configured so
    // the requesting user (running `git worktree add` via `runAsUser` per
    // Issue #838) can write refs / lock files. Idempotent; failure logs a
    // warning but does not block registration (the operator can still apply
    // the documented manual fallback). Issue #845.
    await this.applyMultiUserSharedRepoConfig(absolutePath);

    // In multi-user mode, also bootstrap `safe.directory` into the SERVER's
    // own gitconfig so subsequent server-initiated git operations
    // (`listWorktrees`, `getRemoteUrl`, `fetch`, ...) against a source repo
    // cloned by a different OS user do not hit `dubious ownership`. Mirror of
    // `bootstrapSafeDirectoryForUser` in worktree-service.ts but with
    // `username: null` (run as the server itself, writing the server's
    // gitconfig). Issue #853.
    await this.bootstrapSafeDirectoryForServer(absolutePath);

    const id = crypto.randomUUID();
    const name = path.basename(absolutePath);

    const repository: Repository = {
      id,
      name,
      path: absolutePath,
      createdAt: new Date().toISOString(),
      description: options?.description ?? null,
      defaultAgentId: null,
      // Derived at serving time via `withRepositoryRemote` (Issue #905). The
      // in-memory copy carries `null` so the type contract is satisfied; the
      // REST / WS layer recomputes against `getSourceReposDir()` per request.
      clonedSourceRepoPath: null,
    };

    this.repositories.set(id, repository);
    await this.repository.save(repository);
    logger.info({ repositoryId: id, name }, 'Repository registered');

    // Callback fires after successful save - clients will receive state update
    // only after database write is confirmed
    await this.lifecycleCallbacks?.onRepositoryCreated(repository);

    return repository;
  }

  /**
   * Unregister a repository, deleting its data subtree and DB row.
   *
   * @param id Repository ID to unregister.
   * @param requestUsername OS username of the operator triggering the
   *   unregister. Threaded into the CLEANUP_REPOSITORY job so the handler can
   *   elevate the recursive `fs.rm` to that user when the worktree subtree is
   *   user-owned (`AUTH_MODE=multi-user`, Issue #884). Pass `null` for the
   *   historical direct `fs.rm` path (single-user mode, or non-route callers).
   * @param opts Optional flags. `removeSourceRepo` requests that the cleanup
   *   job also remove the source-repo clone when `repo.path` lives under
   *   `getSourceReposDir()` (Issue #905). The path-guard is applied in
   *   `cleanupRepositoryData`; out-of-prefix paths are silently skipped.
   */
  async unregisterRepository(
    id: string,
    requestUsername: string | null = null,
    opts: { removeSourceRepo?: boolean } = {},
  ): Promise<boolean> {
    const repo = this.repositories.get(id);
    if (!repo) return false;

    // Check if any active sessions are using this repository
    // Uses callback to avoid circular dependency with SessionManager
    const activeSessions = this.dependencyCallbacks?.getSessionsUsingRepository(id) ?? [];
    if (activeSessions.length > 0) {
      throw new Error(
        `Cannot unregister repository: ${activeSessions.length} active session(s) are using it. ` +
        `Delete or close the sessions first.`
      );
    }

    // Clean up related directories
    await this.cleanupRepositoryData(repo.path, requestUsername, opts);

    this.repositories.delete(id);
    await this.repository.delete(id);
    logger.info({ repositoryId: id, name: repo.name }, 'Repository unregistered');

    // Callback fires after successful delete - clients will receive state update
    // only after database write is confirmed
    this.lifecycleCallbacks?.onRepositoryDeleted(id);

    return true;
  }

  /**
   * Update a repository's settings.
   * @param id - Repository ID to update
   * @param updates - Fields to update
   * @returns Updated repository if found, null otherwise
   */
  async updateRepository(id: string, updates: RepositoryUpdates): Promise<Repository | null> {
    const repo = this.repositories.get(id);
    if (!repo) return null;

    const updated = await this.repository.update(id, updates);
    if (!updated) return null;

    this.repositories.set(id, updated);
    logger.info({ repositoryId: id }, 'Repository updated');

    // Callback fires after successful update - clients will receive state update
    // only after database write is confirmed
    await this.lifecycleCallbacks?.onRepositoryUpdated(updated);

    return updated;
  }

  /**
   * In `AUTH_MODE=multi-user`, configure the source repo's `.git/` so members
   * of the shared group (`agent-console-users`) can write refs and lock files
   * when `git worktree add` runs as the requesting user via `runAsUser` (Issue
   * #838 / PR #843). The configuration is the same one previously documented
   * as a manual operator step in `docs/multi-user-setup-guide.md` "Source Repo
   * Group-Writability":
   *
   *   git -C <repo> config core.sharedRepository group
   *   find <repo>/.git -type d -exec chmod g+rwxs {} +
   *   chmod -R g+rw <repo>/.git
   *   chgrp -R <shared-group> <repo>/.git
   *
   * Idempotent: skips when `.git/` already has the shared group + group-write
   * + setgid AND `git config --local --get core.sharedRepository` returns
   * `group`. Failure to apply (typically because the server does not own the
   * repo and is not in its group) logs a warning with the manual fallback
   * commands so the operator can resolve it, then proceeds with registration
   * — the worktree-creation step will surface a clearer error later if the
   * warning was actionable. In `AUTH_MODE=none` (or unset), no-op.
   */
  private async applyMultiUserSharedRepoConfig(absolutePath: string): Promise<void> {
    if (process.env.AUTH_MODE !== 'multi-user') {
      return;
    }

    const gitDir = path.join(absolutePath, '.git');
    const sharedGroup = getSharedGroupName();

    // Cheap idempotent-skip probe: when `.git/` already has the shared
    // group's gid + the group-write + setgid mode bits, AND
    // `core.sharedRepository` is 'group', skip the apply chain. Both halves
    // of the probe are needed -- mode / group can drift independently of
    // the git-config setting.
    //
    // The shared group's gid is resolved at probe time via `getent group
    // <name>`. The service user is a SUPPLEMENTARY member of the shared
    // group (see `scripts/setup-multiuser-for-ubuntu.sh:346`'s
    // `usermod -aG`), so `process.getgid()` (the service user's PRIMARY
    // group) does NOT equal the shared group's gid after a real apply.
    // Without `getent`, the lstat short-circuit would always miss and the
    // documented idempotent-skip optimization would be dead in production.
    const sharedGid = await this.resolveSharedGroupGid(sharedGroup);
    let alreadyConfigured = false;
    try {
      const stat = await lstat(gitDir);
      const mode = stat.mode & 0o7777;
      const hasGroupWrite = (mode & 0o020) === 0o020;
      const hasSetgid = (mode & 0o2000) === 0o2000;
      const gidMatches = sharedGid !== null && stat.gid === sharedGid;
      if (gidMatches && hasGroupWrite && hasSetgid) {
        // Mode/group look right -- confirm git config to be sure.
        const probe = await this._runAsUser({
          username: null,
          command: `git -C ${shellEscape(absolutePath)} config --local --get core.sharedRepository`,
          timeoutMs: SHARED_REPO_APPLY_TIMEOUT_MS,
        });
        if (probe.exitCode === 0 && probe.stdout.trim() === 'group') {
          alreadyConfigured = true;
        }
      }
    } catch (err) {
      // `lstat` failure is not a hard error here -- the apply step will hit
      // the same problem and report it. Log at debug for visibility.
      logger.debug(
        { err, gitDir },
        'multi-user shared-repo probe lstat failed; proceeding to apply',
      );
    }

    if (alreadyConfigured) {
      logger.info(
        { repoPath: absolutePath, sharedGroup },
        'Multi-user shared-repo config already applied; skipping',
      );
      return;
    }

    const escapedRepo = shellEscape(absolutePath);
    const escapedGitDir = shellEscape(gitDir);
    const escapedGroup = shellEscape(sharedGroup);
    // Single shell command so a single `runAsUser` spawn covers all four
    // steps. `&&` chaining means later steps only run when earlier ones
    // succeed; the failing step's stderr surfaces in the captured stderr.
    const command =
      `git -C ${escapedRepo} config core.sharedRepository group` +
      ` && find ${escapedGitDir} -type d -exec chmod g+rwxs {} +` +
      ` && chmod -R g+rw ${escapedGitDir}` +
      ` && chgrp -R ${escapedGroup} ${escapedGitDir}`;

    let result;
    try {
      result = await this._runAsUser({
        username: null, // run as the server process user
        command,
        timeoutMs: SHARED_REPO_APPLY_TIMEOUT_MS,
      });
    } catch (err) {
      logger.warn(
        {
          err,
          repoPath: absolutePath,
          sharedGroup,
          manualFallback: buildManualFallbackCommands(absolutePath, sharedGroup),
        },
        'Multi-user shared-repo config spawn failed; continuing with registration. ' +
          'Apply the manualFallback commands as an operator if worktree creation later fails.',
      );
      return;
    }

    if (result.timedOut || result.exitCode !== 0) {
      logger.warn(
        {
          repoPath: absolutePath,
          sharedGroup,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stderr: result.stderr.trim(),
          manualFallback: buildManualFallbackCommands(absolutePath, sharedGroup),
        },
        'Multi-user shared-repo config returned non-zero; continuing with registration. ' +
          'Apply the manualFallback commands as an operator if worktree creation later fails.',
      );
      return;
    }

    logger.info(
      { repoPath: absolutePath, sharedGroup },
      'Multi-user shared-repo config applied',
    );
  }

  /**
   * Append `<repoPath>` to the SERVER user's `safe.directory` list when not
   * already present. Required because, in multi-user mode, an operator may
   * have cloned the source repo as their own OS user. git's CVE-2022-24765
   * owner check then refuses any server-initiated git operation against
   * that repo with `fatal: detected dubious ownership`. The previous
   * `applyMultiUserSharedRepoConfig` step targets filesystem mode + group
   * ownership but does NOT change file OWNER uid, so safe.directory is the
   * minimum-trust-expansion mitigation. Mirror of
   * `bootstrapSafeDirectoryForUser` in worktree-service.ts (Issue #838 /
   * PR #843), but with `username: null` so the bootstrap writes the SERVER's
   * gitconfig rather than a user's. Issue #853.
   *
   * Idempotent -- checks `git config --get-all safe.directory` first and only
   * adds the entry when this exact `repoPath` is missing. Failure is logged
   * but not thrown, so a misconfigured gitconfig does not block registration;
   * subsequent server-initiated git operations will surface a clearer
   * `dubious ownership` error if the bootstrap was actually needed. In
   * `AUTH_MODE=none` (or unset), no-op.
   */
  private async bootstrapSafeDirectoryForServer(repoPath: string): Promise<void> {
    if (process.env.AUTH_MODE !== 'multi-user') {
      return;
    }

    const escapedPath = shellEscape(repoPath);
    // `--get-all` returns one line per entry, exit 0 even if none match the
    // value. We post-filter rather than relying on `--get` (which would only
    // return the first match and could mis-report when the server has
    // multiple entries).
    const command = `if ! git config --global --get-all safe.directory 2>/dev/null | grep -Fxq ${escapedPath}; then git config --global --add safe.directory ${escapedPath}; fi`;

    let result;
    try {
      result = await this._runAsUser({
        username: null, // run as the server process user (e.g. agentconsole)
        command,
        timeoutMs: SAFE_DIRECTORY_BOOTSTRAP_TIMEOUT_MS,
      });
    } catch (err) {
      logger.warn(
        { err, repoPath },
        'server-side safe.directory bootstrap spawn failed; continuing with registration',
      );
      return;
    }

    if (result.timedOut || result.exitCode !== 0) {
      logger.warn(
        {
          repoPath,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stderr: result.stderr.trim(),
        },
        'server-side safe.directory bootstrap returned non-zero; continuing with registration',
      );
      return;
    }

    logger.info({ repoPath }, 'server-side safe.directory bootstrap completed');
  }

  /**
   * Resolve the shared group's numeric gid via `getent group <name>`.
   * Returns null when the group is not configured or `getent` exits
   * non-zero -- in that case the caller skips the lstat short-circuit and
   * applies the chain unconditionally (the chgrp leg will surface a
   * clearer error if the group truly does not exist).
   *
   * The `getent group` output format is: `<name>:<password>:<gid>:<member1>,...`
   */
  private async resolveSharedGroupGid(sharedGroup: string): Promise<number | null> {
    try {
      const result = await this._runAsUser({
        username: null,
        command: `getent group ${shellEscape(sharedGroup)}`,
        timeoutMs: SHARED_REPO_APPLY_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        return null;
      }
      // Output: `name:password:gid:members`. Split on `:` and take field 3.
      const parts = result.stdout.trim().split(':');
      if (parts.length < 3) {
        return null;
      }
      const gid = Number.parseInt(parts[2], 10);
      return Number.isFinite(gid) ? gid : null;
    } catch (err) {
      logger.debug(
        { err, sharedGroup },
        'getent group resolution failed; skipping idempotent-skip probe',
      );
      return null;
    }
  }

  /**
   * Clean up repository data directory (worktrees and templates)
   * @param repoPath Absolute path of the registered repository (used to
   *   resolve the data dir under `<AGENT_CONSOLE_HOME>/repositories/<org/repo>`).
   * @param requestUsername OS username threaded into the CLEANUP_REPOSITORY
   *   payload so the handler can elevate the recursive `rm` to that user
   *   under `AUTH_MODE=multi-user` when the worktree subtree is user-owned
   *   (Issue #884). `null` keeps the historical direct `fs.rm` path.
   * @param opts.removeSourceRepo When `true`, additionally remove the source
   *   repo clone at `repoPath` itself (Issue #905). Only honoured when
   *   `repoPath` lives under `getSourceReposDir()`; out-of-prefix paths are
   *   silently skipped with a debug log.
   * @throws Error if jobQueue is not available
   */
  private async cleanupRepositoryData(
    repoPath: string,
    requestUsername: string | null,
    opts: { removeSourceRepo?: boolean } = {},
  ): Promise<void> {
    if (!this.jobQueue) {
      throw new Error('JobQueue not available for repository cleanup. Ensure RepositoryManager.create() was called with jobQueue.');
    }

    const orgRepo = await getOrgRepoFromPath(repoPath);
    const repoDir = getRepositoryDir(orgRepo);

    // Issue #905: when the unregister request opts in to source-repo removal,
    // verify the registered path actually lives under the shared source-repos
    // directory before forwarding it as `extraDir`. The frontend gates the
    // checkbox on `clonedSourceRepoPath`, but the server applies the same
    // path-prefix check as a defensive guard against a tampered request body
    // that toggles the flag on a path outside the source-repos prefix.
    let extraDir: string | null = null;
    if (opts.removeSourceRepo === true) {
      const sourceReposDir = getSourceReposDir();
      if (isUnderSourceReposDir(repoPath, sourceReposDir)) {
        extraDir = repoPath;
      } else {
        logger.debug(
          { repoPath, sourceReposDir },
          'removeSourceRepo requested but registered path is outside source-repos dir; skipping extra cleanup',
        );
      }
    }

    // Clean up entire repository directory via job queue
    await this.jobQueue.enqueue(JOB_TYPES.CLEANUP_REPOSITORY, {
      repoDir,
      requestUsername,
      extraDir,
    });
  }

  getRepository(id: string): Repository | undefined {
    return this.repositories.get(id);
  }

  /**
   * Return the slug used for session-data path resolution.
   * Currently the slug is the repository name — keep this accessor distinct
   * from `getRepository` so callers that only need path-purposes data can
   * depend on a narrow `RepositoryLookup` interface.
   * Returns undefined if the repository is not registered.
   */
  getRepositorySlug(id: string): string | undefined {
    return this.repositories.get(id)?.name;
  }

  getAllRepositories(): Repository[] {
    return Array.from(this.repositories.values());
  }

  findRepositoryByPath(repoPath: string): Repository | undefined {
    const absolutePath = path.resolve(repoPath);
    for (const repo of this.repositories.values()) {
      if (repo.path === absolutePath) {
        return repo;
      }
    }
    return undefined;
  }
}
