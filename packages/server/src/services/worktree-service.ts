import { promises as fsPromises } from 'fs';
import * as path from 'path';
import type { Worktree, HookCommandResult } from '@agent-console/shared';
import { getRepositoryDir } from '../lib/config.js';
import {
  getRemoteUrl,
  parseOrgRepo,
  listWorktrees as gitListWorktrees,
  removeWorktree as gitRemoveWorktree,
  pruneWorktrees as gitPruneWorktrees,
  listLocalBranches,
  listRemoteBranches,
  getDefaultBranch as gitGetDefaultBranch,
  refreshDefaultBranch as gitRefreshDefaultBranch,
  GitError,
} from '../lib/git.js';
// listLocalBranches, listRemoteBranches, getDefaultBranch, refreshDefaultBranch
// are thin pass-throughs after Issue #870: lib/git.ts now accepts requestUser
// directly so multi-user mode runs git as the worktree-owning user (picking
// up that user's PATH, gitconfig, and SSH_AUTH_SOCK via sudo -i).
import { createLogger } from '../lib/logger.js';
import { substituteVariables } from '../lib/template-variables.js';
import { getCleanChildProcessEnv } from './env-filter.js';
import {
  runAsUser,
  rmRecursiveAsUser,
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
 * Timeout for `git worktree remove` (and the fallback `rm -rf` / `git
 * worktree prune` shell invocations) that route through `runAsUser` when
 * the worktree is user-owned (Issue #882). Same wall-clock budget as the
 * add path.
 */
const WORKTREE_REMOVE_TIMEOUT_MS = 120000;

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
   * Remove a worktree.
   *
   * When `requestUsername` is provided and elevation engages
   * (`AUTH_MODE=multi-user` + non-server user), `git worktree remove` (and
   * any force-fallback `rm -rf` / `git worktree prune`) is invoked via
   * `runAsUser` so the operations execute as the worktree-owning user. This
   * fixes the `Permission denied` failure mode hit when the server user
   * (`agentconsole`) tries to delete files owned by a delegated user
   * (Issue #882, mirrors the create-side fix from Issue #838 / PR #843).
   *
   * In `AUTH_MODE=none` or when `requestUsername` is null/undefined, the call
   * keeps the historical direct `gitRemoveWorktree` path, preserving the
   * original single-user behaviour (including the existing test surface that
   * mocks `lib/git.ts`).
   */
  async removeWorktree(
    repoPath: string,
    worktreePath: string,
    force: boolean = false,
    requestUsername?: string | null,
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
        await this.removeOrphanedWorktree(worktreePath, requestUsername);
        logger.warn(
          { worktreePath, repoPath },
          'Primary repo dir missing; removed orphaned worktree without git'
        );
        return { success: true };
      }

      // Detect the orphan-worktree-dir case (#895): primary repo OK, but
      // `worktreePath` itself was externally removed. `git worktree remove`
      // would fail with `fatal: '<path>' is not a working tree`. Skip the
      // remove and run `git worktree prune` + DB-row delete in repoPath
      // instead. `removeOrphanedWorktree` is not reusable here because prune
      // still needs the primary repo for context.
      //
      // ENOENT/ENOTDIR-only narrowing mirrors the repoExists block above:
      // other stat errors (EACCES/EPERM/IO) MUST surface as failure, not
      // route to destructive recovery.
      let worktreeExists = false;
      try {
        const stat = await fsPromises.stat(worktreePath);
        worktreeExists = stat.isDirectory();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          worktreeExists = false;
        } else {
          throw error; // caught by the outer catch → { success: false, error }
        }
      }

      if (!worktreeExists) {
        if (shouldElevateForUser(requestUsername)) {
          const elevatedUsername = requestUsername!;
          // Bootstrap safe.directory so the elevated `git worktree prune`
          // does not hit `fatal: detected dubious ownership` on the
          // server-owned source repo. Mirrors the normal elevated remove
          // path below.
          await this.bootstrapSafeDirectoryForUser(elevatedUsername, repoPath);
          const pruneResult = await this._runAsUser({
            username: elevatedUsername,
            command: 'git worktree prune',
            cwd: repoPath,
            timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
          });
          if (pruneResult.timedOut || pruneResult.exitCode !== 0) {
            const detail =
              pruneResult.stderr.trim() || `exit code ${pruneResult.exitCode}`;
            throw new GitError(
              `git worktree prune (orphan worktree-dir recovery, #895) failed: ${detail}`,
              pruneResult.exitCode,
              pruneResult.stderr,
            );
          }
        } else {
          await gitPruneWorktrees(repoPath);
        }
        await this.worktreeRepository.deleteByPath(worktreePath);
        logger.warn(
          { worktreePath, repoPath },
          'Worktree dir missing; pruned registry and removed DB row (#895)',
        );
        return { success: true };
      }

      if (shouldElevateForUser(requestUsername)) {
        const elevatedUsername = requestUsername!;
        // Bootstrap the user's `safe.directory` for `repoPath` so the
        // elevated `git worktree remove` (running as the user) does not hit
        // `fatal: detected dubious ownership` on the server-owned source
        // repo. Mirrors the create path (`createWorktree`) which performs
        // the same bootstrap before `git worktree add`. Idempotent.
        await this.bootstrapSafeDirectoryForUser(elevatedUsername, repoPath);
        await this.invokeGitWorktreeRemove({
          worktreePath,
          repoPath,
          force,
          requestUsername: elevatedUsername,
        });
      } else {
        await gitRemoveWorktree(worktreePath, repoPath, { force });
      }

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
   * Invoke `git worktree remove` via `runAsUser` (multi-user elevated path
   * for Issue #882). Mirrors the fallback semantics of `lib/git.ts`'s
   * `removeWorktree`: when `force` is true and the failure stderr indicates
   * a stale `.git` file or unrecognized worktree, fall back to a manual
   * `rm -rf` plus a best-effort `git worktree prune` — both routed through
   * `runAsUser` so they execute as the worktree-owning user. Prune failure
   * is logged but does not propagate (the rm already succeeded).
   *
   * Throws `GitError` on non-recoverable failure so the outer `removeWorktree`
   * catch keeps its existing `extractErrorMessage` / `instanceof GitError`
   * branching contract.
   */
  private async invokeGitWorktreeRemove(opts: {
    worktreePath: string;
    repoPath: string;
    force: boolean;
    requestUsername: string;
  }): Promise<void> {
    const args = ['git', 'worktree', 'remove', opts.worktreePath];
    if (opts.force) {
      // `--force` twice mirrors `lib/git.ts removeWorktree`: removes unclean
      // worktrees AND locked worktrees.
      args.push('--force', '--force');
    }
    const command = args.map(shellEscape).join(' ');

    const result = await this._runAsUser({
      username: opts.requestUsername,
      command,
      cwd: opts.repoPath,
      timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
    });

    if (!result.timedOut && result.exitCode === 0) {
      return;
    }

    const stderr = result.stderr;

    // Narrow stale-worktree matcher: only patterns that genuinely indicate
    // git can no longer manage the worktree (so a manual removal is the
    // correct recovery). Avoids over-broad matches like `fatal: not a git
    // repository ... .git` that would trigger destructive cleanup against
    // a healthy repo (CodeRabbit, 2026-06-25).
    const isStaleWorktreeError =
      stderr.includes('is not a working tree') ||
      stderr.includes('cannot read .git file') ||
      stderr.includes('invalid gitfile format') ||
      stderr.includes("'.git' file");

    if (opts.force && !result.timedOut && isStaleWorktreeError) {
      const rmResult = await rmRecursiveAsUser(
        opts.worktreePath,
        opts.requestUsername,
        {
          timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
          runAsUserImpl: this._runAsUser,
        },
      );
      if (rmResult.timedOut || rmResult.exitCode !== 0) {
        const detail =
          rmResult.stderr.trim() || `exit code ${rmResult.exitCode}`;
        throw new GitError(
          `git worktree remove (elevated rm fallback) failed: ${detail}`,
          rmResult.exitCode,
          rmResult.stderr,
        );
      }

      // Best-effort prune as the user; failure is logged but not propagated
      // (the rm already succeeded, so git's stale registry is the only cost).
      const pruneResult = await this._runAsUser({
        username: opts.requestUsername,
        command: 'git worktree prune',
        cwd: opts.repoPath,
        timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
      });
      if (pruneResult.timedOut || pruneResult.exitCode !== 0) {
        logger.warn(
          {
            username: opts.requestUsername,
            repoPath: opts.repoPath,
            stderr: pruneResult.stderr.trim(),
            timedOut: pruneResult.timedOut,
          },
          'git worktree prune failed after elevated rm fallback; rm already succeeded so continuing',
        );
      }
      return;
    }

    const detail = stderr.trim() || `exit code ${result.exitCode}`;
    throw new GitError(
      `git worktree remove failed: ${detail}`,
      result.exitCode,
      stderr,
    );
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
   * In multi-user mode (Issue #882) the worktree directory is owned by the
   * requesting user, so the server-process `fsPromises.rm` would fail with
   * `EACCES`. When `requestUsername` is provided and elevation engages, the
   * removal is routed through `runAsUser` (`rm -rf -- <path>`) so it executes
   * as the worktree owner. The DB-row delete still runs in-process (DB rows
   * are not OS-owned).
   *
   * Idempotent. Callers are responsible for any concurrency guard and any
   * security boundary check on `worktreePath`.
   */
  async removeOrphanedWorktree(
    worktreePath: string,
    requestUsername?: string | null,
  ): Promise<void> {
    if (shouldElevateForUser(requestUsername)) {
      const result = await rmRecursiveAsUser(worktreePath, requestUsername!, {
        timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
        runAsUserImpl: this._runAsUser,
      });
      if (result.timedOut || result.exitCode !== 0) {
        const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
        throw new Error(
          `Failed to remove orphaned worktree as ${requestUsername!}: ${detail}`,
        );
      }
    } else {
      await fsPromises.rm(worktreePath, { recursive: true, force: true });
    }
    await this.worktreeRepository.deleteByPath(worktreePath);
  }

  /**
   * List branches in a repository.
   *
   * Routes each constituent git invocation through `lib/git.ts` with the
   * provided `requestUsername`. When non-null, lib/git.ts uses `runAsUser`
   * so multi-user mode runs git as the requesting user — picking up that
   * user's PATH, `~/.gitconfig`, and SSH_AUTH_SOCK from their login shell
   * via `sudo -i`. The server's own SSH_AUTH_SOCK is intentionally NOT
   * forwarded: the server runs as a system user (`agentconsole`) which has
   * no useful agent socket of its own. See Issue #870 for the user-facing
   * symptom (the "Could not check remote status" banner / dubious
   * ownership errors).
   *
   * Preserves the existing swallow contract: any overall failure returns
   * `{ local: [], remote: [], defaultBranch: null }` so the UI can render a
   * neutral "no branches" view instead of propagating an error.
   */
  async listBranches(
    repoPath: string,
    requestUsername: string | null = null,
  ): Promise<{ local: string[]; remote: string[]; defaultBranch: string | null }> {
    try {
      const [local, remote, defaultBranch] = await Promise.all([
        listLocalBranches(repoPath, requestUsername),
        listRemoteBranches(repoPath, requestUsername),
        this.getDefaultBranch(repoPath, requestUsername),
      ]);

      return { local, remote, defaultBranch };
    } catch (error) {
      logger.error({ err: error }, 'Failed to list branches');
      return { local: [], remote: [], defaultBranch: null };
    }
  }

  /**
   * Get the default branch name from remote origin.
   *
   * See {@link listBranches} for the multi-user / SSH credential rationale.
   */
  async getDefaultBranch(
    repoPath: string,
    requestUsername: string | null = null,
  ): Promise<string | null> {
    return gitGetDefaultBranch(repoPath, requestUsername);
  }

  /**
   * Refresh the default branch reference from remote origin.
   * This updates the local refs/remotes/origin/HEAD to match the remote's default branch.
   *
   * See {@link listBranches} for the multi-user / SSH credential rationale.
   * The network call (`git remote set-head origin -a`) is the SSH-using git
   * invocation here, so running it as the requesting user is critical.
   *
   * @returns The updated default branch name
   * @throws GitError if the command fails (e.g., network error, no remote)
   */
  async refreshDefaultBranch(
    repoPath: string,
    requestUsername: string | null = null,
  ): Promise<string> {
    return gitRefreshDefaultBranch(repoPath, requestUsername);
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
   * In `AUTH_MODE=multi-user` with a `requestUsername` that differs from the
   * server-process user (Issue #883), the command is routed through
   * `runAsUser` so the hook executes as the worktree-owning user. This is
   * required because the worktree directory and its credentials (gh, ssh)
   * are owned by the requesting user; running the hook as the server user
   * (`agentconsole`) would fail to write user-owned files and would not see
   * the user's gh / ssh auth.
   *
   * The `getCleanChildProcessEnv()` env filter only applies to the
   * non-elevated branch — on the elevated path `sudo -i` resets the env
   * entirely, so the user gets their normal login env plus the four hook
   * variables (`WORKTREE_NUM`, `BRANCH`, `REPO`, `WORKTREE_PATH`) exported
   * via `runAsUser`'s inner-shell `export` mechanism. The branch is gated
   * at this caller (per `.claude/rules/elevation-helpers.md` strict-thin-
   * wrapper contract) rather than threading the filter through `runAsUser`.
   *
   * @param command - The command template to execute
   * @param worktreePath - The worktree directory path (command will run here)
   * @param vars - Template variables for substitution
   * @param requestUsername - When set and elevation would engage, the hook
   *   runs as this user via `runAsUser`. Null / undefined / single-user mode
   *   preserves the historical direct-spawn behaviour verbatim.
   * @returns Result with success status, output, and any error message
   */
  async executeHookCommand(
    command: string,
    worktreePath: string,
    vars: { worktreeNum: number; branch: string; repo: string },
    requestUsername?: string | null,
  ): Promise<HookCommandResult> {
    // Substitute template variables in the command
    const substitutedCommand = substituteVariables(command, {
      worktreeNum: vars.worktreeNum,
      branch: vars.branch,
      repo: vars.repo,
      worktreePath,
    });

    const hookEnv = {
      WORKTREE_NUM: String(vars.worktreeNum),
      BRANCH: vars.branch,
      REPO: vars.repo,
      WORKTREE_PATH: worktreePath,
    };

    logger.info({ worktreePath, command: substitutedCommand }, 'Executing hook command');

    // Elevated branch (Issue #883): route through runAsUser so the hook runs
    // as the worktree-owning user. Only engaged when AUTH_MODE=multi-user AND
    // requestUsername differs from the server-process user — otherwise the
    // historical direct-spawn path below is preserved verbatim (including
    // the getCleanChildProcessEnv() env filter).
    if (shouldElevateForUser(requestUsername)) {
      try {
        const result = await this._runAsUser({
          username: requestUsername!,
          command: substitutedCommand,
          cwd: worktreePath,
          env: hookEnv,
        });

        if (result.exitCode === 0) {
          logger.info(
            { worktreePath, exitCode: result.exitCode, requestUsername },
            'Hook command completed successfully (elevated)',
          );
          return {
            success: true,
            output: result.stdout || undefined,
          };
        } else {
          logger.warn(
            {
              worktreePath,
              exitCode: result.exitCode,
              stderr: result.stderr,
              requestUsername,
            },
            'Hook command failed (elevated)',
          );
          return {
            success: false,
            output: result.stdout || undefined,
            error: result.stderr || `Command exited with code ${result.exitCode}`,
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error(
          { worktreePath, err: error, requestUsername },
          'Hook command execution error (elevated)',
        );
        return {
          success: false,
          error: errorMessage,
        };
      }
    }

    try {
      // Execute command using Bun.spawn with shell
      const proc = Bun.spawn(['sh', '-c', substitutedCommand], {
        cwd: worktreePath,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...getCleanChildProcessEnv(),
          ...hookEnv,
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
