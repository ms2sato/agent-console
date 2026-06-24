import { promises as fsPromises } from 'fs';
import * as path from 'path';
import type { Worktree, HookCommandResult } from '@agent-console/shared';
import { getRepositoryDir } from '../lib/config.js';
import {
  getRemoteUrl,
  parseOrgRepo,
  listWorktrees as gitListWorktrees,
  removeWorktree as gitRemoveWorktree,
  listLocalBranches,
  listRemoteBranches,
  getDefaultBranch as gitGetDefaultBranch,
  refreshDefaultBranch as gitRefreshDefaultBranch,
  GitError,
} from '../lib/git.js';
import { createLogger } from '../lib/logger.js';
import { substituteVariables } from '../lib/template-variables.js';
import { getCleanChildProcessEnv } from './env-filter.js';
import {
  runAsUser,
  shellEscape,
  shouldElevateForUser,
  type RunAsUserResult,
} from './privilege-elevation.js';
import type { Kysely } from 'kysely';
import type { Database } from '../database/schema.js';
import type { WorktreeRepository, WorktreeRecord } from '../repositories/worktree-repository.js';
import { SqliteWorktreeRepository } from '../repositories/sqlite-worktree-repository.js';

const logger = createLogger('worktree-service');

/**
 * Timeout for `git worktree add` invocations that route through `runAsUser`.
 * Mirrors `HEAVY_GIT_TIMEOUT_MS` from `lib/git.ts` so the multi-user path has
 * the same wall-clock budget as the direct-spawn single-user path.
 */
const WORKTREE_ADD_TIMEOUT_MS = 120000;

/**
 * Timeout for the per-user `safe.directory` bootstrap. Short — the command is
 * a pure local gitconfig write with no network or fs traversal.
 */
const SAFE_DIRECTORY_BOOTSTRAP_TIMEOUT_MS = 10000;

/**
 * Timeout for each template file materialization step (one `mkdir -p` or
 * `cat > <dst>` invocation) when the worktree is user-owned (Issue #838
 * elevated branch). Local fs only, short content -- 10s is generous.
 */
const TEMPLATE_MATERIALIZE_TIMEOUT_MS = 10000;

/**
 * Generate a random alphanumeric suffix
 */
