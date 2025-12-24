import * as fs from 'fs';
import { access } from 'fs/promises';
import * as path from 'path';
import type { Repository } from '@agent-console/shared';
import { getRepositoryDir } from '../lib/config.js';
import { getOrgRepoFromPath as gitGetOrgRepoFromPath } from '../lib/git.js';
import { createLogger } from '../lib/logger.js';
import { initializeDatabase } from '../database/connection.js';
import type { RepositoryRepository } from '../repositories/repository-repository.js';
import { SqliteRepositoryRepository } from '../repositories/sqlite-repository-repository.js';
import { JOB_TYPES, isJobQueueInitialized, getJobQueue, type JobQueue } from '../jobs/index.js';
import { getSessionManager } from './session-manager.js';

const logger = createLogger('repository-manager');

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
  onRepositoryDeleted: (repositoryId: string) => void;
}

export class RepositoryManager {
  private repositories: Map<string, Repository> = new Map();
  private repository: RepositoryRepository;
  private lifecycleCallbacks: RepositoryLifecycleCallbacks | null = null;
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
   * Can be called after construction to inject the job queue.
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

  async registerRepository(repoPath: string): Promise<Repository> {
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
    const sessionManager = await getSessionManager();
    const activeSessions = sessionManager.getSessionsUsingRepository(id);
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
   * Clean up repository data directory (worktrees and templates)
   * @throws Error if jobQueue is not available
   */
  private async cleanupRepositoryData(repoPath: string): Promise<void> {
    if (!this.jobQueue) {
      throw new Error('JobQueue not available for repository cleanup. Ensure setJobQueue() is called before cleanup operations.');
    }

    const orgRepo = await getOrgRepoFromPath(repoPath);
    const repoDir = getRepositoryDir(orgRepo);

    // Clean up entire repository directory via job queue
    this.jobQueue.enqueue(JOB_TYPES.CLEANUP_REPOSITORY, { repoDir });
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

// Singleton with lazy async initialization
let repositoryManagerInstance: RepositoryManager | null = null;
let initializationPromise: Promise<RepositoryManager> | null = null;

export async function getRepositoryManager(): Promise<RepositoryManager> {
  if (repositoryManagerInstance) {
    return repositoryManagerInstance;
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = RepositoryManager.create()
    .then((manager) => {
      repositoryManagerInstance = manager;

      // Inject job queue if initialized
      if (isJobQueueInitialized()) {
        manager.setJobQueue(getJobQueue());
      }

      return manager;
    })
    .catch((error) => {
      initializationPromise = null; // Allow retry on next call
      throw error;
    });

  return initializationPromise;
}

// For testing: reset the singleton
export function resetRepositoryManager(): void {
  repositoryManagerInstance = null;
  initializationPromise = null;
}
