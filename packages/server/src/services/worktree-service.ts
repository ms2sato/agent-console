import * as fs from 'fs';
import * as path from 'path';
import type { Worktree, SetupCommandResult } from '@agent-console/shared';
import { getRepositoryDir } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('worktree-service');
import {
  getRemoteUrl,
  parseOrgRepo,
  listWorktrees as gitListWorktrees,
  createWorktree as gitCreateWorktree,
  removeWorktree as gitRemoveWorktree,
  listLocalBranches,
  listRemoteBranches,
  getDefaultBranch as gitGetDefaultBranch,
  refreshDefaultBranch as gitRefreshDefaultBranch,
  GitError,
} from '../lib/git.js';

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
 *
 * SECURITY NOTE: The variables (branch, repo) come from git which enforces
 * strict naming rules. Git branch names cannot contain shell metacharacters
 * like ;, |, &, etc., so command injection via these values is not possible.
 * See: https://git-scm.com/docs/git-check-ref-format
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
async function getOrgRepoFromRemote(repoPath: string): Promise<string | null> {
  const remoteUrl = await getRemoteUrl(repoPath);
  if (!remoteUrl) {
    return null;
  }
  return parseOrgRepo(remoteUrl);
}

export class WorktreeService {
  /**
   * List all worktrees for a repository
   */
  async listWorktrees(repoPath: string, repositoryId: string): Promise<Worktree[]> {
    try {
      const output = await gitListWorktrees(repoPath);

      // Get org/repo for index store path
      const orgRepo = (await getOrgRepoFromRemote(repoPath)) || path.basename(repoPath);
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
    // Generate worktree path: repositories/{org}/{repo}/worktrees/wt-{index}-{suffix}
    // Directory name is independent of branch name to avoid path issues with branch names containing slashes
    const orgRepo = (await getOrgRepoFromRemote(repoPath)) || path.basename(repoPath);
    const repoWorktreeDir = path.join(getRepositoryDir(orgRepo), 'worktrees');

    // Ensure base directory exists
    if (!fs.existsSync(repoWorktreeDir)) {
      fs.mkdirSync(repoWorktreeDir, { recursive: true });
    }

    // Allocate index before creating worktree
    const indexStore = loadIndexStore(repoWorktreeDir);
    const newIndex = allocateIndex(indexStore);

    // Generate directory name: wt-{index:3 digits}-{4 random alphanumeric}
    const dirSuffix = generateRandomSuffix(4);
    const dirName = `wt-${String(newIndex).padStart(3, '0')}-${dirSuffix}`;
    const worktreePath = path.join(repoWorktreeDir, dirName);

    try {
      await gitCreateWorktree(worktreePath, branch, repoPath, { baseBranch });

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

      return { worktreePath, index: newIndex, copiedFiles };
    } catch (error) {
      const message = error instanceof GitError ? error.stderr : (error instanceof Error ? error.message : 'Unknown error');
      console.error('Failed to create worktree:', message);
      return { worktreePath: '', error: message };
    }
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
    const orgRepo = (await getOrgRepoFromRemote(repoPath)) || path.basename(repoPath);
    const repoWorktreeDir = path.join(getRepositoryDir(orgRepo), 'worktrees');

    try {
      await gitRemoveWorktree(worktreePath, repoPath, { force });

      // Remove index assignment
      const indexStore = loadIndexStore(repoWorktreeDir);
      const removedIndex = indexStore.indexes[worktreePath];
      delete indexStore.indexes[worktreePath];
      saveIndexStore(repoWorktreeDir, indexStore);

      console.log(`Worktree removed: ${worktreePath} (index ${removedIndex} freed)`);
      return { success: true };
    } catch (error) {
      const message = error instanceof GitError ? error.stderr : (error instanceof Error ? error.message : 'Unknown error');
      console.error('Failed to remove worktree:', message);
      return { success: false, error: message };
    }
  }

  /**
   * List branches in a repository
   */
  async listBranches(repoPath: string): Promise<{ local: string[]; remote: string[]; defaultBranch: string | null }> {
    try {
      const [local, remote, defaultBranch] = await Promise.all([
        listLocalBranches(repoPath),
        listRemoteBranches(repoPath),
        this.getDefaultBranch(repoPath),
      ]);

      return { local, remote, defaultBranch };
    } catch (error) {
      console.error('Failed to list branches:', error);
      return { local: [], remote: [], defaultBranch: null };
    }
  }

  /**
   * Get the default branch name from remote origin
   */
  async getDefaultBranch(repoPath: string): Promise<string | null> {
    return gitGetDefaultBranch(repoPath);
  }

  /**
   * Refresh the default branch reference from remote origin.
   * This updates the local refs/remotes/origin/HEAD to match the remote's default branch.
   *
   * @returns The updated default branch name
   * @throws GitError if the command fails (e.g., network error, no remote)
   */
  async refreshDefaultBranch(repoPath: string): Promise<string> {
    return gitRefreshDefaultBranch(repoPath);
  }

  /**
   * Check if a worktree path belongs to a specific repository
   */
  async isWorktreeOf(repoPath: string, worktreePath: string): Promise<boolean> {
    const worktrees = await this.listWorktrees(repoPath, '');
    return worktrees.some(wt => wt.path === worktreePath);
  }

  /**
   * Generate next branch name: wt-{index:3 digits}-{4 random alphanumeric}
   * Uses the next available index from the index store
   */
  async generateNextBranchName(repoPath: string): Promise<string> {
    const orgRepo = (await getOrgRepoFromRemote(repoPath)) || path.basename(repoPath);
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

  /**
   * Execute a setup command in a worktree directory.
   * Supports template variables: {{WORKTREE_NUM}}, {{BRANCH}}, {{REPO}}, {{WORKTREE_PATH}}
   * Also supports arithmetic expressions like {{WORKTREE_NUM + 3000}}
   *
   * @param command - The command template to execute
   * @param worktreePath - The worktree directory path (command will run here)
   * @param vars - Template variables for substitution
   * @returns Result with success status, output, and any error message
   */
  async executeSetupCommand(
    command: string,
    worktreePath: string,
    vars: { worktreeNum: number; branch: string; repo: string }
  ): Promise<SetupCommandResult> {
    // Substitute template variables in the command
    const substitutedCommand = substituteVariables(command, {
      worktreeNum: vars.worktreeNum,
      branch: vars.branch,
      repo: vars.repo,
      worktreePath,
    });

    logger.info({ worktreePath, command: substitutedCommand }, 'Executing setup command');

    try {
      // Execute command using Bun.spawn with shell
      const proc = Bun.spawn(['sh', '-c', substitutedCommand], {
        cwd: worktreePath,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          WORKTREE_NUM: String(vars.worktreeNum),
          BRANCH: vars.branch,
          REPO: vars.repo,
          WORKTREE_PATH: worktreePath,
        },
      });

      // Collect output
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode === 0) {
        logger.info({ worktreePath, exitCode }, 'Setup command completed successfully');
        return {
          success: true,
          output: stdout || undefined,
        };
      } else {
        logger.warn({ worktreePath, exitCode, stderr }, 'Setup command failed');
        return {
          success: false,
          output: stdout || undefined,
          error: stderr || `Command exited with code ${exitCode}`,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ worktreePath, err: error }, 'Setup command execution error');
      return {
        success: false,
        error: errorMessage,
      };
    }
  }
}

// Singleton instance
export const worktreeService = new WorktreeService();
