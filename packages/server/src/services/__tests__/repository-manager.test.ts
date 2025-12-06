import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Repository } from '@agent-console/shared';

// Test directory paths - will be set uniquely for each test
let TEST_CONFIG_DIR: string;
let TEST_REPO_DIR: string;

class TestPersistenceService {
  private repositoriesFile: string;

  constructor(configDir: string) {
    this.repositoriesFile = path.join(configDir, 'repositories.json');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
  }

  loadRepositories(): Repository[] {
    try {
      if (fs.existsSync(this.repositoriesFile)) {
        const content = fs.readFileSync(this.repositoriesFile, 'utf-8');
        return JSON.parse(content);
      }
    } catch {
      // Ignore
    }
    return [];
  }

  saveRepositories(repositories: Repository[]): void {
    fs.writeFileSync(this.repositoriesFile, JSON.stringify(repositories, null, 2));
  }
}

class TestRepositoryManager {
  private repositories: Map<string, Repository> = new Map();
  private persistence: TestPersistenceService;

  constructor(persistence: TestPersistenceService) {
    this.persistence = persistence;
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const persisted = this.persistence.loadRepositories();
    for (const repo of persisted) {
      if (fs.existsSync(repo.path)) {
        this.repositories.set(repo.id, repo);
      }
    }
  }

  private saveToDisk(): void {
    const repos = Array.from(this.repositories.values());
    this.persistence.saveRepositories(repos);
  }

  registerRepository(repoPath: string): Repository {
    const absolutePath = path.resolve(repoPath);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Path does not exist: ${absolutePath}`);
    }

    const gitDir = path.join(absolutePath, '.git');
    if (!fs.existsSync(gitDir)) {
      throw new Error(`Not a git repository: ${absolutePath}`);
    }

    for (const repo of this.repositories.values()) {
      if (repo.path === absolutePath) {
        throw new Error(`Repository already registered: ${absolutePath}`);
      }
    }

    const id = `test-uuid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const name = path.basename(absolutePath);

    const repository: Repository = {
      id,
      name,
      path: absolutePath,
      registeredAt: new Date().toISOString(),
    };

    this.repositories.set(id, repository);
    this.saveToDisk();

    return repository;
  }

  unregisterRepository(id: string): boolean {
    const repo = this.repositories.get(id);
    if (!repo) return false;

    this.repositories.delete(id);
    this.saveToDisk();
    return true;
  }

  getRepository(id: string): Repository | undefined {
    return this.repositories.get(id);
  }

  getAllRepositories(): Repository[] {
    return Array.from(this.repositories.values());
  }

  findRepositoryByPath(repoPath: string): Repository | undefined {
    const absolutePath = path.resolve(repoPath);
    for (const repo of this.repositories.values()) {
      if (repo.path === absolutePath) {
        return repo;
      }
    }
    return undefined;
  }
}

describe('RepositoryManager', () => {
  let manager: TestRepositoryManager;
  let persistence: TestPersistenceService;

  beforeEach(() => {
    // Generate unique directory paths for each test
    const uniqueId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    TEST_CONFIG_DIR = path.join(os.tmpdir(), `agent-console-repo-test-${uniqueId}`);
    TEST_REPO_DIR = path.join(os.tmpdir(), `test-git-repo-${uniqueId}`);

    // Create test directories (clean slate for each test)
    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });

    // Create a fake git repo
    fs.mkdirSync(TEST_REPO_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_REPO_DIR, '.git'));

    persistence = new TestPersistenceService(TEST_CONFIG_DIR);
    manager = new TestRepositoryManager(persistence);
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
    it('should register a valid git repository', () => {
      const repo = manager.registerRepository(TEST_REPO_DIR);

      expect(repo.id).toBeDefined();
      expect(repo.name).toBe(path.basename(TEST_REPO_DIR));
      expect(repo.path).toBe(TEST_REPO_DIR);
      expect(repo.registeredAt).toBeDefined();
    });

    it('should throw error for non-existent path', () => {
      expect(() => {
        manager.registerRepository('/non/existent/path');
      }).toThrow('Path does not exist');
    });

    it('should throw error for non-git directory', () => {
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

    it('should throw error for duplicate registration', () => {
      manager.registerRepository(TEST_REPO_DIR);

      expect(() => {
        manager.registerRepository(TEST_REPO_DIR);
      }).toThrow('Repository already registered');
    });

    it('should persist repository to disk', () => {
      manager.registerRepository(TEST_REPO_DIR);

      // Create new manager instance to verify persistence
      const newManager = new TestRepositoryManager(persistence);
      const repos = newManager.getAllRepositories();

      expect(repos.length).toBe(1);
      expect(repos[0].path).toBe(TEST_REPO_DIR);
    });
  });

  describe('unregisterRepository', () => {
    it('should unregister existing repository', () => {
      const repo = manager.registerRepository(TEST_REPO_DIR);
      const result = manager.unregisterRepository(repo.id);

      expect(result).toBe(true);
      expect(manager.getRepository(repo.id)).toBeUndefined();
    });

    it('should return false for non-existent repository', () => {
      const result = manager.unregisterRepository('non-existent-id');
      expect(result).toBe(false);
    });

    it('should persist unregistration to disk', () => {
      const repo = manager.registerRepository(TEST_REPO_DIR);
      manager.unregisterRepository(repo.id);

      // Create new manager instance to verify persistence
      const newManager = new TestRepositoryManager(persistence);
      expect(newManager.getAllRepositories().length).toBe(0);
    });
  });

  describe('getRepository', () => {
    it('should return repository by id', () => {
      const registered = manager.registerRepository(TEST_REPO_DIR);
      const retrieved = manager.getRepository(registered.id);

      expect(retrieved).toEqual(registered);
    });

    it('should return undefined for unknown id', () => {
      const result = manager.getRepository('unknown-id');
      expect(result).toBeUndefined();
    });
  });

  describe('getAllRepositories', () => {
    it('should return empty array when no repositories', () => {
      const repos = manager.getAllRepositories();
      expect(repos).toEqual([]);
    });

    it('should return all registered repositories', () => {
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
    it('should find repository by path', () => {
      const registered = manager.registerRepository(TEST_REPO_DIR);
      const found = manager.findRepositoryByPath(TEST_REPO_DIR);

      expect(found).toEqual(registered);
    });

    it('should return undefined for unregistered path', () => {
      const result = manager.findRepositoryByPath('/some/other/path');
      expect(result).toBeUndefined();
    });
  });

  describe('loading from disk', () => {
    it('should skip repositories with missing paths on load', () => {
      // Register a repo
      manager.registerRepository(TEST_REPO_DIR);

      // Delete the repo directory
      fs.rmSync(TEST_REPO_DIR, { recursive: true });

      // Create new manager - should skip the missing repo
      const newManager = new TestRepositoryManager(persistence);
      expect(newManager.getAllRepositories().length).toBe(0);
    });
  });
});
