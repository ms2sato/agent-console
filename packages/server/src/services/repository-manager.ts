import * as fs from 'fs';
import { access } from 'fs/promises';
import * as path from 'path';
import type { Repository } from '@agent-console/shared';
import { getRepositoryDir } from '../lib/config.js';
import { getOrgRepoFromPath as gitGetOrgRepoFromPath } from '../lib/git.js';
import { createLogger } from '../lib/logger.js';
import { initializeDatabase } from '../database/connection.js';
import type { RepositoryRepository, RepositoryUpdates } from '../repositories/repository-repository.js';
import { SqliteRepositoryRepository } from '../repositories/sqlite-repository-repository.js';
import { JOB_TYPES, type JobQueue } from '../jobs/index.js';

const logger = createLogger('repository-manager');

/**
 * Callbacks for resolving dependencies without circular imports.
 * Injected by index.ts after both SessionManager and RepositoryManager are initialized.
 */
export interface RepositoryDependencyCallbacks {
  getSessionsUsingRepository: (repositoryId: string) => { id: string; title?: string }[];
}

/**
 * Extract org/repo from git remote URL
 * Falls back to directory name if no remote
 */
async function getOrgRepoFromPath(repoPath: string): Promise<string> {
  const orgRepo = await gitGetOrgRepoFromPath(repoPath);
  return orgRepo ?? path.basename(repoPath);
}

export interface RepositoryLifecycleCallbacks {
  onRepositoryCreated: (repository: Repository) => void;
  onRepositoryUpdated: (repository: Repository) => void;
  onRepositoryDeleted: (repositoryId: string) => void;
}

export class RepositoryManager {
  private repositories: Map<string, Repository> = new Map();
  private repository: RepositoryRepository;
  private lifecycleCallbacks: RepositoryLifecycleCallbacks | null = null;
  private dependencyCallbacks: RepositoryDependencyCallbacks | null = null;
  private jobQueue: JobQueue | null = null;

  /**
   * Create a RepositoryManager instance with async initialization.
   * This is the preferred way to create a RepositoryManager.
   */
  static async create(options?: {
    repository?: RepositoryRepository;
    jobQueue?: JobQueue | null;
  }): Promise<RepositoryManager> {
    const repo = options?.repository ?? new SqliteRepositoryRepository(await initializeDatabase());
    const manager = new RepositoryManager(repo, options?.jobQueue ?? null);
    await manager.initialize();
    return manager;
  }

  /**
   * Private constructor - use RepositoryManager.create() for async initialization.
   */
  private constructor(repository: RepositoryRepository, jobQueue: JobQueue | null = null) {
    this.repository = repository;
    this.jobQueue = jobQueue;
  }

  /**
   * Set the job queue for background task processing.
   * @internal For testing only. In production, pass jobQueue to initializeRepositoryManager().
   */
  setJobQueue(jobQueue: JobQueue): void {
    this.jobQueue = jobQueue;
  }

  /**
   * Set callbacks for repository lifecycle events (for WebSocket broadcasting)
   */
  setLifecycleCallbacks(callbacks: RepositoryLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
  }

  /**
   * Set callbacks for resolving dependencies without circular imports.
   * Must be called after both SessionManager and RepositoryManager are initialized.
   */
  setDependencyCallbacks(callbacks: RepositoryDependencyCallbacks): void {
    this.dependencyCallbacks = callbacks;
  }

  /**
   * Initialize by loading repositories from the database.
   */
  private async initialize(): Promise<void> {
    const persisted = await this.repository.findAll();
    for (const repo of persisted) {
      // Validate that the path still exists
      if (fs.existsSync(repo.path)) {
        this.repositories.set(repo.id, repo);
        logger.info({ repositoryId: repo.id, name: repo.name }, 'Loaded repository');
      } else {
        logger.warn({ repositoryId: repo.id, name: repo.name, path: repo.path }, 'Skipped missing repository');
      }
    }
  }

  async registerRepository(repoPath: string, options?: { description?: string }): Promise<Repository> {
    // Resolve to absolute path
    const absolutePath = path.resolve(repoPath);

    // Check if path exists
    try {
      await access(absolutePath);
    } catch {
      throw new Error(`Path does not exist: ${absolutePath}`);
    }

    // Check if it's a git repository
    const gitDir = path.join(absolutePath, '.git');
    try {
      await access(gitDir);
    } catch {
      throw new Error(`Not a git repository: ${absolutePath}`);
    }

    // Check if already registered
    for (const repo of this.repositories.values()) {
      if (repo.path === absolutePath) {
        throw new Error(`Repository already registered: ${absolutePath}`);
      }
    }

    const id = crypto.randomUUID();
    const name = path.basename(absolutePath);

    const repository: Repository = {
      id,
      name,
      path: absolutePath,
      createdAt: new Date().toISOString(),
      description: options?.description ?? null,
    };

    this.repositories.set(id, repository);
    await this.repository.save(repository);
    logger.info({ repositoryId: id, name }, 'Repository registered');

    // Callback fires after successful save - clients will receive state update
    // only after database write is confirmed
    this.lifecycleCallbacks?.onRepositoryCreated(repository);

    return repository;
  }

