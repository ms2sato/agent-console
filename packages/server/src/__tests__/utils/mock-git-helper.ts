/**
 * Centralized git module mock for tests.
 *
 * IMPORTANT: Import this module in test files that need git mocking.
 * The mock.module call is executed once when this module is imported.
 *
 * @example
 * ```typescript
 * import { mockGit, GitError } from '../../__tests__/utils/mock-git-helper.js';
 *
 * beforeEach(() => {
 *   mockGit.listWorktrees.mockReset();
 *   mockGit.listWorktrees.mockImplementation(() => Promise.resolve('...'));
 * });
 * ```
 */
import { mock, type Mock } from 'bun:test';
import { existsSync } from 'fs';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';

// Import and re-export the real GitError class from the git module.
// This ensures instanceof checks work correctly in tests, because both the test code
// and the mocked module use the same GitError class.
import { GitError } from '../../lib/git.js';
export { GitError };

// Type definitions for mock functions.
//
// Issue #869 / #870: Many lib/git.ts helpers now accept an optional trailing
// `requestUser` argument so callers can route the invocation through
// `runAsUser` for multi-user mode. The mock signatures mirror that shape so
// `toHaveBeenCalledWith(..., 'someuser')` assertions in tests type-check.
type AsyncStringFn = (cwd: string, requestUser?: string | null) => Promise<string>;
type AsyncStringNullFn = (cwd: string, requestUser?: string | null) => Promise<string | null>;
type AsyncStringArrayFn = (cwd: string, requestUser?: string | null) => Promise<string[]>;

type GitFn = (args: string[], cwd: string, timeoutMs?: number, requestUser?: string | null) => Promise<string>;

// Default stdout for the low-level `git(args, ...)` mock. Empty for every verb
// except `rev-list --all --count`, whose caller (`ensureRepoHasCommits`)
// parses an integer: the default reports one reachable commit so a test that
// does not care about the empty-repo pre-check sees a non-empty repo.
const defaultGitStdout: GitFn = (args) =>
  Promise.resolve(args.join(' ') === 'rev-list --all --count' ? '1\n' : '');

async function defaultResolveGitDir(repoPath: string): Promise<{ gitDir: string; bare: boolean } | null> {
  return existsSync(join(repoPath, '.git')) ? { gitDir: join(repoPath, '.git'), bare: false } : null;
}

type WorkingTreeRead =
  | { kind: 'file'; content: Buffer; size?: number }
  | { kind: 'directory' }
  | { kind: 'not-regular' }
  | null;
type WorkingTreeReadOptions = { regularOnly?: boolean; maxBytes?: number };

