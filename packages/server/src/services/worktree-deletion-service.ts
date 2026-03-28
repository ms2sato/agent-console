import { resolve as resolvePath, sep as pathSep } from 'node:path';
import { $ } from 'bun';
import type { HookCommandResult } from '@agent-console/shared';
import { getRepositoriesDir } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import { worktreeService } from './worktree-service.js';
import type { SessionManager } from './session-manager.js';

const logger = createLogger('worktree-deletion-service');

// Guard against concurrent deletion of the same worktree
const deletionsInProgress = new Set<string>();

/** Get the deletion guard set. Exported for testing only. */
export function _getDeletionsInProgress(): Set<string> {
  return deletionsInProgress;
}

/**
 * Check if a deletion is already in progress for the given worktree path.
 */
export function isDeletionInProgress(worktreePath: string): boolean {
  return deletionsInProgress.has(worktreePath);
}

/**
 * Mark a worktree as having a deletion in progress.
 * Returns false if already in progress (caller should abort).
 */
export function markDeletionInProgress(worktreePath: string): boolean {
  if (deletionsInProgress.has(worktreePath)) return false;
  deletionsInProgress.add(worktreePath);
  return true;
}

/**
 * Clear the deletion-in-progress guard for a worktree path.
 */
export function clearDeletionInProgress(worktreePath: string): void {
  deletionsInProgress.delete(worktreePath);
}

/**
 * Validate that a worktree path is within the managed repositories directory
 * and belongs to the specified repository.
 *
 * @returns null if valid, or an error message string if invalid.
 */
export async function validateWorktreePath(
  repoPath: string,
  worktreePath: string,
  repoId: string,
): Promise<string | null> {
  // Canonicalize path to prevent path traversal attacks
  const canonicalPath = resolvePath(worktreePath);

  // SECURITY: Explicit boundary check — resolve both sides to absolute paths
  const repositoriesDir = resolvePath(getRepositoriesDir());
  if (!canonicalPath.startsWith(repositoriesDir + pathSep)) {
    return 'Worktree path is outside managed directory';
  }

  // Verify this is actually a worktree of this repository
  if (!await worktreeService.isWorktreeOf(repoPath, canonicalPath, repoId)) {
    return 'Invalid worktree path for this repository';
  }

  return null;
}

/**
 * Execute the repository's cleanup command if configured.
 * Looks up the worktree in git listing to resolve template variables.
 *
 * @returns The cleanup command result, or undefined if no cleanup command is configured.
 */
export async function executeCleanupCommandIfConfigured(
  repo: { path: string; name: string; cleanupCommand?: string | null },
  repoId: string,
  worktreePath: string,
): Promise<HookCommandResult | undefined> {
  if (!repo.cleanupCommand) return undefined;

  const worktrees = await worktreeService.listWorktrees(repo.path, repoId);
  const targetWorktree = worktrees.find(wt => wt.path === worktreePath);
  if (!targetWorktree || targetWorktree.index === undefined) {
    return { success: false, error: 'Cleanup command skipped: worktree not found in git listing' };
  }

  return worktreeService.executeHookCommand(
    repo.cleanupCommand,
    worktreePath,
    {
      worktreeNum: targetWorktree.index,
      branch: targetWorktree.branch,
      repo: repo.name,
    },
  );
}

// ---------- Orchestration ----------

export interface DeleteWorktreeParams {
  repoPath: string;
  repoId: string;
  repoName: string;
  cleanupCommand?: string | null;
  worktreePath: string;
  sessionId?: string;  // If provided, session workers are killed and session is deleted on success
  force: boolean;
}

export interface DeleteWorktreeResult {
  success: boolean;
  error?: string;
  gitStatus?: string;  // Diagnostic info captured on worktree removal failure
  cleanupCommandResult?: HookCommandResult;
}

/**
 * Orchestrate worktree deletion: cleanup command, kill workers, remove worktree, delete session.
 *
 * Acquires the concurrency guard internally. The caller should NOT call
 * markDeletionInProgress/clearDeletionInProgress — this function handles both.
 */
export async function orchestrateWorktreeDeletion(
  params: DeleteWorktreeParams,
  sessionManager: SessionManager,
): Promise<DeleteWorktreeResult> {
  const { repoPath, repoId, repoName, cleanupCommand, worktreePath, sessionId, force } = params;

  if (!markDeletionInProgress(worktreePath)) {
    return { success: false, error: 'Deletion already in progress' };
  }

  try {
    // 1. Execute cleanup command if configured
    const cleanupCommandResult = await executeCleanupCommandIfConfigured(
      { path: repoPath, name: repoName, cleanupCommand },
      repoId,
      worktreePath,
    );

    // 2. Kill PTY processes to release directory handles
    if (sessionId) {
      sessionManager.killSessionWorkers(sessionId);
    }

    // 3. Remove worktree via git
    const result = await worktreeService.removeWorktree(repoPath, worktreePath, force);

    if (!result.success) {
      // Capture git status for diagnostics
      let gitStatus: string | undefined;
      try {
        const gitStatusResult = await $`git -C ${worktreePath} status`.quiet();
        gitStatus = gitStatusResult.stdout.toString();
      } catch {
        // If git status fails, just omit the field
      }

      logger.error({ repoId, worktreePath, error: result.error }, 'Worktree removal failed');
      // Do NOT delete session — preserve for retry
      return { success: false, error: result.error || 'Failed to remove worktree', gitStatus };
    }

    // 4. Delete session after successful worktree removal
    if (sessionId) {
      try {
        await sessionManager.deleteSession(sessionId);
      } catch (error) {
        logger.error({ repoId, worktreePath, sessionId, error }, 'Failed to delete session after worktree removal');
        // Session cleanup failure is non-fatal — worktree was removed successfully
      }
    }

    logger.info({ repoId, worktreePath, sessionId }, 'Worktree deletion completed');
    return { success: true, cleanupCommandResult };
  } finally {
    clearDeletionInProgress(worktreePath);
  }
}
