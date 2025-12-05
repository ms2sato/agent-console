import { execSync, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Worktree } from '@agents-web-console/shared';

// Worktree base directory (can be overridden by WORKTREE_BASE_DIR env var)
const getWorktreeBaseDir = () => {
  return process.env.WORKTREE_BASE_DIR || path.join(os.homedir(), '.agents-web-console', 'worktrees');
};

/**
 * Extract org/repo from git remote URL
 * Examples:
 *   git@github.com:ms2sato/agents-web-console.git -> ms2sato/agents-web-console
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

      return this.parsePorcelainOutput(output, repositoryId, repoPath);
    } catch (error) {
      console.error('Failed to list worktrees:', error);
      return [];
    }
  }

  /**
   * Parse git worktree list --porcelain output
   */
  private parsePorcelainOutput(output: string, repositoryId: string, mainRepoPath: string): Worktree[] {
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
        worktrees.push({
          path: worktreePath,
          branch,
          head,
          isMain: worktreePath === mainRepoPath,
          repositoryId,
        });
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
  ): Promise<{ worktreePath: string; error?: string }> {
    // Generate worktree path: .worktrees/{org}/{repo}/{branch}
    // Falls back to repo directory name if remote URL cannot be parsed
    const orgRepo = getOrgRepoFromRemote(repoPath) || path.basename(repoPath);
    const baseDir = getWorktreeBaseDir();
    const repoWorktreeDir = path.join(baseDir, orgRepo);
    const worktreePath = path.join(repoWorktreeDir, branch);

    // Ensure base directory exists
    if (!fs.existsSync(repoWorktreeDir)) {
      fs.mkdirSync(repoWorktreeDir, { recursive: true });
    }

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

        console.log(`Worktree created: ${worktreePath}`);
        resolve({ worktreePath });
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
    return new Promise((resolve) => {
      const forceFlag = force ? ' --force' : '';
      const command = `git worktree remove "${worktreePath}"${forceFlag}`;

      exec(command, { cwd: repoPath }, (error, _stdout, stderr) => {
        if (error) {
          console.error('Failed to remove worktree:', stderr);
          resolve({ success: false, error: stderr || error.message });
          return;
        }

        console.log(`Worktree removed: ${worktreePath}`);
        resolve({ success: true });
      });
    });
  }

  /**
   * List branches in a repository
   */
  listBranches(repoPath: string): { local: string[]; remote: string[] } {
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

      return { local, remote };
    } catch (error) {
      console.error('Failed to list branches:', error);
      return { local: [], remote: [] };
    }
  }

  /**
   * Check if a worktree path belongs to a specific repository
   */
  isWorktreeOf(repoPath: string, worktreePath: string): boolean {
    const worktrees = this.listWorktrees(repoPath, '');
    return worktrees.some(wt => wt.path === worktreePath);
  }
}

// Singleton instance
export const worktreeService = new WorktreeService();
