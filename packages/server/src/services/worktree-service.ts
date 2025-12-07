import { execSync, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Worktree } from '@agent-console/shared';
import { getRepositoryDir } from '../lib/config.js';

// ========== Index Management ==========
interface IndexStore {
  // Map of worktree path -> index number
  indexes: Record<string, number>;
}

/**
 * Load index store for a repository
 */
function loadIndexStore(repoWorktreeDir: string): IndexStore {
  const indexFile = path.join(repoWorktreeDir, 'worktree-indexes.json');
  try {
    if (fs.existsSync(indexFile)) {
      return JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load index store:', e);
  }
  return { indexes: {} };
}

/**
 * Save index store for a repository
 */
function saveIndexStore(repoWorktreeDir: string, store: IndexStore): void {
  const indexFile = path.join(repoWorktreeDir, 'worktree-indexes.json');
  try {
    fs.writeFileSync(indexFile, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error('Failed to save index store:', e);
  }
}

/**
 * Allocate the next available index (fills gaps)
 */
function allocateIndex(store: IndexStore): number {
  const usedIndexes = new Set(Object.values(store.indexes));
  let index = 1;
  while (usedIndexes.has(index)) {
    index++;
  }
  return index;
}

/**
 * Get index for a worktree path
 */
function getIndexForPath(store: IndexStore, worktreePath: string): number | undefined {
  return store.indexes[worktreePath];
}

/**
 * Generate a random alphanumeric suffix
 */
function generateRandomSuffix(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let suffix = '';
  for (let i = 0; i < length; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return suffix;
}

// ========== Template Functionality ==========

/**
 * Find templates directory for a repository
 * Priority: 1. .git-wt/ in repo root  2. $AGENT_CONSOLE_HOME/repositories/<owner>/<repo>/templates/
 */
function findTemplatesDir(repoPath: string, orgRepo: string): string | null {
  // Check repo-local templates
  const localTemplates = path.join(repoPath, '.git-wt');
  if (fs.existsSync(localTemplates) && fs.statSync(localTemplates).isDirectory()) {
    return localTemplates;
  }

  // Check global templates in $AGENT_CONSOLE_HOME/repositories/<org>/<repo>/templates/
  const globalTemplates = path.join(getRepositoryDir(orgRepo), 'templates');
  if (fs.existsSync(globalTemplates) && fs.statSync(globalTemplates).isDirectory()) {
    return globalTemplates;
  }

  return null;
}

/**
 * Substitute template variables in content
 * Supports: {{WORKTREE_NUM}}, {{BRANCH}}, {{REPO}}, {{WORKTREE_PATH}}
 * Also supports arithmetic: {{WORKTREE_NUM + 3000}}
 */
function substituteVariables(
  content: string,
  vars: { worktreeNum: number; branch: string; repo: string; worktreePath: string }
): string {
  // Handle arithmetic expressions like {{WORKTREE_NUM + 3000}}
  content = content.replace(/\{\{WORKTREE_NUM\s*([+\-*/])\s*(\d+)\}\}/g, (_match, op, num) => {
    const n = parseInt(num, 10);
    switch (op) {
      case '+': return String(vars.worktreeNum + n);
      case '-': return String(vars.worktreeNum - n);
      case '*': return String(vars.worktreeNum * n);
      case '/': return String(Math.floor(vars.worktreeNum / n));
      default: return String(vars.worktreeNum);
    }
  });

  // Simple substitutions
  content = content.replace(/\{\{WORKTREE_NUM\}\}/g, String(vars.worktreeNum));
  content = content.replace(/\{\{BRANCH\}\}/g, vars.branch);
  content = content.replace(/\{\{REPO\}\}/g, vars.repo);
  content = content.replace(/\{\{WORKTREE_PATH\}\}/g, vars.worktreePath);

  return content;
}

/**
 * Copy template files to worktree with variable substitution
 */
function copyTemplateFiles(
  templatesDir: string,
  worktreePath: string,
  vars: { worktreeNum: number; branch: string; repo: string; worktreePath: string }
): string[] {
  const copiedFiles: string[] = [];

  function copyRecursive(srcDir: string, destDir: string) {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip .DS_Store
      if (entry.name === '.DS_Store') continue;

      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      if (entry.isDirectory()) {
        if (!fs.existsSync(destPath)) {
          fs.mkdirSync(destPath, { recursive: true });
        }
        copyRecursive(srcPath, destPath);
      } else {
        // Read, substitute, and write
        const content = fs.readFileSync(srcPath, 'utf-8');
        const substituted = substituteVariables(content, vars);

        // Ensure parent directory exists
        const destParent = path.dirname(destPath);
        if (!fs.existsSync(destParent)) {
          fs.mkdirSync(destParent, { recursive: true });
        }

        fs.writeFileSync(destPath, substituted);
        copiedFiles.push(path.relative(worktreePath, destPath));
      }
    }
  }

  copyRecursive(templatesDir, worktreePath);
  return copiedFiles;
}

/**
 * Extract org/repo from git remote URL
 * Examples:
 *   git@github.com:owner/repo-name.git -> owner/repo-name
 *   https://github.com/anthropics/claude-code.git -> anthropics/claude-code
 */
const getOrgRepoFromRemote = (repoPath: string): string | null => {
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim();

    // SSH format: git@github.com:org/repo.git
    const sshMatch = remoteUrl.match(/git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch) {
      return sshMatch[1];
    }

    // HTTPS format: https://github.com/org/repo.git
    const httpsMatch = remoteUrl.match(/https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (httpsMatch) {
      return httpsMatch[1];
    }

    return null;
  } catch {
    return null;
  }
};

export class WorktreeService {
  /**
   * List all worktrees for a repository
   */
  listWorktrees(repoPath: string, repositoryId: string): Worktree[] {
    try {
      const output = execSync('git worktree list --porcelain', {
        cwd: repoPath,
        encoding: 'utf-8',
      });

      // Get org/repo for index store path
      const orgRepo = getOrgRepoFromRemote(repoPath) || path.basename(repoPath);
      const repoWorktreeDir = path.join(getRepositoryDir(orgRepo), 'worktrees');
      const indexStore = loadIndexStore(repoWorktreeDir);

      return this.parsePorcelainOutput(output, repositoryId, repoPath, indexStore);
    } catch (error) {
      console.error('Failed to list worktrees:', error);
      return [];
    }
  }

  /**
   * Parse git worktree list --porcelain output
   */
  private parsePorcelainOutput(
    output: string,
    repositoryId: string,
    mainRepoPath: string,
    indexStore: IndexStore
  ): Worktree[] {
    const worktrees: Worktree[] = [];
    const entries = output.trim().split('\n\n');

    for (const entry of entries) {
      if (!entry.trim()) continue;

      const lines = entry.split('\n');
      let worktreePath = '';
      let head = '';
      let branch = '';

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          worktreePath = line.substring(9);
        } else if (line.startsWith('HEAD ')) {
          head = line.substring(5);
        } else if (line.startsWith('branch ')) {
          // refs/heads/main -> main
          branch = line.substring(7).replace('refs/heads/', '');
        } else if (line === 'detached') {
          branch = `(detached at ${head.substring(0, 7)})`;
        }
      }

      if (worktreePath) {
        const isMain = worktreePath === mainRepoPath;
        const index = getIndexForPath(indexStore, worktreePath);

        // Only include worktrees that are registered in the index store (created by this app)
        // Main worktree is always included
        if (isMain || index !== undefined) {
          worktrees.push({
            path: worktreePath,
            branch,
            isMain,
            repositoryId,
            index: isMain ? undefined : index,
          });
        }
      }
    }

    return worktrees;
  }

  /**
   * Create a new worktree
   */
  async createWorktree(
    repoPath: string,
    branch: string,
    baseBranch?: string
  ): Promise<{ worktreePath: string; index?: number; copiedFiles?: string[]; error?: string }> {
    // Generate worktree path: repositories/{org}/{repo}/worktrees/{branch}
    // Falls back to repo directory name if remote URL cannot be parsed
    const orgRepo = getOrgRepoFromRemote(repoPath) || path.basename(repoPath);
    const repoWorktreeDir = path.join(getRepositoryDir(orgRepo), 'worktrees');
    const worktreePath = path.join(repoWorktreeDir, branch);

    // Ensure base directory exists
    if (!fs.existsSync(repoWorktreeDir)) {
      fs.mkdirSync(repoWorktreeDir, { recursive: true });
    }

    // Allocate index before creating worktree
    const indexStore = loadIndexStore(repoWorktreeDir);
    const newIndex = allocateIndex(indexStore);

    return new Promise((resolve) => {
      let command: string;

      if (baseBranch) {
        // Create new branch from baseBranch
        command = `git worktree add -b "${branch}" "${worktreePath}" "${baseBranch}"`;
      } else {
        // Use existing branch
        command = `git worktree add "${worktreePath}" "${branch}"`;
      }

      exec(command, { cwd: repoPath }, (error, _stdout, stderr) => {
        if (error) {
          console.error('Failed to create worktree:', stderr);
          resolve({ worktreePath: '', error: stderr || error.message });
          return;
        }

        // Save index assignment
        indexStore.indexes[worktreePath] = newIndex;
        saveIndexStore(repoWorktreeDir, indexStore);

        console.log(`Worktree created: ${worktreePath} (index: ${newIndex})`);

        // Copy template files
        const templatesDir = findTemplatesDir(repoPath, orgRepo);
        let copiedFiles: string[] = [];

        if (templatesDir) {
          const repoName = orgRepo.includes('/') ? orgRepo.split('/')[1] : orgRepo;
          copiedFiles = copyTemplateFiles(templatesDir, worktreePath, {
            worktreeNum: newIndex,
            branch,
            repo: repoName,
            worktreePath,
          });
          if (copiedFiles.length > 0) {
            console.log(`Template files copied: ${copiedFiles.join(', ')}`);
          }
        }

        resolve({ worktreePath, index: newIndex, copiedFiles });
      });
    });
  }

  /**
   * Remove a worktree
   */
  async removeWorktree(
    repoPath: string,
    worktreePath: string,
    force: boolean = false
  ): Promise<{ success: boolean; error?: string }> {
    // Get org/repo for index store
    const orgRepo = getOrgRepoFromRemote(repoPath) || path.basename(repoPath);
    const repoWorktreeDir = path.join(getRepositoryDir(orgRepo), 'worktrees');

    return new Promise((resolve) => {
      const forceFlag = force ? ' --force' : '';
      const command = `git worktree remove "${worktreePath}"${forceFlag}`;

      exec(command, { cwd: repoPath }, (error, _stdout, stderr) => {
        if (error) {
          console.error('Failed to remove worktree:', stderr);
          resolve({ success: false, error: stderr || error.message });
          return;
        }

        // Remove index assignment
        const indexStore = loadIndexStore(repoWorktreeDir);
        const removedIndex = indexStore.indexes[worktreePath];
        delete indexStore.indexes[worktreePath];
        saveIndexStore(repoWorktreeDir, indexStore);

        console.log(`Worktree removed: ${worktreePath} (index ${removedIndex} freed)`);
        resolve({ success: true });
      });
    });
  }

  /**
   * List branches in a repository
   */
  listBranches(repoPath: string): { local: string[]; remote: string[]; defaultBranch: string | null } {
    try {
      // Get local branches
      const localOutput = execSync('git branch --format="%(refname:short)"', {
        cwd: repoPath,
        encoding: 'utf-8',
      });
      const local = localOutput.trim().split('\n').filter(Boolean);

      // Get remote branches
      const remoteOutput = execSync('git branch -r --format="%(refname:short)"', {
        cwd: repoPath,
        encoding: 'utf-8',
      });
      const remote = remoteOutput.trim().split('\n').filter(Boolean);

      // Get default branch from remote HEAD
      const defaultBranch = this.getDefaultBranch(repoPath);

      return { local, remote, defaultBranch };
    } catch (error) {
      console.error('Failed to list branches:', error);
      return { local: [], remote: [], defaultBranch: null };
    }
  }

  /**
   * Get the default branch name from remote origin
   */
  getDefaultBranch(repoPath: string): string | null {
    try {
      const output = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
        cwd: repoPath,
        encoding: 'utf-8',
      });
      // refs/remotes/origin/main -> main
      return output.trim().replace('refs/remotes/origin/', '');
    } catch {
      // Fallback: check if main or master exists
      try {
        execSync('git rev-parse --verify main', { cwd: repoPath, stdio: 'ignore' });
        return 'main';
      } catch {
        try {
          execSync('git rev-parse --verify master', { cwd: repoPath, stdio: 'ignore' });
          return 'master';
        } catch {
          return null;
        }
      }
    }
  }

  /**
   * Check if a worktree path belongs to a specific repository
   */
  isWorktreeOf(repoPath: string, worktreePath: string): boolean {
    const worktrees = this.listWorktrees(repoPath, '');
    return worktrees.some(wt => wt.path === worktreePath);
  }

  /**
   * Generate next branch name: wt-{index:3 digits}-{4 random alphanumeric}
   * Uses the next available index from the index store
   */
  generateNextBranchName(repoPath: string): string {
    const orgRepo = getOrgRepoFromRemote(repoPath) || path.basename(repoPath);
    const repoWorktreeDir = path.join(getRepositoryDir(orgRepo), 'worktrees');

    // Ensure directory exists for index store
    if (!fs.existsSync(repoWorktreeDir)) {
      fs.mkdirSync(repoWorktreeDir, { recursive: true });
    }

    const indexStore = loadIndexStore(repoWorktreeDir);
    const nextIndex = allocateIndex(indexStore);
    const suffix = generateRandomSuffix(4);

    return `wt-${String(nextIndex).padStart(3, '0')}-${suffix}`;
  }
}

// Singleton instance
export const worktreeService = new WorktreeService();
