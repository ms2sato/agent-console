/**
 * Git utilities using Bun.spawn for async, shell-free execution.
 *
 * Benefits over child_process.execSync/exec:
 * - No shell injection vulnerabilities (args passed as array, not string)
 * - Consistent async API
 * - Non-blocking I/O
 *
 * Many exported helpers accept an optional `requestUser` trailing argument.
 * When non-null, the invocation is routed via `runAsUser` (see
 * `../services/privilege-elevation.js`) so that, in
 * multi-user mode, git executes as the requesting OS user — picking up
 * that user's PATH, gitconfig, and SSH_AUTH_SOCK from their login shell
 * via `sudo -i`. When `requestUser` is null/undefined (the default), the
 * historical `Bun.spawn(['git', ...args])` direct-spawn path runs verbatim.
 */
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import {
  runAsUser as defaultRunAsUser,
  shellEscape,
  type RunAsUserOpts,
  type RunAsUserResult,
} from '../services/privilege-elevation.js';
import { isErrnoException } from './type-guards.js';
import { isValidSlug } from './session-data-path.js';
import { createLogger } from './logger.js';
import { raceWithTimeout } from './race-with-timeout.js';
import { canonicalPath } from './canonical-path.js';

const logger = createLogger('git');

/** Default timeout for local git operations (30 seconds) */
const DEFAULT_GIT_TIMEOUT_MS = 30000;

/** Timeout for network operations like fetch (60 seconds) */
const NETWORK_GIT_TIMEOUT_MS = 60000;

/** Timeout for heavy file operations like worktree add/remove (120 seconds) */
const HEAVY_GIT_TIMEOUT_MS = 120000;

export class GitError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderr: string
  ) {
    super(message);
    this.name = 'GitError';
  }
}

// ============================================================
// Privilege-elevation test seam
// ============================================================

type RunAsUserFn = (opts: RunAsUserOpts) => Promise<RunAsUserResult>;

let _runAsUser: RunAsUserFn = defaultRunAsUser;

/**
 * Inject a fake `runAsUser` implementation for tests. Pass `null` to
 * restore the real implementation. Tests should call this in
 * `beforeEach`/`afterEach` to avoid cross-test leakage.
 *
 * @internal Test-only seam; production callers must not use this.
 */
export function __setRunAsUserForTesting(fn: RunAsUserFn | null): void {
  _runAsUser = fn ?? defaultRunAsUser;
}

/**
 * Apply the chosen trim mode to raw stdout.
 *
 * - `'full'`     - trims both ends; use for single-token outputs like
 *                  rev-parse / merge-base / symbolic-ref.
 * - `'start'`    - trims only leading whitespace; use for diff output where
 *                  trailing newlines are significant.
 * - `'preserve'` - no trimming; use for `git status --porcelain` and similar
 *                  formats whose every line has meaningful leading whitespace
 *                  (the staged/unstaged status columns). Trimming the output
 *                  would silently strip the indexStatus from the first line
 *                  and break porcelain parsing.
 */
function applyTrim(stdout: string, mode: 'full' | 'start' | 'preserve'): string {
  switch (mode) {
    case 'full':     return stdout.trim();
    case 'start':    return stdout.trimStart();
    case 'preserve': return stdout;
  }
}

/**
 * Internal implementation of git command execution.
 *
 * @param args - Git command arguments (without 'git' prefix)
 * @param cwd - Working directory for the command
 * @param timeoutMs - Timeout in milliseconds
 * @param trimOutput - How to trim stdout (see `applyTrim`).
 * @param requestUser - When non-null, route the invocation through
 *   `runAsUser` so it executes as that OS user under multi-user mode.
 *   When null/undefined (the default), use the direct `Bun.spawn` path.
 * @returns The stdout output
 * @throws GitError if the command fails or times out
 */
async function gitExec(
  args: string[],
  cwd: string,
  timeoutMs: number,
  trimOutput: 'full' | 'start' | 'preserve',
  requestUser?: string | null
): Promise<string> {
  if (requestUser != null && requestUser.length > 0) {
    // Elevated path: route via runAsUser. cwd is interpolated inside the
    // sudo'd inner command; the helper handles single-user bypass when the
    // requestUser matches the server process user (or AUTH_MODE != multi-user).
    const command = ['git', ...args].map(shellEscape).join(' ');
    let result: RunAsUserResult;
    try {
      result = await _runAsUser({
        username: requestUser,
        command,
        cwd,
        timeoutMs,
      });
    } catch (error) {
      // Spawn failure (e.g., sudo missing). Surface as GitError so callers
      // that branch on `instanceof GitError` keep working.
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new GitError(`git ${args[0] ?? '<unknown>'} failed: ${message}`, -1, message);
    }
    if (result.timedOut) {
      throw new GitError(
        `git ${args[0] ?? '<unknown>'} timed out after ${timeoutMs}ms`,
        result.exitCode,
        'Timeout'
      );
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr;
      throw new GitError(
        `git ${args[0] ?? '<unknown>'} failed: ${stderr.trim() || `exit code ${result.exitCode}`}`,
        result.exitCode,
        stderr
      );
    }
    return applyTrim(result.stdout, trimOutput);
  }

  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  try {
    // Race between process exit and timeout
    const exitCode = await raceWithTimeout(
      proc.exited,
      timeoutMs,
      () => new GitError(`git ${args[0] || 'unknown'} timed out after ${timeoutMs}ms`, -1, 'Timeout'),
    );

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new GitError(
        `git ${args[0]} failed: ${stderr.trim() || `exit code ${exitCode}`}`,
        exitCode,
        stderr
      );
    }

    const stdout = await new Response(proc.stdout).text();
    return applyTrim(stdout, trimOutput);
  } catch (error) {
    // If timeout occurred, kill the process
    if (error instanceof GitError && error.stderr === 'Timeout') {
      try {
        proc.kill();
      } catch {
        // Ignore kill errors (process may have already exited)
      }
    }
    throw error;
  }
}

