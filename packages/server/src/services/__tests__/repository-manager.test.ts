import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import type { Repository } from '@agent-console/shared';
import { setupMemfs, cleanupMemfs, createMockGitRepoFiles } from '../../__tests__/utils/mock-fs-helper.js';

describe('RepositoryManager', () => {
  const TEST_CONFIG_DIR = '/test/config';
  const TEST_REPO_DIR = '/test/repo';
  let importCounter = 0;

  beforeEach(() => {
    // Set up memfs with config dir and a git repo
    const gitRepoFiles = createMockGitRepoFiles(TEST_REPO_DIR);
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
      ...gitRepoFiles,
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
  });

  afterEach(() => {
    cleanupMemfs();
  });

  // Helper to get fresh module instance
  async function getRepositoryManager() {
    const module = await import(`../repository-manager.js?v=${++importCounter}`);
    return module.RepositoryManager;
  }

  // Helper to pre-populate repositories file
  function setupRepositories(repos: Repository[]) {
    fs.writeFileSync(
      `${TEST_CONFIG_DIR}/repositories.json`,
      JSON.stringify(repos)
    );
  }

  describe('registerRepository', () => {
    it('should register a valid git repository', async () => {
      const RepositoryManager = await getRepositoryManager();
      const manager = new RepositoryManager();

      const repo = manager.registerRepository(TEST_REPO_DIR);

      expect(repo.id).toBeDefined();
      expect(repo.name).toBe('repo');
      expect(repo.path).toBe(TEST_REPO_DIR);
      expect(repo.registeredAt).toBeDefined();
    });

    it('should throw error for non-existent path', async () => {
      const RepositoryManager = await getRepositoryManager();
      const manager = new RepositoryManager();

      expect(() => {
        manager.registerRepository('/non/existent/path');
      }).toThrow('Path does not exist');
    });

    it('should throw error for non-git directory', async () => {
      const RepositoryManager = await getRepositoryManager();
      const manager = new RepositoryManager();

      // Create a non-git directory
      fs.mkdirSync('/non-git-dir', { recursive: true });

      expect(() => {
        manager.registerRepository('/non-git-dir');
      }).toThrow('Not a git repository');
    });

    it('should throw error for duplicate registration', async () => {
      const RepositoryManager = await getRepositoryManager();
      const manager = new RepositoryManager();

      manager.registerRepository(TEST_REPO_DIR);

      expect(() => {
        manager.registerRepository(TEST_REPO_DIR);
      }).toThrow('Repository already registered');
    });

    it('should persist repository via persistence service', async () => {
      const RepositoryManager = await getRepositoryManager();
      const manager = new RepositoryManager();

      manager.registerRepository(TEST_REPO_DIR);

      // Check persisted data
      const savedData = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/repositories.json`, 'utf-8'));
      expect(savedData.length).toBe(1);
      expect(savedData[0].path).toBe(TEST_REPO_DIR);
    });
  });

  describe('unregisterRepository', () => {
    it('should unregister existing repository', async () => {
      const RepositoryManager = await getRepositoryManager();
      const manager = new RepositoryManager();

      const repo = manager.registerRepository(TEST_REPO_DIR);
      const result = manager.unregisterRepository(repo.id);

      expect(result).toBe(true);
      expect(manager.getRepository(repo.id)).toBeUndefined();
    });

    it('should return false for non-existent repository', async () => {
      const RepositoryManager = await getRepositoryManager();
      const manager = new RepositoryManager();

      const result = manager.unregisterRepository('non-existent-id');
      expect(result).toBe(false);
    });

    it('should persist unregistration via persistence service', async () => {
      const RepositoryManager = await getRepositoryManager();
      const manager = new RepositoryManager();

      const repo = manager.registerRepository(TEST_REPO_DIR);
      manager.unregisterRepository(repo.id);

      // Check persisted data
      const savedData = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/repositories.json`, 'utf-8'));
      expect(savedData.length).toBe(0);
    });
  });

  describe('getRepository', () => {
    it('should return repository by id', async () => {
      const RepositoryManager = await getRepositoryManager();
      const manager = new RepositoryManager();

      const registered = manager.registerRepository(TEST_REPO_DIR);
      const retrieved = manager.getRepository(registered.id);

      expect(retrieved).toEqual(registered);
    });

    it('should return undefined for unknown id', async () => {
      const RepositoryManager = await getRepositoryManager();
      const manager = new RepositoryManager();

      const result = manager.getRepository('unknown-id');
      expect(result).toBeUndefined();
    });
  });

  describe('getAllRepositories', () => {
    it('should return empty array when no repositories', async () => {
      const RepositoryManager = await getRepositoryManager();
      const manager = new RepositoryManager();

      const repos = manager.getAllRepositories();
      expect(repos).toEqual([]);
    });

    it('should return all registered repositories', async () => {
      const RepositoryManager = await getRepositoryManager();
      const manager = new RepositoryManager();

      // Register first repo
      const repo1 = manager.registerRepository(TEST_REPO_DIR);
      expect(manager.getAllRepositories().length).toBe(1);

      // Create and register second repo
      const secondRepoFiles = createMockGitRepoFiles('/test/repo2');
      for (const [path, content] of Object.entries(secondRepoFiles)) {
        fs.mkdirSync(path.substring(0, path.lastIndexOf('/')), { recursive: true });
        fs.writeFileSync(path, content);
      }

      const repo2 = manager.registerRepository('/test/repo2');

      const repos = manager.getAllRepositories();
      expect(repos.length).toBe(2);

      const repoIds = repos.map((r: Repository) => r.id);
      expect(repoIds).toContain(repo1.id);
      expect(repoIds).toContain(repo2.id);
    });
  });

  describe('findRepositoryByPath', () => {
    it('should find repository by path', async () => {
      const RepositoryManager = await getRepositoryManager();
      const manager = new RepositoryManager();

      const registered = manager.registerRepository(TEST_REPO_DIR);
      const found = manager.findRepositoryByPath(TEST_REPO_DIR);

      expect(found).toEqual(registered);
    });

    it('should return undefined for unregistered path', async () => {
      const RepositoryManager = await getRepositoryManager();
      const manager = new RepositoryManager();

      const result = manager.findRepositoryByPath('/some/other/path');
      expect(result).toBeUndefined();
    });
  });

  describe('loading from disk', () => {
    it('should load repositories from persistence service on construction', async () => {
      // Pre-populate repositories file
      setupRepositories([
        {
          id: 'existing-id',
          name: 'repo',
          path: TEST_REPO_DIR,
          registeredAt: '2024-01-01T00:00:00.000Z',
        },
      ]);

      const RepositoryManager = await getRepositoryManager();
      const manager = new RepositoryManager();

      const repos = manager.getAllRepositories();
      expect(repos.length).toBe(1);
      expect(repos[0].id).toBe('existing-id');
    });

    it('should skip repositories with missing paths on load', async () => {
      // Pre-populate with a repo that points to non-existent path
      setupRepositories([
        {
          id: 'missing-repo',
          name: 'missing',
          path: '/non/existent/path',
          registeredAt: '2024-01-01T00:00:00.000Z',
        },
      ]);

      const RepositoryManager = await getRepositoryManager();
      const manager = new RepositoryManager();

      expect(manager.getAllRepositories().length).toBe(0);
    });
  });
});
