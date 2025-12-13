/**
 * Git utilities using Bun.spawn for async, shell-free execution.
 *
 * Benefits over child_process.execSync/exec:
 * - No shell injection vulnerabilities (args passed as array, not string)
 * - Consistent async API
 * - Non-blocking I/O
 */

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
 * Execute a git command asynchronously.
 *
 * @param args - Git command arguments (without 'git' prefix)
 * @param cwd - Working directory for the command
 * @returns The stdout output trimmed
 * @throws GitError if the command fails
 *
 * @example
 * const branch = await git(['branch', '--show-current'], repoPath);
 * const remoteUrl = await git(['remote', 'get-url', 'origin'], repoPath);
 */
export async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;

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
