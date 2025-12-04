import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import type { Repository } from '@agents-web-console/shared';
import { persistenceService } from './persistence-service.js';

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

    this.repositories.delete(id);
    this.saveToDisk();
    console.log(`Repository unregistered: ${repo.name} (${id})`);
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

// Singleton instance
export const repositoryManager = new RepositoryManager();
