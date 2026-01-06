/**
 * Git utilities using Bun.spawn for async, shell-free execution.
 *
 * Benefits over child_process.execSync/exec:
 * - No shell injection vulnerabilities (args passed as array, not string)
 * - Consistent async API
 * - Non-blocking I/O
 */

/** Default timeout for git operations (30 seconds) */
const DEFAULT_GIT_TIMEOUT_MS = 30000;

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

/**
 * Create a timeout promise that rejects after the specified time.
 * Also returns a cleanup function to prevent timer leaks.
 */
function createTimeoutPromise(timeoutMs: number, command: string): { promise: Promise<never>; cleanup: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const promise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new GitError(`git ${command} timed out after ${timeoutMs}ms`, -1, 'Timeout'));
    }, timeoutMs);
  });

  const cleanup = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  };

  return { promise, cleanup };
}

/**
 * Execute a git command asynchronously with timeout protection.
 *
 * @param args - Git command arguments (without 'git' prefix)
 * @param cwd - Working directory for the command
 * @param timeoutMs - Timeout in milliseconds (default: 30000ms)
 * @returns The stdout output trimmed
 * @throws GitError if the command fails or times out
 *
 * @example
 * const branch = await git(['branch', '--show-current'], repoPath);
 * const remoteUrl = await git(['remote', 'get-url', 'origin'], repoPath);
 */
export async function git(args: string[], cwd: string, timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const { promise: timeoutPromise, cleanup: cleanupTimeout } = createTimeoutPromise(timeoutMs, args[0] || 'unknown');

  try {
    // Race between process exit and timeout
    const exitCode = await Promise.race([proc.exited, timeoutPromise]);

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new GitError(
        `git ${args[0]} failed: ${stderr.trim() || `exit code ${exitCode}`}`,
        exitCode,
        stderr
      );
    }

    const stdout = await new Response(proc.stdout).text();
    return stdout.trim();
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
  } finally {
    cleanupTimeout();
  }
}

/**
 * Execute a git command, returning null on failure instead of throwing.
 * Useful for commands where failure is expected (e.g., checking if a branch exists).
 */
export async function gitSafe(args: string[], cwd: string): Promise<string | null> {
  try {
    return await git(args, cwd);
  } catch {
    return null;
  }
}

/**
 * Check if a git ref exists.
 */
export async function gitRefExists(ref: string, cwd: string): Promise<boolean> {
  const result = await gitSafe(['rev-parse', '--verify', ref], cwd);
  return result !== null;
}

// ============================================================
// High-level Git Operations
// ============================================================

/**
 * Get current branch name.
 */
