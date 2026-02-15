import { promises as fsPromises } from 'fs';
import * as path from 'path';
import type { Worktree, SetupCommandResult } from '@agent-console/shared';
import { getRepositoryDir } from '../lib/config.js';
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
import { createLogger } from '../lib/logger.js';
import type { WorktreeRepository, WorktreeRecord } from '../repositories/worktree-repository.js';
import { SqliteWorktreeRepository } from '../repositories/sqlite-worktree-repository.js';
import { getDatabase } from '../database/connection.js';

const logger = createLogger('worktree-service');

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
 * Priority: 1. .agent-console/ in repo root  2. $AGENT_CONSOLE_HOME/repositories/<owner>/<repo>/templates/
 */
async function findTemplatesDir(repoPath: string, orgRepo: string): Promise<string | null> {
  // Check repo-local templates
  const localTemplates = path.join(repoPath, '.agent-console');
  try {
    const stat = await fsPromises.stat(localTemplates);
    if (stat.isDirectory()) {
      return localTemplates;
    }
  } catch {
    // Directory doesn't exist, continue to global templates
  }

  // Check global templates in $AGENT_CONSOLE_HOME/repositories/<org>/<repo>/templates/
  const globalTemplates = path.join(getRepositoryDir(orgRepo), 'templates');
  try {
    const stat = await fsPromises.stat(globalTemplates);
    if (stat.isDirectory()) {
      return globalTemplates;
    }
  } catch {
    // Directory doesn't exist
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
async function copyTemplateFiles(
  templatesDir: string,
  worktreePath: string,
  vars: { worktreeNum: number; branch: string; repo: string; worktreePath: string }
): Promise<string[]> {
  const copiedFiles: string[] = [];

  async function copyRecursive(srcDir: string, destDir: string): Promise<void> {
    const entries = await fsPromises.readdir(srcDir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip .DS_Store
      if (entry.name === '.DS_Store') continue;

      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      if (entry.isDirectory()) {
        await fsPromises.mkdir(destPath, { recursive: true });
        await copyRecursive(srcPath, destPath);
      } else {
        // Read, substitute, and write
        const content = await fsPromises.readFile(srcPath, 'utf-8');
        const substituted = substituteVariables(content, vars);

        // Ensure parent directory exists
        const destParent = path.dirname(destPath);
        await fsPromises.mkdir(destParent, { recursive: true });

        await fsPromises.writeFile(destPath, substituted);
        copiedFiles.push(path.relative(worktreePath, destPath));
      }
    }
  }

  await copyRecursive(templatesDir, worktreePath);
  return copiedFiles;
}

/**
 * Extract user-facing error message from a git or generic error.
 * Prefers stderr from GitError (which contains the actual git error details).
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof GitError) return error.stderr;
  if (error instanceof Error) return error.message;
  return 'Unknown error';
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
   * Injected repository (via constructor). When provided, it is cached and reused.
   * When null, worktreeRepository getter creates a fresh SqliteWorktreeRepository
   * from the current database on each access. This avoids stale references when
   * the database is closed and reopened (e.g., between tests).
   */
  private readonly _injectedRepository: WorktreeRepository | null;

  constructor(worktreeRepository?: WorktreeRepository) {
    this._injectedRepository = worktreeRepository ?? null;
  }

  private get worktreeRepository(): WorktreeRepository {
    if (this._injectedRepository) {
      return this._injectedRepository;
    }
    return new SqliteWorktreeRepository(getDatabase());
  }

  /**
   * List all worktrees for a repository.
   * Includes git-tracked worktrees registered in DB and orphaned DB records
   * (worktrees that exist in DB but are no longer tracked by git).
   */
  async listWorktrees(repoPath: string, repositoryId: string): Promise<Worktree[]> {
    try {
      const output = await gitListWorktrees(repoPath);

      // Get all registered worktrees from DB
      const dbRecords = await this.worktreeRepository.findByRepositoryId(repositoryId);

      // Parse git output, matching with DB records for index info
      const gitWorktrees = this.parsePorcelainOutput(output, repositoryId, repoPath, dbRecords);

      // Find orphaned worktrees: exist in DB but not in git output
      const gitPaths = new Set(gitWorktrees.map(wt => wt.path));
      for (const record of dbRecords) {
        if (!gitPaths.has(record.path)) {
          gitWorktrees.push({
            path: record.path,
            branch: '(orphaned)',
            isMain: false,
            repositoryId,
            index: record.indexNumber,
          });
        }
      }

      return gitWorktrees;
    } catch (error) {
      logger.error({ err: error, repoPath }, 'Failed to list worktrees');
      return [];
    }
  }

  /**
   * Parse git worktree list --porcelain output.
   * Returns only git-tracked worktrees; the caller handles adding orphaned ones.
   */
  private parsePorcelainOutput(
    output: string,
    repositoryId: string,
    mainRepoPath: string,
    dbRecords: WorktreeRecord[]
  ): Worktree[] {
    const worktrees: Worktree[] = [];
    const entries = output.trim().split('\n\n');

    // Build a lookup map from DB records for efficient index retrieval
    const recordByPath = new Map(dbRecords.map(r => [r.path, r]));

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
        const record = recordByPath.get(worktreePath);

        // Only include worktrees that are registered in the DB (created by this app)
        // Main worktree is always included
        if (isMain || record !== undefined) {
          worktrees.push({
            path: worktreePath,
            branch,
            isMain,
            repositoryId,
            index: isMain ? undefined : record?.indexNumber,
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
    repositoryId: string,
    baseBranch?: string
  ): Promise<{ worktreePath: string; index?: number; copiedFiles?: string[]; error?: string }> {
    // Generate worktree path: repositories/{org}/{repo}/worktrees/wt-{index}-{suffix}
    // Directory name is independent of branch name to avoid path issues with branch names containing slashes
    const orgRepo = (await getOrgRepoFromRemote(repoPath)) || path.basename(repoPath);
    const repoWorktreeDir = path.join(getRepositoryDir(orgRepo), 'worktrees');

    // Ensure base directory exists
    await fsPromises.mkdir(repoWorktreeDir, { recursive: true });

    // Allocate index from DB records
    const dbRecords = await this.worktreeRepository.findByRepositoryId(repositoryId);
    const newIndex = this.allocateNextIndex(dbRecords);

    // Generate directory name: wt-{index:3 digits}-{4 random alphanumeric}
    const dirSuffix = generateRandomSuffix(4);
    const dirName = `wt-${String(newIndex).padStart(3, '0')}-${dirSuffix}`;
    const worktreePath = path.join(repoWorktreeDir, dirName);

    try {
      await gitCreateWorktree(worktreePath, branch, repoPath, { baseBranch });

      // Save record to DB
      await this.worktreeRepository.save({
        id: crypto.randomUUID(),
        repositoryId,
        path: worktreePath,
        indexNumber: newIndex,
        createdAt: new Date().toISOString(),
      });

      logger.info({ worktreePath, index: newIndex }, 'Worktree created');

      // Copy template files
      const templatesDir = await findTemplatesDir(repoPath, orgRepo);
      let copiedFiles: string[] = [];

      if (templatesDir) {
        const repoName = orgRepo.includes('/') ? orgRepo.split('/')[1] : orgRepo;
        copiedFiles = await copyTemplateFiles(templatesDir, worktreePath, {
          worktreeNum: newIndex,
          branch,
          repo: repoName,
          worktreePath,
        });
        if (copiedFiles.length > 0) {
          logger.info({ copiedFiles }, 'Template files copied');
        }
      }

      return { worktreePath, index: newIndex, copiedFiles };
    } catch (error) {
      const message = extractErrorMessage(error);
      logger.error({ err: error, message }, 'Failed to create worktree');
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
    try {
      await gitRemoveWorktree(worktreePath, repoPath, { force });

      // Remove DB record
      await this.worktreeRepository.deleteByPath(worktreePath);

      logger.info({ worktreePath }, 'Worktree removed');
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      logger.error({ err: error, message, worktreePath }, 'Failed to remove worktree');
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
      logger.error({ err: error }, 'Failed to list branches');
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
   * Check if a worktree path belongs to a specific repository.
   * Uses direct DB lookup instead of listing all worktrees.
   */
  async isWorktreeOf(repoPath: string, worktreePath: string, repositoryId: string): Promise<boolean> {
    // Main worktree is always valid
    if (worktreePath === repoPath) return true;

    // Check DB for registered worktree
    const record = await this.worktreeRepository.findByPath(worktreePath);
    return record !== null && record.repositoryId === repositoryId;
  }

  /**
   * Generate next branch name: wt-{index:3 digits}-{4 random alphanumeric}
   * Uses the next available index from the DB
   */
  async generateNextBranchName(repositoryId: string): Promise<string> {
    const dbRecords = await this.worktreeRepository.findByRepositoryId(repositoryId);
    const nextIndex = this.allocateNextIndex(dbRecords);
    const suffix = generateRandomSuffix(4);

    return `wt-${String(nextIndex).padStart(3, '0')}-${suffix}`;
  }

  /**
   * Allocate the next available index (fills gaps) from DB records
   */
  private allocateNextIndex(records: WorktreeRecord[]): number {
    const usedIndexes = new Set(records.map(r => r.indexNumber));
    let index = 1;
    while (usedIndexes.has(index)) {
      index++;
    }
    return index;
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
