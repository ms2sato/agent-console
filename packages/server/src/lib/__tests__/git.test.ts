import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellEscape } from '../../services/privilege-elevation.js';
import { rootLogger } from '../logger.js';
import { timerClearedAfter } from '../../__tests__/utils/timer-capture.js';

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
  kill?: () => void;
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

// The direct-spawn branch of gitExec races `proc.exited` against a timeout
// built by raceWithTimeout with a GitError factory. These pins cover the
// branch's contract: the typed timeout error (so the kill check and every
// `instanceof GitError` consumer keep working), the kill, the timer cleanup,
// and that an ordinary failure neither times out nor kills.
//
// Measured reach: replacing the factory with a plain message fails (1);
// removing the `finally` from raceWithTimeout fails (3).
describe('gitExec direct-spawn timeout', () => {
  let killCalls = 0;

  beforeEach(() => {
    spawnCalls = [];
    killCalls = 0;
    setMockSpawnResult('');
    (Bun as { spawn: typeof Bun.spawn }).spawn = ((args: string[], options?: Record<string, unknown>) => {
      spawnCalls.push({ args, options: options || {} });
      return mockSpawnResult;
    }) as typeof Bun.spawn;
  });

  afterAll(() => {
    (Bun as { spawn: typeof Bun.spawn }).spawn = originalBunSpawn;
  });

  function hangingProcess(): void {
    mockSpawnResult = {
      exited: new Promise<number>(() => {}), // never exits
      stdout: new ReadableStream({ start: (c) => c.close() }),
      stderr: new ReadableStream({ start: (c) => c.close() }),
      kill: () => {
        killCalls += 1;
      },
    };
  }

  it('(1) rejects with a GitError carrying exitCode -1, stderr "Timeout" and the timeout message', async () => {
    hangingProcess();
    const { git, GitError } = await getGitModule();

    const err = await git(['rev-parse', 'HEAD'], '/repo', 20).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitError);
    expect(err.exitCode).toBe(-1);
    expect(err.stderr).toBe('Timeout');
    expect(err.message).toBe('git rev-parse timed out after 20ms');
  });

  it('(2) kills the process exactly once on timeout', async () => {
    hangingProcess();
    const { git } = await getGitModule();

    await git(['rev-parse', 'HEAD'], '/repo', 20).catch(() => {});

    expect(killCalls).toBe(1);
  });

  it('(3) clears its timer when the process exits normally', async () => {
    setMockSpawnResult('abc123\n');
    const { git } = await getGitModule();

    const { created, cleared } = await timerClearedAfter(() => git(['rev-parse', 'HEAD'], '/repo', 60_000));

    expect(created).toHaveLength(1);
    expect(cleared).toContain(created[0]);
  });

  it('(4) a non-zero exit throws the ordinary GitError with the real stderr and does not kill', async () => {
    setMockSpawnResult('', 128, 'fatal: not a git repository');
    mockSpawnResult.kill = () => {
      killCalls += 1;
    };
    const { git, GitError } = await getGitModule();

    const err = await git(['rev-parse', 'HEAD'], '/repo', 60_000).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitError);
    expect(err.exitCode).toBe(128);
    expect(err.stderr).toBe('fatal: not a git repository');
    expect(err.message).toBe('git rev-parse failed: fatal: not a git repository');
    expect(killCalls).toBe(0);
  });
});

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

    it('uses Bun.spawn directly when requestUser is omitted (default path)', async () => {
      setMockSpawnResult('');
      const { fetchRemote } = await getGitModule();

      await fetchRemote('main', '/repo');

      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].args).toEqual(['git', 'fetch', 'origin', 'main']);
      expect(spawnCalls[0].options.cwd).toBe('/repo');
    });

    it('routes through runAsUser when requestUser is non-empty (elevated path)', async () => {
      const runAsUserCalls: Array<Record<string, unknown>> = [];
      const fakeRunAsUser = async (opts: Record<string, unknown>) => {
        runAsUserCalls.push(opts);
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      };

      const mod = await getGitModule();
      mod.__setRunAsUserForTesting(fakeRunAsUser);
      try {
        await mod.fetchRemote('main', '/repo', 'alice');

        // Direct-spawn path was NOT used.
        expect(spawnCalls.length).toBe(0);
        expect(runAsUserCalls.length).toBe(1);
        expect(runAsUserCalls[0].username).toBe('alice');
        expect(runAsUserCalls[0].cwd).toBe('/repo');
        expect(runAsUserCalls[0].command).toBe("'git' 'fetch' 'origin' 'main'");
      } finally {
        mod.__setRunAsUserForTesting(null);
      }
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

    it('uses Bun.spawn directly when requestUser is omitted (default path)', async () => {
      setMockSpawnResult('');
      const { fetchAllRemote } = await getGitModule();

      await fetchAllRemote('/repo');

      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].args).toEqual(['git', 'fetch', 'origin']);
      expect(spawnCalls[0].options.cwd).toBe('/repo');
    });

    it('routes through runAsUser when requestUser is non-empty (elevated path)', async () => {
      const runAsUserCalls: Array<Record<string, unknown>> = [];
      const fakeRunAsUser = async (opts: Record<string, unknown>) => {
        runAsUserCalls.push(opts);
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      };

      const mod = await getGitModule();
      mod.__setRunAsUserForTesting(fakeRunAsUser);
      try {
        await mod.fetchAllRemote('/repo', 'alice');

        expect(spawnCalls.length).toBe(0);
        expect(runAsUserCalls.length).toBe(1);
        expect(runAsUserCalls[0].username).toBe('alice');
        expect(runAsUserCalls[0].cwd).toBe('/repo');
        expect(runAsUserCalls[0].command).toBe("'git' 'fetch' 'origin'");
      } finally {
        mod.__setRunAsUserForTesting(null);
      }
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

  describe('getMergeBaseSafe', () => {
    it('returns the trimmed stdout of git merge-base on exit 0', async () => {
      setMockSpawnResult('abc1234def\n');
      const { getMergeBaseSafe } = await getGitModule();

      const result = await getMergeBaseSafe('main', 'HEAD', '/repo');

      expect(result).toBe('abc1234def');
      expect(spawnCalls[0].args).toEqual(['git', 'merge-base', 'main', 'HEAD']);
      expect(spawnCalls[0].options.cwd).toBe('/repo');
    });

    it('returns null instead of throwing when git exits non-zero', async () => {
      setMockSpawnResult('', 1, 'fatal: Not a valid object name nope');
      const { getMergeBaseSafe } = await getGitModule();

      const result = await getMergeBaseSafe('main', 'nope', '/repo');

      expect(result).toBeNull();
    });

    it('forwards requestUser through the elevated spawn seam', async () => {
      const runAsUserCalls: Array<Record<string, unknown>> = [];
      const fakeRunAsUser = async (opts: Record<string, unknown>) => {
        runAsUserCalls.push(opts);
        return { stdout: 'abc1234\n', stderr: '', exitCode: 0, timedOut: false };
      };

      const mod = await getGitModule();
      mod.__setRunAsUserForTesting(fakeRunAsUser);
      try {
        const result = await mod.getMergeBaseSafe('main', 'HEAD', '/repo', 'alice');

        expect(result).toBe('abc1234');
        expect(spawnCalls.length).toBe(0);
        expect(runAsUserCalls.length).toBe(1);
        expect(runAsUserCalls[0].username).toBe('alice');
        expect(runAsUserCalls[0].cwd).toBe('/repo');
        expect(runAsUserCalls[0].command).toBe("'git' 'merge-base' 'main' 'HEAD'");
      } finally {
        mod.__setRunAsUserForTesting(null);
      }
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

    it('uses Bun.spawn directly when requestUser is omitted (default path)', async () => {
      setSequentialMockResults([
        { stdout: 'abc1234\n' },       // git rev-parse HEAD (before)
        { stdout: '' },                 // git pull --ff-only
        { stdout: 'abc1234\n' },       // git rev-parse HEAD (after, up to date)
      ]);
      const { pullFastForward } = await getGitModule();

      const result = await pullFastForward('/repo');
      // HEAD unchanged → up-to-date → 0 commits pulled, rev-list not called.
      expect(result).toBe(0);

      // Direct-spawn path was used for every internal git invocation.
      expect(spawnCalls.length).toBe(3);
      expect(spawnCalls[0].args).toEqual(['git', 'rev-parse', 'HEAD']);
      expect(spawnCalls[1].args).toEqual(['git', 'pull', '--ff-only']);
      expect(spawnCalls[2].args).toEqual(['git', 'rev-parse', 'HEAD']);
      for (const call of spawnCalls) {
        expect(call.options.cwd).toBe('/repo');
      }
    });

    it('routes every internal git call through runAsUser when requestUser is non-empty (elevated path)', async () => {
      // The bug this test guards against: pullFastForward previously did not
      // accept a requestUser param, so the internal `git pull --ff-only`
      // always ran as the server user and failed against SSH-URL remotes
      // in multi-user mode. Assert that ALL four internal git invocations
      // route through the runAsUser seam with the caller's username.
      const runAsUserCalls: Array<Record<string, unknown>> = [];
      const fakeRunAsUser = async (opts: Record<string, unknown>) => {
        runAsUserCalls.push(opts);
        // Return distinct HEADs so the fourth `rev-list --count` call runs too.
        const command = String(opts.command ?? '');
        if (command.includes("'rev-parse' 'HEAD'")) {
          // First rev-parse returns headBefore; second returns headAfter.
          const revParseCallsSoFar = runAsUserCalls.filter(
            (c) => String(c.command ?? '').includes("'rev-parse' 'HEAD'"),
          ).length;
          const stdout = revParseCallsSoFar === 1 ? 'abc1234' : 'def5678';
          return { stdout, stderr: '', exitCode: 0, timedOut: false };
        }
        if (command.includes("'rev-list' '--count'")) {
          return { stdout: '3', stderr: '', exitCode: 0, timedOut: false };
        }
        // git pull --ff-only
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      };

      const mod = await getGitModule();
      mod.__setRunAsUserForTesting(fakeRunAsUser);
      try {
        const result = await mod.pullFastForward('/repo', 'alice');

        expect(result).toBe(3);
        // Direct-spawn path was NOT used.
        expect(spawnCalls.length).toBe(0);
        // Each of the four internal git calls routed through runAsUser.
        expect(runAsUserCalls.length).toBe(4);
        for (const call of runAsUserCalls) {
          expect(call.username).toBe('alice');
          expect(call.cwd).toBe('/repo');
        }
        expect(runAsUserCalls[0].command).toBe("'git' 'rev-parse' 'HEAD'");
        expect(runAsUserCalls[1].command).toBe("'git' 'pull' '--ff-only'");
        expect(runAsUserCalls[2].command).toBe("'git' 'rev-parse' 'HEAD'");
        expect(runAsUserCalls[3].command).toBe("'git' 'rev-list' '--count' 'abc1234..def5678'");
      } finally {
        mod.__setRunAsUserForTesting(null);
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

    it('maps cwdFailed from runAsUser to a GitError that names the cwd, before the generic non-zero handling', async () => {
      const fakeRunAsUser = async () => ({
        stdout: '',
        stderr: '',
        exitCode: 125,
        timedOut: false,
        cwdFailed: true,
      });

      const mod = await getGitModule();
      mod.__setRunAsUserForTesting(fakeRunAsUser);
      try {
        let caught: unknown;
        try {
          await mod.git(['status'], '/gone/worktree', undefined, 'alice');
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(mod.GitError);
        const error = caught as InstanceType<typeof mod.GitError>;
        expect(error.message).toContain('/gone/worktree');
        expect(error.message).toContain('git status');
        expect(error.message).not.toContain('exit code');
        expect(error.exitCode).toBe(125);
      } finally {
        mod.__setRunAsUserForTesting(null);
      }
    });

    it('does not treat a bare exit 125 (cwdFailed false) as a cwd failure', async () => {
      const fakeRunAsUser = async () => ({
        stdout: '',
        stderr: 'xargs: command failed\n',
        exitCode: 125,
        timedOut: false,
        cwdFailed: false,
      });

      const mod = await getGitModule();
      mod.__setRunAsUserForTesting(fakeRunAsUser);
      try {
        let caught: unknown;
        try {
          await mod.git(['status'], '/repo', undefined, 'alice');
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(mod.GitError);
        expect((caught as Error).message).toContain('xargs: command failed');
        expect((caught as Error).message).not.toContain('working directory');
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

  // =========================================================================
  // deriveRepositorySlug (Issue #1300): the single writer for the canonical
  // org/repo slug used by worktree/template placement, repository-data
  // cleanup, and (as of this Issue) session-creation's frozen dataScopeSlug.
  // Total by contract: every branch below returns `fallback` instead of
  // throwing.
  // =========================================================================
  describe('deriveRepositorySlug (Issue #1300)', () => {
    it('returns org/repo parsed from an SSH remote URL', async () => {
      setMockSpawnResult('git@github.com:owner/repo-name.git\n');
      const { deriveRepositorySlug } = await getGitModule();

      const result = await deriveRepositorySlug('/repo', 'repo-name');

      expect(result).toBe('owner/repo-name');
    });

    it('returns org/repo parsed from an HTTPS remote URL', async () => {
      setMockSpawnResult('https://github.com/anthropics/claude-code.git\n');
      const { deriveRepositorySlug } = await getGitModule();

      const result = await deriveRepositorySlug('/repo', 'claude-code');

      expect(result).toBe('anthropics/claude-code');
    });

    it('returns the fallback verbatim when no remote is configured (local-only repo)', async () => {
      // `git remote get-url origin` exits non-zero when no such remote
      // exists -- gitSafe swallows the GitError and getRemoteUrl returns
      // null.
      setMockSpawnResult('', 128, "fatal: No such remote 'origin'");
      const { deriveRepositorySlug } = await getGitModule();

      const result = await deriveRepositorySlug('/repo', 'my-local-repo');

      expect(result).toBe('my-local-repo');
    });

    it('returns the fallback when the remote URL does not match a parseable org/repo shape', async () => {
      setMockSpawnResult('some-nonstandard-remote-format\n');
      const { deriveRepositorySlug } = await getGitModule();

      const result = await deriveRepositorySlug('/repo', 'my-repo');

      expect(result).toBe('my-repo');
    });

    it('returns the fallback, never a throw, when the parsed org/repo contains a traversal segment', async () => {
      // Captures group 'owner/..' -- parseOrgRepo has no traversal
      // awareness (it is a pure regex extraction), so isValidSlug is the
      // gate that must catch this.
      setMockSpawnResult('git@github.com:owner/..\n');
      const { deriveRepositorySlug } = await getGitModule();

      const result = await deriveRepositorySlug('/repo', 'safe-fallback');

      expect(result).toBe('safe-fallback');
    });

    it('returns the fallback, never a throw, when the parsed org/repo contains characters outside the slug grammar', async () => {
      setMockSpawnResult('git@github.com:owner/repo name.git\n');
      const { deriveRepositorySlug } = await getGitModule();

      const result = await deriveRepositorySlug('/repo', 'safe-fallback');

      expect(result).toBe('safe-fallback');
    });

    it('passes the caller-supplied fallback through unchanged (never repo.name / a display name)', async () => {
      setMockSpawnResult('', 128, "fatal: No such remote 'origin'");
      const { deriveRepositorySlug } = await getGitModule();

      const result = await deriveRepositorySlug('/repo', 'exact-fallback-value');

      expect(result).toBe('exact-fallback-value');
    });
  });

  // =========================================================================
  // describeRemoteUrlShapeForLogging (CodeRabbit finding on Issue #1300's
  // PR #1328): the credential-safe diagnostic used on deriveRepositorySlug's
  // unparseable-URL branch, which is the branch most likely to see a URL
  // carrying embedded credentials (a URL that deviates from the ordinary
  // SSH/HTTPS shapes is exactly the shape a `user:pass@host` URL would take
  // here). Never returns the raw value.
  // =========================================================================
  describe('describeRemoteUrlShapeForLogging', () => {
    it('strips embedded HTTPS credentials, returning only protocol + hostname', async () => {
      const { describeRemoteUrlShapeForLogging } = await getGitModule();

      const result = describeRemoteUrlShapeForLogging('https://user:s3cr3t-token@example.com/org/repo.git');

      expect(result).toBe('https://example.com');
      expect(result).not.toContain('user');
      expect(result).not.toContain('s3cr3t-token');
    });

    it('returns protocol + hostname for a credential-free URL', async () => {
      const { describeRemoteUrlShapeForLogging } = await getGitModule();

      const result = describeRemoteUrlShapeForLogging('https://gitlab.example.com/org/repo.git');

      expect(result).toBe('https://gitlab.example.com');
    });

    it('returns a fixed marker for an scp-style SSH shape (not a WHATWG URL)', async () => {
      const { describeRemoteUrlShapeForLogging } = await getGitModule();

      const result = describeRemoteUrlShapeForLogging('git@github.com:owner/repo.git');

      expect(result).toBe('<non-URL remote shape>');
    });

    it('returns a fixed marker for a garbage, unparseable value rather than echoing it', async () => {
      const { describeRemoteUrlShapeForLogging } = await getGitModule();

      const result = describeRemoteUrlShapeForLogging('not a url at all');

      expect(result).toBe('<non-URL remote shape>');
    });
  });

  // =========================================================================
  // getCurrentBranch / renameBranch requestUser routing (Issue #1622)
  //
  // Sibling helpers in this file (fetchRemote, refreshDefaultBranch, etc.)
  // already accept a trailing `requestUser` and route through `runAsUser` in
  // multi-user mode. getCurrentBranch/renameBranch did not, so a branch
  // rename during worker restart on a user-owned worktree failed with
  // "dubious ownership" -- the direct-spawn path always ran as the server
  // process user. Model these on the `requestUser routing (Issue #869 /
  // #870)` block above.
  // =========================================================================
  describe('getCurrentBranch / renameBranch requestUser routing (Issue #1622)', () => {
    describe('getCurrentBranch', () => {
      it('uses Bun.spawn directly when requestUser is omitted (default path)', async () => {
        setMockSpawnResult('main\n');
        const { getCurrentBranch } = await getGitModule();

        const result = await getCurrentBranch('/repo');

        expect(result).toBe('main');
        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args).toEqual(['git', 'branch', '--show-current']);
        expect(spawnCalls[0].options.cwd).toBe('/repo');
      });

      it('routes through runAsUser when requestUser is non-empty (elevated path)', async () => {
        const runAsUserCalls: Array<Record<string, unknown>> = [];
        const fakeRunAsUser = async (opts: Record<string, unknown>) => {
          runAsUserCalls.push(opts);
          return { stdout: 'feature-branch\n', stderr: '', exitCode: 0, timedOut: false };
        };

        const mod = await getGitModule();
        mod.__setRunAsUserForTesting(fakeRunAsUser);
        try {
          const result = await mod.getCurrentBranch('/repo', 'alice');

          expect(result).toBe('feature-branch');
          // Direct-spawn path was NOT used.
          expect(spawnCalls.length).toBe(0);
          expect(runAsUserCalls.length).toBe(1);
          expect(runAsUserCalls[0].username).toBe('alice');
          expect(runAsUserCalls[0].cwd).toBe('/repo');
          expect(runAsUserCalls[0].command).toBe("'git' 'branch' '--show-current'");
        } finally {
          mod.__setRunAsUserForTesting(null);
        }
      });

      it('swallows a thrown error into "(unknown)" on the elevated path too', async () => {
        const fakeRunAsUser = async () => ({
          stdout: '',
          stderr: 'fatal: not a git repository\n',
          exitCode: 128,
          timedOut: false,
        });

        const mod = await getGitModule();
        mod.__setRunAsUserForTesting(fakeRunAsUser);
        try {
          const result = await mod.getCurrentBranch('/repo', 'alice');

          expect(result).toBe('(unknown)');
        } finally {
          mod.__setRunAsUserForTesting(null);
        }
      });

      // Polarity measured: removing the `logger.warn(...)` call from the
      // catch block (keeping the `'(unknown)'` return) makes both warn
      // assertions below fail while the return-value assertion still
      // passes -- confirming the warn pins the previously-silent swallow,
      // not the pre-existing sentinel contract.
      it('logs a warn naming cwd when the branch read fails', async () => {
        const fakeRunAsUser = async () => ({
          stdout: '',
          stderr: 'fatal: detected dubious ownership\n',
          exitCode: 128,
          timedOut: false,
        });

        const warnSpy = spyOn(rootLogger, 'warn');
        const mod = await getGitModule();
        mod.__setRunAsUserForTesting(fakeRunAsUser);
        try {
          const result = await mod.getCurrentBranch('/repo', 'alice');

          expect(result).toBe('(unknown)');
          expect(warnSpy.mock.calls.length).toBe(1);
          expect(warnSpy.mock.calls[0]![0]).toMatchObject({ cwd: '/repo' });
        } finally {
          mod.__setRunAsUserForTesting(null);
          warnSpy.mockRestore();
        }
      });

      it('does not warn when the branch read succeeds', async () => {
        setMockSpawnResult('main\n');
        const warnSpy = spyOn(rootLogger, 'warn');
        const { getCurrentBranch } = await getGitModule();
        try {
          const result = await getCurrentBranch('/repo');

          expect(result).toBe('main');
          expect(warnSpy.mock.calls.length).toBe(0);
        } finally {
          warnSpy.mockRestore();
        }
      });
    });

    describe('renameBranch', () => {
      it('uses Bun.spawn directly when requestUser is omitted (default path)', async () => {
        setMockSpawnResult('');
        const { renameBranch } = await getGitModule();

        await renameBranch('old-name', 'new-name', '/repo');

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args).toEqual(['git', 'branch', '-m', 'old-name', 'new-name']);
        expect(spawnCalls[0].options.cwd).toBe('/repo');
      });

      it('routes through runAsUser when requestUser is non-empty (elevated path)', async () => {
        const runAsUserCalls: Array<Record<string, unknown>> = [];
        const fakeRunAsUser = async (opts: Record<string, unknown>) => {
          runAsUserCalls.push(opts);
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
        };

        const mod = await getGitModule();
        mod.__setRunAsUserForTesting(fakeRunAsUser);
        try {
          await mod.renameBranch('old-name', 'new-name', '/repo', 'alice');

          // Direct-spawn path was NOT used.
          expect(spawnCalls.length).toBe(0);
          expect(runAsUserCalls.length).toBe(1);
          expect(runAsUserCalls[0].username).toBe('alice');
          expect(runAsUserCalls[0].cwd).toBe('/repo');
          expect(runAsUserCalls[0].command).toBe("'git' 'branch' '-m' 'old-name' 'new-name'");
        } finally {
          mod.__setRunAsUserForTesting(null);
        }
      });
    });
  });
  describe('readWorkingTreeFile', () => {
    type Opts = { username: string; command: string; cwd: string; timeoutMs?: number };
    const captureSeam = (result: { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean; cwdFailed?: boolean }) => {
      const calls: Opts[] = [];
      const fake = async (opts: Opts) => {
        calls.push(opts);
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, cwdFailed: false, ...result };
      };
      return { calls, fake };
    };

    describe('direct path (requestUser null, single-user mode)', () => {
      let tmpDir: string;
      beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'read-working-tree-'));
      });
      afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
      });

      it('reads a file and never touches the runAsUser seam', async () => {
        writeFileSync(join(tmpDir, 'a.txt'), 'hello\n');
        const { calls, fake } = captureSeam({});
        const mod = await getGitModule();
        mod.__setRunAsUserForTesting(fake);
        try {
          const result = await mod.readWorkingTreeFile(tmpDir, 'a.txt', null);
          expect(result.kind).toBe('file');
          expect(result.content.toString('utf-8')).toBe('hello\n');
          expect(calls.length).toBe(0);
        } finally {
          mod.__setRunAsUserForTesting(null);
        }
      });

      it('returns null for a missing file', async () => {
        const mod = await getGitModule();
        expect(await mod.readWorkingTreeFile(tmpDir, 'missing.txt')).toBeNull();
      });

      it('returns kind directory for a directory', async () => {
        mkdirSync(join(tmpDir, 'sub'));
        const mod = await getGitModule();
        expect(await mod.readWorkingTreeFile(tmpDir, 'sub', '')).toEqual({ kind: 'directory' });
      });
    });

    describe('elevated path (multi-user mode, requestUser set)', () => {
      it('runs cat as the user with the escaped path, cwd and timeout, and returns stdout as a Buffer', async () => {
        const { calls, fake } = captureSeam({ stdout: 'line1\nline2\n' });
        const mod = await getGitModule();
        mod.__setRunAsUserForTesting(fake);
        try {
          const result = await mod.readWorkingTreeFile('/work/tree', "dir/it's.ts", 'alice');
          expect(result.kind).toBe('file');
          expect(result.content.toString('utf-8')).toBe('line1\nline2\n');
          expect(calls.length).toBe(1);
          expect(calls[0].username).toBe('alice');
          expect(calls[0].cwd).toBe('/work/tree');
          expect(calls[0].timeoutMs).toBe(30000);
          const e = shellEscape(join('/work/tree', "dir/it's.ts"));
          expect(calls[0].command).toBe(`test -d ${e} && exit 42; cat -- ${e}`);
        } finally {
          mod.__setRunAsUserForTesting(null);
        }
      });

      it('maps exit code 42 with empty stdout to kind directory', async () => {
        const { fake } = captureSeam({ exitCode: 42, stdout: '' });
        const mod = await getGitModule();
        mod.__setRunAsUserForTesting(fake);
        try {
          expect(await mod.readWorkingTreeFile('/work/tree', 'sub', 'alice')).toEqual({ kind: 'directory' });
        } finally {
          mod.__setRunAsUserForTesting(null);
        }
      });

      it('maps cwdFailed to a GitError naming the cwd instead of reading as if the file were absent', async () => {
        const { fake } = captureSeam({ exitCode: 125, cwdFailed: true });
        const mod = await getGitModule();
        mod.__setRunAsUserForTesting(fake);
        try {
          let caught: unknown;
          try {
            await mod.readWorkingTreeFile('/gone/worktree', 'a.txt', 'alice');
          } catch (err) {
            caught = err;
          }
          expect(caught).toBeInstanceOf(mod.GitError);
          expect((caught as Error).message).toContain('/gone/worktree');
          expect((caught as Error).message).toContain('read a.txt');
        } finally {
          mod.__setRunAsUserForTesting(null);
        }
      });

      it('treats a regular file whose content is exactly __AC_DIR__ as a file', async () => {
        const { fake } = captureSeam({ exitCode: 0, stdout: '__AC_DIR__\n' });
        const mod = await getGitModule();
        mod.__setRunAsUserForTesting(fake);
        try {
          const result = await mod.readWorkingTreeFile('/work/tree', 'marker.txt', 'alice');
          expect(result.kind).toBe('file');
          expect(result.content.toString('utf-8')).toBe('__AC_DIR__\n');
        } finally {
          mod.__setRunAsUserForTesting(null);
        }
      });

      it('maps a "No such file" failure to null', async () => {
        const { fake } = captureSeam({ exitCode: 1, stderr: 'cat: x: No such file or directory\n' });
        const mod = await getGitModule();
        mod.__setRunAsUserForTesting(fake);
        try {
          expect(await mod.readWorkingTreeFile('/work/tree', 'x', 'alice')).toBeNull();
        } finally {
          mod.__setRunAsUserForTesting(null);
        }
      });

      it('throws GitError for any other failure', async () => {
        const { fake } = captureSeam({ exitCode: 1, stderr: 'cat: x: Permission denied\n' });
        const mod = await getGitModule();
        mod.__setRunAsUserForTesting(fake);
        try {
          const err = await mod.readWorkingTreeFile('/work/tree', 'x', 'alice').catch((e: unknown) => e);
          expect(err).toBeInstanceOf(mod.GitError);
          expect(err.exitCode).toBe(1);
          expect(err.stderr).toContain('Permission denied');
        } finally {
          mod.__setRunAsUserForTesting(null);
        }
      });

      it('throws GitError on timeout and on a spawn failure', async () => {
        const mod = await getGitModule();
        mod.__setRunAsUserForTesting(captureSeam({ timedOut: true, exitCode: -1 }).fake);
        try {
          await expect(mod.readWorkingTreeFile('/w', 'x', 'alice')).rejects.toBeInstanceOf(mod.GitError);
          mod.__setRunAsUserForTesting(async () => {
            throw new Error('spawn failed');
          });
          await expect(mod.readWorkingTreeFile('/w', 'x', 'alice')).rejects.toBeInstanceOf(mod.GitError);
        } finally {
          mod.__setRunAsUserForTesting(null);
        }
      });
    });

    describe('mode matrix (target-environment cross-check)', () => {
      it('single-user mode: requestUser null never calls the seam', async () => {
        const { calls, fake } = captureSeam({});
        const mod = await getGitModule();
        mod.__setRunAsUserForTesting(fake);
        try {
          await mod.readWorkingTreeFile('/nonexistent-dir', 'a.txt', null);
          expect(calls.length).toBe(0);
        } finally {
          mod.__setRunAsUserForTesting(null);
        }
      });

      it('single-user mode: omitted requestUser never calls the seam', async () => {
        const { calls, fake } = captureSeam({});
        const mod = await getGitModule();
        mod.__setRunAsUserForTesting(fake);
        try {
          await mod.readWorkingTreeFile('/nonexistent-dir', 'a.txt');
          expect(calls.length).toBe(0);
        } finally {
          mod.__setRunAsUserForTesting(null);
        }
      });

      it('multi-user mode: a session owner name is handed to the seam', async () => {
        const { calls, fake } = captureSeam({ stdout: 'x' });
        const mod = await getGitModule();
        mod.__setRunAsUserForTesting(fake);
        try {
          await mod.readWorkingTreeFile('/home/bob/wt', 'a.txt', 'bob');
          expect(calls.map((c) => c.username)).toEqual(['bob']);
        } finally {
          mod.__setRunAsUserForTesting(null);
        }
      });
    });
  });
});
