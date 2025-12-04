import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import type { Repository } from '@agents-web-console/shared';

export class RepositoryManager {
  private repositories: Map<string, Repository> = new Map();

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
    console.log(`Repository registered: ${name} (${id})`);

    return repository;
  }

  unregisterRepository(id: string): boolean {
    const repo = this.repositories.get(id);
    if (!repo) return false;

    this.repositories.delete(id);
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
