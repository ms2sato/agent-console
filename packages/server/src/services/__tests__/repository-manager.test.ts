import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Repository } from '@agent-console/shared';

// Test directory paths - will be set uniquely for each test
let TEST_CONFIG_DIR: string;
let TEST_REPO_DIR: string;

// Storage for mocked repositories
let mockRepositories: Repository[] = [];

// Mock persistence service
vi.mock('../persistence-service.js', () => ({
  persistenceService: {
    loadRepositories: vi.fn(() => mockRepositories),
    saveRepositories: vi.fn((repos: Repository[]) => {
      mockRepositories = repos;
    }),
  },
}));

// Mock config
vi.mock('../../lib/config.js', () => ({
  getConfigDir: vi.fn(() => TEST_CONFIG_DIR),
  getRepositoriesDir: vi.fn(() => `${TEST_CONFIG_DIR}/repositories`),
  getRepositoryDir: vi.fn((orgRepo: string) => `${TEST_CONFIG_DIR}/repositories/${orgRepo}`),
}));

describe('RepositoryManager', () => {
  beforeEach(() => {
    // Reset modules to get fresh instance
    vi.resetModules();

    // Generate unique directory paths for each test
    const uniqueId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    TEST_CONFIG_DIR = path.join(os.tmpdir(), `agent-console-repo-test-${uniqueId}`);
    TEST_REPO_DIR = path.join(os.tmpdir(), `test-git-repo-${uniqueId}`);

    // Reset mock storage
    mockRepositories = [];

    // Create test directories
    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });

    // Create a fake git repo
    fs.mkdirSync(TEST_REPO_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_REPO_DIR, '.git'));
  });

  afterEach(() => {
    // Clean up
    if (fs.existsSync(TEST_CONFIG_DIR)) {
      fs.rmSync(TEST_CONFIG_DIR, { recursive: true });
    }
    if (fs.existsSync(TEST_REPO_DIR)) {
      fs.rmSync(TEST_REPO_DIR, { recursive: true });
    }
  });

  describe('registerRepository', () => {
    it('should register a valid git repository', async () => {
      const { RepositoryManager } = await import('../repository-manager.js');
      const manager = new RepositoryManager();

      const repo = manager.registerRepository(TEST_REPO_DIR);

      expect(repo.id).toBeDefined();
      expect(repo.name).toBe(path.basename(TEST_REPO_DIR));
      expect(repo.path).toBe(TEST_REPO_DIR);
      expect(repo.registeredAt).toBeDefined();
    });

    it('should throw error for non-existent path', async () => {
      const { RepositoryManager } = await import('../repository-manager.js');
      const manager = new RepositoryManager();

      expect(() => {
        manager.registerRepository('/non/existent/path');
      }).toThrow('Path does not exist');
    });

    it('should throw error for non-git directory', async () => {
      const { RepositoryManager } = await import('../repository-manager.js');
      const manager = new RepositoryManager();

      const nonGitDir = path.join(os.tmpdir(), 'non-git-dir-' + Date.now());
      fs.mkdirSync(nonGitDir, { recursive: true });

      try {
        expect(() => {
          manager.registerRepository(nonGitDir);
        }).toThrow('Not a git repository');
      } finally {
        fs.rmSync(nonGitDir, { recursive: true });
      }
    });

    it('should throw error for duplicate registration', async () => {
      const { RepositoryManager } = await import('../repository-manager.js');
      const manager = new RepositoryManager();

      manager.registerRepository(TEST_REPO_DIR);

      expect(() => {
        manager.registerRepository(TEST_REPO_DIR);
      }).toThrow('Repository already registered');
    });

    it('should persist repository via persistence service', async () => {
      const { persistenceService } = await import('../persistence-service.js');
      const { RepositoryManager } = await import('../repository-manager.js');
      const manager = new RepositoryManager();

      manager.registerRepository(TEST_REPO_DIR);

      expect(vi.mocked(persistenceService.saveRepositories)).toHaveBeenCalled();
      expect(mockRepositories.length).toBe(1);
      expect(mockRepositories[0].path).toBe(TEST_REPO_DIR);
    });
  });

  describe('unregisterRepository', () => {
    it('should unregister existing repository', async () => {
      const { RepositoryManager } = await import('../repository-manager.js');
      const manager = new RepositoryManager();

      const repo = manager.registerRepository(TEST_REPO_DIR);
      const result = manager.unregisterRepository(repo.id);

      expect(result).toBe(true);
      expect(manager.getRepository(repo.id)).toBeUndefined();
    });

    it('should return false for non-existent repository', async () => {
      const { RepositoryManager } = await import('../repository-manager.js');
      const manager = new RepositoryManager();

      const result = manager.unregisterRepository('non-existent-id');
      expect(result).toBe(false);
    });

    it('should persist unregistration via persistence service', async () => {
      const { persistenceService } = await import('../persistence-service.js');
      const { RepositoryManager } = await import('../repository-manager.js');
      const manager = new RepositoryManager();

      const repo = manager.registerRepository(TEST_REPO_DIR);
      vi.mocked(persistenceService.saveRepositories).mockClear();

      manager.unregisterRepository(repo.id);

      expect(vi.mocked(persistenceService.saveRepositories)).toHaveBeenCalled();
      expect(mockRepositories.length).toBe(0);
    });
  });

  describe('getRepository', () => {
    it('should return repository by id', async () => {
      const { RepositoryManager } = await import('../repository-manager.js');
      const manager = new RepositoryManager();

      const registered = manager.registerRepository(TEST_REPO_DIR);
      const retrieved = manager.getRepository(registered.id);

      expect(retrieved).toEqual(registered);
    });

    it('should return undefined for unknown id', async () => {
      const { RepositoryManager } = await import('../repository-manager.js');
      const manager = new RepositoryManager();

      const result = manager.getRepository('unknown-id');
      expect(result).toBeUndefined();
    });
  });

  describe('getAllRepositories', () => {
    it('should return empty array when no repositories', async () => {
      const { RepositoryManager } = await import('../repository-manager.js');
      const manager = new RepositoryManager();

      const repos = manager.getAllRepositories();
      expect(repos).toEqual([]);
    });

    it('should return all registered repositories', async () => {
      const { RepositoryManager } = await import('../repository-manager.js');
      const manager = new RepositoryManager();

      // Register first repo
      const repo1 = manager.registerRepository(TEST_REPO_DIR);
      expect(manager.getAllRepositories().length).toBe(1);

      // Create and register second repo
      const testRepo2 = path.join(os.tmpdir(), `test-git-repo-second-${process.pid}-${Date.now()}`);
      fs.mkdirSync(testRepo2, { recursive: true });
      fs.mkdirSync(path.join(testRepo2, '.git'));

      try {
        const repo2 = manager.registerRepository(testRepo2);

        const repos = manager.getAllRepositories();
        expect(repos.length).toBe(2);

        const repoIds = repos.map(r => r.id);
        expect(repoIds).toContain(repo1.id);
        expect(repoIds).toContain(repo2.id);
      } finally {
        if (fs.existsSync(testRepo2)) {
          fs.rmSync(testRepo2, { recursive: true });
        }
      }
    });
  });

  describe('findRepositoryByPath', () => {
    it('should find repository by path', async () => {
      const { RepositoryManager } = await import('../repository-manager.js');
      const manager = new RepositoryManager();

      const registered = manager.registerRepository(TEST_REPO_DIR);
      const found = manager.findRepositoryByPath(TEST_REPO_DIR);

      expect(found).toEqual(registered);
    });

    it('should return undefined for unregistered path', async () => {
      const { RepositoryManager } = await import('../repository-manager.js');
      const manager = new RepositoryManager();

      const result = manager.findRepositoryByPath('/some/other/path');
      expect(result).toBeUndefined();
    });
  });

  describe('loading from disk', () => {
    it('should load repositories from persistence service on construction', async () => {
      // Pre-populate mock storage
      mockRepositories = [
        {
          id: 'existing-id',
          name: path.basename(TEST_REPO_DIR),
          path: TEST_REPO_DIR,
          registeredAt: '2024-01-01T00:00:00.000Z',
        },
      ];

      const { RepositoryManager } = await import('../repository-manager.js');
      const manager = new RepositoryManager();

      const repos = manager.getAllRepositories();
      expect(repos.length).toBe(1);
      expect(repos[0].id).toBe('existing-id');
    });

    it('should skip repositories with missing paths on load', async () => {
      // Pre-populate with a repo that points to non-existent path
      mockRepositories = [
        {
          id: 'missing-repo',
          name: 'missing',
          path: '/non/existent/path',
          registeredAt: '2024-01-01T00:00:00.000Z',
        },
      ];

      const { RepositoryManager } = await import('../repository-manager.js');
      const manager = new RepositoryManager();

      expect(manager.getAllRepositories().length).toBe(0);
    });
  });
});
