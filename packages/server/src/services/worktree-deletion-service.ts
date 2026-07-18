import { resolve as resolvePath, sep as pathSep } from 'node:path';
import { $ } from 'bun';
import type { HookCommandResult, Session } from '@agent-console/shared';
import { getRepositoriesDir } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import type { WorktreeService } from './worktree-service.js';

/** Narrow subset of WorktreeService methods needed by the deletion service. */
type DeleteWorktreeServiceDeps = Pick<
  WorktreeService,
  'isWorktreeOf' | 'listWorktrees' | 'executeHookCommand' | 'removeWorktree' | 'removeOrphanedWorktree'
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
  requestUsername: string | null | undefined,
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
    requestUsername,
  );
}

// ---------- Dependencies ----------

export interface DeleteWorktreeDeps {
  worktreeService: DeleteWorktreeServiceDeps;
  sessionManager: SessionManager;
  repositoryManager: {
    getRepository(id: string): { name: string; path: string; cleanupCommand?: string | null } | undefined;
  };
  findOpenPullRequest: (
    branch: string,
    cwd: string,
    requestUsername: string | null,
  ) => Promise<{ number: number; title: string } | null>;
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

// ---------- Orphan recovery ----------

/**
 * Clean up an orphaned worktree whose repository row is no longer registered
 * in memory.
 *
 * Same shape as the main `deleteWorktree` path but git-less: no cleanup
 * command (the repository row is gone, so there is no `cleanupCommand` to
 * read), no open-PR check (no repo means no `gh` context), no main-worktree
 * check based on the registry (we rely on the per-session invariant).
 *
 * Security boundary still applies: the worktreePath must resolve under
 * `getRepositoriesDir()`. The main-worktree invariant still applies via the
 * matching sessions' `isMainWorktree` flag. The concurrency guard still
 * applies via `markDeletionInProgress`.
 *
 * `force` is intentionally not a parameter here: with no repository row,
 * there is no data to protect, so unconditional cleanup is the correct
 * default per #815.
 */
async function cleanupOrphanedWorktree(
  params: { repoId: string; worktreePath: string; requestUsername?: string | null },
  deps: DeleteWorktreeDeps,
): Promise<DeleteWorktreeResult> {
  const { repoId, worktreePath, requestUsername } = params;
  const { worktreeService, sessionManager } = deps;

  // 1. Security boundary check — same as validateWorktreePath, but without
  //    the repo-bound `isWorktreeOf` step (no registered repo to bind to).
  const canonicalPath = resolvePath(worktreePath);
  const repositoriesDir = resolvePath(getRepositoriesDir());
  if (!canonicalPath.startsWith(repositoriesDir + pathSep)) {
    return { success: false, error: 'Worktree path is outside managed directory', errorType: 'validation' };
  }

  // 2. Find matching sessions (same pattern as the registered path).
  const matchingSessions = sessionManager.getAllSessions().filter(
    (session: Session) => session.locationPath === worktreePath,
  );
  const sessionIds = matchingSessions.map(s => s.id);

  // 2a. Main-worktree protection: even on the orphan path, do not allow
  //     removing the main worktree of a registered worktree-session.
  for (const session of matchingSessions) {
    if (session.type === 'worktree' && session.isMainWorktree) {
      return {
        success: false,
        error: 'Cannot remove the main worktree. Only added worktrees can be removed.',
        errorType: 'validation',
      };
    }
  }

  // 3. Concurrency guard.
  if (!markDeletionInProgress(worktreePath)) {
    return { success: false, error: 'Deletion already in progress', errorType: 'conflict' };
  }

  try {
    // 4. Kill PTYs — best-effort, do not fail the deletion on these errors.
    const killResults = await Promise.allSettled(
      sessionIds.map((sid) => sessionManager.killSessionWorkers(sid)),
    );
    const killErrors: Array<{ sessionId: string; error: string }> = [];
    for (let i = 0; i < killResults.length; i++) {
      const result = killResults[i];
      if (result.status === 'rejected') {
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        logger.warn({ sessionId: sessionIds[i], error: msg }, 'PTY kill failed, proceeding with orphan cleanup');
        killErrors.push({ sessionId: sessionIds[i], error: msg });
      }
    }

    // 5. Remove the worktree dir + DB row via the git-less helper.
    //    Idempotent — fs.rm with force does not throw on missing paths,
    //    and deleteByPath does not throw on missing rows. In multi-user mode
    //    the requestUsername threads through so the elevated `rm -rf` runs
    //    as the worktree-owning user.
    try {
      await worktreeService.removeOrphanedWorktree(canonicalPath, requestUsername);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { repoId, worktreePath, requestUsername, err: error },
        'Failed to remove orphaned worktree directory',
      );
      return { success: false, error: message, sessionIds };
    }

    // 6. Delete sessions.
    let sessionDeleteError: string | undefined;
    if (sessionIds.length > 0) {
      const deleteErrors: string[] = [];
      for (const sid of sessionIds) {
        try {
          await sessionManager.deleteSession(sid);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.error({ repoId, worktreePath, sessionId: sid, error }, 'Failed to delete session after orphan cleanup');
          deleteErrors.push(`${sid}: ${msg}`);
        }
      }
      if (deleteErrors.length > 0) {
        sessionDeleteError = deleteErrors.join('; ');
      }
    }

    logger.info(
      { repoId, worktreePath, sessionIds },
      'Orphaned worktree cleaned up (repository row unregistered)',
    );
    return {
      success: true,
      ...(killErrors.length > 0 ? { killErrors } : {}),
      sessionDeleteError,
      sessionIds,
    };
  } finally {
    clearDeletionInProgress(worktreePath);
  }
}