/**
 * Execute a git command asynchronously with timeout protection.
 *
 * @param args - Git command arguments (without 'git' prefix)
 * @param cwd - Working directory for the command
 * @param timeoutMs - Timeout in milliseconds (default: 30000ms)
 * @param requestUser - When non-null, run as this OS user via `runAsUser`
 *   (multi-user mode picks up that user's PATH/gitconfig/SSH_AUTH_SOCK).
 *   When null/undefined (the default), spawn directly as the server user.
 * @returns The stdout output trimmed
 * @throws GitError if the command fails or times out
 *
 * @example
 * const branch = await git(['branch', '--show-current'], repoPath);
 * const remoteUrl = await git(['remote', 'get-url', 'origin'], repoPath);
 */
export async function git(
  args: string[],
  cwd: string,
  timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS,
  requestUser?: string | null,
): Promise<string> {
  return gitExec(args, cwd, timeoutMs, 'full', requestUser);
}

/**
 * Execute a git command asynchronously, preserving trailing whitespace.
 * Use this for commands where trailing newlines are significant (e.g., diff output).
 *
 * @param args - Git command arguments (without 'git' prefix)
 * @param cwd - Working directory for the command
 * @param timeoutMs - Timeout in milliseconds (default: 30000ms)
 * @param requestUser - See {@link git}.
 * @returns The stdout output with only leading whitespace trimmed
 * @throws GitError if the command fails or times out
 *
 * @example
 * // Use for diff commands where trailing newlines matter for parsing
 * const diff = await gitRaw(['diff', baseRef], repoPath);
 */
export async function gitRaw(
  args: string[],
  cwd: string,
  timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS,
  requestUser?: string | null,
): Promise<string> {
  return gitExec(args, cwd, timeoutMs, 'start', requestUser);
}

/**
 * Execute a git command, returning null on failure instead of throwing.
 * Useful for commands where failure is expected (e.g., checking if a branch exists).
 *
 * @param requestUser - See {@link git}.
 */
export async function gitSafe(
  args: string[],
  cwd: string,
  requestUser?: string | null,
): Promise<string | null> {
  try {
    return await git(args, cwd, DEFAULT_GIT_TIMEOUT_MS, requestUser);
  } catch {
    return null;
  }
}

/**
 * Check if a git ref exists.
 *
 * @param requestUser - See {@link git}.
 */
export async function gitRefExists(
  ref: string,
  cwd: string,
  requestUser?: string | null,
): Promise<boolean> {
  const result = await gitSafe(['rev-parse', '--verify', ref], cwd, requestUser);
  return result !== null;
}

// ============================================================
// High-level Git Operations
// ============================================================

/**
 * Get current branch name.
 *
 * @param requestUser - See {@link git}. Callers on a user-owned worktree
 *   (multi-user mode) must pass the SESSION'S SPAWN USER
 *   (`resolveSpawnUsername(session.createdBy)`) — NOT the requesting auth
 *   user — so a shared session's rename runs as the shared account, not
 *   the requester (#1622).
 */
export async function getCurrentBranch(cwd: string, requestUser?: string | null): Promise<string> {
  try {
    const branch = await git(['branch', '--show-current'], cwd, DEFAULT_GIT_TIMEOUT_MS, requestUser);
    return branch || '(detached)';
  } catch (err) {
    logger.warn({ cwd, requestUser, err }, 'Failed to read current branch; returning "(unknown)"');
    return '(unknown)';
  }
}

/**
 * Get remote URL for origin.
 */
export async function getRemoteUrl(cwd: string): Promise<string | null> {
  return gitSafe(['remote', 'get-url', 'origin'], cwd);
}

/**
 * List local branches.
 *
 * @param requestUser - See {@link git}. Enables multi-user mode to run as
 *   the worktree-owning user (picks up that user's gitconfig, avoiding
 *   `dubious ownership` on user-owned repos).
 */
