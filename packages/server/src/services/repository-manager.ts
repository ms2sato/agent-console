import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import { access } from 'fs/promises';
import * as path from 'path';
import type { Repository } from '@agent-console/shared';
import { persistenceService } from './persistence-service.js';
import { getRepositoryDir } from '../lib/config.js';
import { getOrgRepoFromPath as gitGetOrgRepoFromPath } from '../lib/git.js';

/**
 * Extract org/repo from git remote URL
 * Falls back to directory name if no remote
 */
async function getOrgRepoFromPath(repoPath: string): Promise<string> {
  const orgRepo = await gitGetOrgRepoFromPath(repoPath);
  return orgRepo ?? path.basename(repoPath);
}

export class RepositoryManager {
  private repositories: Map<string, Repository> = new Map();

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const persisted = persistenceService.loadRepositories();
    for (const repo of persisted) {
      // Validate that the path still exists
      if (fs.existsSync(repo.path)) {
        this.repositories.set(repo.id, repo);
        console.log(`Loaded repository: ${repo.name} (${repo.id})`);
      } else {
        console.log(`Skipped missing repository: ${repo.name} (${repo.path})`);
      }
    }
  }

  private saveToDisk(): void {
    const repos = Array.from(this.repositories.values());
    persistenceService.saveRepositories(repos);
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

    const id = uuidv4();
    const name = path.basename(absolutePath);

    const repository: Repository = {
      id,
      name,
      path: absolutePath,
      registeredAt: new Date().toISOString(),
    };

    this.repositories.set(id, repository);
    this.saveToDisk();
    console.log(`Repository registered: ${name} (${id})`);

    return repository;
  }

  async unregisterRepository(id: string): Promise<boolean> {
    const repo = this.repositories.get(id);
    if (!repo) return false;

    // Clean up related directories
    await this.cleanupRepositoryData(repo.path);

    this.repositories.delete(id);
    this.saveToDisk();
    console.log(`Repository unregistered: ${repo.name} (${id})`);
    return true;
  }

  /**
   * Clean up repository data directory (worktrees and templates)
   */
  private async cleanupRepositoryData(repoPath: string): Promise<void> {
    const orgRepo = await getOrgRepoFromPath(repoPath);
    const repoDir = getRepositoryDir(orgRepo);

    // Clean up entire repository directory
    if (fs.existsSync(repoDir)) {
      try {
        fs.rmSync(repoDir, { recursive: true });
        console.log(`Cleaned up repository data: ${repoDir}`);
      } catch (e) {
        console.error(`Failed to clean up repository data: ${repoDir}`, e);
      }
    }
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
export const repositoryManager = new RepositoryManager();