// ---------- Main entry point ----------

export interface DeleteWorktreeParams {
  repoId: string;
  worktreePath: string;
  force: boolean;
  /**
   * Requesting OS username — when provided and `AUTH_MODE=multi-user`, threads
   * through to two distinct elevation points:
   * - `git worktree remove` / fallback `rm -rf` route through `runAsUser` so
   *   they execute as the worktree-owning user, fixing the `Permission denied`
   *   failure when the server user (`agentconsole`) tries to delete files
   *   owned by a delegated user.
   * - `findOpenPullRequest`'s `gh pr list` invocation runs under the
   *   requesting user's gh auth token instead of the server user's.
   *
   * Optional / null / undefined / single-user mode — both elevation points
   * bypass `sudo` and the existing direct-spawn behaviour is preserved.
   */
  requestUsername?: string | null;
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
export type DeleteWorktreeFn = typeof deleteWorktree;

export async function deleteWorktree(
  params: DeleteWorktreeParams,
  deps: DeleteWorktreeDeps,
): Promise<DeleteWorktreeResult> {
  const { repoId, worktreePath, force, requestUsername } = params;
  const { worktreeService, sessionManager, repositoryManager, findOpenPullRequest, getCurrentBranch } = deps;

  // 1. Look up repository.
  //
  // If the repository row is not in memory the worktree has lost its anchor:
  // RepositoryManager.initialize() skips missing repository directories at
  // startup, but persisted sessions and worktree DB rows referencing the
  // missing repo can still load. Returning "not-found" here would leave the
  // orphaned rows un-removable from the UI (see #815). Instead, route into
  // the git-less orphan cleanup path — "if the underlying data doesn't
  // exist, just clean up nicely rather than giving up partway".
  const repo = repositoryManager.getRepository(repoId);
  if (!repo) {
    return cleanupOrphanedWorktree({ repoId, worktreePath, requestUsername }, deps);
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
        const openPr = await findOpenPullRequest(branch, repo.path, requestUsername ?? null);
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
      requestUsername,
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

    // 6c. Remove worktree via git. `requestUsername` threads down so that in
    //     multi-user mode the `git worktree remove` / fallback `rm -rf` run
    //     as the worktree-owning user; null in single-user mode preserves
    //     the historical direct-spawn path.
    const result = await worktreeService.removeWorktree(repo.path, worktreePath, force, requestUsername);

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
