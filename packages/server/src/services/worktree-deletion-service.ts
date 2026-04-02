import { resolve as resolvePath, sep as pathSep } from 'node:path';
import { $ } from 'bun';
import type { HookCommandResult, Session } from '@agent-console/shared';
import { getRepositoriesDir } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import type { WorktreeService } from './worktree-service.js';

/** Narrow subset of WorktreeService methods needed by the deletion service. */
type DeleteWorktreeServiceDeps = Pick<
  WorktreeService,
  'isWorktreeOf' | 'listWorktrees' | 'executeHookCommand' | 'removeWorktree'
>;
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

function markDeletionInProgress(worktreePath: string): boolean {
  if (deletionsInProgress.has(worktreePath)) return false;
  deletionsInProgress.add(worktreePath);
  return true;
}

function clearDeletionInProgress(worktreePath: string): void {
  deletionsInProgress.delete(worktreePath);
}

// ---------- Internal validation ----------

/**
 * Validate that a worktree path is within the managed repositories directory
 * and belongs to the specified repository.
 *
 * @returns null if valid, or an error message string if invalid.
 */
async function validateWorktreePath(
  worktreeService: DeleteWorktreeServiceDeps,
  repoPath: string,
  worktreePath: string,
  repoId: string,
): Promise<string | null> {
  const canonicalPath = resolvePath(worktreePath);

  // SECURITY: Explicit boundary check — resolve both sides to absolute paths
  const repositoriesDir = resolvePath(getRepositoriesDir());
  if (!canonicalPath.startsWith(repositoriesDir + pathSep)) {
    return 'Worktree path is outside managed directory';
  }

  if (!await worktreeService.isWorktreeOf(repoPath, canonicalPath, repoId)) {
    return 'Invalid worktree path for this repository';
  }

  return null;
}

/**
 * Execute the repository's cleanup command if configured.
 * Looks up the worktree in git listing to resolve template variables.
 */