export async function getCurrentBranch(cwd: string): Promise<string> {
  try {
    const branch = await git(['branch', '--show-current'], cwd);
    return branch || '(detached)';
  } catch {
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
 */
export async function listLocalBranches(cwd: string): Promise<string[]> {
  try {
    const output = await git(['branch', '--format=%(refname:short)'], cwd);
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * List remote branches.
 */
export async function listRemoteBranches(cwd: string): Promise<string[]> {
  try {
    const output = await git(['branch', '-r', '--format=%(refname:short)'], cwd);
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
 */
export async function getDefaultBranch(cwd: string): Promise<string | null> {
  // Try symbolic-ref first
  const symbolicRef = await gitSafe(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd);
  if (symbolicRef) {
    return symbolicRef.replace('refs/remotes/origin/', '');
  }

  // Fallback: check if main or master exists
  if (await gitRefExists('main', cwd)) {
    return 'main';
  }
  if (await gitRefExists('master', cwd)) {
    return 'master';
  }

  return null;
}

/**
 * Refresh the default branch reference from remote origin.
 * This updates the local refs/remotes/origin/HEAD to match the remote's default branch.
 *
 * @returns The updated default branch name
 * @throws GitError if the command fails (e.g., network error, no remote)
 */
export async function refreshDefaultBranch(cwd: string): Promise<string> {
  // Update the remote HEAD reference
  await git(['remote', 'set-head', 'origin', '-a'], cwd);

  // Now get the updated default branch
  const defaultBranch = await getDefaultBranch(cwd);
  if (!defaultBranch) {
    throw new GitError('Could not determine default branch after refresh', -1, 'No default branch found');
  }

  return defaultBranch;
}

/**
 * Rename a branch.
 */
export async function renameBranch(oldName: string, newName: string, cwd: string): Promise<void> {
  await git(['branch', '-m', oldName, newName], cwd);
}

/**
 * List worktrees in porcelain format.
 */
export async function listWorktrees(cwd: string): Promise<string> {
  return git(['worktree', 'list', '--porcelain'], cwd);
}

/**
 * Create a new worktree.
 */
export async function createWorktree(
  worktreePath: string,
  branch: string,
  cwd: string,
  options?: { baseBranch?: string }
): Promise<void> {
  const args = ['worktree', 'add'];

  if (options?.baseBranch) {
    // Create new branch from baseBranch
    args.push('-b', branch, worktreePath, options.baseBranch);
  } else {
    // Use existing branch
    args.push(worktreePath, branch);
  }

  await git(args, cwd);
}

/**
 * Remove a worktree.
 */
export async function removeWorktree(
  worktreePath: string,
  cwd: string,
  options?: { force?: boolean }
): Promise<void> {
  const args = ['worktree', 'remove', worktreePath];

  if (options?.force) {
    args.push('--force');
  }

  await git(args, cwd);
}

// ============================================================
// Diff Operations
// ============================================================

/**
 * Get the merge-base commit of two refs (their common ancestor).
 * Useful for finding where a branch diverged from the base branch.
 *
 * @example
 * const mergeBase = await getMergeBase('main', 'HEAD', repoPath);
 */
export async function getMergeBase(ref1: string, ref2: string, cwd: string): Promise<string> {
  return git(['merge-base', ref1, ref2], cwd);
}

/**
 * Get the merge-base commit of two refs, returning null on failure.
 */
export async function getMergeBaseSafe(ref1: string, ref2: string, cwd: string): Promise<string | null> {
  return gitSafe(['merge-base', ref1, ref2], cwd);
}

/**
 * Get unified diff between a base ref and working directory (including staged and unstaged).
 * If targetRef is provided, compares base to that ref instead of working directory.
 *
 * @example
 * // Diff from merge-base to working directory
 * const diff = await getDiff(mergeBase, undefined, repoPath);
 *
 * // Diff between two commits
 * const diff = await getDiff(commit1, commit2, repoPath);
 */
export async function getDiff(baseRef: string, targetRef: string | undefined, cwd: string): Promise<string> {
  if (targetRef) {
    return git(['diff', baseRef, targetRef], cwd);
  } else {
    // Diff from baseRef to working directory (staged + unstaged)
    return git(['diff', baseRef], cwd);
  }
}

/**
 * Get diff statistics in numstat format (machine-readable).
 * Returns lines of: additions<TAB>deletions<TAB>filename
 * For binary files, returns "-<TAB>-<TAB>filename"
 *
 * @example
 * const stats = await getDiffNumstat(mergeBase, undefined, repoPath);
 * // "12\t5\tsrc/index.ts"
 * // "0\t3\tREADME.md"
 */
export async function getDiffNumstat(baseRef: string, targetRef: string | undefined, cwd: string): Promise<string> {
  if (targetRef) {
    return git(['diff', '--numstat', baseRef, targetRef], cwd);
  } else {
    return git(['diff', '--numstat', baseRef], cwd);
  }
}

/**
 * Get list of staged files with their status.
 * Returns lines of: status<TAB>filename (e.g., "M\tsrc/index.ts")
 *
 * Status codes: A=added, M=modified, D=deleted, R=renamed, C=copied
 */
export async function getStagedFiles(cwd: string): Promise<string> {
  return git(['diff', '--cached', '--name-status'], cwd);
}

/**
 * Get list of unstaged files (modified tracked files).
 * Returns lines of: status<TAB>filename
 */
export async function getUnstagedFiles(cwd: string): Promise<string> {
  return git(['diff', '--name-status'], cwd);
}

/**
 * Get list of untracked files.
 */
export async function getUntrackedFiles(cwd: string): Promise<string[]> {
  try {
    const output = await git(['ls-files', '--others', '--exclude-standard'], cwd);
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
 */
export async function getStatusPorcelain(cwd: string): Promise<string> {
  return git(['status', '--porcelain', '-uall'], cwd);
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
 */
export async function getOrgRepoFromPath(repoPath: string): Promise<string | null> {
  const remoteUrl = await getRemoteUrl(repoPath);
  if (!remoteUrl) {
    return null;
  }
  return parseOrgRepo(remoteUrl);
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
 * Fetch a specific branch from remote origin.
 */
export async function fetchRemote(branch: string, cwd: string): Promise<void> {
  await git(['fetch', 'origin', branch], cwd);
}

/**
 * Fetch all branches from remote origin.
 */
export async function fetchAllRemote(cwd: string): Promise<void> {
  await git(['fetch', 'origin'], cwd);
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