  async unregisterRepository(id: string): Promise<boolean> {
    const repo = this.repositories.get(id);
    if (!repo) return false;

    // Check if any active sessions are using this repository
    // Uses callback to avoid circular dependency with SessionManager
    const activeSessions = this.dependencyCallbacks?.getSessionsUsingRepository(id) ?? [];
    if (activeSessions.length > 0) {
      throw new Error(
        `Cannot unregister repository: ${activeSessions.length} active session(s) are using it. ` +
        `Delete or close the sessions first.`
      );
    }

    // Clean up related directories
    await this.cleanupRepositoryData(repo.path);

    this.repositories.delete(id);
    await this.repository.delete(id);
    logger.info({ repositoryId: id, name: repo.name }, 'Repository unregistered');

    // Callback fires after successful delete - clients will receive state update
    // only after database write is confirmed
    this.lifecycleCallbacks?.onRepositoryDeleted(id);

    return true;
  }

  /**
   * Update a repository's settings.
   * @param id - Repository ID to update
   * @param updates - Fields to update
   * @returns Updated repository if found, null otherwise
   */
  async updateRepository(id: string, updates: RepositoryUpdates): Promise<Repository | null> {
    const repo = this.repositories.get(id);
    if (!repo) return null;

    const updated = await this.repository.update(id, updates);
    if (!updated) return null;

    this.repositories.set(id, updated);
    logger.info({ repositoryId: id }, 'Repository updated');

    // Callback fires after successful update - clients will receive state update
    // only after database write is confirmed
    this.lifecycleCallbacks?.onRepositoryUpdated(updated);

    return updated;
  }

  /**
   * Clean up repository data directory (worktrees and templates)
   * @throws Error if jobQueue is not available
   */
  private async cleanupRepositoryData(repoPath: string): Promise<void> {
    if (!this.jobQueue) {
      throw new Error('JobQueue not available for repository cleanup. Ensure initializeRepositoryManager() was called with jobQueue.');
    }

    const orgRepo = await getOrgRepoFromPath(repoPath);
    const repoDir = getRepositoryDir(orgRepo);

    // Clean up entire repository directory via job queue
    await this.jobQueue.enqueue(JOB_TYPES.CLEANUP_REPOSITORY, { repoDir });
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

// Singleton instance
let repositoryManagerInstance: RepositoryManager | null = null;

/**
 * Initialize the RepositoryManager singleton.
 * Must be called once at application startup before getRepositoryManager().
 * @param options.jobQueue - JobQueue for background cleanup tasks
 * @param options.repository - Optional custom repository implementation
 */
export async function initializeRepositoryManager(options: {
  jobQueue: JobQueue;
  repository?: RepositoryRepository;
}): Promise<void> {
  if (repositoryManagerInstance) {
    throw new Error('RepositoryManager already initialized');
  }
  repositoryManagerInstance = await RepositoryManager.create(options);
}

/**
 * Get the RepositoryManager singleton.
 * @throws Error if initializeRepositoryManager() has not been called
 */
export function getRepositoryManager(): RepositoryManager {
  if (!repositoryManagerInstance) {
    throw new Error('RepositoryManager not initialized. Call initializeRepositoryManager() first.');
  }
  return repositoryManagerInstance;
}

/**
 * Check if RepositoryManager has been initialized.
 */
export function isRepositoryManagerInitialized(): boolean {
  return repositoryManagerInstance !== null;
}

/**
 * Reset the singleton for testing.
 * @internal For testing only.
 */
export function resetRepositoryManager(): void {
  repositoryManagerInstance = null;
}

/**
 * Set the RepositoryManager singleton from an existing instance.
 * Used by AppContext to set the singleton without re-creating.
 * @internal For AppContext initialization only.
 */
export function setRepositoryManager(instance: RepositoryManager): void {
  if (repositoryManagerInstance) {
    throw new Error('RepositoryManager already initialized');
  }
  repositoryManagerInstance = instance;
}
