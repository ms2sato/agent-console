import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import * as fs from 'fs';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { mockGit, GitError } from '../../__tests__/utils/mock-git-helper.js';
import type { Worktree } from '@agent-console/shared';
import type { WorktreeRepository, WorktreeRecord } from '../../repositories/worktree-repository.js';

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

/**
 * Create an in-memory mock WorktreeRepository for testing.
 * Stores records in a plain array, avoiding any database dependency.
 */
function createMockWorktreeRepository(): WorktreeRepository & { records: WorktreeRecord[] } {
  const records: WorktreeRecord[] = [];
  return {
    records,
    async findByRepositoryId(repositoryId: string) {
      return records.filter(r => r.repositoryId === repositoryId);
    },
    async findByPath(path: string) {
      return records.find(r => r.path === path) ?? null;
    },
    async save(record: WorktreeRecord) {
      records.push(record);
    },
    async deleteByPath(path: string) {
      const idx = records.findIndex(r => r.path === path);
      if (idx >= 0) records.splice(idx, 1);
    },
  };
}

describe('WorktreeService', () => {
  let mockRepo: ReturnType<typeof createMockWorktreeRepository>;

  beforeEach(() => {
    // Setup memfs with config directory structure
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    // Create fresh mock repository for each test
    mockRepo = createMockWorktreeRepository();

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
    it('should only return main worktree and worktrees registered in DB', async () => {
      // Register one worktree in the mock repository
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature-1',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService(mockRepo);

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

    it('should filter out worktrees not registered in DB', async () => {
      // No records in mock repository - only main worktree should be returned
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService(mockRepo);

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
      const service = new WorktreeService(mockRepo);

      const worktrees = await service.listWorktrees('/repo/main', 'repo-1');

      expect(worktrees[0].branch).toBe('(detached at abc1234)');
    });

    it('should return empty array on error', async () => {
      mockGit.listWorktrees.mockImplementation(() => Promise.reject(new Error('git error')));

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService(mockRepo);

      const worktrees = await service.listWorktrees('/repo', 'repo-1');
      expect(worktrees).toEqual([]);
    });

    it('should include orphaned worktrees (in DB but not in git)', async () => {
      // Add DB record for a worktree that will not appear in git output
      mockRepo.records.push({
        id: 'wt-orphaned',
        repositoryId: 'repo-1',
        path: '/worktrees/orphaned-1',
        indexNumber: 2,
        createdAt: new Date().toISOString(),
      });
      // Also add a normal registered worktree
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature-1',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService(mockRepo);
      const worktrees = await service.listWorktrees('/repo/main', 'repo-1');

      // Should include: main + feature-1 (from git) + orphaned-1 (from DB only)
      expect(worktrees.length).toBe(3);
      const orphaned = worktrees.find((wt: Worktree) => wt.path === '/worktrees/orphaned-1');
      expect(orphaned).toBeDefined();
      expect(orphaned!.branch).toBe('(orphaned)');
      expect(orphaned!.index).toBe(2);
    });
  });

  describe('createWorktree', () => {
    it('should create worktree with existing branch', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService(mockRepo);

      const result = await service.createWorktree('/repo', 'feature-branch', 'repo-1');

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
      // Verify record was saved to mock repository
      expect(mockRepo.records.length).toBe(1);
      expect(mockRepo.records[0].repositoryId).toBe('repo-1');
      expect(mockRepo.records[0].path).toBe(result.worktreePath);
    });

    it('should create worktree with new branch from base', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService(mockRepo);

      await service.createWorktree('/repo', 'new-feature', 'repo-1', 'main');

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
      const service = new WorktreeService(mockRepo);

      const result = await service.createWorktree('/repo', 'existing-branch', 'repo-1');

      expect(result.error).toBeDefined();
      expect(result.worktreePath).toBe('');
    });

    describe('template copying', () => {
      it('should copy template files from repo-local .agent-console/ directory', async () => {
        // Setup: create /repo/.agent-console/ with a template file
        fs.mkdirSync('/repo/.agent-console', { recursive: true });
        fs.writeFileSync('/repo/.agent-console/CLAUDE.md', 'hello world');

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService(mockRepo);

        const result = await service.createWorktree('/repo', 'feature-branch', 'repo-1');

        expect(result.error).toBeUndefined();
        expect(result.copiedFiles).toContain('CLAUDE.md');
        // Verify the file was actually written to the worktree
        const content = fs.readFileSync(`${result.worktreePath}/CLAUDE.md`, 'utf-8');
        expect(content).toBe('hello world');
      });

      it('should fall back to global templates when .agent-console/ does not exist', async () => {
        // Setup: create global templates dir (no /repo/.agent-console/)
        // /repo must exist as a directory but without .agent-console
        fs.mkdirSync('/repo', { recursive: true });
        const globalTemplatesDir = `${TEST_CONFIG_DIR}/repositories/owner/repo-name/templates`;
        fs.mkdirSync(globalTemplatesDir, { recursive: true });
        fs.writeFileSync(`${globalTemplatesDir}/setup.sh`, '#!/bin/bash\necho setup');

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService(mockRepo);

        const result = await service.createWorktree('/repo', 'feature-branch', 'repo-1');

        expect(result.error).toBeUndefined();
        expect(result.copiedFiles).toContain('setup.sh');
        const content = fs.readFileSync(`${result.worktreePath}/setup.sh`, 'utf-8');
        expect(content).toBe('#!/bin/bash\necho setup');
      });

      it('should substitute template variables in copied files', async () => {
        fs.mkdirSync('/repo/.agent-console', { recursive: true });
        fs.writeFileSync(
          '/repo/.agent-console/config.txt',
          'branch={{BRANCH}} num={{WORKTREE_NUM}}'
        );

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService(mockRepo);

        const result = await service.createWorktree('/repo', 'my-feature', 'repo-1');

        expect(result.error).toBeUndefined();
        const content = fs.readFileSync(`${result.worktreePath}/config.txt`, 'utf-8');
        expect(content).toContain('branch=my-feature');
        expect(content).toMatch(/num=\d+/);
      });

      it('should copy nested directory structure', async () => {
        fs.mkdirSync('/repo/.agent-console/.claude', { recursive: true });
        fs.writeFileSync(
          '/repo/.agent-console/.claude/settings.local.json',
          '{"key": "value"}'
        );
        fs.writeFileSync('/repo/.agent-console/root-file.txt', 'root');

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService(mockRepo);

        const result = await service.createWorktree('/repo', 'feature-branch', 'repo-1');

        expect(result.error).toBeUndefined();
        expect(result.copiedFiles).toContain('.claude/settings.local.json');
        expect(result.copiedFiles).toContain('root-file.txt');
        // Verify nested file content
        const nested = fs.readFileSync(
          `${result.worktreePath}/.claude/settings.local.json`,
          'utf-8'
        );
        expect(nested).toBe('{"key": "value"}');
      });
    });
  });

  describe('removeWorktree', () => {
    it('should remove worktree successfully', async () => {
      // Pre-populate DB record for the worktree being removed
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService(mockRepo);

      const result = await service.removeWorktree('/repo', '/worktrees/feature');

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      // Verify record was deleted from mock repository
      expect(mockRepo.records.length).toBe(0);
    });

    it('should use force flag when specified', async () => {
      // Pre-populate DB record
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService(mockRepo);

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
      const service = new WorktreeService(mockRepo);

      const result = await service.removeWorktree('/repo', '/worktrees/feature');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('listBranches', () => {
    it('should list local and remote branches', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService(mockRepo);

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
      const service = new WorktreeService(mockRepo);

      const result = await service.listBranches('/repo');

      expect(result.local).toEqual([]);
      expect(result.remote).toEqual([]);
      expect(result.defaultBranch).toBeNull();
    });
  });

  describe('getDefaultBranch', () => {
    it('should return default branch from git', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService(mockRepo);

      const result = await service.getDefaultBranch('/repo');
      expect(result).toBe('main');
    });

    it('should return null if no default branch found', async () => {
      mockGit.getDefaultBranch.mockImplementation(() => Promise.resolve(null));

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService(mockRepo);

      const result = await service.getDefaultBranch('/repo');
      expect(result).toBeNull();
    });
  });

  describe('isWorktreeOf', () => {
    it('should return true for valid worktree path', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService(mockRepo);

      // Main worktree path equals repo path, always valid
      const result = await service.isWorktreeOf('/repo/main', '/repo/main', 'repo-1');
      expect(result).toBe(true);
    });

    it('should return true for secondary worktree path', async () => {
      // Register worktree in mock repository
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature-1',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService(mockRepo);

      const result = await service.isWorktreeOf('/repo/main', '/worktrees/feature-1', 'repo-1');
      expect(result).toBe(true);
    });

    it('should return false for invalid worktree path', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService(mockRepo);

      const result = await service.isWorktreeOf('/repo/main', '/other/path', 'repo-1');
      expect(result).toBe(false);
    });
  });

  describe('generateNextBranchName', () => {
    it('should return wt-001-XXXX format when no worktrees exist', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService(mockRepo);

      const branchName = await service.generateNextBranchName('repo-1');

      expect(branchName).toMatch(/^wt-001-[a-z0-9]{4}$/);
    });

    it('should return wt-002-XXXX format when index 1 is used', async () => {
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/existing',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService(mockRepo);

      const branchName = await service.generateNextBranchName('repo-1');

      expect(branchName).toMatch(/^wt-002-[a-z0-9]{4}$/);
    });

    it('should match format /^wt-\\d{3}-[a-z0-9]{4}$/', async () => {
      // Add several records to push the index higher
      for (let i = 1; i <= 5; i++) {
        mockRepo.records.push({
          id: `wt-${i}`,
          repositoryId: 'repo-1',
          path: `/worktrees/wt-${i}`,
          indexNumber: i,
          createdAt: new Date().toISOString(),
        });
      }

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService(mockRepo);

      const branchName = await service.generateNextBranchName('repo-1');

      expect(branchName).toMatch(/^wt-\d{3}-[a-z0-9]{4}$/);
      // Should be wt-006-xxxx since indexes 1-5 are taken
      expect(branchName).toMatch(/^wt-006-/);
    });
  });

  describe('allocateNextIndex (tested indirectly via createWorktree)', () => {
    it('should fill gaps: indexes [1, 3] exist -> next is 2', async () => {
      mockRepo.records.push(
        {
          id: 'wt-1',
          repositoryId: 'repo-1',
          path: '/worktrees/wt-1',
          indexNumber: 1,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'wt-3',
          repositoryId: 'repo-1',
          path: '/worktrees/wt-3',
          indexNumber: 3,
          createdAt: new Date().toISOString(),
        }
      );

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService(mockRepo);

      const result = await service.createWorktree('/repo', 'feature-gap', 'repo-1');

      expect(result.error).toBeUndefined();
      expect(result.index).toBe(2);
    });

    it('should allocate sequentially: indexes [1, 2, 3] exist -> next is 4', async () => {
      for (let i = 1; i <= 3; i++) {
        mockRepo.records.push({
          id: `wt-${i}`,
          repositoryId: 'repo-1',
          path: `/worktrees/wt-${i}`,
          indexNumber: i,
          createdAt: new Date().toISOString(),
        });
      }

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService(mockRepo);

      const result = await service.createWorktree('/repo', 'feature-next', 'repo-1');

      expect(result.error).toBeUndefined();
      expect(result.index).toBe(4);
    });

    it('should allocate index 1 when no indexes exist', async () => {
      // mockRepo.records is empty

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService(mockRepo);

      const result = await service.createWorktree('/repo', 'first-worktree', 'repo-1');

      expect(result.error).toBeUndefined();
      expect(result.index).toBe(1);
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
