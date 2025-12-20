import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { mockGit, GitError } from '../../__tests__/utils/mock-git-helper.js';

// Test config directory
const TEST_CONFIG_DIR = '/test/config';

let importCounter = 0;

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
});
