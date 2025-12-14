import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  SessionValidationResult,
  SessionValidationIssue,
  SessionsValidationResponse,
} from '@agent-console/shared';
import {
  persistenceService,
  type PersistedSession,
} from './persistence-service.js';
import { gitRefExists } from '../lib/git.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('session-validation');

/**
 * Service for validating session integrity.
 *
 * Checks:
 * 1. locationPath exists (directory)
 * 2. For worktree sessions: locationPath is a git repository
 * 3. For worktree sessions: worktreeId (branch) exists
 */
export class SessionValidationService {
  /**
   * Validate a single session
   */
  async validateSession(session: PersistedSession): Promise<SessionValidationResult> {
    const issues: SessionValidationIssue[] = [];

    // Check 1: Directory exists
    const directoryExists = await this.checkDirectoryExists(session.locationPath);
    if (!directoryExists) {
      issues.push({
        type: 'directory_not_found',
        message: `Directory does not exist: ${session.locationPath}`,
      });
      // If directory doesn't exist, we can't check further
      return this.buildResult(session, issues);
    }

    // For worktree sessions, perform git-specific checks
    if (session.type === 'worktree') {
      // Check 2: Is a git repository
      const isGitRepo = await this.checkIsGitRepository(session.locationPath);
      if (!isGitRepo) {
        issues.push({
          type: 'not_git_repository',
          message: `Not a git repository: ${session.locationPath}`,
        });
        // If not a git repo, we can't check branch
        return this.buildResult(session, issues);
      }

      // Check 3: Branch exists
      const branchExists = await this.checkBranchExists(session.worktreeId, session.locationPath);
      if (!branchExists) {
        issues.push({
          type: 'branch_not_found',
          message: `Branch does not exist: ${session.worktreeId}`,
        });
      }
    }

    return this.buildResult(session, issues);
  }

  /**
   * Validate all persisted sessions
   */
  async validateAllSessions(): Promise<SessionsValidationResponse> {
    const persistedSessions = persistenceService.loadSessions();
    const results: SessionValidationResult[] = [];

    for (const session of persistedSessions) {
      const result = await this.validateSession(session);
      results.push(result);
    }

    const hasIssues = results.some(r => !r.valid);

    logger.info({
      totalSessions: results.length,
      invalidSessions: results.filter(r => !r.valid).length,
      hasIssues,
    }, 'Session validation completed');

    return { results, hasIssues };
  }

  /**
   * Get only invalid sessions
   */
  async getInvalidSessions(): Promise<SessionValidationResult[]> {
    const response = await this.validateAllSessions();
    return response.results.filter(r => !r.valid);
  }

  private async checkDirectoryExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dirPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  private async checkIsGitRepository(dirPath: string): Promise<boolean> {
    // Check for .git file or directory (supports both regular repos and worktrees)
    const gitPath = path.join(dirPath, '.git');
    try {
      await fs.access(gitPath);
      return true;
    } catch {
      return false;
    }
  }

  private async checkBranchExists(branch: string, cwd: string): Promise<boolean> {
    // Use gitRefExists which checks if the ref can be resolved
    return gitRefExists(branch, cwd);
  }

  private buildResult(session: PersistedSession, issues: SessionValidationIssue[]): SessionValidationResult {
    return {
      sessionId: session.id,
      session: {
        type: session.type,
        locationPath: session.locationPath,
        worktreeId: session.type === 'worktree' ? session.worktreeId : undefined,
        title: session.title,
      },
      valid: issues.length === 0,
      issues,
    };
  }
}

// Singleton instance
export const sessionValidationService = new SessionValidationService();