// Default for `readWorkingTreeFile`: read the real file from disk so tests that
// write temp files and call through the service keep exercising real content.
// Honors the same options as the real function (a regular-file check, and a
// bounded read that also reports the total size), so a caller that passes them
// sees the shape it expects.
async function defaultReadWorkingTreeFile(
  cwd: string,
  relPath: string,
  _requestUser?: string | null,
  opts: WorkingTreeReadOptions = {},
): Promise<WorkingTreeRead> {
  const fullPath = join(cwd, relPath);
  try {
    const stats = await stat(fullPath);
    if (stats.isDirectory()) return { kind: 'directory' };
    if (opts.regularOnly && !stats.isFile()) return { kind: 'not-regular' };
    const content = await readFile(fullPath);
    if (opts.maxBytes === undefined) return { kind: 'file', content };
    return { kind: 'file', content: content.subarray(0, opts.maxBytes), size: content.length };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// Exported mock functions - configure these in beforeEach
export const mockGit = {
  // Low-level
  git: mock(defaultGitStdout) as Mock<GitFn>,
  gitRaw: mock(() => Promise.resolve('')) as Mock<GitFn>,
  gitSafe: mock(() => Promise.resolve(null)) as Mock<(args: string[], cwd: string, requestUser?: string | null) => Promise<string | null>>,
  gitRefExists: mock(() => Promise.resolve(false)) as Mock<(ref: string, cwd: string, requestUser?: string | null) => Promise<boolean>>,

  // Branch operations
  getCurrentBranch: mock(() => Promise.resolve('main')) as Mock<AsyncStringFn>,
  listLocalBranches: mock(() => Promise.resolve(['main'])) as Mock<AsyncStringArrayFn>,
  listRemoteBranches: mock(() => Promise.resolve(['origin/main'])) as Mock<AsyncStringArrayFn>,
  listAllBranches: mock(() => Promise.resolve(['main'])) as Mock<AsyncStringArrayFn>,
  getDefaultBranch: mock(() => Promise.resolve('main')) as Mock<AsyncStringNullFn>,
  refreshDefaultBranch: mock(() => Promise.resolve('main')) as Mock<AsyncStringFn>,
  renameBranch: mock(() => Promise.resolve()) as Mock<(oldName: string, newName: string, cwd: string, requestUser?: string | null) => Promise<void>>,

  // Remote operations
  getRemoteUrl: mock(() => Promise.resolve('git@github.com:owner/repo.git')) as Mock<AsyncStringNullFn>,

  // Worktree operations
  listWorktrees: mock(() => Promise.resolve('')) as Mock<AsyncStringFn>,
  removeWorktree: mock(() => Promise.resolve()) as Mock<(worktreePath: string, cwd: string, options?: { force?: boolean }) => Promise<void>>,

  // Org/Repo extraction (sync functions)
  parseOrgRepo: mock((remoteUrl: string) => {
    const sshMatch = remoteUrl.match(/git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];
    const httpsMatch = remoteUrl.match(/https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];
    return null;
  }) as Mock<(remoteUrl: string) => string | null>,
  getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')) as Mock<AsyncStringNullFn>,
  deriveRepositorySlug: mock(() => Promise.resolve('owner/repo')) as Mock<
    (repoPath: string, fallback: string) => Promise<string>
  >,

  // Git directory resolution (registerRepository). The default mirrors the
  // pre-resolveGitDir check, `<path>/.git` exists, so a test that sets up a
  // repo as a directory containing `.git` (memfs) registers as before; a bare
  // repository is a per-test override: `mockResolvedValueOnce({ gitDir, bare: true })`.
  resolveGitDir: mock(defaultResolveGitDir) as Mock<typeof defaultResolveGitDir>,
  // True only for the root of a bare repository (a linked worktree of one is
  // false); a per-test override decides which paths are bare roots.
  isBareRepositoryRoot: mock(() => Promise.resolve(false)) as Mock<(dir: string) => Promise<boolean>>,
  assertOriginFetchRefspec: mock(() => Promise.resolve('present' as const)) as Mock<
    (repoPath: string) => Promise<'no-remote' | 'present' | 'missing'>
  >,

  // Object-store reads (bare repositories have no working tree to read)
  resolveSourceReadRef: mock(() => Promise.resolve('HEAD')) as Mock<(repoPath: string) => Promise<string>>,
  readRepoFileAtRef: mock(() => Promise.resolve(null)) as Mock<
    (repoPath: string, ref: string, relPath: string) => Promise<string | null>
  >,
  exportRepoTreeAtRef: mock(() => Promise.resolve(null)) as Mock<
    (repoPath: string, ref: string, relPath: string, destDir: string) => Promise<string | null>
  >,

  // Working-tree reads (as the session owner when requestUser is set)
  readWorkingTreeFile: mock(defaultReadWorkingTreeFile) as Mock<
    (cwd: string, relPath: string, requestUser?: string | null, opts?: WorkingTreeReadOptions) => Promise<WorkingTreeRead>
  >,

  // Remote fetch operations
  fetchRemote: mock(() => Promise.resolve()) as Mock<
    (branch: string, cwd: string, requestUser?: string | null) => Promise<void>
  >,
  fetchAllRemote: mock(() => Promise.resolve()) as Mock<
    (cwd: string, requestUser?: string | null) => Promise<void>
  >,
  getCommitsBehind: mock(() => Promise.resolve(0)) as Mock<(branch: string, cwd: string) => Promise<number>>,
  getCommitsAhead: mock(() => Promise.resolve(0)) as Mock<(branch: string, cwd: string) => Promise<number>>,

  // Working directory operations
  isWorkingDirectoryClean: mock(() => Promise.resolve(true)) as Mock<(cwd: string) => Promise<boolean>>,
  pullFastForward: mock(() => Promise.resolve(0)) as Mock<
    (cwd: string, requestUser?: string | null) => Promise<number>
  >,

  // Diff operations
  getMergeBaseSafe: mock(() => Promise.resolve('abc1234')) as Mock<(ref1: string, ref2: string, cwd: string, requestUser?: string | null) => Promise<string | null>>,
  getDiff: mock(() => Promise.resolve('')) as Mock<(baseRef: string, targetRef: string | undefined, cwd: string, requestUser?: string | null) => Promise<string>>,
  getDiffNumstat: mock(() => Promise.resolve('')) as Mock<(baseRef: string, targetRef: string | undefined, cwd: string, requestUser?: string | null) => Promise<string>>,
  getUntrackedFiles: mock(() => Promise.resolve([])) as Mock<AsyncStringArrayFn>,
  getStatusPorcelain: mock(() => Promise.resolve('')) as Mock<AsyncStringFn>,
};

// Register mock once at module load time
mock.module('../../lib/git.js', () => ({
  ...mockGit,
  GitError,
}));

/**
 * Reset all git mocks to default implementations.
 * Call this in beforeEach for clean test state.
 */
export function resetGitMocks(): void {
  mockGit.git.mockReset();
  mockGit.gitRaw.mockReset();
  mockGit.gitSafe.mockReset();
  mockGit.gitRefExists.mockReset();
  mockGit.getCurrentBranch.mockReset();
  mockGit.listLocalBranches.mockReset();
  mockGit.listRemoteBranches.mockReset();
  mockGit.listAllBranches.mockReset();
  mockGit.getDefaultBranch.mockReset();
  mockGit.refreshDefaultBranch.mockReset();
  mockGit.renameBranch.mockReset();
  mockGit.getRemoteUrl.mockReset();
  mockGit.listWorktrees.mockReset();
  mockGit.removeWorktree.mockReset();
  mockGit.parseOrgRepo.mockReset();
  mockGit.getOrgRepoFromPath.mockReset();
  mockGit.deriveRepositorySlug.mockReset();
  mockGit.resolveGitDir.mockReset();
  mockGit.isBareRepositoryRoot.mockReset();
  mockGit.assertOriginFetchRefspec.mockReset();
  mockGit.resolveSourceReadRef.mockReset();
  mockGit.readRepoFileAtRef.mockReset();
  mockGit.exportRepoTreeAtRef.mockReset();
  mockGit.readWorkingTreeFile.mockReset();
  mockGit.fetchRemote.mockReset();
  mockGit.fetchAllRemote.mockReset();
  mockGit.getCommitsBehind.mockReset();
  mockGit.getCommitsAhead.mockReset();
  mockGit.isWorkingDirectoryClean.mockReset();
  mockGit.pullFastForward.mockReset();
  mockGit.getMergeBaseSafe.mockReset();
  mockGit.getDiff.mockReset();
  mockGit.getDiffNumstat.mockReset();
  mockGit.getUntrackedFiles.mockReset();
  mockGit.getStatusPorcelain.mockReset();

  // Set default implementations
  mockGit.git.mockImplementation(defaultGitStdout);
  mockGit.gitRaw.mockImplementation(() => Promise.resolve(''));
  mockGit.gitSafe.mockImplementation(() => Promise.resolve(null));
  mockGit.gitRefExists.mockImplementation(() => Promise.resolve(false));
  mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('main'));
  mockGit.listLocalBranches.mockImplementation(() => Promise.resolve(['main']));
  mockGit.listRemoteBranches.mockImplementation(() => Promise.resolve(['origin/main']));
  mockGit.listAllBranches.mockImplementation(() => Promise.resolve(['main']));
  mockGit.getDefaultBranch.mockImplementation(() => Promise.resolve('main'));
  mockGit.refreshDefaultBranch.mockImplementation(() => Promise.resolve('main'));
  mockGit.renameBranch.mockImplementation(() => Promise.resolve());
  mockGit.getRemoteUrl.mockImplementation(() => Promise.resolve('git@github.com:owner/repo.git'));
  mockGit.listWorktrees.mockImplementation(() => Promise.resolve(''));
  mockGit.removeWorktree.mockImplementation(() => Promise.resolve());
  mockGit.parseOrgRepo.mockImplementation((remoteUrl: string) => {
    const sshMatch = remoteUrl.match(/git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];
    const httpsMatch = remoteUrl.match(/https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];
    return null;
  });
  mockGit.getOrgRepoFromPath.mockImplementation(() => Promise.resolve('owner/repo'));
  mockGit.deriveRepositorySlug.mockImplementation(() => Promise.resolve('owner/repo'));
  mockGit.resolveGitDir.mockImplementation(defaultResolveGitDir);
  mockGit.isBareRepositoryRoot.mockImplementation(() => Promise.resolve(false));
  mockGit.assertOriginFetchRefspec.mockImplementation(() => Promise.resolve('present' as const));
  mockGit.resolveSourceReadRef.mockImplementation(() => Promise.resolve('HEAD'));
  mockGit.readRepoFileAtRef.mockImplementation(() => Promise.resolve(null));
  mockGit.exportRepoTreeAtRef.mockImplementation(() => Promise.resolve(null));
  mockGit.readWorkingTreeFile.mockImplementation(defaultReadWorkingTreeFile);
  mockGit.fetchRemote.mockImplementation(() => Promise.resolve());
  mockGit.fetchAllRemote.mockImplementation(() => Promise.resolve());
  mockGit.getCommitsBehind.mockImplementation(() => Promise.resolve(0));
  mockGit.getCommitsAhead.mockImplementation(() => Promise.resolve(0));
  mockGit.isWorkingDirectoryClean.mockImplementation(() => Promise.resolve(true));
  mockGit.pullFastForward.mockImplementation(() => Promise.resolve(0));
  mockGit.getMergeBaseSafe.mockImplementation(() => Promise.resolve('abc1234'));
  mockGit.getDiff.mockImplementation(() => Promise.resolve(''));
  mockGit.getDiffNumstat.mockImplementation(() => Promise.resolve(''));
  mockGit.getUntrackedFiles.mockImplementation(() => Promise.resolve([]));
  mockGit.getStatusPorcelain.mockImplementation(() => Promise.resolve(''));
}
