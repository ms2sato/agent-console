import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as childProcess from 'child_process';

// Mock config - must be before any imports that use it
vi.mock('../../lib/config.js', () => ({
  getConfigDir: vi.fn(() => '/test/config'),
  getRepositoriesDir: vi.fn(() => '/test/config/repositories'),
  getRepositoryDir: vi.fn((orgRepo: string) => `/test/config/repositories/${orgRepo}`),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => JSON.stringify({ indexes: {} })),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}));

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  exec: vi.fn(),
}));

describe('WorktreeService', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    // Reset default mock implementations
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ indexes: {} }));

    // Default git commands
    vi.mocked(childProcess.execSync).mockImplementation((cmd) => {
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

    vi.mocked(childProcess.exec).mockImplementation(
      (_cmd: string, _options: unknown, callback?: (error: Error | null, stdout: string, stderr: string) => void) => {
        if (callback) {
          callback(null, '', '');
        }
        return undefined as never;
      }
    );
  });

  describe('listWorktrees', () => {
    it('should only return main worktree and worktrees registered in index store', async () => {
      // Mock index store with one registered worktree
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ indexes: { '/worktrees/feature-1': 1 } })
      );

      const { WorktreeService } = await import('../worktree-service.js');
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
      // Mock empty index store - no worktrees registered
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ indexes: {} }));

      const { WorktreeService } = await import('../worktree-service.js');
      const service = new WorktreeService();

      const worktrees = service.listWorktrees('/repo/main', 'repo-1');

      // Only main worktree should be returned
      expect(worktrees.length).toBe(1);
      expect(worktrees[0].path).toBe('/repo/main');
      expect(worktrees[0].isMain).toBe(true);
    });

    it('should handle detached HEAD worktree', async () => {
      vi.mocked(childProcess.execSync).mockImplementation((cmd) => {
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

      const { WorktreeService } = await import('../worktree-service.js');
      const service = new WorktreeService();

      const worktrees = service.listWorktrees('/repo/main', 'repo-1');

      expect(worktrees[0].branch).toBe('(detached at abc1234)');
    });

    it('should return empty array on error', async () => {
      vi.mocked(childProcess.execSync).mockImplementation(() => {
        throw new Error('git error');
      });

      const { WorktreeService } = await import('../worktree-service.js');
      const service = new WorktreeService();

      const worktrees = service.listWorktrees('/repo', 'repo-1');
      expect(worktrees).toEqual([]);
    });
  });

  describe('createWorktree', () => {
    it('should create worktree with existing branch', async () => {
      vi.mocked(childProcess.exec).mockImplementation(
        (_cmd: string, _options: unknown, callback?: (error: Error | null, stdout: string, stderr: string) => void) => {
          if (callback) callback(null, '', '');
          return undefined as never;
        }
      );

      const { WorktreeService } = await import('../worktree-service.js');
      const service = new WorktreeService();

      const result = await service.createWorktree('/repo', 'feature-branch');

      expect(result.error).toBeUndefined();
      expect(result.worktreePath).toContain('feature-branch');
      expect(result.index).toBeDefined();
    });

    it('should create worktree with new branch from base', async () => {
      let capturedCommand = '';

      vi.mocked(childProcess.exec).mockImplementation(
        (cmd: string, _options: unknown, callback?: (error: Error | null, stdout: string, stderr: string) => void) => {
          capturedCommand = cmd;
          if (callback) callback(null, '', '');
          return undefined as never;
        }
      );

      const { WorktreeService } = await import('../worktree-service.js');
      const service = new WorktreeService();

      await service.createWorktree('/repo', 'new-feature', 'main');

      expect(capturedCommand).toContain('-b');
      expect(capturedCommand).toContain('main');
    });

    it('should return error on failure', async () => {
      vi.mocked(childProcess.exec).mockImplementation(
        (_cmd: string, _options: unknown, callback?: (error: Error | null, stdout: string, stderr: string) => void) => {
          if (callback) callback(new Error('branch already exists'), '', 'fatal: branch already exists');
          return undefined as never;
        }
      );

      const { WorktreeService } = await import('../worktree-service.js');
      const service = new WorktreeService();

      const result = await service.createWorktree('/repo', 'existing-branch');

      expect(result.error).toBeDefined();
      expect(result.worktreePath).toBe('');
    });
  });

  describe('removeWorktree', () => {
    it('should remove worktree successfully', async () => {
      vi.mocked(childProcess.exec).mockImplementation(
        (_cmd: string, _options: unknown, callback?: (error: Error | null, stdout: string, stderr: string) => void) => {
          if (callback) callback(null, '', '');
          return undefined as never;
        }
      );

      const { WorktreeService } = await import('../worktree-service.js');
      const service = new WorktreeService();

      const result = await service.removeWorktree('/repo', '/worktrees/feature');

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should use force flag when specified', async () => {
      let capturedCommand = '';

      vi.mocked(childProcess.exec).mockImplementation(
        (cmd: string, _options: unknown, callback?: (error: Error | null, stdout: string, stderr: string) => void) => {
          capturedCommand = cmd;
          if (callback) callback(null, '', '');
          return undefined as never;
        }
      );

      const { WorktreeService } = await import('../worktree-service.js');
      const service = new WorktreeService();

      await service.removeWorktree('/repo', '/worktrees/feature', true);

      expect(capturedCommand).toContain('--force');
    });

    it('should return error on failure', async () => {
      vi.mocked(childProcess.exec).mockImplementation(
        (_cmd: string, _options: unknown, callback?: (error: Error | null, stdout: string, stderr: string) => void) => {
          if (callback) callback(new Error('worktree has changes'), '', 'fatal: worktree has uncommitted changes');
          return undefined as never;
        }
      );

      const { WorktreeService } = await import('../worktree-service.js');
      const service = new WorktreeService();

      const result = await service.removeWorktree('/repo', '/worktrees/feature');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('listBranches', () => {
    it('should list local and remote branches', async () => {
      const { WorktreeService } = await import('../worktree-service.js');
      const service = new WorktreeService();

      const result = service.listBranches('/repo');

      expect(result.local).toContain('main');
      expect(result.local).toContain('feature-1');
      expect(result.remote).toContain('origin/main');
      expect(result.defaultBranch).toBe('main');
    });

    it('should return empty arrays on error', async () => {
      vi.mocked(childProcess.execSync).mockImplementation(() => {
        throw new Error('git error');
      });

      const { WorktreeService } = await import('../worktree-service.js');
      const service = new WorktreeService();

      const result = service.listBranches('/repo');

      expect(result.local).toEqual([]);
      expect(result.remote).toEqual([]);
      expect(result.defaultBranch).toBeNull();
    });
  });

  describe('getDefaultBranch', () => {
    it('should return default branch from symbolic ref', async () => {
      const { WorktreeService } = await import('../worktree-service.js');
      const service = new WorktreeService();

      const result = service.getDefaultBranch('/repo');
      expect(result).toBe('main');
    });

    it('should fallback to main if symbolic ref fails', async () => {
      vi.mocked(childProcess.execSync).mockImplementation((cmd) => {
        if (cmd.includes('symbolic-ref')) {
          throw new Error('not found');
        }
        if (cmd.includes('rev-parse --verify main')) {
          return '';
        }
        throw new Error('unknown command');
      });

      const { WorktreeService } = await import('../worktree-service.js');
      const service = new WorktreeService();

      const result = service.getDefaultBranch('/repo');
      expect(result).toBe('main');
    });

    it('should fallback to master if main does not exist', async () => {
      vi.mocked(childProcess.execSync).mockImplementation((cmd) => {
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

      const { WorktreeService } = await import('../worktree-service.js');
      const service = new WorktreeService();

      const result = service.getDefaultBranch('/repo');
      expect(result).toBe('master');
    });

    it('should return null if no default branch found', async () => {
      vi.mocked(childProcess.execSync).mockImplementation((_cmd: string) => {
        throw new Error('not found');
      });

      const { WorktreeService } = await import('../worktree-service.js');
      const service = new WorktreeService();

      const result = service.getDefaultBranch('/repo');
      expect(result).toBeNull();
    });
  });

  describe('isWorktreeOf', () => {
    it('should return true for valid worktree path', async () => {
      const { WorktreeService } = await import('../worktree-service.js');
      const service = new WorktreeService();

      // listWorktrees will return /repo/main and /worktrees/feature-1
      const result = service.isWorktreeOf('/repo/main', '/repo/main');
      expect(result).toBe(true);
    });

    it('should return true for secondary worktree path', async () => {
      // Mock index store with registered worktree
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ indexes: { '/worktrees/feature-1': 1 } })
      );

      const { WorktreeService } = await import('../worktree-service.js');
      const service = new WorktreeService();

      const result = service.isWorktreeOf('/repo/main', '/worktrees/feature-1');
      expect(result).toBe(true);
    });

    it('should return false for invalid worktree path', async () => {
      const { WorktreeService } = await import('../worktree-service.js');
      const service = new WorktreeService();

      const result = service.isWorktreeOf('/repo/main', '/other/path');
      expect(result).toBe(false);
    });
  });
});
