import { describe, it, expect, beforeEach, afterAll } from 'bun:test';

/**
 * Tests for remote git operations.
 *
 * These tests mock Bun.spawn to avoid actual git operations.
 * The approach mirrors the pattern used in worktree-service.test.ts.
 */

// Store original Bun.spawn to restore after tests
const originalBunSpawn = Bun.spawn;

// Track spawn calls for assertions
let spawnCalls: Array<{ args: string[]; options: Record<string, unknown> }> = [];

// Mock result to be returned by Bun.spawn
let mockSpawnResult: {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
};

/**
 * Helper to set mock spawn result.
 */
function setMockSpawnResult(stdout: string, exitCode = 0, stderr = '') {
  mockSpawnResult = {
    exited: Promise.resolve(exitCode),
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stderr));
        controller.close();
      },
    }),
  };
}

// Import counter for dynamic module loading
let importCounter = 0;

/**
 * Get fresh git module instance.
 * Dynamic import ensures we get a fresh module that uses our mocked Bun.spawn.
 */
async function getGitModule() {
  const module = await import(`../git.js?v=${++importCounter}`);
  return module;
}

describe('git remote operations', () => {
  beforeEach(() => {
    // Reset spawn tracking
    spawnCalls = [];

    // Default mock result (successful command with empty output)
    setMockSpawnResult('');

    // Mock Bun.spawn
    (Bun as { spawn: typeof Bun.spawn }).spawn = ((args: string[], options?: Record<string, unknown>) => {
      spawnCalls.push({ args, options: options || {} });
      return mockSpawnResult;
    }) as typeof Bun.spawn;
  });

  afterAll(() => {
    // Restore original Bun.spawn
    (Bun as { spawn: typeof Bun.spawn }).spawn = originalBunSpawn;
  });

  describe('fetchRemote', () => {
    it('should call git with correct arguments for specific branch', async () => {
      setMockSpawnResult('');
      const { fetchRemote } = await getGitModule();

      await fetchRemote('main', '/repo');

      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].args).toEqual(['git', 'fetch', 'origin', 'main']);
      expect(spawnCalls[0].options.cwd).toBe('/repo');
    });

    it('should call git with correct arguments for feature branch', async () => {
      setMockSpawnResult('');
      const { fetchRemote } = await getGitModule();

      await fetchRemote('feature/my-branch', '/workspace/project');

      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].args).toEqual(['git', 'fetch', 'origin', 'feature/my-branch']);
      expect(spawnCalls[0].options.cwd).toBe('/workspace/project');
    });

    it('should throw GitError on failure', async () => {
      setMockSpawnResult('', 128, 'fatal: Could not read from remote repository');
      const { fetchRemote, GitError } = await getGitModule();

      await expect(fetchRemote('nonexistent', '/repo')).rejects.toBeInstanceOf(GitError);
    });
  });

  describe('fetchAllRemote', () => {
    it('should call git fetch origin without branch argument', async () => {
      setMockSpawnResult('');
      const { fetchAllRemote } = await getGitModule();

      await fetchAllRemote('/repo');

      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].args).toEqual(['git', 'fetch', 'origin']);
      expect(spawnCalls[0].options.cwd).toBe('/repo');
    });

    it('should work with different working directories', async () => {
      setMockSpawnResult('');
      const { fetchAllRemote } = await getGitModule();

      await fetchAllRemote('/home/user/projects/my-app');

      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].args).toEqual(['git', 'fetch', 'origin']);
      expect(spawnCalls[0].options.cwd).toBe('/home/user/projects/my-app');
    });

    it('should throw GitError on failure', async () => {
      setMockSpawnResult('', 128, 'fatal: Could not read from remote repository');
      const { fetchAllRemote, GitError } = await getGitModule();

      await expect(fetchAllRemote('/repo')).rejects.toBeInstanceOf(GitError);
    });
  });

  describe('getCommitsBehind', () => {
    it('should return correct count when local is behind remote', async () => {
      setMockSpawnResult('5\n');
      const { getCommitsBehind } = await getGitModule();

      const result = await getCommitsBehind('main', '/repo');

      expect(result).toBe(5);
      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].args).toEqual(['git', 'rev-list', '--count', 'main..origin/main']);
    });

    it('should return 0 when up to date', async () => {
      setMockSpawnResult('0\n');
      const { getCommitsBehind } = await getGitModule();

      const result = await getCommitsBehind('develop', '/repo');

      expect(result).toBe(0);
      expect(spawnCalls[0].args).toEqual(['git', 'rev-list', '--count', 'develop..origin/develop']);
    });

    it('should return 0 on error (e.g., no remote tracking branch)', async () => {
      setMockSpawnResult('', 128, 'fatal: bad revision');
      const { getCommitsBehind } = await getGitModule();

      const result = await getCommitsBehind('local-only-branch', '/repo');

      expect(result).toBe(0);
    });

    it('should handle large commit counts', async () => {
      setMockSpawnResult('1234\n');
      const { getCommitsBehind } = await getGitModule();

      const result = await getCommitsBehind('main', '/repo');

      expect(result).toBe(1234);
    });
  });

  describe('getCommitsAhead', () => {
    it('should return correct count when local is ahead of remote', async () => {
      setMockSpawnResult('3\n');
      const { getCommitsAhead } = await getGitModule();

      const result = await getCommitsAhead('main', '/repo');

      expect(result).toBe(3);
      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].args).toEqual(['git', 'rev-list', '--count', 'origin/main..main']);
    });

    it('should return 0 when up to date', async () => {
      setMockSpawnResult('0\n');
      const { getCommitsAhead } = await getGitModule();

      const result = await getCommitsAhead('feature-branch', '/repo');

      expect(result).toBe(0);
      expect(spawnCalls[0].args).toEqual(['git', 'rev-list', '--count', 'origin/feature-branch..feature-branch']);
    });

    it('should return 0 on error (e.g., no remote tracking branch)', async () => {
      setMockSpawnResult('', 128, 'fatal: bad revision');
      const { getCommitsAhead } = await getGitModule();

      const result = await getCommitsAhead('local-only-branch', '/repo');

      expect(result).toBe(0);
    });

    it('should handle large commit counts', async () => {
      setMockSpawnResult('567\n');
      const { getCommitsAhead } = await getGitModule();

      const result = await getCommitsAhead('main', '/repo');

      expect(result).toBe(567);
    });
  });

  describe('GitError', () => {
    it('should be instanceof Error', async () => {
      const { GitError } = await getGitModule();
      const error = new GitError('test message', 128, 'stderr content');

      expect(error).toBeInstanceOf(Error);
    });

    it('should have correct name', async () => {
      const { GitError } = await getGitModule();
      const error = new GitError('test message', 128, 'stderr content');

      expect(error.name).toBe('GitError');
    });

    it('should have correct properties', async () => {
      const { GitError } = await getGitModule();
      const error = new GitError('test message', 128, 'stderr content');

      expect(error.message).toBe('test message');
      expect(error.exitCode).toBe(128);
      expect(error.stderr).toBe('stderr content');
    });
  });

  describe('git function', () => {
    it('should trim both leading and trailing whitespace', async () => {
      setMockSpawnResult('  output with spaces  \n');
      const { git } = await getGitModule();

      const result = await git(['status'], '/repo');

      expect(result).toBe('output with spaces');
    });

    it('should trim trailing newlines', async () => {
      setMockSpawnResult('branch-name\n');
      const { git } = await getGitModule();

      const result = await git(['branch', '--show-current'], '/repo');

      expect(result).toBe('branch-name');
    });
  });

  describe('gitRaw function', () => {
    it('should preserve trailing whitespace', async () => {
      // Simulate diff output with trailing newline
      const diffOutput = 'diff --git a/file.txt b/file.txt\n@@ -1,3 +1,3 @@\n line1\n line2\n line3\n';
      setMockSpawnResult(diffOutput);
      const { gitRaw } = await getGitModule();

      const result = await gitRaw(['diff', 'HEAD~1'], '/repo');

      expect(result).toBe(diffOutput);
      expect(result.endsWith('\n')).toBe(true);
    });

    it('should trim only leading whitespace', async () => {
      setMockSpawnResult('  output with trailing space  \n');
      const { gitRaw } = await getGitModule();

      const result = await gitRaw(['diff', 'HEAD~1'], '/repo');

      expect(result).toBe('output with trailing space  \n');
    });

    it('should preserve multiple trailing newlines', async () => {
      const output = 'content\n\n';
      setMockSpawnResult(output);
      const { gitRaw } = await getGitModule();

      const result = await gitRaw(['diff', 'HEAD~1'], '/repo');

      expect(result).toBe(output);
    });

    it('should return empty string for empty diff output', async () => {
      setMockSpawnResult('');
      const { gitRaw } = await getGitModule();

      const result = await gitRaw(['diff', 'HEAD'], '/repo');

      expect(result).toBe('');
    });

    it('should preserve output without trailing newline as-is', async () => {
      // Some edge cases may produce output without trailing newline
      const output = 'no trailing newline';
      setMockSpawnResult(output);
      const { gitRaw } = await getGitModule();

      const result = await gitRaw(['diff', 'HEAD~1'], '/repo');

      expect(result).toBe(output);
      expect(result.endsWith('\n')).toBe(false);
    });

    it('should preserve whitespace-only changes within diff content', async () => {
      // Diff showing whitespace-only changes (spaces added at end of lines)
      const diffOutput = 'diff --git a/file.txt b/file.txt\n@@ -1,2 +1,2 @@\n-line with no trailing space\n+line with trailing space   \n';
      setMockSpawnResult(diffOutput);
      const { gitRaw } = await getGitModule();

      const result = await gitRaw(['diff', 'HEAD~1'], '/repo');

      expect(result).toBe(diffOutput);
      // Verify the trailing spaces in the changed line are preserved
      expect(result).toContain('+line with trailing space   \n');
    });

    it('should throw GitError on command failure', async () => {
      setMockSpawnResult('', 128, 'fatal: bad revision');
      const { gitRaw, GitError } = await getGitModule();

      await expect(gitRaw(['diff', 'nonexistent-ref'], '/repo')).rejects.toBeInstanceOf(GitError);
    });

    // Bug reproduction test: This test demonstrates the actual bug scenario
    // where using .trim() would fail but .trimStart() works correctly.
    // The unified diff format requires trailing newlines for proper parsing -
    // line count in hunk headers like "@@ -1,5 +1,6 @@" must match actual lines.
    it('should preserve trailing newline in realistic unified diff (bug reproduction)', async () => {
      // Realistic unified diff output from git
      // The hunk header "@@ -1,5 +1,6 @@" means:
      // - Starting at line 1, show 5 lines in old version
      // - Starting at line 1, show 6 lines in new version
      // The parser relies on counting lines, and trailing newline is part of the format
      const realisticDiff = `diff --git a/src/lib/git.ts b/src/lib/git.ts
index abc1234..def5678 100644
--- a/src/lib/git.ts
+++ b/src/lib/git.ts
@@ -1,5 +1,6 @@
 /**
  * Git utilities using Bun.spawn
+ * Now with improved diff handling
  */

 export class GitError extends Error {
`;
      setMockSpawnResult(realisticDiff);
      const { gitRaw } = await getGitModule();

      const result = await gitRaw(['diff', 'HEAD~1'], '/repo');

      // The exact output must be preserved including trailing newline
      expect(result).toBe(realisticDiff);
      expect(result.endsWith('\n')).toBe(true);

      // Verify line count matches what hunk header claims
      // The hunk header "@@ -1,5 +1,6 @@" indicates 6 lines in the new version
      // Hunk content lines (after header): context, context, added, context, blank, context = 6 lines
      // Split includes trailing empty string from final newline, so we need to account for that
      const allLines = result.split('\n');
      const hunkStartIndex = 5; // Lines 0-4 are: diff, index, ---, +++, @@
      // The hunk content starts at index 5 and goes until the trailing empty string
      // For +1,6 we expect 6 lines in the hunk content
      const hunkLines = allLines.slice(hunkStartIndex, allLines.length - 1); // Exclude trailing empty from split
      expect(hunkLines.length).toBe(6);
    });
  });

  describe('getDiff', () => {
    it('should use gitRaw and preserve trailing newlines', async () => {
      const diffOutput = 'diff --git a/file.txt b/file.txt\nindex abc..def\n--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,3 @@\n line1\n line2\n+line3\n';
      setMockSpawnResult(diffOutput);
      const { getDiff } = await getGitModule();

      const result = await getDiff('HEAD~1', undefined, '/repo');

      expect(result).toBe(diffOutput);
      expect(result.endsWith('\n')).toBe(true);
      expect(spawnCalls[0].args).toEqual(['git', 'diff', 'HEAD~1']);
    });

    it('should handle diff between two refs', async () => {
      const diffOutput = 'diff --git a/file.txt b/file.txt\n';
      setMockSpawnResult(diffOutput);
      const { getDiff } = await getGitModule();

      const result = await getDiff('abc123', 'def456', '/repo');

      expect(result).toBe(diffOutput);
      expect(spawnCalls[0].args).toEqual(['git', 'diff', 'abc123', 'def456']);
    });
  });

  describe('getDiffNumstat', () => {
    it('should use gitRaw and preserve trailing newlines', async () => {
      const numstatOutput = '10\t5\tfile.txt\n3\t0\tREADME.md\n';
      setMockSpawnResult(numstatOutput);
      const { getDiffNumstat } = await getGitModule();

      const result = await getDiffNumstat('HEAD~1', undefined, '/repo');

      expect(result).toBe(numstatOutput);
      expect(result.endsWith('\n')).toBe(true);
      expect(spawnCalls[0].args).toEqual(['git', 'diff', '--numstat', 'HEAD~1']);
    });

    it('should handle numstat between two refs', async () => {
      const numstatOutput = '1\t1\tfile.txt\n';
      setMockSpawnResult(numstatOutput);
      const { getDiffNumstat } = await getGitModule();

      const result = await getDiffNumstat('abc123', 'def456', '/repo');

      expect(result).toBe(numstatOutput);
      expect(spawnCalls[0].args).toEqual(['git', 'diff', '--numstat', 'abc123', 'def456']);
    });
  });

  describe('isWorkingDirectoryClean', () => {
    it('should return true when working directory is clean', async () => {
      setMockSpawnResult('');
      const { isWorkingDirectoryClean } = await getGitModule();

      const result = await isWorkingDirectoryClean('/repo');

      expect(result).toBe(true);
      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].args).toEqual(['git', 'status', '--porcelain']);
      expect(spawnCalls[0].options.cwd).toBe('/repo');
    });

    it('should return false when there are uncommitted changes', async () => {
      setMockSpawnResult(' M src/file.ts\n?? new-file.txt\n');
      const { isWorkingDirectoryClean } = await getGitModule();

      const result = await isWorkingDirectoryClean('/repo');

      expect(result).toBe(false);
    });

    it('should throw GitError on command failure', async () => {
      setMockSpawnResult('', 128, 'fatal: not a git repository');
      const { isWorkingDirectoryClean, GitError } = await getGitModule();

      await expect(isWorkingDirectoryClean('/not-a-repo')).rejects.toBeInstanceOf(GitError);
    });
  });

  describe('pullFastForward', () => {
    /**
     * Helper to create a sequential mock where each spawn call returns different results.
     */
    function setSequentialMockResults(results: Array<{ stdout: string; exitCode?: number; stderr?: string }>) {
      let callIndex = 0;
      (Bun as { spawn: typeof Bun.spawn }).spawn = ((args: string[], options?: Record<string, unknown>) => {
        spawnCalls.push({ args, options: options || {} });
        const result = results[callIndex] || { stdout: '', exitCode: 0, stderr: '' };
        callIndex++;
        return {
          exited: Promise.resolve(result.exitCode ?? 0),
          stdout: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(result.stdout));
              controller.close();
            },
          }),
          stderr: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(result.stderr ?? ''));
              controller.close();
            },
          }),
        };
      }) as typeof Bun.spawn;
    }

    it('should return commit count when pull brings new commits', async () => {
      setSequentialMockResults([
        { stdout: 'abc1234\n' },       // git rev-parse HEAD (before)
        { stdout: '' },                 // git pull --ff-only
        { stdout: 'def5678\n' },       // git rev-parse HEAD (after)
        { stdout: '3\n' },             // git rev-list --count
      ]);
      const { pullFastForward } = await getGitModule();

      const result = await pullFastForward('/repo');

      expect(result).toBe(3);
      expect(spawnCalls[0].args).toEqual(['git', 'rev-parse', 'HEAD']);
      expect(spawnCalls[1].args).toEqual(['git', 'pull', '--ff-only']);
      expect(spawnCalls[2].args).toEqual(['git', 'rev-parse', 'HEAD']);
      expect(spawnCalls[3].args).toEqual(['git', 'rev-list', '--count', 'abc1234..def5678']);
    });

    it('should return 0 when already up to date', async () => {
      setSequentialMockResults([
        { stdout: 'abc1234\n' },       // git rev-parse HEAD (before)
        { stdout: '' },                 // git pull --ff-only (no changes)
        { stdout: 'abc1234\n' },       // git rev-parse HEAD (after, same as before)
      ]);
      const { pullFastForward } = await getGitModule();

      const result = await pullFastForward('/repo');

      expect(result).toBe(0);
      // Should not call rev-list --count since HEAD didn't change
      expect(spawnCalls.length).toBe(3);
    });

    it('should throw GitError when branches have diverged', async () => {
      setSequentialMockResults([
        { stdout: 'abc1234\n' },       // git rev-parse HEAD (before)
        { stdout: '', exitCode: 128, stderr: 'fatal: Not possible to fast-forward, aborting.' },
      ]);
      const { pullFastForward, GitError } = await getGitModule();

      await expect(pullFastForward('/repo')).rejects.toBeInstanceOf(GitError);
    });

    it('should use the correct working directory', async () => {
      setSequentialMockResults([
        { stdout: 'aaa\n' },
        { stdout: '' },
        { stdout: 'aaa\n' },
      ]);
      const { pullFastForward } = await getGitModule();

      await pullFastForward('/my/worktree/path');

      for (const call of spawnCalls) {
        expect(call.options.cwd).toBe('/my/worktree/path');
      }
    });
  });

  describe('removeWorktree', () => {
    it('should call git worktree remove without --force by default', async () => {
      setMockSpawnResult('');
      const { removeWorktree } = await getGitModule();

      await removeWorktree('/path/to/worktree', '/repo');

      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].args).toEqual(['git', 'worktree', 'remove', '/path/to/worktree']);
      expect(spawnCalls[0].options.cwd).toBe('/repo');
    });

    it('should call git worktree remove without --force when force is false', async () => {
      setMockSpawnResult('');
      const { removeWorktree } = await getGitModule();

      await removeWorktree('/path/to/worktree', '/repo', { force: false });

      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].args).toEqual(['git', 'worktree', 'remove', '/path/to/worktree']);
    });

    it('should call git worktree remove with --force twice when force is true', async () => {
      setMockSpawnResult('');
      const { removeWorktree } = await getGitModule();

      await removeWorktree('/path/to/worktree', '/repo', { force: true });

      expect(spawnCalls.length).toBe(1);
      // --force twice removes both unclean worktrees AND locked worktrees
      expect(spawnCalls[0].args).toEqual(['git', 'worktree', 'remove', '/path/to/worktree', '--force', '--force']);
      expect(spawnCalls[0].options.cwd).toBe('/repo');
    });

    it('should throw GitError when removal fails', async () => {
      setMockSpawnResult('', 128, "fatal: '/path/to/worktree' is not a working tree");
      const { removeWorktree, GitError } = await getGitModule();

      await expect(removeWorktree('/path/to/worktree', '/repo')).rejects.toBeInstanceOf(GitError);
    });

    it('should throw GitError when removal fails without force even if .git error', async () => {
      setMockSpawnResult('', 128, 'fatal: cannot read .git file');
      const { removeWorktree, GitError } = await getGitModule();

      await expect(removeWorktree('/path/to/worktree', '/repo')).rejects.toBeInstanceOf(GitError);
    });

    it('should fall back to manual cleanup when force is true and the .git file cannot be read', async () => {
      const fs = await import('node:fs/promises');

      // Create a temp directory using the same fs module that removeWorktree will use
      // (which may be memfs when running in the full test suite).
      const tempWorktreePath = `/tmp/git-test-worktree-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await fs.mkdir(tempWorktreePath, { recursive: true });
      const tempRepoPath = `/tmp/git-test-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await fs.mkdir(tempRepoPath, { recursive: true });

      try {
        let callCount = 0;
        (Bun as { spawn: typeof Bun.spawn }).spawn = ((args: string[], options?: Record<string, unknown>) => {
          spawnCalls.push({ args, options: options || {} });
          callCount++;
          if (callCount === 1) {
            // First call: git worktree remove fails
            return {
              exited: Promise.resolve(128),
              stdout: new ReadableStream({
                start(controller) { controller.close(); },
              }),
              stderr: new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('fatal: cannot read .git file'));
                  controller.close();
                },
              }),
            };
          }
          // Second call: git worktree prune succeeds
          return {
            exited: Promise.resolve(0),
            stdout: new ReadableStream({
              start(controller) { controller.close(); },
            }),
            stderr: new ReadableStream({
              start(controller) { controller.close(); },
            }),
          };
        }) as typeof Bun.spawn;

        const { removeWorktree } = await getGitModule();

        await removeWorktree(tempWorktreePath, tempRepoPath, { force: true });

        // `--expire=now` is required because the fallback just deleted the
        // worktree dir; git's default 3-month grace would leave the
        // freshly-stale registry entry behind otherwise.
        expect(spawnCalls.length).toBe(2);
        expect(spawnCalls[0].args).toEqual(['git', 'worktree', 'remove', tempWorktreePath, '--force', '--force']);
        expect(spawnCalls[1].args).toEqual(['git', 'worktree', 'prune', '--expire=now']);
        expect(spawnCalls[1].options.cwd).toBe(tempRepoPath);
      } finally {
        // Clean up temp directories (worktree may already be removed by removeWorktree)
        await fs.rm(tempWorktreePath, { recursive: true, force: true });
        await fs.rm(tempRepoPath, { recursive: true, force: true });
      }
    });

    it('should fall back to manual cleanup when force is true and path is not a working tree (orphaned worktree)', async () => {
      const fs = await import('node:fs/promises');

      const tempWorktreePath = `/tmp/git-test-worktree-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await fs.mkdir(tempWorktreePath, { recursive: true });
      // cwd (primary repo) must exist for the prune step to run.
      const tempRepoPath = `/tmp/git-test-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await fs.mkdir(tempRepoPath, { recursive: true });

      try {
        // First call fails with "is not a working tree" error, second call (worktree prune) succeeds
        let callCount = 0;
        (Bun as { spawn: typeof Bun.spawn }).spawn = ((args: string[], options?: Record<string, unknown>) => {
          spawnCalls.push({ args, options: options || {} });
          callCount++;
          if (callCount === 1) {
            // First call: git worktree remove fails with orphaned worktree error
            return {
              exited: Promise.resolve(128),
              stdout: new ReadableStream({
                start(controller) { controller.close(); },
              }),
              stderr: new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(`fatal: '${tempWorktreePath}' is not a working tree`));
                  controller.close();
                },
              }),
            };
          }
          // Second call: git worktree prune succeeds
          return {
            exited: Promise.resolve(0),
            stdout: new ReadableStream({
              start(controller) { controller.close(); },
            }),
            stderr: new ReadableStream({
              start(controller) { controller.close(); },
            }),
          };
        }) as typeof Bun.spawn;

        const { removeWorktree } = await getGitModule();

        await removeWorktree(tempWorktreePath, tempRepoPath, { force: true });

        // `--expire=now` is required: the fallback just deleted the worktree
        // dir, and git's default 3-month grace would leave the freshly-stale
        // registry entry behind.
        expect(spawnCalls.length).toBe(2);
        expect(spawnCalls[0].args).toEqual(['git', 'worktree', 'remove', tempWorktreePath, '--force', '--force']);
        expect(spawnCalls[1].args).toEqual(['git', 'worktree', 'prune', '--expire=now']);
        expect(spawnCalls[1].options.cwd).toBe(tempRepoPath);
      } finally {
        // Clean up temp directories (worktree may already be removed by removeWorktree)
        await fs.rm(tempWorktreePath, { recursive: true, force: true });
        await fs.rm(tempRepoPath, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // Privilege-elevation seam (Issue #869 / #870)
  //
  // When a `requestUser` is passed, lib/git.ts must route the invocation
  // through `runAsUser` instead of spawning git directly. The
  // `__setRunAsUserForTesting` hook lets us swap in a capture mock to
  // assert the contract without spawning any sudo/sh processes.
  // =========================================================================
  describe('requestUser routing (Issue #869 / #870)', () => {
    it('uses Bun.spawn directly when requestUser is null/undefined (default path)', async () => {
      setMockSpawnResult('main\n');
      const { git } = await getGitModule();

      const result = await git(['rev-parse', 'HEAD'], '/repo');

      expect(result).toBe('main');
      // Direct spawn path: Bun.spawn was invoked with the full git argv.
      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].args).toEqual(['git', 'rev-parse', 'HEAD']);
      expect(spawnCalls[0].options.cwd).toBe('/repo');
    });

    it('routes through runAsUser when requestUser is non-empty (elevated path)', async () => {
      const runAsUserCalls: Array<Record<string, unknown>> = [];
      const fakeRunAsUser = async (opts: Record<string, unknown>) => {
        runAsUserCalls.push(opts);
        return { stdout: 'mainbranch\n', stderr: '', exitCode: 0, timedOut: false };
      };

      const mod = await getGitModule();
      mod.__setRunAsUserForTesting(fakeRunAsUser);
      try {
        const result = await mod.git(['rev-parse', 'HEAD'], '/repo', undefined, 'alice');

        expect(result).toBe('mainbranch');
        // Direct-spawn path was NOT used: Bun.spawn was never called.
        expect(spawnCalls.length).toBe(0);
        // runAsUser was invoked once with username, cwd, and a shell-escaped
        // git command string.
        expect(runAsUserCalls.length).toBe(1);
        expect(runAsUserCalls[0].username).toBe('alice');
        expect(runAsUserCalls[0].cwd).toBe('/repo');
        expect(runAsUserCalls[0].command).toBe("'git' 'rev-parse' 'HEAD'");
      } finally {
        mod.__setRunAsUserForTesting(null);
      }
    });

    it('translates a non-zero exitCode from runAsUser into a GitError', async () => {
      const fakeRunAsUser = async () => ({
        stdout: '',
        stderr: 'fatal: bad revision\n',
        exitCode: 128,
        timedOut: false,
      });

      const mod = await getGitModule();
      mod.__setRunAsUserForTesting(fakeRunAsUser);
      try {
        let caught: unknown;
        try {
          await mod.git(['rev-parse', 'no-such-ref'], '/repo', undefined, 'alice');
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(mod.GitError);
        expect((caught as Error).message).toContain('bad revision');
      } finally {
        mod.__setRunAsUserForTesting(null);
      }
    });

    it('translates timedOut from runAsUser into a GitError', async () => {
      const fakeRunAsUser = async () => ({
        stdout: '',
        stderr: '',
        exitCode: 137,
        timedOut: true,
      });

      const mod = await getGitModule();
      mod.__setRunAsUserForTesting(fakeRunAsUser);
      try {
        let caught: unknown;
        try {
          await mod.git(['fetch'], '/repo', 5000, 'alice');
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(mod.GitError);
        expect((caught as Error).message).toContain('timed out');
      } finally {
        mod.__setRunAsUserForTesting(null);
      }
    });

    it('wraps a spawn failure thrown by runAsUser into a GitError (e.g., sudo missing)', async () => {
      const fakeRunAsUser = async () => {
        throw new Error('spawn sudo ENOENT');
      };

      const mod = await getGitModule();
      mod.__setRunAsUserForTesting(fakeRunAsUser);
      try {
        let caught: unknown;
        try {
          await mod.git(['rev-parse', 'HEAD'], '/repo', undefined, 'alice');
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(mod.GitError);
        expect((caught as Error).message).toContain('spawn sudo ENOENT');
      } finally {
        mod.__setRunAsUserForTesting(null);
      }
    });
  });

  // =========================================================================
  // getStatusPorcelain whitespace preservation (Issue #870 latent fix)
  //
  // The porcelain output's two-column status prefix (`XY filename`) is
  // separated from the filename by a single space, and the first line in
  // particular carries meaningful leading whitespace when X is ' ' (e.g.,
  // ` M file.ts` = unstaged-modified). Trimming the whole stdout would
  // silently strip that whitespace and break parseStatusPorcelain's
  // `^(.)(.) (.+)$` regex. Verify the output is returned UNTRIMMED.
  // =========================================================================
  describe('getStatusPorcelain whitespace preservation (Issue #870)', () => {
    it('preserves leading whitespace on the first line so XY status survives', async () => {
      // ` M file.ts` -> unstaged modified. The leading space is the index
      // status column and must NOT be stripped by `.trim()`.
      setMockSpawnResult(' M file.ts\n M other.ts\n');
      const { getStatusPorcelain } = await getGitModule();

      const result = await getStatusPorcelain('/repo');

      // The leading space MUST be intact. If gitExec stripped it via
      // .trim()/.trimStart(), the first line would become `M file.ts` and
      // the XY parser would see only one status column.
      expect(result.startsWith(' M file.ts')).toBe(true);
      expect(result).toContain(' M file.ts\n M other.ts');
    });

    it('preserves leading whitespace under the elevated runAsUser path too', async () => {
      const fakeRunAsUser = async () => ({
        stdout: ' M file.ts\n?? new.ts\n',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      });

      const mod = await getGitModule();
      mod.__setRunAsUserForTesting(fakeRunAsUser);
      try {
        const result = await mod.getStatusPorcelain('/repo', 'alice');
        // Same invariant on the elevated path.
        expect(result.startsWith(' M file.ts')).toBe(true);
      } finally {
        mod.__setRunAsUserForTesting(null);
      }
    });
  });
});