function generateRandomSuffix(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let suffix = '';
  for (let i = 0; i < length; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return suffix;
}

/**
 * Find templates directory for a repository
 * Priority: 1. .agent-console/ in repo root  2. $AGENT_CONSOLE_HOME/repositories/<owner>/<repo>/templates/
 */
async function findTemplatesDir(repoPath: string, orgRepo: string): Promise<string | null> {
  // Check repo-local templates
  const localTemplates = path.join(repoPath, '.agent-console');
  try {
    const stat = await fsPromises.stat(localTemplates);
    if (stat.isDirectory()) {
      return localTemplates;
    }
  } catch {
    // Directory doesn't exist, continue to global templates
  }

  // Check global templates in $AGENT_CONSOLE_HOME/repositories/<org>/<repo>/templates/
  const globalTemplates = path.join(getRepositoryDir(orgRepo), 'templates');
  try {
    const stat = await fsPromises.stat(globalTemplates);
    if (stat.isDirectory()) {
      return globalTemplates;
    }
  } catch {
    // Directory doesn't exist
  }

  return null;
}

/**
 * Sink for template file materialization. Production uses a sink that
 * routes writes through `runAsUser` when the worktree is user-owned
 * (Issue #838) so template files land owned by the requesting user
 * rather than the server process. Tests use the in-process sink that
 * writes via `fsPromises` directly.
 */
interface TemplateFileSink {
  mkdir(dirPath: string): Promise<void>;
  writeFile(filePath: string, content: string): Promise<void>;
}

/**
 * In-process sink used when the worktree is server-owned (single-user
 * mode, or multi-user with no `requestUsername`). Equivalent to the
 * original pre-#838 behaviour.
 */
const directFsSink: TemplateFileSink = {
  async mkdir(dirPath) {
    await fsPromises.mkdir(dirPath, { recursive: true });
  },
  async writeFile(filePath, content) {
    await fsPromises.writeFile(filePath, content);
  },
};

/**
 * Copy template files to worktree with variable substitution.
 *
 * The reader side (substitution) always runs in-process because templates
 * live under server-controlled paths (`<repo>/.agent-console/` or
 * `<AGENT_CONSOLE_HOME>/repositories/<org>/<repo>/templates/`). Only the
 * writer side is potentially elevated, via the injected `sink`, so that
 * template files in a user-owned worktree end up owned by the requesting
 * user rather than the server process (Issue #838).
 */
async function copyTemplateFiles(
  templatesDir: string,
  worktreePath: string,
  vars: { worktreeNum: number; branch: string; repo: string; worktreePath: string },
  sink: TemplateFileSink,
): Promise<string[]> {
  const copiedFiles: string[] = [];

  async function copyRecursive(srcDir: string, destDir: string): Promise<void> {
    const entries = await fsPromises.readdir(srcDir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip .DS_Store
      if (entry.name === '.DS_Store') continue;

      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      if (entry.isDirectory()) {
        await sink.mkdir(destPath);
        await copyRecursive(srcPath, destPath);
      } else {
        // Read, substitute, and write
        const content = await fsPromises.readFile(srcPath, 'utf-8');
        const substituted = substituteVariables(content, vars);

        // Ensure parent directory exists
        const destParent = path.dirname(destPath);
        await sink.mkdir(destParent);

        await sink.writeFile(destPath, substituted);
        copiedFiles.push(path.relative(worktreePath, destPath));
      }
    }
  }

  await copyRecursive(templatesDir, worktreePath);
  return copiedFiles;
}

/**
 * Extract user-facing error message from a git or generic error.
 * Prefers stderr from GitError (which contains the actual git error details).
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof GitError) return error.stderr;
  if (error instanceof Error) return error.message;
  return 'Unknown error';
}

/**
 * Extract org/repo from git remote URL
 * Examples:
 *   git@github.com:owner/repo-name.git -> owner/repo-name
 *   https://github.com/anthropics/claude-code.git -> anthropics/claude-code
 */
async function getOrgRepoFromRemote(repoPath: string): Promise<string | null> {
  const remoteUrl = await getRemoteUrl(repoPath);
  if (!remoteUrl) {
    return null;
  }
  return parseOrgRepo(remoteUrl);
}

/**
 * Type of the privilege-elevation helper, exposed for dependency injection
 * in tests. Production code uses the real `runAsUser` import.
 */
type RunAsUserFn = typeof runAsUser;

/**
 * Discriminated union for WorktreeService dependencies.
 * Either provide a `db` (and the service creates its own repository),
 * or provide a `worktreeRepository` directly (e.g. in tests).
 *
 * `runAsUserImpl` is an optional injection point used only by tests; in
 * production it defaults to the real `runAsUser`.
 */
export type WorktreeServiceDeps =
  | { db: Kysely<Database>; worktreeRepository?: never; runAsUserImpl?: RunAsUserFn }
  | { db?: never; worktreeRepository: WorktreeRepository; runAsUserImpl?: RunAsUserFn };

export class WorktreeService {
  private readonly _worktreeRepository: WorktreeRepository;
  private readonly _runAsUser: RunAsUserFn;

  constructor(deps: WorktreeServiceDeps) {
    this._worktreeRepository = deps.worktreeRepository ?? new SqliteWorktreeRepository(deps.db);
    this._runAsUser = deps.runAsUserImpl ?? runAsUser;
  }

  private get worktreeRepository(): WorktreeRepository {
    return this._worktreeRepository;
  }

  /**
   * Probe the source repo's git accessibility. Runs `git worktree list`
   * against the source repo and **throws** on git failure (does not swallow).
   *
   * This is the verification that `listWorktrees` was conceptually doing,
   * preserved as a separate method so the swallow contract of `listWorktrees`
   * (used by UI / API listings that expect `[]` on transient errors) stays
   * intact for its other callers.
   *
   * Used as a pre-create probe by `createWorktreeWithSession` so failures
   * such as `dubious ownership`, corrupt `.git/`, or missing remote surface
   * as actionable errors before any filesystem side effect is performed
   * (Issue #854).
   *
   * @throws GitError when the underlying `git worktree list` fails.
   */
  async verifyRepoAccessible(repoPath: string): Promise<void> {
    // We discard the return value; only the throw-or-not signal is needed.
    await gitListWorktrees(repoPath);
  }

  /**
   * List all worktrees for a repository.
   * Includes git-tracked worktrees registered in DB and orphaned DB records
   * (worktrees that exist in DB but are no longer tracked by git).
   */
  async listWorktrees(repoPath: string, repositoryId: string): Promise<Worktree[]> {
    try {
      const output = await gitListWorktrees(repoPath);

      // Get all registered worktrees from DB
      const dbRecords = await this.worktreeRepository.findByRepositoryId(repositoryId);

      // Parse git output, matching with DB records for index info
      const gitWorktrees = this.parsePorcelainOutput(output, repositoryId, repoPath, dbRecords);

      // Find orphaned worktrees: exist in DB but not in git output
      const gitPaths = new Set(gitWorktrees.map(wt => wt.path));
      for (const record of dbRecords) {
        if (!gitPaths.has(record.path)) {
          gitWorktrees.push({
            path: record.path,
            branch: '(orphaned)',
            isMain: false,
            repositoryId,
            index: record.indexNumber,
          });
        }
      }

      return gitWorktrees;
    } catch (error) {
      logger.error({ err: error, repoPath }, 'Failed to list worktrees');
      return [];
    }
  }

  /**
   * Parse git worktree list --porcelain output.
   * Returns only git-tracked worktrees; the caller handles adding orphaned ones.
   */
  private parsePorcelainOutput(
    output: string,
    repositoryId: string,
    mainRepoPath: string,
    dbRecords: WorktreeRecord[]
  ): Worktree[] {
    const worktrees: Worktree[] = [];
    const entries = output.trim().split('\n\n');

    // Build a lookup map from DB records for efficient index retrieval
    const recordByPath = new Map(dbRecords.map(r => [r.path, r]));

    for (const entry of entries) {
      if (!entry.trim()) continue;

      const lines = entry.split('\n');
      let worktreePath = '';
      let head = '';
      let branch = '';

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          worktreePath = line.substring(9);
        } else if (line.startsWith('HEAD ')) {
          head = line.substring(5);
        } else if (line.startsWith('branch ')) {
          // refs/heads/main -> main
          branch = line.substring(7).replace('refs/heads/', '');
        } else if (line === 'detached') {
          branch = `(detached at ${head.substring(0, 7)})`;
        }
      }

      if (worktreePath) {
        const isMain = worktreePath === mainRepoPath;
        const record = recordByPath.get(worktreePath);

        // Only include worktrees that are registered in the DB (created by this app)
        // Main worktree is always included
        if (isMain || record !== undefined) {
          worktrees.push({
            path: worktreePath,
            branch,
            isMain,
            repositoryId,
            index: isMain ? undefined : record?.indexNumber,
          });
        }
      }
    }

    return worktrees;
  }

  /**
   * Create a new worktree.
   *
   * When `requestUsername` is provided and the server is in `AUTH_MODE=multi-user`,
   * `git worktree add` is invoked via `runAsUser` so the resulting worktree
   * files are owned by the requesting user. This eliminates the
   * `dubious ownership` error users hit when running git commands inside the
   * worktree's PTY (Issue #838 / umbrella #837).
   *
   * In `AUTH_MODE=none` or when `requestUsername` is null/undefined, the call
   * still routes through `runAsUser` (which bypasses elevation in that case),
   * preserving the original single-user behaviour.
   *
   * When elevating, the server also runs `git config --global --add
   * safe.directory <repoPath>` as the requesting user once, so git's owner
   * check passes against the source repo (which remains owned by the server
   * user). The bootstrap is idempotent thanks to `git config --get-all`
   * checking for an existing entry first.
   */
  async createWorktree(
    repoPath: string,
    branch: string,
    repositoryId: string,
    baseBranch?: string,
    requestUsername?: string | null,
  ): Promise<{ worktreePath: string; index?: number; copiedFiles?: string[]; error?: string }> {
    // Generate worktree path: repositories/{org}/{repo}/worktrees/wt-{index}-{suffix}
    // Directory name is independent of branch name to avoid path issues with branch names containing slashes
    const orgRepo = (await getOrgRepoFromRemote(repoPath)) || path.basename(repoPath);
    const repoWorktreeDir = path.join(getRepositoryDir(orgRepo), 'worktrees');

    // Ensure base directory exists
    await fsPromises.mkdir(repoWorktreeDir, { recursive: true });

    // Allocate index from DB records
    const dbRecords = await this.worktreeRepository.findByRepositoryId(repositoryId);
    const newIndex = this.allocateNextIndex(dbRecords);

    // Generate directory name: wt-{index:3 digits}-{4 random alphanumeric}
    const dirSuffix = generateRandomSuffix(4);
    const dirName = `wt-${String(newIndex).padStart(3, '0')}-${dirSuffix}`;
    const worktreePath = path.join(repoWorktreeDir, dirName);

    try {
      // Determine whether elevation will actually engage. `runAsUser` itself
      // checks the same conditions; we replicate the check locally so we can
      // also gate the safe.directory bootstrap (only meaningful when running
      // as a non-server user).
      const willElevate = shouldElevateForUser(requestUsername);

      if (willElevate) {
        // Bootstrap the user's gitconfig so `git worktree add` (running as
        // the user) accepts the server-owned source repo. Idempotent —
        // `git config --get-all safe.directory` is checked first so we only
        // add the entry if it is not already present.
        await this.bootstrapSafeDirectoryForUser(requestUsername!, repoPath);
      }

      await this.invokeGitWorktreeAdd({
        worktreePath,
        branch,
        repoPath,
        baseBranch,
        requestUsername: willElevate ? requestUsername! : null,
      });

      // Save record to DB
      await this.worktreeRepository.save({
        id: crypto.randomUUID(),
        repositoryId,
        path: worktreePath,
        indexNumber: newIndex,
        createdAt: new Date().toISOString(),
      });

      logger.info(
        { worktreePath, index: newIndex, elevated: willElevate },
        'Worktree created',
      );

      // Copy template files. When the worktree is user-owned (Issue #838
      // elevated branch), template files must also be materialized as the
      // requesting user so the ownership of the entire worktree subtree is
      // consistent. The sink wraps `runAsUser` for that case; the
      // non-elevated branch uses direct fs writes (server-owned worktree
      // matches server-owned templates).
      const templatesDir = await findTemplatesDir(repoPath, orgRepo);
      let copiedFiles: string[] = [];

      if (templatesDir) {
        const repoName = orgRepo.includes('/') ? orgRepo.split('/')[1] : orgRepo;
        const sink = willElevate
          ? this.makeUserOwnedTemplateSink(requestUsername!)
          : directFsSink;
        copiedFiles = await copyTemplateFiles(
          templatesDir,
          worktreePath,
          {
            worktreeNum: newIndex,
            branch,
            repo: repoName,
            worktreePath,
          },
          sink,
        );
        if (copiedFiles.length > 0) {
          logger.info({ copiedFiles }, 'Template files copied');
        }
      }

      return { worktreePath, index: newIndex, copiedFiles };
    } catch (error) {
      const message = extractErrorMessage(error);
      logger.error({ err: error, message }, 'Failed to create worktree');
      return { worktreePath: '', error: message };
    }
  }

  /**
   * Invoke `git worktree add` via `runAsUser`. When `requestUsername` is null
   * or in `AUTH_MODE=none`, `runAsUser` bypasses elevation and runs the
   * command as the server user (the same effective behaviour as the prior
   * `Bun.spawn(['git', ...])` call in `lib/git.ts`). When elevation engages,
   * the worktree files end up owned by the requesting user, eliminating the
   * `dubious ownership` issue (#838).
   *
   * Throws a `GitError`-compatible error on non-zero exit so callers can
   * keep their existing `instanceof GitError` branching (via
   * `extractErrorMessage`).
   */
  private async invokeGitWorktreeAdd(opts: {
    worktreePath: string;
    branch: string;
    repoPath: string;
    baseBranch?: string;
    requestUsername: string | null;
  }): Promise<void> {
    // Build the git invocation as a shell command. Every interpolated value
    // is shell-escaped — branch names and worktree paths originate from
    // server-controlled / DB-driven sources but routing them through
    // `shellEscape` keeps the contract uniform (no value reaches sh -c
    // unquoted).
    const args = ['git', 'worktree', 'add'];
    if (opts.baseBranch !== undefined) {
      args.push('-b', opts.branch, opts.worktreePath, opts.baseBranch);
    } else {
      args.push(opts.worktreePath, opts.branch);
    }
    const command = args.map(shellEscape).join(' ');

    const result = await this._runAsUser({
      username: opts.requestUsername,
      command,
      cwd: opts.repoPath,
      timeoutMs: WORKTREE_ADD_TIMEOUT_MS,
    });

    if (result.timedOut || result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      const detail = stderr || `exit code ${result.exitCode}`;
      throw new GitError(`git worktree failed: ${detail}`, result.exitCode, stderr);
    }
  }

  /**
   * Append `<repoPath>` to the requesting user's `safe.directory` list when
   * not already present. Required because the source repo is owned by the
   * server user (`agentconsole`), so `git worktree add` running as the
   * requesting user would otherwise hit `fatal: detected dubious ownership`.
   * Mitigation A from Issue #838.
   *
   * Idempotent — checks `git config --get-all safe.directory` first and only
   * adds the entry when this exact `repoPath` is missing. Failure is logged
   * but not thrown, so a misconfigured gitconfig does not block worktree
   * creation; the subsequent `git worktree add` will surface a clearer
   * `dubious ownership` error if the bootstrap was actually needed.
   */
  private async bootstrapSafeDirectoryForUser(
    username: string,
    repoPath: string,
  ): Promise<void> {
    const escapedPath = shellEscape(repoPath);
    // `--get-all` returns one line per entry, exit 0 even if none match the
    // value. We post-filter rather than relying on `--get` (which would only
    // return the first match and could mis-report when the user has multiple
    // entries).
    const command = `if ! git config --global --get-all safe.directory 2>/dev/null | grep -Fxq ${escapedPath}; then git config --global --add safe.directory ${escapedPath}; fi`;
    let result: RunAsUserResult;
    try {
      result = await this._runAsUser({
        username,
        command,
        timeoutMs: SAFE_DIRECTORY_BOOTSTRAP_TIMEOUT_MS,
      });
    } catch (error) {
      logger.warn(
        { err: error, username, repoPath },
        'safe.directory bootstrap spawn failed; continuing with worktree creation',
      );
      return;
    }

    if (result.timedOut || result.exitCode !== 0) {
      logger.warn(
        {
          username,
          repoPath,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stderr: result.stderr.trim(),
        },
        'safe.directory bootstrap returned non-zero; continuing with worktree creation',
      );
      return;
    }

    logger.info({ username, repoPath }, 'safe.directory bootstrap completed for user');
  }

  /**
   * Build a template-file sink that materializes directories and files as
   * the requesting user via `runAsUser`. Used by `copyTemplateFiles` so
   * that template entries in a user-owned worktree (Issue #838 elevated
   * branch) inherit the same ownership as the worktree itself.
   *
   * The reader side (template content + variable substitution) stays
   * in-process; only the writer side is elevated. Files are materialized
   * by piping the substituted content through `sh -c 'cat > <dst>'` as
   * the user. Directories are created via `mkdir -p <dir>` as the user.
   *
   * Failure modes: a non-zero exit from the spawn causes the function to
   * throw, which propagates up through `copyTemplateFiles` and is caught
   * by `createWorktree`'s outer try/catch (returns `{ error }` and logs).
   */
  private makeUserOwnedTemplateSink(username: string): TemplateFileSink {
    const runAsUser = this._runAsUser;
    return {
      async mkdir(dirPath: string): Promise<void> {
        const escaped = shellEscape(dirPath);
        const result = await runAsUser({
          username,
          command: `mkdir -p ${escaped}`,
          timeoutMs: TEMPLATE_MATERIALIZE_TIMEOUT_MS,
        });
        if (result.timedOut || result.exitCode !== 0) {
          const detail = result.stderr.trim() || `exit ${result.exitCode}`;
          throw new Error(`mkdir as ${username} failed for ${dirPath}: ${detail}`);
        }
      },
      async writeFile(filePath: string, content: string): Promise<void> {
        const escaped = shellEscape(filePath);
        // `cat > <dst>` is the canonical "write stdin to file" shell
        // idiom. The user's shell receives the bytes via the stdin
        // pipe (runAsUser plumbs `opts.stdin` through Bun.spawn) and
        // creates `<dst>` owned by the user with the user's umask.
        // Production umask=0002 + setgid parent → mode 0664 group
        // agent-console-users, matching the rest of the worktree.
        const result = await runAsUser({
          username,
          command: `cat > ${escaped}`,
          stdin: content,
          timeoutMs: TEMPLATE_MATERIALIZE_TIMEOUT_MS,
        });
        if (result.timedOut || result.exitCode !== 0) {
          const detail = result.stderr.trim() || `exit ${result.exitCode}`;
          throw new Error(`writeFile as ${username} failed for ${filePath}: ${detail}`);
        }
      },
    };
  }

  /**
   * Remove a worktree
   */
  async removeWorktree(
    repoPath: string,
    worktreePath: string,
    force: boolean = false
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Detect the orphaned-worktree case where the primary repo dir was deleted
      // out-of-band. Every git op in the removal path runs with cwd = repoPath, and
      // a nonexistent cwd makes Bun.spawn throw ENOENT (not a GitError with parseable
      // stderr), so the normal git path — including the force fallback's prune — cannot
      // recover. A real-fs existence pre-check on repoPath is the reliable detector.
      //
      // Only ENOENT/ENOTDIR means "missing" — other stat errors (EACCES/EPERM/IO)
      // must NOT route to destructive recovery; let them surface as a failure via
      // the outer catch below.
      let repoExists = false;
      try {
        const stat = await fsPromises.stat(repoPath);
        repoExists = stat.isDirectory();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          repoExists = false;
        } else {
          throw error; // caught by the outer catch → { success: false, error }
        }
      }

      if (!repoExists) {
        // Primary repo is gone: the worktree is already orphaned. Recover without
        // git, unconditionally (no `force` required) — recovery of an orphaned
        // worktree is always defensible, and this also satisfies "at minimum force
        // must work". The helper is idempotent and is also used by the deletion
        // service when the repository row itself is unregistered (#815).
        await this.removeOrphanedWorktree(worktreePath);
        logger.warn(
          { worktreePath, repoPath },
          'Primary repo dir missing; removed orphaned worktree without git'
        );
        return { success: true };
      }

      await gitRemoveWorktree(worktreePath, repoPath, { force });

      // Remove DB record
      await this.worktreeRepository.deleteByPath(worktreePath);

      logger.info({ worktreePath }, 'Worktree removed');
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      logger.error({ err: error, message, worktreePath }, 'Failed to remove worktree');
      return { success: false, error: message };
    }
  }

  /**
   * Remove an orphaned worktree without invoking git.
   *
   * Used when a worktree has lost its anchor — either the primary repo
   * directory is gone (see #811), or the repository row itself is no longer
   * registered in memory (see #815). In both cases there is no git context
   * to drive `git worktree remove`, so the recovery is a pure best-effort
   * filesystem + DB cleanup:
   *
   * - `fs.rm` with `force: true` — no-op if the directory is already gone.
   * - `worktreeRepository.deleteByPath` — no-op if the row is already gone.
   *
   * Idempotent. Callers are responsible for any concurrency guard and any
   * security boundary check on `worktreePath`.
   */
  async removeOrphanedWorktree(worktreePath: string): Promise<void> {
    await fsPromises.rm(worktreePath, { recursive: true, force: true });
    await this.worktreeRepository.deleteByPath(worktreePath);
  }

  /**
   * List branches in a repository
   */
  async listBranches(repoPath: string): Promise<{ local: string[]; remote: string[]; defaultBranch: string | null }> {
    try {
      const [local, remote, defaultBranch] = await Promise.all([
        listLocalBranches(repoPath),
        listRemoteBranches(repoPath),
        this.getDefaultBranch(repoPath),
      ]);

      return { local, remote, defaultBranch };
    } catch (error) {
      logger.error({ err: error }, 'Failed to list branches');
      return { local: [], remote: [], defaultBranch: null };
    }
  }

  /**
   * Get the default branch name from remote origin
   */
  async getDefaultBranch(repoPath: string): Promise<string | null> {
    return gitGetDefaultBranch(repoPath);
  }

  /**
   * Refresh the default branch reference from remote origin.
   * This updates the local refs/remotes/origin/HEAD to match the remote's default branch.
   *
   * @returns The updated default branch name
   * @throws GitError if the command fails (e.g., network error, no remote)
   */
  async refreshDefaultBranch(repoPath: string): Promise<string> {
    return gitRefreshDefaultBranch(repoPath);
  }

  /**
   * Check if a worktree path belongs to a specific repository.
   * Uses direct DB lookup instead of listing all worktrees.
   */
  async isWorktreeOf(repoPath: string, worktreePath: string, repositoryId: string): Promise<boolean> {
    // Main worktree is always valid
    if (worktreePath === repoPath) return true;

    // Check DB for registered worktree
    const record = await this.worktreeRepository.findByPath(worktreePath);
    return record !== null && record.repositoryId === repositoryId;
  }

  /**
   * Get the index number for a worktree by its path.
   * Returns 0 for the main worktree (no DB record).
   */
  async getWorktreeIndexNumber(worktreePath: string): Promise<number> {
    const record = await this.worktreeRepository.findByPath(worktreePath);
    return record?.indexNumber ?? 0;
  }

  /**
   * Generate next branch name: wt-{index:3 digits}-{4 random alphanumeric}
   * Uses the next available index from the DB
   */
  async generateNextBranchName(repositoryId: string): Promise<string> {
    const dbRecords = await this.worktreeRepository.findByRepositoryId(repositoryId);
    const nextIndex = this.allocateNextIndex(dbRecords);
    const suffix = generateRandomSuffix(4);

    return `wt-${String(nextIndex).padStart(3, '0')}-${suffix}`;
  }

  /**
   * Allocate the next available index (fills gaps) from DB records
   */
  private allocateNextIndex(records: WorktreeRecord[]): number {
    const usedIndexes = new Set(records.map(r => r.indexNumber));
    let index = 1;
    while (usedIndexes.has(index)) {
      index++;
    }
    return index;
  }

  /**
   * Execute a hook command in a worktree directory.
   * Used for both setup (after creation) and cleanup (before deletion) hooks.
   * Supports template variables: {{WORKTREE_NUM}}, {{BRANCH}}, {{REPO}}, {{WORKTREE_PATH}}
   * Also supports arithmetic expressions like {{WORKTREE_NUM + 3000}}
   *
   * @param command - The command template to execute
   * @param worktreePath - The worktree directory path (command will run here)
   * @param vars - Template variables for substitution
   * @returns Result with success status, output, and any error message
   */
  async executeHookCommand(
    command: string,
    worktreePath: string,
    vars: { worktreeNum: number; branch: string; repo: string }
  ): Promise<HookCommandResult> {
    // Substitute template variables in the command
    const substitutedCommand = substituteVariables(command, {
      worktreeNum: vars.worktreeNum,
      branch: vars.branch,
      repo: vars.repo,
      worktreePath,
    });

    logger.info({ worktreePath, command: substitutedCommand }, 'Executing hook command');

    try {
      // Execute command using Bun.spawn with shell
      const proc = Bun.spawn(['sh', '-c', substitutedCommand], {
        cwd: worktreePath,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...getCleanChildProcessEnv(),
          WORKTREE_NUM: String(vars.worktreeNum),
          BRANCH: vars.branch,
          REPO: vars.repo,
          WORKTREE_PATH: worktreePath,
        },
      });

      // Collect output
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode === 0) {
        logger.info({ worktreePath, exitCode }, 'Hook command completed successfully');
        return {
          success: true,
          output: stdout || undefined,
        };
      } else {
        logger.warn({ worktreePath, exitCode, stderr }, 'Hook command failed');
        return {
          success: false,
          output: stdout || undefined,
          error: stderr || `Command exited with code ${exitCode}`,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ worktreePath, err: error }, 'Hook command execution error');
      return {
        success: false,
        error: errorMessage,
      };
    }
  }
}
