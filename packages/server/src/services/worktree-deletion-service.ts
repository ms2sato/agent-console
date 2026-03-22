import { resolve as resolvePath, sep as pathSep } from 'node:path';
import type { HookCommandResult } from '@agent-console/shared';
import { getRepositoriesDir } from '../lib/config.js';
import { worktreeService } from './worktree-service.js';

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

  // SECURITY: Explicit boundary check
  const repositoriesDir = getRepositoriesDir();
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
