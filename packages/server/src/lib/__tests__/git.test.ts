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
});
