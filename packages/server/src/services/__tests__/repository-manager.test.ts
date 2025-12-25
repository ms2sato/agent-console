import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import type { Repository } from '@agent-console/shared';
import { setupMemfs, cleanupMemfs, createMockGitRepoFiles } from '../../__tests__/utils/mock-fs-helper.js';
import { mockGit } from '../../__tests__/utils/mock-git-helper.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import type { RepositoryRepository, RepositoryUpdates } from '../../repositories/repository-repository.js';
import { JobQueue } from '../../jobs/index.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { resetSessionManager, initializeSessionManager } from '../session-manager.js';
import { createSessionRepository } from '../../repositories/index.js';

// Test JobQueue instance (created fresh for each test)
let testJobQueue: JobQueue | null = null;

/**
 * In-memory mock implementation of RepositoryRepository for testing.
 */
class InMemoryRepositoryRepository implements RepositoryRepository {
  private repositories = new Map<string, Repository>();

  async findAll(): Promise<Repository[]> {
    return Array.from(this.repositories.values());
  }

  async findById(id: string): Promise<Repository | null> {
    return this.repositories.get(id) ?? null;
  }

  async findByPath(path: string): Promise<Repository | null> {
    for (const repo of this.repositories.values()) {
      if (repo.path === path) return repo;
    }
    return null;
  }

  async save(repository: Repository): Promise<void> {
    this.repositories.set(repository.id, repository);
  }

  async update(id: string, updates: RepositoryUpdates): Promise<Repository | null> {
    const repo = this.repositories.get(id);
    if (!repo) return null;
    const updated = { ...repo, ...updates };
    this.repositories.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    this.repositories.delete(id);
  }

  // Test helper to pre-populate data
  setRepositories(repos: Repository[]): void {
    this.repositories.clear();
    for (const repo of repos) {
      this.repositories.set(repo.id, repo);
    }
  }
}

