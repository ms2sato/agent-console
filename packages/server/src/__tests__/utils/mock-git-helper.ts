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

// GitError class for tests
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

// Type definitions for mock functions
type AsyncStringFn = (cwd: string) => Promise<string>;
type AsyncStringNullFn = (cwd: string) => Promise<string | null>;
type AsyncStringArrayFn = (cwd: string) => Promise<string[]>;
type AsyncVoidFn = (...args: unknown[]) => Promise<void>;

// Exported mock functions - configure these in beforeEach
export const mockGit = {
  // Low-level
  git: mock(() => Promise.resolve('')) as Mock<AsyncStringFn>,
  gitSafe: mock(() => Promise.resolve(null)) as Mock<AsyncStringNullFn>,
  gitRefExists: mock(() => Promise.resolve(false)) as Mock<(ref: string, cwd: string) => Promise<boolean>>,

  // Branch operations
  getCurrentBranch: mock(() => Promise.resolve('main')) as Mock<AsyncStringFn>,
  listLocalBranches: mock(() => Promise.resolve(['main'])) as Mock<AsyncStringArrayFn>,
  listRemoteBranches: mock(() => Promise.resolve(['origin/main'])) as Mock<AsyncStringArrayFn>,
  listAllBranches: mock(() => Promise.resolve(['main'])) as Mock<AsyncStringArrayFn>,
  getDefaultBranch: mock(() => Promise.resolve('main')) as Mock<AsyncStringNullFn>,
  renameBranch: mock(() => Promise.resolve()) as Mock<AsyncVoidFn>,

  // Remote operations
  getRemoteUrl: mock(() => Promise.resolve('git@github.com:owner/repo.git')) as Mock<AsyncStringNullFn>,

  // Worktree operations
  listWorktrees: mock(() => Promise.resolve('')) as Mock<AsyncStringFn>,
  createWorktree: mock(() => Promise.resolve()) as Mock<AsyncVoidFn>,
  removeWorktree: mock(() => Promise.resolve()) as Mock<AsyncVoidFn>,

  // Org/Repo extraction (sync functions)
  parseOrgRepo: mock((remoteUrl: string) => {
    const sshMatch = remoteUrl.match(/git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];
    const httpsMatch = remoteUrl.match(/https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];
    return null;
  }) as Mock<(remoteUrl: string) => string | null>,
  getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')) as Mock<AsyncStringNullFn>,
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
  mockGit.gitSafe.mockReset();
  mockGit.gitRefExists.mockReset();
  mockGit.getCurrentBranch.mockReset();
  mockGit.listLocalBranches.mockReset();
  mockGit.listRemoteBranches.mockReset();
  mockGit.listAllBranches.mockReset();
  mockGit.getDefaultBranch.mockReset();
  mockGit.renameBranch.mockReset();
  mockGit.getRemoteUrl.mockReset();
  mockGit.listWorktrees.mockReset();
  mockGit.createWorktree.mockReset();
  mockGit.removeWorktree.mockReset();
  mockGit.parseOrgRepo.mockReset();
  mockGit.getOrgRepoFromPath.mockReset();

  // Set default implementations
  mockGit.git.mockImplementation(() => Promise.resolve(''));
  mockGit.gitSafe.mockImplementation(() => Promise.resolve(null));
  mockGit.gitRefExists.mockImplementation(() => Promise.resolve(false));
  mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('main'));
  mockGit.listLocalBranches.mockImplementation(() => Promise.resolve(['main']));
  mockGit.listRemoteBranches.mockImplementation(() => Promise.resolve(['origin/main']));
  mockGit.listAllBranches.mockImplementation(() => Promise.resolve(['main']));
  mockGit.getDefaultBranch.mockImplementation(() => Promise.resolve('main'));
  mockGit.renameBranch.mockImplementation(() => Promise.resolve());
  mockGit.getRemoteUrl.mockImplementation(() => Promise.resolve('git@github.com:owner/repo.git'));
  mockGit.listWorktrees.mockImplementation(() => Promise.resolve(''));
  mockGit.createWorktree.mockImplementation(() => Promise.resolve());
  mockGit.removeWorktree.mockImplementation(() => Promise.resolve());
  mockGit.parseOrgRepo.mockImplementation((remoteUrl: string) => {
    const sshMatch = remoteUrl.match(/git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];
    const httpsMatch = remoteUrl.match(/https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];
    return null;
  });
  mockGit.getOrgRepoFromPath.mockImplementation(() => Promise.resolve('owner/repo'));
}
