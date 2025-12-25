import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import * as fs from 'fs';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { mockGit, GitError } from '../../__tests__/utils/mock-git-helper.js';

// Test config directory
const TEST_CONFIG_DIR = '/test/config';

let importCounter = 0;

// Mock Bun.spawn for executeSetupCommand tests
let mockSpawnResult: {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
};

const originalBunSpawn = Bun.spawn;
let spawnCalls: Array<{ args: string[]; options: Record<string, unknown> }> = [];

// Helper to set mock spawn result
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

describe('WorktreeService', () => {
  beforeEach(() => {
    // Setup memfs with config directory structure
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    // Reset mocks
    mockGit.getRemoteUrl.mockReset();
    mockGit.parseOrgRepo.mockReset();
    mockGit.listWorktrees.mockReset();
    mockGit.createWorktree.mockReset();
    mockGit.removeWorktree.mockReset();
    mockGit.listLocalBranches.mockReset();
    mockGit.listRemoteBranches.mockReset();
    mockGit.getDefaultBranch.mockReset();

    // Default implementations
    mockGit.getRemoteUrl.mockImplementation(() => Promise.resolve('git@github.com:owner/repo-name.git'));
    mockGit.parseOrgRepo.mockImplementation(() => 'owner/repo-name');
    mockGit.listWorktrees.mockImplementation(() => Promise.resolve(`worktree /repo/main
HEAD abc123
branch refs/heads/main

worktree /worktrees/feature-1
HEAD def456
branch refs/heads/feature-1
`));
    mockGit.createWorktree.mockImplementation(() => Promise.resolve());
    mockGit.removeWorktree.mockImplementation(() => Promise.resolve());
    mockGit.listLocalBranches.mockImplementation(() => Promise.resolve(['main', 'feature-1', 'feature-2']));
    mockGit.listRemoteBranches.mockImplementation(() => Promise.resolve(['origin/main', 'origin/develop']));
    mockGit.getDefaultBranch.mockImplementation(() => Promise.resolve('main'));
  });

  afterEach(() => {
    cleanupMemfs();
  });

  // Helper to get fresh module instance
  async function getWorktreeService() {
    const module = await import(`../worktree-service.js?v=${++importCounter}`);
    return module.WorktreeService;
  }

  describe('listWorktrees', () => {
    it('should only return main worktree and worktrees registered in index store', async () => {
      // Create index store with one registered worktree
      const indexStorePath = `${TEST_CONFIG_DIR}/repositories/owner/repo-name/worktrees`;
      fs.mkdirSync(indexStorePath, { recursive: true });
      fs.writeFileSync(
        `${indexStorePath}/worktree-indexes.json`,
        JSON.stringify({ indexes: { '/worktrees/feature-1': 1 } })
      );

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const worktrees = await service.listWorktrees('/repo/main', 'repo-1');

      expect(worktrees.length).toBe(2);
      expect(worktrees[0].path).toBe('/repo/main');
      expect(worktrees[0].branch).toBe('main');
      expect(worktrees[0].isMain).toBe(true);
      expect(worktrees[0].index).toBeUndefined();

      expect(worktrees[1].path).toBe('/worktrees/feature-1');
      expect(worktrees[1].branch).toBe('feature-1');
      expect(worktrees[1].isMain).toBe(false);
      expect(worktrees[1].index).toBe(1);
    });

    it('should filter out worktrees not registered in index store', async () => {
      // Create empty index store
      const indexStorePath = `${TEST_CONFIG_DIR}/repositories/owner/repo-name/worktrees`;
      fs.mkdirSync(indexStorePath, { recursive: true });
      fs.writeFileSync(
        `${indexStorePath}/worktree-indexes.json`,
        JSON.stringify({ indexes: {} })
      );

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const worktrees = await service.listWorktrees('/repo/main', 'repo-1');

      // Only main worktree should be returned
      expect(worktrees.length).toBe(1);
      expect(worktrees[0].path).toBe('/repo/main');
      expect(worktrees[0].isMain).toBe(true);
    });

    it('should handle detached HEAD worktree', async () => {
      mockGit.listWorktrees.mockImplementation(() => Promise.resolve(`worktree /repo/main
HEAD abc1234567890
detached
`));

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const worktrees = await service.listWorktrees('/repo/main', 'repo-1');

      expect(worktrees[0].branch).toBe('(detached at abc1234)');
    });

    it('should return empty array on error', async () => {
      mockGit.listWorktrees.mockImplementation(() => Promise.reject(new Error('git error')));

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const worktrees = await service.listWorktrees('/repo', 'repo-1');
      expect(worktrees).toEqual([]);
    });
  });

  describe('createWorktree', () => {
    it('should create worktree with existing branch', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const result = await service.createWorktree('/repo', 'feature-branch');

      expect(result.error).toBeUndefined();
      // Directory name is wt-XXX-xxxx format, independent of branch name
      expect(result.worktreePath).toMatch(/wt-\d{3}-[a-z0-9]{4}$/);
      expect(result.index).toBeDefined();
      // Verify createWorktree was called with correct arguments
      expect(mockGit.createWorktree).toHaveBeenCalledWith(
        expect.stringMatching(/wt-\d{3}-[a-z0-9]{4}$/),
        'feature-branch',
        '/repo',
        { baseBranch: undefined }
      );
    });

    it('should create worktree with new branch from base', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      await service.createWorktree('/repo', 'new-feature', 'main');

      expect(mockGit.createWorktree).toHaveBeenCalledWith(
        expect.stringMatching(/wt-\d{3}-[a-z0-9]{4}$/),
        'new-feature',
        '/repo',
        { baseBranch: 'main' }
      );
    });

    it('should return error on failure', async () => {
      mockGit.createWorktree.mockImplementation(() =>
        Promise.reject(new GitError('branch already exists', 128, 'fatal: branch already exists'))
      );

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const result = await service.createWorktree('/repo', 'existing-branch');

      expect(result.error).toBeDefined();
      expect(result.worktreePath).toBe('');
    });
  });

  describe('removeWorktree', () => {
    it('should remove worktree successfully', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const result = await service.removeWorktree('/repo', '/worktrees/feature');

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should use force flag when specified', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      await service.removeWorktree('/repo', '/worktrees/feature', true);

      expect(mockGit.removeWorktree).toHaveBeenCalledWith(
        '/worktrees/feature',
        '/repo',
        { force: true }
      );
    });

    it('should return error on failure', async () => {
      mockGit.removeWorktree.mockImplementation(() =>
        Promise.reject(new GitError('worktree has changes', 128, 'fatal: worktree has uncommitted changes'))
      );

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const result = await service.removeWorktree('/repo', '/worktrees/feature');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('listBranches', () => {
    it('should list local and remote branches', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const result = await service.listBranches('/repo');

      expect(result.local).toContain('main');
      expect(result.local).toContain('feature-1');
      expect(result.remote).toContain('origin/main');
      expect(result.defaultBranch).toBe('main');
    });

    it('should return empty arrays on error', async () => {
      mockGit.listLocalBranches.mockImplementation(() => Promise.reject(new Error('git error')));
      mockGit.listRemoteBranches.mockImplementation(() => Promise.reject(new Error('git error')));
      mockGit.getDefaultBranch.mockImplementation(() => Promise.reject(new Error('git error')));

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const result = await service.listBranches('/repo');

      expect(result.local).toEqual([]);
      expect(result.remote).toEqual([]);
      expect(result.defaultBranch).toBeNull();
    });
  });

  describe('getDefaultBranch', () => {
    it('should return default branch from git', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const result = await service.getDefaultBranch('/repo');
      expect(result).toBe('main');
    });

    it('should return null if no default branch found', async () => {
      mockGit.getDefaultBranch.mockImplementation(() => Promise.resolve(null));

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const result = await service.getDefaultBranch('/repo');
      expect(result).toBeNull();
    });
  });

  describe('isWorktreeOf', () => {
    it('should return true for valid worktree path', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      // listWorktrees will return /repo/main and /worktrees/feature-1
      const result = await service.isWorktreeOf('/repo/main', '/repo/main');
      expect(result).toBe(true);
    });

    it('should return true for secondary worktree path', async () => {
      // Create index store with registered worktree
      const indexStorePath = `${TEST_CONFIG_DIR}/repositories/owner/repo-name/worktrees`;
      fs.mkdirSync(indexStorePath, { recursive: true });
      fs.writeFileSync(
        `${indexStorePath}/worktree-indexes.json`,
        JSON.stringify({ indexes: { '/worktrees/feature-1': 1 } })
      );

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const result = await service.isWorktreeOf('/repo/main', '/worktrees/feature-1');
      expect(result).toBe(true);
    });

    it('should return false for invalid worktree path', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const result = await service.isWorktreeOf('/repo/main', '/other/path');
      expect(result).toBe(false);
    });
  });

  describe('executeSetupCommand', () => {
    beforeEach(() => {
      // Reset spawn tracking
      spawnCalls = [];

      // Default mock result (successful command)
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

    describe('template variable substitution', () => {
      it('should substitute {{WORKTREE_NUM}} variable', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        await service.executeSetupCommand(
          'echo {{WORKTREE_NUM}}',
          '/test/worktree',
          { worktreeNum: 5, branch: 'feature-1', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args[2]).toBe('echo 5');
      });

      it('should substitute {{BRANCH}} variable', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        await service.executeSetupCommand(
          'git checkout {{BRANCH}}',
          '/test/worktree',
          { worktreeNum: 1, branch: 'feature/my-branch', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args[2]).toBe('git checkout feature/my-branch');
      });

      it('should substitute {{REPO}} variable', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        await service.executeSetupCommand(
          'echo Working on {{REPO}}',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'awesome-project' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args[2]).toBe('echo Working on awesome-project');
      });

      it('should substitute {{WORKTREE_PATH}} variable', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        await service.executeSetupCommand(
          'cd {{WORKTREE_PATH}} && ls',
          '/home/user/worktrees/wt-001',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args[2]).toBe('cd /home/user/worktrees/wt-001 && ls');
      });

      it('should substitute multiple variables in a single command', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        await service.executeSetupCommand(
          'echo "WT {{WORKTREE_NUM}} for {{REPO}} on {{BRANCH}} at {{WORKTREE_PATH}}"',
          '/worktrees/wt-003',
          { worktreeNum: 3, branch: 'fix/bug-123', repo: 'test-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args[2]).toBe('echo "WT 3 for test-repo on fix/bug-123 at /worktrees/wt-003"');
      });
    });

    describe('arithmetic expressions', () => {
      it('should evaluate {{WORKTREE_NUM + N}} addition', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        await service.executeSetupCommand(
          'export PORT={{WORKTREE_NUM + 3000}}',
          '/test/worktree',
          { worktreeNum: 5, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args[2]).toBe('export PORT=3005');
      });

      it('should evaluate {{WORKTREE_NUM - N}} subtraction', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        await service.executeSetupCommand(
          'echo {{WORKTREE_NUM - 2}}',
          '/test/worktree',
          { worktreeNum: 10, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args[2]).toBe('echo 8');
      });

      it('should evaluate {{WORKTREE_NUM * N}} multiplication', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        await service.executeSetupCommand(
          'echo {{WORKTREE_NUM * 100}}',
          '/test/worktree',
          { worktreeNum: 3, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args[2]).toBe('echo 300');
      });

      it('should evaluate {{WORKTREE_NUM / N}} division (floor)', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        await service.executeSetupCommand(
          'echo {{WORKTREE_NUM / 3}}',
          '/test/worktree',
          { worktreeNum: 10, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        // 10 / 3 = 3 (floor)
        expect(spawnCalls[0].args[2]).toBe('echo 3');
      });

      it('should handle arithmetic with spaces around operator', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        await service.executeSetupCommand(
          'export PORT={{WORKTREE_NUM   +   8080}}',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args[2]).toBe('export PORT=8081');
      });
    });

    describe('successful command execution', () => {
      it('should return success true and stdout output on exit code 0', async () => {
        setMockSpawnResult('command output here\nsecond line');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        const result = await service.executeSetupCommand(
          'echo "hello"',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' }
        );

        expect(result.success).toBe(true);
        expect(result.output).toBe('command output here\nsecond line');
        expect(result.error).toBeUndefined();
      });

      it('should return undefined output when stdout is empty', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        const result = await service.executeSetupCommand(
          'silent-command',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' }
        );

        expect(result.success).toBe(true);
        expect(result.output).toBeUndefined();
        expect(result.error).toBeUndefined();
      });
    });

    describe('failed command execution', () => {
      it('should return success false and stderr on non-zero exit code', async () => {
        setMockSpawnResult('partial output', 1, 'command not found');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        const result = await service.executeSetupCommand(
          'invalid-command',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' }
        );

        expect(result.success).toBe(false);
        expect(result.output).toBe('partial output');
        expect(result.error).toBe('command not found');
      });

      it('should include exit code in error when stderr is empty', async () => {
        setMockSpawnResult('', 127, '');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        const result = await service.executeSetupCommand(
          'nonexistent-command',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' }
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('127');
      });

      it('should handle various non-zero exit codes', async () => {
        setMockSpawnResult('', 2, 'permission denied');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        const result = await service.executeSetupCommand(
          'protected-command',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' }
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe('permission denied');
      });
    });

    describe('environment variable injection', () => {
      it('should inject WORKTREE_NUM environment variable', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        await service.executeSetupCommand(
          'echo $WORKTREE_NUM',
          '/test/worktree',
          { worktreeNum: 42, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        const env = spawnCalls[0].options.env as Record<string, string>;
        expect(env.WORKTREE_NUM).toBe('42');
      });

      it('should inject BRANCH environment variable', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        await service.executeSetupCommand(
          'echo $BRANCH',
          '/test/worktree',
          { worktreeNum: 1, branch: 'feature/new-feature', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        const env = spawnCalls[0].options.env as Record<string, string>;
        expect(env.BRANCH).toBe('feature/new-feature');
      });

      it('should inject REPO environment variable', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        await service.executeSetupCommand(
          'echo $REPO',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'test-repository' }
        );

        expect(spawnCalls.length).toBe(1);
        const env = spawnCalls[0].options.env as Record<string, string>;
        expect(env.REPO).toBe('test-repository');
      });

      it('should inject WORKTREE_PATH environment variable', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        await service.executeSetupCommand(
          'echo $WORKTREE_PATH',
          '/home/user/worktrees/wt-005',
          { worktreeNum: 5, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        const env = spawnCalls[0].options.env as Record<string, string>;
        expect(env.WORKTREE_PATH).toBe('/home/user/worktrees/wt-005');
      });

      it('should preserve existing process environment variables', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        await service.executeSetupCommand(
          'echo $PATH',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        const env = spawnCalls[0].options.env as Record<string, string>;
        // Should still have PATH from process.env
        expect(env.PATH).toBeDefined();
      });
    });

    describe('command execution context', () => {
      it('should execute command in worktree directory (cwd)', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        await service.executeSetupCommand(
          'pwd',
          '/home/user/worktrees/wt-001',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].options.cwd).toBe('/home/user/worktrees/wt-001');
      });

      it('should execute command via sh -c', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService();

        await service.executeSetupCommand(
          'npm install && npm run build',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args[0]).toBe('sh');
        expect(spawnCalls[0].args[1]).toBe('-c');
        expect(spawnCalls[0].args[2]).toBe('npm install && npm run build');
      });
    });
  });
});