describe('RepositoryManager', () => {
  const TEST_CONFIG_DIR = '/test/config';
  const TEST_REPO_DIR = '/test/repo';
  let importCounter = 0;
  let mockRepository: InMemoryRepositoryRepository;

  beforeEach(async () => {
    // Close any existing database connection first
    await closeDatabase();

    // Set up memfs with config dir and a git repo
    const gitRepoFiles = createMockGitRepoFiles(TEST_REPO_DIR);
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
      ...gitRepoFiles,
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    // Initialize in-memory database (needed for SessionManager singleton)
    await initializeDatabase(':memory:');

    // Reset session manager singleton (needed for unregisterRepository check)
    resetSessionManager();

    // Create a test JobQueue with the shared database connection
    testJobQueue = new JobQueue(getDatabase());

    // Initialize session manager singleton (needed for unregisterRepository check)
    const sessionRepository = await createSessionRepository();
    await initializeSessionManager({ sessionRepository, jobQueue: testJobQueue });

    // Reset process mock
    resetProcessMock();
    mockProcess.markAlive(process.pid);

    // Reset git mocks
    mockGit.getOrgRepoFromPath.mockReset();
    mockGit.getOrgRepoFromPath.mockImplementation(() => Promise.resolve('test-org/repo'));

    // Create fresh mock repository for each test
    mockRepository = new InMemoryRepositoryRepository();
  });

  afterEach(async () => {
    // Clean up test JobQueue
    if (testJobQueue) {
      await testJobQueue.stop();
      testJobQueue = null;
    }
    await closeDatabase();
    cleanupMemfs();
  });

  // Helper to get fresh RepositoryManager instance with the mock repository
  async function getRepositoryManager(preloadedRepos: Repository[] = []) {
    // Pre-populate the repository before creating the manager
    mockRepository.setRepositories(preloadedRepos);
    const module = await import(`../repository-manager.js?v=${++importCounter}`);
    return module.RepositoryManager.create({
      repository: mockRepository,
      jobQueue: testJobQueue,
    });
  }

  describe('registerRepository', () => {
    it('should register a valid git repository', async () => {
      const manager = await getRepositoryManager();

      const repo = await manager.registerRepository(TEST_REPO_DIR);

      expect(repo.id).toBeDefined();
      expect(repo.name).toBe('repo');
      expect(repo.path).toBe(TEST_REPO_DIR);
      expect(repo.createdAt).toBeDefined();
    });

    it('should throw error for non-existent path', async () => {
      const manager = await getRepositoryManager();

      await expect(
        manager.registerRepository('/non/existent/path')
      ).rejects.toThrow('Path does not exist');
    });

    it('should throw error for non-git directory', async () => {
      const manager = await getRepositoryManager();

      // Create a non-git directory
      fs.mkdirSync('/non-git-dir', { recursive: true });

      await expect(
        manager.registerRepository('/non-git-dir')
      ).rejects.toThrow('Not a git repository');
    });

    it('should throw error for duplicate registration', async () => {
      const manager = await getRepositoryManager();

      await manager.registerRepository(TEST_REPO_DIR);

      await expect(
        manager.registerRepository(TEST_REPO_DIR)
      ).rejects.toThrow('Repository already registered');
    });

    it('should persist repository via repository', async () => {
      const manager = await getRepositoryManager();

      await manager.registerRepository(TEST_REPO_DIR);

      // Check persisted data in the mock repository
      const savedRepos = await mockRepository.findAll();
      expect(savedRepos.length).toBe(1);
      expect(savedRepos[0].path).toBe(TEST_REPO_DIR);
    });
  });

  describe('unregisterRepository', () => {
    it('should unregister existing repository', async () => {
      const manager = await getRepositoryManager();

      const repo = await manager.registerRepository(TEST_REPO_DIR);
      const result = await manager.unregisterRepository(repo.id);

      expect(result).toBe(true);
      expect(manager.getRepository(repo.id)).toBeUndefined();
    });

    it('should return false for non-existent repository', async () => {
      const manager = await getRepositoryManager();

      const result = await manager.unregisterRepository('non-existent-id');
      expect(result).toBe(false);
    });

    it('should persist unregistration via repository', async () => {
      const manager = await getRepositoryManager();

      const repo = await manager.registerRepository(TEST_REPO_DIR);
      await manager.unregisterRepository(repo.id);

      // Check persisted data in the mock repository
      const savedRepos = await mockRepository.findAll();
      expect(savedRepos.length).toBe(0);
    });
  });

  describe('getRepository', () => {
    it('should return repository by id', async () => {
      const manager = await getRepositoryManager();

      const registered = await manager.registerRepository(TEST_REPO_DIR);
      const retrieved = manager.getRepository(registered.id);

      expect(retrieved).toEqual(registered);
    });

    it('should return undefined for unknown id', async () => {
      const manager = await getRepositoryManager();

      const result = manager.getRepository('unknown-id');
      expect(result).toBeUndefined();
    });
  });

  describe('getAllRepositories', () => {
    it('should return empty array when no repositories', async () => {
      const manager = await getRepositoryManager();

      const repos = manager.getAllRepositories();
      expect(repos).toEqual([]);
    });

    it('should return all registered repositories', async () => {
      const manager = await getRepositoryManager();

      // Register first repo
      const repo1 = await manager.registerRepository(TEST_REPO_DIR);
      expect(manager.getAllRepositories().length).toBe(1);

      // Create and register second repo
      const secondRepoFiles = createMockGitRepoFiles('/test/repo2');
      for (const [path, content] of Object.entries(secondRepoFiles)) {
        fs.mkdirSync(path.substring(0, path.lastIndexOf('/')), { recursive: true });
        fs.writeFileSync(path, content);
      }

      const repo2 = await manager.registerRepository('/test/repo2');

      const repos = manager.getAllRepositories();
      expect(repos.length).toBe(2);

      const repoIds = repos.map((r: Repository) => r.id);
      expect(repoIds).toContain(repo1.id);
      expect(repoIds).toContain(repo2.id);
    });
  });

  describe('findRepositoryByPath', () => {
    it('should find repository by path', async () => {
      const manager = await getRepositoryManager();

      const registered = await manager.registerRepository(TEST_REPO_DIR);
      const found = manager.findRepositoryByPath(TEST_REPO_DIR);

      expect(found).toEqual(registered);
    });

    it('should return undefined for unregistered path', async () => {
      const manager = await getRepositoryManager();

      const result = manager.findRepositoryByPath('/some/other/path');
      expect(result).toBeUndefined();
    });
  });

  describe('loading from repository', () => {
    it('should load repositories from repository on construction', async () => {
      // Pre-populate repository
      const preloadedRepos: Repository[] = [
        {
          id: 'existing-id',
          name: 'repo',
          path: TEST_REPO_DIR,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ];

      const manager = await getRepositoryManager(preloadedRepos);

      const repos = manager.getAllRepositories();
      expect(repos.length).toBe(1);
      expect(repos[0].id).toBe('existing-id');
    });

    it('should skip repositories with missing paths on load', async () => {
      // Pre-populate with a repo that points to non-existent path
      const preloadedRepos: Repository[] = [
        {
          id: 'missing-repo',
          name: 'missing',
          path: '/non/existent/path',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ];

      const manager = await getRepositoryManager(preloadedRepos);

      expect(manager.getAllRepositories().length).toBe(0);
    });
  });
});
