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
 *
 * Issue #869: `git-diff-service.ts` no longer routes through `lib/git.ts`; it
 * calls `runAsUser` directly with `'git' ...` command strings. The lib/git
 * mocks below therefore have no effect on git-diff-service code paths.
 *
 * To keep integration tests (api.test.ts, session-manager.test.ts, etc.) free
 * of real `sh -c 'git ...'` spawns when they exercise git-diff worker
 * creation, `resetGitMocks()` ALSO installs a default fake `runAsUser` that
 * returns an empty success. This is sufficient for "happy path" worker
 * creation (computeDefaultBaseSpec falls through to 'HEAD' when every git
 * invocation returns empty stdout). Tests that need specific git outputs for
 * git-diff-service should use `mock-run-as-user.ts` directly and override the
 * default via `__setRunAsUserForTesting`.
 */
import { mock, type Mock } from 'bun:test';
import { __setRunAsUserForTesting } from '../../services/git-diff-service.js';
import type { RunAsUserOpts, RunAsUserResult } from '../../services/privilege-elevation.js';

// Import and re-export the real GitError class from the git module.
// This ensures instanceof checks work correctly in tests, because both the test code
// and the mocked module use the same GitError class.
import { GitError } from '../../lib/git.js';
export { GitError };

/**
 * Parse a shell command string of the form `'<arg>' '<arg>' ...` (the format
 * produced by `git-diff-service`'s `runGit` helper via `shellEscape`) back
 * into the original args. Only handles single-quoted args without embedded
 * single quotes — sufficient for every git invocation `git-diff-service`
 * makes today (refs, paths, flag strings).
 */
function parseGitCommand(command: string): string[] | null {
  // Match individual single-quoted segments. Reject if any segment contains
  // an unescaped inner quote — outside the helper's scope.
  const parts: string[] = [];
  const re = /'([^']*)'/g;
  let match: RegExpExecArray | null;
  let lastEnd = 0;
  while ((match = re.exec(command)) !== null) {
    // Separator between args must be a single space (or start of string).
    if (match.index !== lastEnd && match.index !== lastEnd + 1) return null;
    parts.push(match[1]);
    lastEnd = match.index + match[0].length;
  }
  if (lastEnd !== command.length) return null;
  if (parts.length === 0 || parts[0] !== 'git') return null;
  return parts.slice(1);
}

function success(stdout: string): RunAsUserResult {
  return { stdout, stderr: '', exitCode: 0, timedOut: false };
}

function failure(stderr = ''): RunAsUserResult {
  return { stdout: '', stderr, exitCode: 1, timedOut: false };
}

/**
 * Default `runAsUser` for tests that import this helper: parses the git
 * command string and dispatches to the corresponding `mockGit.*` function so
 * existing test setups (mocking `mockGit.getMergeBaseSafe`,
 * `mockGit.getDefaultBranch`, etc.) continue to drive `git-diff-service`
 * after Issue #869's refactor.
 *
 * Commands the dispatcher does not recognize fall through to an empty-success
 * result. Tests that need finer control should override per-test via
 * `__setRunAsUserForTesting` (see `mock-run-as-user.ts`).
 */