export async function listLocalBranches(
  cwd: string,
  requestUser?: string | null,
): Promise<string[]> {
  try {
    const output = await git(['branch', '--format=%(refname:short)'], cwd, DEFAULT_GIT_TIMEOUT_MS, requestUser);
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * List remote branches.
 *
 * @param requestUser - See {@link listLocalBranches}.
 */
export async function listRemoteBranches(
  cwd: string,
  requestUser?: string | null,
): Promise<string[]> {
  try {
    const output = await git(['branch', '-r', '--format=%(refname:short)'], cwd, DEFAULT_GIT_TIMEOUT_MS, requestUser);
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * List all branches (local and remote).
 */
export async function listAllBranches(cwd: string): Promise<string[]> {
  try {
    const output = await git(['branch', '-a', '--list'], cwd);
    return output
      .split('\n')
      .map(line => line.replace(/^\*?\s+/, '').replace(/^remotes\/[^/]+\//, '').trim())
      .filter(Boolean)
      .filter((branch, index, self) => self.indexOf(branch) === index); // unique
  } catch {
    return [];
  }
}

/**
 * Get the default branch name from remote origin.
 *
 * @param requestUser - See {@link listLocalBranches}.
 */
export async function getDefaultBranch(
  cwd: string,
  requestUser?: string | null,
): Promise<string | null> {
  // Try symbolic-ref first
  const symbolicRef = await gitSafe(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd, requestUser);
  if (symbolicRef) {
    return symbolicRef.replace('refs/remotes/origin/', '');
  }

  // Fallback: check if main or master exists
  if (await gitRefExists('main', cwd, requestUser)) {
    return 'main';
  }
  if (await gitRefExists('master', cwd, requestUser)) {
    return 'master';
  }

  return null;
}

/**
 * Refresh the default branch reference from remote origin.
 * This updates the local refs/remotes/origin/HEAD to match the remote's default branch.
 *
 * The network call `git remote set-head origin -a` is the SSH-using git
 * invocation here. When `requestUser` is non-null, it runs via `runAsUser`
 * so it executes as that user — picking up their SSH_AUTH_SOCK from the
 * login shell (sudo -i) so git-over-SSH authenticates against
 * private remotes.
 *
 * @param requestUser - See {@link listLocalBranches}.
 * @returns The updated default branch name
 * @throws GitError if the command fails (e.g., network error, no remote)
 */
export async function refreshDefaultBranch(
  cwd: string,
  requestUser?: string | null,
): Promise<string> {
  // Update the remote HEAD reference
  await git(['remote', 'set-head', 'origin', '-a'], cwd, NETWORK_GIT_TIMEOUT_MS, requestUser);

  // Now get the updated default branch
  const defaultBranch = await getDefaultBranch(cwd, requestUser);
  if (!defaultBranch) {
    throw new GitError('Could not determine default branch after refresh', -1, 'No default branch found');
  }

  return defaultBranch;
}

/**
 * Rename a branch.
 *
 * @param requestUser - See {@link git}. Callers on a user-owned worktree
 *   (multi-user mode) must pass the SESSION'S SPAWN USER
 *   (`resolveSpawnUsername(session.createdBy)`) — NOT the requesting auth
 *   user — so a shared session's rename runs as the shared account, not
 *   the requester (#1622).
 */
export async function renameBranch(
  oldName: string,
  newName: string,
  cwd: string,
  requestUser?: string | null,
): Promise<void> {
  await git(['branch', '-m', oldName, newName], cwd, DEFAULT_GIT_TIMEOUT_MS, requestUser);
}

/**
 * List worktrees in porcelain format.
 */
export async function listWorktrees(cwd: string): Promise<string> {
  return git(['worktree', 'list', '--porcelain'], cwd);
}

/**
 * Runner abstraction for {@link removeWorktreeWithFallback}: `runGit`
 * dispatches a `git` argv (direct spawn or elevated) and reports exit via
 * the returned tuple; `rmRecursive` removes a directory tree force-style.
 */
export interface WorktreeRemovalRunner {
  runGit(args: string[]): Promise<{ exitCode: number; stderr: string; timedOut?: boolean }>;
  rmRecursive(path: string): Promise<void>;
}

/**
 * Shared orchestration for `git worktree remove` with force-fallback recovery.
 *
 * `--expire=now` on the fallback prune is required because the rm has just
 * deleted the worktree dir itself: git's default `gc.worktreePruneExpire`
 * is 3 months, so a plain `git worktree prune` would leave the freshly-stale
 * registry entry behind and a subsequent `worktree add` at the same path
 * could collide.
 *
 * The stale-worktree matcher is intentionally narrow — it never matches a
 * bare `.git` substring, which over-triggered destructive recovery on
 * `fatal: not a git repository ... .git`.
 */
export async function removeWorktreeWithFallback(
  worktreePath: string,
  runner: WorktreeRemovalRunner,
  options: { force: boolean },
): Promise<void> {
  const args = ['worktree', 'remove', worktreePath];
  if (options.force) {
    // --force twice removes unclean worktrees AND locked worktrees.
    args.push('--force', '--force');
  }

  const result = await runner.runGit(args);
  if (result.exitCode === 0 && !result.timedOut) return;

  const stderr = result.stderr;
  const isStaleWorktreeError =
    stderr.includes('is not a working tree') ||
    stderr.includes('cannot read .git file') ||
    stderr.includes('invalid gitfile format') ||
    stderr.includes("'.git' file");

  if (options.force && !result.timedOut && isStaleWorktreeError) {
    await runner.rmRecursive(worktreePath);
    await runner.runGit(['worktree', 'prune', '--expire=now']).catch(() => {});
    return;
  }

  throw new GitError(
    `git worktree remove failed: ${stderr.trim() || `exit code ${result.exitCode}`}`,
    result.exitCode,
    stderr,
  );
}

/**
 * Remove a worktree (server-process `Bun.spawn` runner over
 * {@link removeWorktreeWithFallback}). The elevated sibling is
 * `worktree-service.ts:invokeGitWorktreeRemove`.
 */
export async function removeWorktree(
  worktreePath: string,
  cwd: string,
  options?: { force?: boolean }
): Promise<void> {
  const runner: WorktreeRemovalRunner = {
    runGit: async (args) => {
      try {
        await git(args, cwd, HEAVY_GIT_TIMEOUT_MS);
        return { exitCode: 0, stderr: '', timedOut: false };
      } catch (error) {
        if (error instanceof GitError) {
          return { exitCode: error.exitCode, stderr: error.stderr, timedOut: false };
        }
        // ENOENT/ENOTDIR on the spawn itself (cwd vanished): surface as a
        // non-stale result so the helper falls through to its throw branch
        // on the remove call, or is silently swallowed on the prune call.
        const code = isErrnoException(error) ? error.code : undefined;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return { exitCode: -1, stderr: `spawn ${code}`, timedOut: false };
        }
        throw error;
      }
    },
    rmRecursive: async (target) => {
      const fs = await import('node:fs/promises');
      await fs.rm(target, { recursive: true, force: true });
    },
  };

  await removeWorktreeWithFallback(worktreePath, runner, {
    force: options?.force ?? false,
  });
}

// ============================================================
// Diff Operations
// ============================================================

/**
 * Get the merge-base commit of two refs, returning null on failure.
 *
 * @param requestUser - See {@link git}.
 */
export async function getMergeBaseSafe(
  ref1: string,
  ref2: string,
  cwd: string,
  requestUser?: string | null,
): Promise<string | null> {
  return gitSafe(['merge-base', ref1, ref2], cwd, requestUser);
}

/**
 * Get unified diff between a base ref and working directory (including staged and unstaged).
 * If targetRef is provided, compares base to that ref instead of working directory.
 *
 * @param requestUser - See {@link git}.
 *
 * @example
 * // Diff from merge-base to working directory
 * const diff = await getDiff(mergeBase, undefined, repoPath);
 *
 * // Diff between two commits
 * const diff = await getDiff(commit1, commit2, repoPath);
 */
export async function getDiff(
  baseRef: string,
  targetRef: string | undefined,
  cwd: string,
  requestUser?: string | null,
): Promise<string> {
  if (targetRef) {
    return gitRaw(['diff', baseRef, targetRef], cwd, DEFAULT_GIT_TIMEOUT_MS, requestUser);
  } else {
    // Diff from baseRef to working directory (staged + unstaged)
    return gitRaw(['diff', baseRef], cwd, DEFAULT_GIT_TIMEOUT_MS, requestUser);
  }
}

/**
 * Get diff statistics in numstat format (machine-readable).
 * Returns lines of: additions<TAB>deletions<TAB>filename
 * For binary files, returns "-<TAB>-<TAB>filename"
 *
 * @param requestUser - See {@link git}.
 *
 * @example
 * const stats = await getDiffNumstat(mergeBase, undefined, repoPath);
 * // "12\t5\tsrc/index.ts"
 * // "0\t3\tREADME.md"
 */
export async function getDiffNumstat(
  baseRef: string,
  targetRef: string | undefined,
  cwd: string,
  requestUser?: string | null,
): Promise<string> {
  if (targetRef) {
    return gitRaw(['diff', '--numstat', baseRef, targetRef], cwd, DEFAULT_GIT_TIMEOUT_MS, requestUser);
  } else {
    return gitRaw(['diff', '--numstat', baseRef], cwd, DEFAULT_GIT_TIMEOUT_MS, requestUser);
  }
}

/**
 * Get list of untracked files.
 *
 * @param requestUser - See {@link git}.
 */
export async function getUntrackedFiles(
  cwd: string,
  requestUser?: string | null,
): Promise<string[]> {
  try {
    const output = await git(['ls-files', '--others', '--exclude-standard'], cwd, DEFAULT_GIT_TIMEOUT_MS, requestUser);
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get summary of changes between base ref and working directory.
 * Includes both tracked (staged/unstaged) and untracked files.
 */
export interface DiffFileSummary {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked';
  oldPath?: string; // For renamed files
  additions: number;
  deletions: number;
  isBinary: boolean;
  isStaged: boolean;
  isUnstaged: boolean;
}

export interface DiffSummary {
  files: DiffFileSummary[];
  totalAdditions: number;
  totalDeletions: number;
}

/**
 * Parse git status output to understand staged/unstaged state.
 * Uses porcelain format for reliable parsing.
 *
 * IMPORTANT: porcelain output is returned UNTRIMMED. Every line carries the
 * staged / unstaged status in its leading two columns (e.g. ` M file.ts`),
 * and trimming the whole stdout silently strips the indexStatus from the
 * first line so `XY filename` regex parsing fails on it. Hence we route
 * through `gitExec` with `trimOutput: 'preserve'` rather than the standard
 * `git()` wrapper.
 *
 * @param requestUser - See {@link git}.
 */
export async function getStatusPorcelain(
  cwd: string,
  requestUser?: string | null,
): Promise<string> {
  return gitExec(['status', '--porcelain', '-uall'], cwd, DEFAULT_GIT_TIMEOUT_MS, 'preserve', requestUser);
}

// ============================================================
// Org/Repo Extraction
// ============================================================

/**
 * Extract org/repo from a git remote URL.
 *
 * @example
 * parseOrgRepo('git@github.com:owner/repo.git') // 'owner/repo'
 * parseOrgRepo('https://github.com/anthropics/claude-code.git') // 'anthropics/claude-code'
 */
export function parseOrgRepo(remoteUrl: string): string | null {
  // SSH format: git@github.com:org/repo.git
  const sshMatch = remoteUrl.match(/git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[1];
  }

  // HTTPS format: https://github.com/org/repo.git
  const httpsMatch = remoteUrl.match(/https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return httpsMatch[1];
  }

  return null;
}

/**
 * Get org/repo from a repository path by reading its remote URL.
 *
 * Distinct from {@link deriveRepositorySlug}, which serves a different
 * downstream contract on the same underlying remote-URL parse:
 *
 * - {@link getOrgRepoFromPath} returns `Promise<string | null>` with no
 *   fallback. Right for callers that need to *identify* whether a
 *   repository has a resolvable GitHub-shaped remote at all (`routes/
 *   sessions.ts`'s PR-link resolution, `services/inbound/
 *   resolve-targets.ts`'s webhook target matching) -- `null` is a real,
 *   meaningful answer they branch on.
 * - {@link deriveRepositorySlug} returns `Promise<string>`, is total
 *   (never throws), and always produces an *addressable* slug by falling
 *   back to a caller-supplied value. Right for callers deriving a
 *   filesystem path (worktree/template placement, session-data path
 *   resolution) where "no remote" must still resolve to *something*.
 */
export async function getOrgRepoFromPath(repoPath: string): Promise<string | null> {
  const remoteUrl = await getRemoteUrl(repoPath);
  if (!remoteUrl) {
    return null;
  }
  return parseOrgRepo(remoteUrl);
}

/**
 * Reduce a remote URL to a credential-safe diagnostic shape for logging.
 *
 * A remote URL can embed HTTP(S) credentials (`https://user:token@host/...`),
 * and this is used specifically on the branch that sees URLs which failed
 * to parse as `org/repo` -- the branch most likely to see an unusual or
 * malformed URL, which is also the shape most likely to carry embedded
 * userinfo. Never returns the raw value.
 *
 * When `remoteUrl` parses as a WHATWG URL, returns `protocol//hostname`
 * only -- `URL`'s `.protocol`/`.hostname` accessors are userinfo-free by
 * construction, so this is safe even when the input had a `user:pass@`
 * component. Falls back to a fixed marker for scp-style SSH shapes
 * (`git@host:org/repo`, not a valid WHATWG URL) or any other shape that
 * doesn't parse -- both carry no credential-leak risk either way, but a
 * fixed marker avoids guessing at ad-hoc redaction for a shape too
 * malformed to reason about structurally.
 *
 * @internal Exported for testing.
 */
export function describeRemoteUrlShapeForLogging(remoteUrl: string): string {
  try {
    const parsed = new URL(remoteUrl);
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return '<non-URL remote shape>';
  }
}

/**
 * Single writer for deriving a repository's canonical `org/repo` slug from
 * its remote (see `docs/design/session-data-path.md`).
 *
 * See {@link getOrgRepoFromPath}'s doc comment for why that sibling helper
 * is not redundant with this one — different downstream contract
 * (nullable, no fallback, remote-identification) on the same underlying
 * remote-URL parse.
 *
 * Total: never throws. Every branch that cannot produce a valid `org/repo`
 * value returns `fallback` instead:
 *   - no remote configured (the common case for local-only repositories)
 *   - a remote URL that does not match a recognized SSH/HTTPS shape
 *   - a parsed `org/repo` value that fails `isValidSlug` (traversal
 *     segments, disallowed characters)
 *   - any unexpected exception (defense-in-depth; `getRemoteUrl` already
 *     swallows git-command failures via `gitSafe`, so this branch is not
 *     currently reachable in production, but keeps the function total if
 *     that chain changes in the future)
 *
 * Totality is load-bearing: this function is called from inside session
 * creation (`SessionManager.createSession`), which has an existing
 * failure-rollback path. A never-throws helper means the call cannot
 * introduce a new rejection route there.
 *
 * A missing remote is expected/common and is not logged. An unparseable
 * remote URL or a slug-validation failure is surprising and logged at WARN.
 *
 * @param repoPath Absolute path to the repository's working tree.
 * @param fallback Value to return when no valid `org/repo` can be derived.
 *   Callers must pass `path.basename(repoPath)` — never a display name —
 *   so address derivation never depends on user-editable metadata.
 */
export async function deriveRepositorySlug(
  repoPath: string,
  fallback: string,
): Promise<string> {
  try {
    const remoteUrl = await getRemoteUrl(repoPath);
    if (!remoteUrl) {
      // No origin remote configured (or the underlying git command failed,
      // which getRemoteUrl/gitSafe already swallow) -- expected for
      // local-only repositories, not worth a warning.
      return fallback;
    }
    const orgRepo = parseOrgRepo(remoteUrl);
    if (!orgRepo) {
      logger.warn(
        { repoPath, remoteUrlShape: describeRemoteUrlShapeForLogging(remoteUrl) },
        'Remote URL did not match a parseable org/repo shape; using fallback slug',
      );
      return fallback;
    }
    if (!isValidSlug(orgRepo)) {
      logger.warn(
        { repoPath, orgRepo },
        'Derived org/repo slug failed validation; using fallback slug',
      );
      return fallback;
    }
    return orgRepo;
  } catch (err) {
    logger.warn({ err, repoPath }, 'Repository slug derivation threw unexpectedly; using fallback slug');
    return fallback;
  }
}

// ============================================================
// Commit Log Operations
// ============================================================

export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

// ============================================================
// Remote Operations
// ============================================================

/**
 * Check if a working directory is clean (no uncommitted changes).
 * Uses `git status --porcelain` which outputs nothing when clean.
 */
export async function isWorkingDirectoryClean(cwd: string): Promise<boolean> {
  const output = await git(['status', '--porcelain'], cwd);
  return output === '';
}

/**
 * Pull with fast-forward only strategy.
 * Returns the number of commits pulled (0 if already up to date).
 *
 * @param requestUser - See {@link git}.
 * @throws GitError if pull fails (e.g., branches have diverged, no remote tracking branch)
 */
export async function pullFastForward(
  cwd: string,
  requestUser?: string | null,
): Promise<number> {
  // Get the current HEAD before pulling
  const headBefore = await git(['rev-parse', 'HEAD'], cwd, undefined, requestUser);

  // Execute git pull --ff-only
  await git(['pull', '--ff-only'], cwd, NETWORK_GIT_TIMEOUT_MS, requestUser);

  // Get the HEAD after pulling
  const headAfter = await git(['rev-parse', 'HEAD'], cwd, undefined, requestUser);

  // If HEAD didn't change, already up to date
  if (headBefore === headAfter) {
    return 0;
  }

  // Count commits between old and new HEAD
  const countStr = await git(
    ['rev-list', '--count', `${headBefore}..${headAfter}`],
    cwd,
    undefined,
    requestUser,
  );
  const commitsPulled = Number.parseInt(countStr, 10);
  if (Number.isNaN(commitsPulled)) {
    throw new GitError(`Invalid commit count from git rev-list: "${countStr}"`, -1, countStr);
  }
  return commitsPulled;
}

/**
 * Fetch a specific branch from remote origin.
 *
 * @param requestUser - See {@link git}.
 */
export async function fetchRemote(
  branch: string,
  cwd: string,
  requestUser?: string | null,
): Promise<void> {
  await git(['fetch', 'origin', branch], cwd, NETWORK_GIT_TIMEOUT_MS, requestUser);
}

/**
 * Fetch all branches from remote origin.
 *
 * @param requestUser - See {@link git}.
 */
export async function fetchAllRemote(
  cwd: string,
  requestUser?: string | null,
): Promise<void> {
  await git(['fetch', 'origin'], cwd, NETWORK_GIT_TIMEOUT_MS, requestUser);
}

/**
 * Where a repository's git directory is, and whether the repository is bare.
 * SINGLE WRITER of "where is the git directory": callers that used to build
 * `path.join(repoPath, '.git')` (which does not exist for a bare repository,
 * whose git directory IS the repository root) ask this instead.
 *
 * - `git rev-parse --git-common-dir` (resolved against `repoPath`): the
 *   `.git` of a non-bare repo, the repo root of a bare one. The common dir,
 *   not `--git-dir`, so a linked worktree resolves to the repository it
 *   belongs to.
 * - Bareness is asked of the COMMON dir (`git --git-dir <common-dir> rev-parse
 *   --is-bare-repository`), never the cwd: inside a linked worktree of a bare
 *   repository the cwd form prints `false`.
 *
 * - The bareness probe names the directory with an explicit `--git-dir` instead
 *   of running git from inside it (`-C <common-dir>`). Git's ownership check
 *   ("dubious ownership") lives in repository DISCOVERY and is keyed on the
 *   discovered path, which for a non-bare repository is `<repo>/.git`; a
 *   `safe.directory` entry for `<repo>` never covers that path, so a repository
 *   owned by another OS user was reported as "not a git repository". An explicit
 *   `--git-dir` skips discovery, and with it the check.
 *
 * Returns `null` when `repoPath` is not a git repository (either probe fails).
 *
 */
export async function resolveGitDir(
  repoPath: string,
): Promise<{ gitDir: string; bare: boolean } | null> {
  const abs = path.resolve(repoPath);

  const common = await gitSafe(['rev-parse', '--git-common-dir'], abs);
  if (common === null || common === '') return null;
  const gitDir = path.resolve(abs, common);

  const bare = await gitSafe(['--git-dir', gitDir, 'rev-parse', '--is-bare-repository'], abs);
  if (bare === null) return null;
  return { gitDir, bare: bare === 'true' };
}

/**
 * Whether `dir` IS the root of a bare repository (its git directory), as
 * opposed to a linked worktree of one.
 *
 * `resolveGitDir` reports the COMMON dir's bareness, so inside a linked
 * worktree of a bare repository it says `bare: true` with `gitDir` = the bare
 * repository. A bare-only check would therefore wrongly include those
 * worktrees; the equality of the git directory with `dir` is what separates the
 * bare root (nothing to run in) from a worktree (a normal place for a session).
 */
export async function isBareRepositoryRoot(dir: string): Promise<boolean> {
  const resolved = await resolveGitDir(dir);
  return resolved !== null && resolved.bare && (await canonicalPath(resolved.gitDir)) === (await canonicalPath(dir));
}

/**
 * Whether a repository's `origin` carries the fetch refspec the ref-only
 * helpers (`listRemoteBranches`, `refreshDefaultBranch`, `getCommitsBehind` ...)
 * rely on. READ-ONLY: it never writes into the repository.
 *
 * `git clone --bare` writes no `remote.origin.fetch` and no
 * `refs/remotes/origin/*`, so on a bare clone `branch -r` is empty and `remote
 * set-head origin -a` fails with "Not a valid ref". A non-bare clone always has
 * the refspec.
 *
 * - No `remote.origin.url`: nothing to track -> `'no-remote'`.
 * - `remote.origin.fetch` set -> `'present'`.
 * - URL set, refspec absent -> `'missing'`.
 */
export async function assertOriginFetchRefspec(
  repoPath: string,
): Promise<'no-remote' | 'present' | 'missing'> {
  const url = await gitSafe(['config', '--get', 'remote.origin.url'], repoPath);
  if (url === null || url === '') return 'no-remote';
  const existing = await gitSafe(['config', '--get', 'remote.origin.fetch'], repoPath);
  return existing !== null && existing !== '' ? 'present' : 'missing';
}

/**
 * The ref source files are read from when a repository has no working tree to
 * read (`readRepoFileAtRef` / `exportRepoTreeAtRef`).
 *
 * On a bare clone `fetch origin` updates `refs/remotes/origin/*` only; the
 * local `refs/heads/<default>` stays at the commit the clone was made at. So
 * the fresh tip is `origin/<default>`, and that ref only exists once the fetch
 * refspec is configured. Without it the only ref that exists is `HEAD`.
 */
export async function resolveSourceReadRef(repoPath: string): Promise<string> {
  if ((await assertOriginFetchRefspec(repoPath)) !== 'present') return 'HEAD';
  const defaultBranch = await getDefaultBranch(repoPath);
  return `origin/${defaultBranch ?? 'HEAD'}`;
}

/**
 * Read one file's content from the object store at `ref`, without a working
 * tree. Returns `null` when the path (or the ref) does not exist. The content
 * is trimmed like every other `git()` result.
 *
 * @throws GitError when the path exists but `git show` fails.
 */
export async function readRepoFileAtRef(
  repoPath: string,
  ref: string,
  relPath: string,
): Promise<string | null> {
  const object = `${ref}:${relPath}`;
  if ((await gitSafe(['cat-file', '-e', object], repoPath)) === null) return null;
  return git(['show', object], repoPath);
}

/** Exit code the elevated directory probe in `readWorkingTreeFile` uses to say "this is a directory". */
const WORKING_TREE_DIR_EXIT_CODE = 42;

/**
 * Read one file from a working tree, as the session owner when `requestUser`
 * is set. A user worktree can be mode 0700 for another OS user in multi-user
 * mode, so the server process cannot read it directly.
 *
 * Direct path (`requestUser` null/empty): `stat` + `readFile` in-process.
 * Elevated path: `cat` through the same `_runAsUser` seam `gitExec` uses;
 * `runAsUser` itself bypasses elevation when the user is the server user or
 * AUTH_MODE is not multi-user. A directory is signalled by the exit code, never
 * by stdout: stdout carries the file's bytes, so any stdout marker would
 * misclassify a regular file whose content equals the marker.
 *
 * Accepted limitation: `runAsUser` returns stdout as a UTF-8 string, so on the
 * elevated path invalid byte sequences come back as U+FFFD. NUL bytes survive,
 * so `isBinaryContent` still classifies binaries, and no caller renders binary
 * content.
 *
 * @returns the file content, `{ kind: 'directory' }` for a directory, or `null`
 *   when the path does not exist.
 * @throws GitError when the elevated read fails for any other reason.
 */
export async function readWorkingTreeFile(
  cwd: string,
  relPath: string,
  requestUser?: string | null,
): Promise<{ kind: 'file'; content: Buffer } | { kind: 'directory' } | null> {
  if (requestUser != null && requestUser.length > 0) {
    const escaped = shellEscape(relPath);
    const command = `test -d ${escaped} && exit ${WORKING_TREE_DIR_EXIT_CODE}; cat -- ${escaped}`;
    let result: RunAsUserResult;
    try {
      result = await _runAsUser({
        username: requestUser,
        command,
        cwd,
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new GitError(`read ${relPath} failed: ${message}`, -1, message);
    }
    if (result.timedOut) {
      throw new GitError(
        `read ${relPath} timed out after ${DEFAULT_GIT_TIMEOUT_MS}ms`,
        result.exitCode,
        'Timeout'
      );
    }
    if (result.exitCode === WORKING_TREE_DIR_EXIT_CODE) return { kind: 'directory' };
    if (result.exitCode !== 0) {
      if (/No such file/.test(result.stderr)) return null;
      throw new GitError(
        `read ${relPath} failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`,
        result.exitCode,
        result.stderr
      );
    }
    return { kind: 'file', content: Buffer.from(result.stdout, 'utf-8') };
  }

  const fullPath = path.join(cwd, relPath);
  try {
    if ((await stat(fullPath)).isDirectory()) return { kind: 'directory' };
    return { kind: 'file', content: await readFile(fullPath) };
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Largest `git archive` output `exportRepoTreeAtRef` accepts. Templates are
 * kilobytes; the cap keeps a repository that pushes a huge tree under the
 * template path from being buffered whole into the server's memory.
 */
export const MAX_TEMPLATE_ARCHIVE_BYTES = 16 * 1024 * 1024;

/**
 * Export the tree at `relPath` of `ref` into `destDir` (which must exist), as
 * `git archive` piped into `tar -x` through an in-memory buffer: two separate
 * spawns, no shell, both exit codes checked. Returns `<destDir>/<relPath>`, or
 * `null` when `relPath` does not exist at `ref`.
 *
 * The archive is read chunk by chunk and `git archive` is killed as soon as the
 * running total passes `opts.maxBytes` (default `MAX_TEMPLATE_ARCHIVE_BYTES`).
 *
 * @throws GitError for any other failure of either process (including an
 *   unresolvable `ref` and an archive over the byte cap).
 */
export async function exportRepoTreeAtRef(
  repoPath: string,
  ref: string,
  relPath: string,
  destDir: string,
  opts: { maxBytes?: number } = {},
): Promise<string | null> {
  const maxBytes = opts.maxBytes ?? MAX_TEMPLATE_ARCHIVE_BYTES;
  const archive = Bun.spawn(['git', 'archive', '--format=tar', ref, '--', relPath], {
    cwd: repoPath,
    // The "absent path" verdict below is read from git's stderr text.
    env: { ...process.env, LC_ALL: 'C' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const killArchive = () => {
    try {
      archive.kill();
    } catch {
      // Process may have already exited.
    }
  };
  const readCapped = async (): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = archive.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        killArchive();
        throw new GitError(`git archive output exceeds ${maxBytes} bytes`, -1, 'ArchiveTooLarge');
      }
      chunks.push(value);
    }
    const all = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return all;
  };
  const [tarBytes, archiveStderr, archiveExit] = await raceWithTimeout(
    Promise.all([readCapped(), new Response(archive.stderr).text(), archive.exited]),
    DEFAULT_GIT_TIMEOUT_MS,
    () => {
      killArchive();
      return new GitError(`git archive timed out after ${DEFAULT_GIT_TIMEOUT_MS}ms`, -1, 'Timeout');
    },
  );
  if (archiveExit !== 0) {
    if (archiveStderr.includes('did not match any files')) return null;
    throw new GitError(
      `git archive failed: ${archiveStderr.trim() || `exit code ${archiveExit}`}`,
      archiveExit,
      archiveStderr,
    );
  }

  const extract = Bun.spawn(['tar', '-x', '-C', destDir], {
    stdin: tarBytes,
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const [extractStderr, extractExit] = await raceWithTimeout(
    Promise.all([new Response(extract.stderr).text(), extract.exited]),
    DEFAULT_GIT_TIMEOUT_MS,
    () => {
      try {
        extract.kill();
      } catch {
        // Process may have already exited.
      }
      return new GitError(`tar extract timed out after ${DEFAULT_GIT_TIMEOUT_MS}ms`, -1, 'Timeout');
    },
  );
  if (extractExit !== 0) {
    throw new GitError(
      `tar extract failed: ${extractStderr.trim() || `exit code ${extractExit}`}`,
      extractExit,
      extractStderr,
    );
  }
  return path.join(destDir, relPath);
}

/**
 * Get how many commits the local branch is behind the remote branch.
 * Returns 0 if up to date, positive number if behind.
 */
export async function getCommitsBehind(branch: string, cwd: string): Promise<number> {
  try {
    // Count commits in origin/branch that are not in local branch
    const output = await git(['rev-list', '--count', `${branch}..origin/${branch}`], cwd);
    return parseInt(output, 10);
  } catch {
    return 0; // If the comparison fails, assume up to date
  }
}

/**
 * Get how many commits the local branch is ahead of the remote branch.
 */
export async function getCommitsAhead(branch: string, cwd: string): Promise<number> {
  try {
    // Count commits in local branch that are not in origin/branch
    const output = await git(['rev-list', '--count', `origin/${branch}..${branch}`], cwd);
    return parseInt(output, 10);
  } catch {
    return 0;
  }
}

// ============================================================
// Commit Log Operations
// ============================================================

/**
 * Get commits between a base ref and HEAD (commits created in this branch).
 * Uses `git log <baseRef>..HEAD` to get commits that are in HEAD but not in baseRef.
 *
 * @example
 * const commits = await getBranchCommits('main', repoPath);
 */
export async function getBranchCommits(baseRef: string, cwd: string): Promise<CommitInfo[]> {
  try {
    // Format: hash|shortHash|message|author|date
    const format = '%H|%h|%s|%an|%ai';
    const output = await git(['log', `${baseRef}..HEAD`, `--format=${format}`], cwd);

    if (!output) {
      return [];
    }

    return output.split('\n').filter(Boolean).map((line) => {
      const [hash, shortHash, message, author, date] = line.split('|');
      return { hash, shortHash, message, author, date };
    });
  } catch {
    return [];
  }
}