async function executeCleanupCommandIfConfigured(
  worktreeService: DeleteWorktreeServiceDeps,
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

// ---------- Dependencies ----------

export interface DeleteWorktreeDeps {
  worktreeService: DeleteWorktreeServiceDeps;
  sessionManager: SessionManager;
  repositoryManager: {
    getRepository(id: string): { name: string; path: string; cleanupCommand?: string | null } | undefined;
  };
  findOpenPullRequest: (branch: string, cwd: string) => Promise<{ number: number; title: string } | null>;
  getCurrentBranch: (cwd: string) => Promise<string>;
}

// ---------- Result ----------

export interface DeleteWorktreeResult {
  success: boolean;
  error?: string;
  /** Helps handlers map to appropriate HTTP status codes */
  errorType?: 'not-found' | 'validation' | 'conflict' | 'open-pr';
  gitStatus?: string;
  cleanupCommandResult?: HookCommandResult;
  sessionDeleteError?: string;
  /** Per-session PTY kill errors (non-blocking — deletion proceeded despite these) */
  killErrors?: Array<{ sessionId: string; error: string }>;
  /** Session IDs that were cleaned up (for WebSocket broadcast) */
  sessionIds?: string[];
}

// ---------- Main entry point ----------

export interface DeleteWorktreeParams {
  repoId: string;
  worktreePath: string;
  force: boolean;
}

/**
 * Orchestrate worktree deletion end-to-end:
 * 1. Look up repository
 * 2. Validate worktree path
 * 3. Find all matching sessions, check main worktree protection
 * 4. Check for open PRs (unless force)
 * 5. Acquire concurrency guard
 * 6. Execute cleanup command, kill workers, remove worktree, delete sessions
 */
export async function deleteWorktree(
  params: DeleteWorktreeParams,
  deps: DeleteWorktreeDeps,
): Promise<DeleteWorktreeResult> {
  const { repoId, worktreePath, force } = params;
  const { worktreeService, sessionManager, repositoryManager, findOpenPullRequest, getCurrentBranch } = deps;

  // 1. Look up repository
  const repo = repositoryManager.getRepository(repoId);
  if (!repo) {
    return { success: false, error: `Repository not found: ${repoId}`, errorType: 'not-found' };
  }

  // 2. Validate worktree path
  const validationError = await validateWorktreePath(worktreeService, repo.path, worktreePath, repoId);
  if (validationError) {
    return { success: false, error: validationError, errorType: 'validation' };
  }

  // 3. Find all matching sessions
  const matchingSessions = sessionManager.getAllSessions().filter(
    (session: Session) => session.locationPath === worktreePath,
  );
  const sessionIds = matchingSessions.map(s => s.id);

  // 3a. Main worktree protection: check if any matching session is the main worktree
  for (const session of matchingSessions) {
    if (session.type === 'worktree' && session.isMainWorktree) {
      return {
        success: false,
        error: 'Cannot remove the main worktree. Only added worktrees can be removed.',
        errorType: 'validation',
      };
    }
  }

  // 4. Check for open PRs (unless force)
  if (!force) {
    try {
      const branch = await getCurrentBranch(worktreePath);
      if (branch && branch !== '(detached)' && branch !== '(unknown)') {
        const openPr = await findOpenPullRequest(branch, repo.path);
        if (openPr) {
          return {
            success: false,
            error: `WARNING: Cannot remove worktree. Branch '${branch}' has open PR #${openPr.number}. Merge or close the PR first, then retry.`,
            errorType: 'open-pr',
          };
        }
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to check for open PRs: ${error instanceof Error ? error.message : String(error)}. Cannot proceed with deletion.`,
        errorType: 'open-pr',
      };
    }
  }

  // 5. Acquire concurrency guard
  if (!markDeletionInProgress(worktreePath)) {
    return { success: false, error: 'Deletion already in progress', errorType: 'conflict' };
  }

  try {
    // 6a. Execute cleanup command if configured
    const cleanupCommandResult = await executeCleanupCommandIfConfigured(
      worktreeService,
      { path: repo.path, name: repo.name, cleanupCommand: repo.cleanupCommand },
      repoId,
      worktreePath,
    );

    // 6b. Kill PTY processes to release directory handles (await exit before worktree remove)
    const killResults = await Promise.allSettled(
      sessionIds.map((sid) => sessionManager.killSessionWorkers(sid)),
    );
    const killErrors: Array<{ sessionId: string; error: string }> = [];
    for (let i = 0; i < killResults.length; i++) {
      const result = killResults[i];
      if (result.status === 'rejected') {
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        logger.warn({ sessionId: sessionIds[i], error: msg }, 'PTY kill failed, proceeding with deletion');
        killErrors.push({ sessionId: sessionIds[i], error: msg });
      }
    }

    // 6c. Remove worktree via git
    const result = await worktreeService.removeWorktree(repo.path, worktreePath, force);

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
      // Do NOT delete sessions — preserve for retry
      return { success: false, error: result.error || 'Failed to remove worktree', gitStatus, sessionIds };
    }

    // 6d. Delete sessions after successful worktree removal
    let sessionDeleteError: string | undefined;
    if (sessionIds.length > 0) {
      const deleteErrors: string[] = [];
      for (const sid of sessionIds) {
        try {
          await sessionManager.deleteSession(sid);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.error({ repoId, worktreePath, sessionId: sid, error }, 'Failed to delete session after worktree removal');
          deleteErrors.push(`${sid}: ${msg}`);
        }
      }
      if (deleteErrors.length > 0) {
        sessionDeleteError = deleteErrors.join('; ');
      }
    }

    logger.info({ repoId, worktreePath, sessionIds }, 'Worktree deletion completed');
    return {
      success: true,
      cleanupCommandResult,
      ...(killErrors.length > 0 ? { killErrors } : {}),
      sessionDeleteError,
      sessionIds,
    };
  } finally {
    clearDeletionInProgress(worktreePath);
  }
}