async function defaultEmptyRunAsUser(opts: RunAsUserOpts): Promise<RunAsUserResult> {
  const args = parseGitCommand(opts.command);
  if (!args) {
    return success('');
  }
  const cwd = opts.cwd ?? '';

  // Atomic helpers
  if (args[0] === 'rev-parse' && args[1] === '--verify' && args.length === 3) {
    const exists = await mockGit.gitRefExists(args[2], cwd);
    return exists ? success('') : failure();
  }
  if (args[0] === 'rev-parse' && args.length === 2) {
    const result = await mockGit.gitSafe(['rev-parse', args[1]], cwd);
    return result === null ? failure() : success(result);
  }
  if (args[0] === 'rev-list' && args[1] === '--max-parents=0' && args[2] === 'HEAD') {
    const result = await mockGit.gitSafe(['rev-list', '--max-parents=0', 'HEAD'], cwd);
    return result === null ? failure() : success(result);
  }
  if (args[0] === 'merge-base' && args.length === 3) {
    const result = await mockGit.getMergeBaseSafe(args[1], args[2], cwd);
    return result === null ? failure() : success(result);
  }
  if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/origin/HEAD') {
    // Mirror what the production getDefaultBranch chain expects: when the
    // mock `getDefaultBranch` is set, surface a matching symbolic-ref so
    // `getDefaultBranchAsUser` returns the same branch name. Without it,
    // surface a non-zero exit so it falls through to main/master probes.
    const branch = await mockGit.getDefaultBranch(cwd);
    if (branch) return success(`refs/remotes/origin/${branch}\n`);
    return failure();
  }
  if (args[0] === 'diff') {
    // Variants: diff <base>, diff <base> <target>, diff --numstat <base> [<target>],
    // diff <base> -- <filePath>
    if (args[1] === '--numstat') {
      const targetRef = args.length >= 4 && args[3] !== '--' ? args[3] : undefined;
      try {
        const stdout = await mockGit.getDiffNumstat(args[2], targetRef, cwd);
        return success(stdout);
      } catch (err) {
        return failure(err instanceof Error ? err.message : String(err));
      }
    }
    // `diff <base> -- <file>` is a targeted per-file diff (mirrors gitRaw).
    if (args.includes('--')) {
      try {
        // The mock-git-helper's `mockGit.gitRaw` is typed `(cwd) => Promise<string>`
        // for historical reasons but the real `gitRaw` is `(args, cwd, timeoutMs?)`.
        // Tests assert on `mockGit.gitRaw.mock.calls[i][0]` as the args array, so
        // we invoke it with the production shape and silence the typecheck here.
        const stdout = await (mockGit.gitRaw as unknown as (args: string[], cwd: string) => Promise<string>)(args, cwd);
        return success(stdout);
      } catch (err) {
        return failure(err instanceof Error ? err.message : String(err));
      }
    }
    // `diff <base> [<target>]`
    const targetRef = args.length >= 3 ? args[2] : undefined;
    try {
      const stdout = await mockGit.getDiff(args[1], targetRef, cwd);
      return success(stdout);
    } catch (err) {
      return failure(err instanceof Error ? err.message : String(err));
    }
  }
  if (args[0] === 'status' && args[1] === '--porcelain' && args[2] === '-uall') {
    try {
      const stdout = await mockGit.getStatusPorcelain(cwd);
      return success(stdout);
    } catch (err) {
      return failure(err instanceof Error ? err.message : String(err));
    }
  }
  if (args[0] === 'ls-files' && args[1] === '--others' && args[2] === '--exclude-standard') {
    try {
      const files = await mockGit.getUntrackedFiles(cwd);
      return success(files.length === 0 ? '' : files.join('\n') + '\n');
    } catch {
      return failure();
    }
  }
  if (args[0] === 'show' && args.length === 2) {
    const result = await mockGit.gitSafe(['show', args[1]], cwd);
    return result === null ? failure() : success(result);
  }

  // Unrecognized git invocation -> succeed with empty stdout (safe default).
  return success('');
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
  gitRaw: mock(() => Promise.resolve('')) as Mock<AsyncStringFn>,
  gitSafe: mock(() => Promise.resolve(null)) as Mock<(args: string[], cwd: string) => Promise<string | null>>,
  gitRefExists: mock(() => Promise.resolve(false)) as Mock<(ref: string, cwd: string) => Promise<boolean>>,

  // Branch operations
  getCurrentBranch: mock(() => Promise.resolve('main')) as Mock<AsyncStringFn>,
  listLocalBranches: mock(() => Promise.resolve(['main'])) as Mock<AsyncStringArrayFn>,
  listRemoteBranches: mock(() => Promise.resolve(['origin/main'])) as Mock<AsyncStringArrayFn>,
  listAllBranches: mock(() => Promise.resolve(['main'])) as Mock<AsyncStringArrayFn>,
  getDefaultBranch: mock(() => Promise.resolve('main')) as Mock<AsyncStringNullFn>,
  refreshDefaultBranch: mock(() => Promise.resolve('main')) as Mock<AsyncStringFn>,
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

  // Remote fetch operations
  fetchRemote: mock(() => Promise.resolve()) as Mock<(branch: string, cwd: string) => Promise<void>>,
  fetchAllRemote: mock(() => Promise.resolve()) as Mock<(cwd: string) => Promise<void>>,
  getCommitsBehind: mock(() => Promise.resolve(0)) as Mock<(branch: string, cwd: string) => Promise<number>>,
  getCommitsAhead: mock(() => Promise.resolve(0)) as Mock<(branch: string, cwd: string) => Promise<number>>,

  // Working directory operations
  isWorkingDirectoryClean: mock(() => Promise.resolve(true)) as Mock<(cwd: string) => Promise<boolean>>,
  pullFastForward: mock(() => Promise.resolve(0)) as Mock<(cwd: string) => Promise<number>>,

  // Diff operations
  getMergeBase: mock(() => Promise.resolve('abc1234')) as Mock<(ref1: string, ref2: string, cwd: string) => Promise<string>>,
  getMergeBaseSafe: mock(() => Promise.resolve('abc1234')) as Mock<(ref1: string, ref2: string, cwd: string) => Promise<string | null>>,
  getDiff: mock(() => Promise.resolve('')) as Mock<(baseRef: string, targetRef: string | undefined, cwd: string) => Promise<string>>,
  getDiffNumstat: mock(() => Promise.resolve('')) as Mock<(baseRef: string, targetRef: string | undefined, cwd: string) => Promise<string>>,
  getStagedFiles: mock(() => Promise.resolve('')) as Mock<AsyncStringFn>,
  getUnstagedFiles: mock(() => Promise.resolve('')) as Mock<AsyncStringFn>,
  getUntrackedFiles: mock(() => Promise.resolve([])) as Mock<AsyncStringArrayFn>,
  getStatusPorcelain: mock(() => Promise.resolve('')) as Mock<AsyncStringFn>,
};

