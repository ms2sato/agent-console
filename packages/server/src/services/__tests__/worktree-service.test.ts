import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import * as fs from 'fs';
import type { ExecSyncOptions, ExecOptions } from 'child_process';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';

// Test config directory
const TEST_CONFIG_DIR = '/test/config';

// Create typed mock functions for child_process
type ExecSyncFn = (cmd: string, options?: ExecSyncOptions) => string;
type ExecFn = (cmd: string, options: ExecOptions, callback: (error: Error | null, stdout: string, stderr: string) => void) => void;

const mockExecSync: Mock<ExecSyncFn> = mock(() => '');
const mockExec: Mock<ExecFn> = mock(() => undefined);

// Mock child_process module (built-in module - acceptable per testing guidelines)
mock.module('child_process', () => ({
  execSync: mockExecSync,
  exec: mockExec,
}));

let importCounter = 0;

describe('WorktreeService', () => {
  beforeEach(() => {
    // Setup memfs with config directory structure
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    // Reset mocks
    mockExecSync.mockReset();
    mockExec.mockReset();

    // Default git commands
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd !== 'string') return '';

      if (cmd.includes('git worktree list --porcelain')) {
        return `worktree /repo/main
HEAD abc123
branch refs/heads/main

worktree /worktrees/feature-1
HEAD def456
branch refs/heads/feature-1
`;
      }
      if (cmd.includes('git remote get-url origin')) {
        return 'git@github.com:owner/repo-name.git';
      }
      if (cmd.includes('git branch --format')) {
        return 'main\nfeature-1\nfeature-2';
      }
      if (cmd.includes('git branch -r --format')) {
        return 'origin/main\norigin/develop';
      }
      if (cmd.includes('git symbolic-ref refs/remotes/origin/HEAD')) {
        return 'refs/remotes/origin/main';
      }
      return '';
    });

    mockExec.mockImplementation(
      (_cmd: string, _options: unknown, callback?: (error: Error | null, stdout: string, stderr: string) => void) => {
        if (callback) {
          callback(null, '', '');
        }
        return undefined as never;
      }
    );
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

      const worktrees = service.listWorktrees('/repo/main', 'repo-1');

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

      const worktrees = service.listWorktrees('/repo/main', 'repo-1');

      // Only main worktree should be returned
      expect(worktrees.length).toBe(1);
      expect(worktrees[0].path).toBe('/repo/main');
      expect(worktrees[0].isMain).toBe(true);
    });

    it('should handle detached HEAD worktree', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd !== 'string') return '';
        if (cmd.includes('git worktree list --porcelain')) {
          return `worktree /repo/main
HEAD abc1234567890
detached
`;
        }
        if (cmd.includes('git remote get-url origin')) {
          return 'git@github.com:owner/repo-name.git';
        }
        return '';
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const worktrees = service.listWorktrees('/repo/main', 'repo-1');

      expect(worktrees[0].branch).toBe('(detached at abc1234)');
    });

    it('should return empty array on error', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('git error');
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const worktrees = service.listWorktrees('/repo', 'repo-1');
      expect(worktrees).toEqual([]);
    });
  });

  describe('createWorktree', () => {
    it('should create worktree with existing branch', async () => {
      let capturedCommand = '';

      mockExec.mockImplementation(
        (cmd: string, _options: unknown, callback?: (error: Error | null, stdout: string, stderr: string) => void) => {
          capturedCommand = cmd;
          if (callback) callback(null, '', '');
          return undefined as never;
        }
      );

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const result = await service.createWorktree('/repo', 'feature-branch');

      expect(result.error).toBeUndefined();
      // Directory name is wt-XXX-xxxx format, independent of branch name
      expect(result.worktreePath).toMatch(/wt-\d{3}-[a-z0-9]{4}$/);
      expect(result.index).toBeDefined();
      // Branch name should be in the git command
      expect(capturedCommand).toContain('feature-branch');
    });

    it('should create worktree with new branch from base', async () => {
      let capturedCommand = '';

      mockExec.mockImplementation(
        (cmd: string, _options: unknown, callback?: (error: Error | null, stdout: string, stderr: string) => void) => {
          capturedCommand = cmd;
          if (callback) callback(null, '', '');
          return undefined as never;
        }
      );

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      await service.createWorktree('/repo', 'new-feature', 'main');

      expect(capturedCommand).toContain('-b');
      expect(capturedCommand).toContain('main');
    });

    it('should return error on failure', async () => {
      mockExec.mockImplementation(
        (_cmd: string, _options: unknown, callback?: (error: Error | null, stdout: string, stderr: string) => void) => {
          if (callback) callback(new Error('branch already exists'), '', 'fatal: branch already exists');
          return undefined as never;
        }
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
      mockExec.mockImplementation(
        (_cmd: string, _options: unknown, callback?: (error: Error | null, stdout: string, stderr: string) => void) => {
          if (callback) callback(null, '', '');
          return undefined as never;
        }
      );

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const result = await service.removeWorktree('/repo', '/worktrees/feature');

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should use force flag when specified', async () => {
      let capturedCommand = '';

      mockExec.mockImplementation(
        (cmd: string, _options: unknown, callback?: (error: Error | null, stdout: string, stderr: string) => void) => {
          capturedCommand = cmd;
          if (callback) callback(null, '', '');
          return undefined as never;
        }
      );

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      await service.removeWorktree('/repo', '/worktrees/feature', true);

      expect(capturedCommand).toContain('--force');
    });

    it('should return error on failure', async () => {
      mockExec.mockImplementation(
        (_cmd: string, _options: unknown, callback?: (error: Error | null, stdout: string, stderr: string) => void) => {
          if (callback) callback(new Error('worktree has changes'), '', 'fatal: worktree has uncommitted changes');
          return undefined as never;
        }
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

      const result = service.listBranches('/repo');

      expect(result.local).toContain('main');
      expect(result.local).toContain('feature-1');
      expect(result.remote).toContain('origin/main');
      expect(result.defaultBranch).toBe('main');
    });

    it('should return empty arrays on error', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('git error');
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const result = service.listBranches('/repo');

      expect(result.local).toEqual([]);
      expect(result.remote).toEqual([]);
      expect(result.defaultBranch).toBeNull();
    });
  });

  describe('getDefaultBranch', () => {
    it('should return default branch from symbolic ref', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const result = service.getDefaultBranch('/repo');
      expect(result).toBe('main');
    });

    it('should fallback to main if symbolic ref fails', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd !== 'string') return '';
        if (cmd.includes('symbolic-ref')) {
          throw new Error('not found');
        }
        if (cmd.includes('rev-parse --verify main')) {
          return '';
        }
        throw new Error('unknown command');
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const result = service.getDefaultBranch('/repo');
      expect(result).toBe('main');
    });

    it('should fallback to master if main does not exist', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd !== 'string') return '';
        if (cmd.includes('symbolic-ref')) {
          throw new Error('not found');
        }
        if (cmd.includes('rev-parse --verify main')) {
          throw new Error('main not found');
        }
        if (cmd.includes('rev-parse --verify master')) {
          return '';
        }
        throw new Error('unknown command');
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const result = service.getDefaultBranch('/repo');
      expect(result).toBe('master');
    });

    it('should return null if no default branch found', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const result = service.getDefaultBranch('/repo');
      expect(result).toBeNull();
    });
  });

  describe('isWorktreeOf', () => {
    it('should return true for valid worktree path', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      // listWorktrees will return /repo/main and /worktrees/feature-1
      const result = service.isWorktreeOf('/repo/main', '/repo/main');
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

      const result = service.isWorktreeOf('/repo/main', '/worktrees/feature-1');
      expect(result).toBe(true);
    });

    it('should return false for invalid worktree path', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService();

      const result = service.isWorktreeOf('/repo/main', '/other/path');
      expect(result).toBe(false);
    });
  });
});
