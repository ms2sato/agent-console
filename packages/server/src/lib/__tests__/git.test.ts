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
      setMockSpawnResult('', 128, "fatal: '.git' does not exist");
      const { removeWorktree, GitError } = await getGitModule();

      await expect(removeWorktree('/path/to/worktree', '/repo')).rejects.toBeInstanceOf(GitError);
    });

    it('should fall back to manual cleanup when force is true and .git does not exist', async () => {
      // First call fails with .git error, second call (worktree prune) succeeds
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
                controller.enqueue(new TextEncoder().encode("fatal: '.git' does not exist"));
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

      // Mock fs.access and fs.rm via the worktree path not existing on disk
      // Since /path/to/worktree doesn't exist, fs.access will reject and rm won't be called
      const { removeWorktree } = await getGitModule();

      await removeWorktree('/path/to/worktree', '/repo', { force: true });

      // Should have called git worktree remove first, then git worktree prune
      expect(spawnCalls.length).toBe(2);
      expect(spawnCalls[0].args).toEqual(['git', 'worktree', 'remove', '/path/to/worktree', '--force', '--force']);
      expect(spawnCalls[1].args).toEqual(['git', 'worktree', 'prune']);
      expect(spawnCalls[1].options.cwd).toBe('/repo');
    });
  });
});
