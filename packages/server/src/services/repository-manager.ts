import { v4 as uuidv4 } from 'uuid';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Repository } from '@agent-console/shared';
import { persistenceService } from './persistence-service.js';
import { getConfigDir } from '../lib/config.js';

/**
 * Extract org/repo from git remote URL
 * Falls back to directory name if no remote
 */
function getOrgRepoFromPath(repoPath: string): string {
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // SSH format: git@github.com:org/repo.git
    const sshMatch = remoteUrl.match(/git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];

    // HTTPS format: https://github.com/org/repo.git
    const httpsMatch = remoteUrl.match(/https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];
  } catch {
    // No remote or error - fall through
  }
  return path.basename(repoPath);
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

  registerRepository(repoPath: string): Repository {
    // Resolve to absolute path
    const absolutePath = path.resolve(repoPath);

    // Check if path exists
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Path does not exist: ${absolutePath}`);
    }

    // Check if it's a git repository
    const gitDir = path.join(absolutePath, '.git');
    if (!fs.existsSync(gitDir)) {
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

  unregisterRepository(id: string): boolean {
    const repo = this.repositories.get(id);
    if (!repo) return false;

    // Clean up related directories
    this.cleanupRepositoryData(repo.path);

    this.repositories.delete(id);
    this.saveToDisk();
    console.log(`Repository unregistered: ${repo.name} (${id})`);
    return true;
  }

  /**
   * Clean up worktrees and templates directories for a repository
   */
  private cleanupRepositoryData(repoPath: string): void {
    const orgRepo = getOrgRepoFromPath(repoPath);

    // Clean up worktrees directory
    const worktreesDir = path.join(getConfigDir(), 'worktrees', orgRepo);
    if (fs.existsSync(worktreesDir)) {
      try {
        fs.rmSync(worktreesDir, { recursive: true });
        console.log(`Cleaned up worktrees: ${worktreesDir}`);
      } catch (e) {
        console.error(`Failed to clean up worktrees: ${worktreesDir}`, e);
      }
    }

    // Clean up templates directory
    const templatesDir = path.join(getConfigDir(), 'templates', orgRepo);
    if (fs.existsSync(templatesDir)) {
      try {
        fs.rmSync(templatesDir, { recursive: true });
        console.log(`Cleaned up templates: ${templatesDir}`);
      } catch (e) {
        console.error(`Failed to clean up templates: ${templatesDir}`, e);
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
