import * as fs from 'fs';
import { access, lstat } from 'fs/promises';
import * as path from 'path';
import type { Repository } from '@agent-console/shared';
import { getRepositoryDir } from '../lib/config.js';
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
 * Type of the privilege-elevation helper, exposed for dependency injection
 * in tests. Production code uses the real `runAsUser` import.
 * @internal Exported for testing.
 */
export type RunAsUserFn = typeof runAsUser;

function getSharedGroupName(): string {
  return process.env.AGENT_CONSOLE_SERVICE_GROUP || DEFAULT_SHARED_GROUP;
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

    const id = crypto.randomUUID();
    const name = path.basename(absolutePath);

    const repository: Repository = {
      id,
      name,
      path: absolutePath,
      createdAt: new Date().toISOString(),
      description: options?.description ?? null,
      defaultAgentId: null,
    };

    this.repositories.set(id, repository);
    await this.repository.save(repository);
    logger.info({ repositoryId: id, name }, 'Repository registered');

    // Callback fires after successful save - clients will receive state update
    // only after database write is confirmed
    await this.lifecycleCallbacks?.onRepositoryCreated(repository);

    return repository;
  }

  async unregisterRepository(id: string): Promise<boolean> {
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
    await this.cleanupRepositoryData(repo.path);

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

    // Cheap idempotent-skip probe: when `.git/` already has the right group
    // and the group-write + setgid mode bits, AND core.sharedRepository is
    // 'group', skip the apply chain. Both halves of the probe are needed —
    // mode/group can drift independently of the git config setting.
    let alreadyConfigured = false;
    try {
      const stat = await lstat(gitDir);
      const mode = stat.mode & 0o7777;
      const hasGroupWrite = (mode & 0o020) === 0o020;
      const hasSetgid = (mode & 0o2000) === 0o2000;
      const gidMatches =
        typeof process.getgid === 'function' && stat.gid === process.getgid();
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
          manualFallback: this.buildManualFallbackCommands(absolutePath, sharedGroup),
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
          manualFallback: this.buildManualFallbackCommands(absolutePath, sharedGroup),
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
   * Build the same manual remediation commands that
   * `docs/multi-user-setup-guide.md` "Source Repo Group-Writability"
   * documents, embedded in the warn log so an operator can copy-paste them
   * when the auto-apply step cannot complete (e.g., the repo is owned by a
   * different user the server cannot chgrp on behalf of).
   */
  private buildManualFallbackCommands(repoPath: string, sharedGroup: string): string[] {
    return [
      `sudo -u agentconsole bash -lc 'cd ${repoPath} && git config core.sharedRepository group'`,
      `sudo find ${repoPath}/.git -type d -exec chmod g+rwxs {} +`,
      `sudo chmod -R g+rw ${repoPath}/.git`,
      `sudo chgrp -R ${sharedGroup} ${repoPath}/.git`,
    ];
  }

  /**
   * Clean up repository data directory (worktrees and templates)
   * @throws Error if jobQueue is not available
   */
  private async cleanupRepositoryData(repoPath: string): Promise<void> {
    if (!this.jobQueue) {
      throw new Error('JobQueue not available for repository cleanup. Ensure RepositoryManager.create() was called with jobQueue.');
    }

    const orgRepo = await getOrgRepoFromPath(repoPath);
    const repoDir = getRepositoryDir(orgRepo);

    // Clean up entire repository directory via job queue
    await this.jobQueue.enqueue(JOB_TYPES.CLEANUP_REPOSITORY, { repoDir });
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