// Register mock once at module load time
mock.module('../../lib/git.js', () => ({
  ...mockGit,
  GitError,
}));

// Issue #869: also install the default empty-success `runAsUser` at module
// load so any test file importing this helper gets isolation from real `sh`
// spawns (essential when memfs replaces the real filesystem). Tests that
// call `resetGitMocks()` get the same default re-installed below.
__setRunAsUserForTesting(defaultEmptyRunAsUser);

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
  mockGit.createWorktree.mockReset();
  mockGit.removeWorktree.mockReset();
  mockGit.parseOrgRepo.mockReset();
  mockGit.getOrgRepoFromPath.mockReset();
  mockGit.fetchRemote.mockReset();
  mockGit.fetchAllRemote.mockReset();
  mockGit.getCommitsBehind.mockReset();
  mockGit.getCommitsAhead.mockReset();
  mockGit.isWorkingDirectoryClean.mockReset();
  mockGit.pullFastForward.mockReset();
  mockGit.getMergeBase.mockReset();
  mockGit.getMergeBaseSafe.mockReset();
  mockGit.getDiff.mockReset();
  mockGit.getDiffNumstat.mockReset();
  mockGit.getStagedFiles.mockReset();
  mockGit.getUnstagedFiles.mockReset();
  mockGit.getUntrackedFiles.mockReset();
  mockGit.getStatusPorcelain.mockReset();

  // Set default implementations
  mockGit.git.mockImplementation(() => Promise.resolve(''));
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
  mockGit.fetchRemote.mockImplementation(() => Promise.resolve());
  mockGit.fetchAllRemote.mockImplementation(() => Promise.resolve());
  mockGit.getCommitsBehind.mockImplementation(() => Promise.resolve(0));
  mockGit.getCommitsAhead.mockImplementation(() => Promise.resolve(0));
  mockGit.isWorkingDirectoryClean.mockImplementation(() => Promise.resolve(true));
  mockGit.pullFastForward.mockImplementation(() => Promise.resolve(0));
  mockGit.getMergeBase.mockImplementation(() => Promise.resolve('abc1234'));
  mockGit.getMergeBaseSafe.mockImplementation(() => Promise.resolve('abc1234'));
  mockGit.getDiff.mockImplementation(() => Promise.resolve(''));
  mockGit.getDiffNumstat.mockImplementation(() => Promise.resolve(''));
  mockGit.getStagedFiles.mockImplementation(() => Promise.resolve(''));
  mockGit.getUnstagedFiles.mockImplementation(() => Promise.resolve(''));
  mockGit.getUntrackedFiles.mockImplementation(() => Promise.resolve([]));
  mockGit.getStatusPorcelain.mockImplementation(() => Promise.resolve(''));

  // Issue #869: also install the empty-success default for runAsUser so
  // git-diff-service composes without real sh spawns under memfs. Tests can
  // still override via __setRunAsUserForTesting after this call.
  __setRunAsUserForTesting(defaultEmptyRunAsUser);
}
