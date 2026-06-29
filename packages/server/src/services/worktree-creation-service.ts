import { promises as fsPromises } from 'fs';
import type { Worktree, HookCommandResult } from '@agent-console/shared';
import type { Session } from '@agent-console/shared';
import type { SessionManager } from './session-manager.js';
import type { SessionCreationContext } from './internal-types.js';
import type { WorktreeService } from './worktree-service.js';

/** Narrow subset of WorktreeService methods needed by the creation service. */
type CreateWorktreeServiceDeps = Pick<
  WorktreeService,
  'verifyRepoAccessible' | 'createWorktree' | 'removeWorktree' | 'executeHookCommand'
>;
import { fetchRemote, GitError } from '../lib/git.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('worktree-creation-service');

async function rollbackWorktree(
  worktreeService: CreateWorktreeServiceDeps,
  repoPath: string,
  worktreePath: string,
  requestUsername?: string | null,
): Promise<void> {
  try {
    // Thread `requestUsername` through so the rollback also elevates in
    // multi-user mode (Issue #882). The create path itself elevates per
    // #838 / PR #843, so leaving the rollback un-elevated would silently
    // re-introduce the same Permission-denied symptom against a worktree
    // the server user does not own.
    await worktreeService.removeWorktree(repoPath, worktreePath, true, requestUsername);
  } catch (cleanupErr) {
    logger.warn(
      { worktreePath, err: cleanupErr },
      'Failed to clean up worktree during rollback',
    );
  }
}

export interface CreateWorktreeParams {
  repoPath: string;
  repoId: string;
  repoName: string;
  setupCommand?: string | null;
  branch: string;
  baseBranch?: string;
  useRemote: boolean;
  agentId: string;
  initialPrompt?: string;
  title?: string;
  autoStartSession?: boolean;  // Defaults to true. When false, skip session creation.
  context?: SessionCreationContext;
  /**
   * OS username of the user who requested this worktree (typically
   * `authUser.username` from the route handler). Threaded down to
   * `WorktreeService.createWorktree` -> `runAsUser` so multi-user mode
   * creates the worktree files owned by the requesting user (Issue #838).
   * `null` / `undefined` -> no elevation (single-user mode, or any path that
   * has no authenticated user context).
   */
  requestUsername?: string | null;
}

export interface CreateWorktreeResult {
  success: boolean;
  error?: string;
  worktree?: Worktree;
  session?: Session;
  setupCommandResult?: HookCommandResult;
  fetchFailed?: boolean;
  fetchError?: string;
}

/**
 * Orchestrate worktree creation: fetch remote, create worktree, setup command, create session.
 *
 * On failure after worktree creation, rolls back by force-removing the created worktree.
 */
export type CreateWorktreeWithSessionFn = typeof createWorktreeWithSession;

export async function createWorktreeWithSession(
  params: CreateWorktreeParams,
  sessionManager: SessionManager,
  worktreeService: CreateWorktreeServiceDeps,
): Promise<CreateWorktreeResult> {
  const {
    repoPath, repoId, repoName, setupCommand, branch, baseBranch,
    useRemote, agentId, initialPrompt, title,
    autoStartSession = true,
    context,
    requestUsername,
  } = params;

  // 1. Pre-probe: verify the source repo is git-accessible BEFORE any
  // filesystem side effects. Surfaces failures like `dubious ownership`,
  // missing remote, or corrupt `.git/` with the underlying git stderr so
  // operators see the real cause instead of a misleading post-create
  // "could not be found in the list" message (Issue #854).
  try {
    await worktreeService.verifyRepoAccessible(repoPath);
  } catch (probeErr) {
    const detail = probeErr instanceof GitError
      ? (probeErr.stderr.trim() || `git exit code ${probeErr.exitCode}`)
      : probeErr instanceof Error
        ? probeErr.message
        : String(probeErr);
    logger.warn(
      { repoId, repoPath, err: probeErr },
      'Source repo accessibility probe failed; aborting worktree create',
    );
    return { success: false, error: `Cannot access repository: ${detail}` };
  }

  // 2. Handle remote fetch if requested
  let effectiveBaseBranch = baseBranch;
  let fetchFailed = false;
  let fetchError: string | undefined;

  if (useRemote && baseBranch) {
    try {
      // Forward `requestUsername` so multi-user mode runs the network fetch
      // as the requesting user (picks up their SSH credentials via sudo -i),
      // matching the elevated `createWorktree` call below.
      await fetchRemote(baseBranch, repoPath, requestUsername);
      effectiveBaseBranch = `origin/${baseBranch}`;
    } catch (error) {
      logger.warn(
        { repoId, baseBranch, error: error instanceof Error ? error.message : String(error) },
        'Failed to fetch remote branch, falling back to local',
      );
      fetchFailed = true;
      fetchError = 'Failed to fetch remote branch, created from local branch instead';
      // Keep local baseBranch as-is
    }
  }

  // 3. Create worktree
  const wtResult = await worktreeService.createWorktree(
    repoPath,
    branch,
    repoId,
    effectiveBaseBranch,
    requestUsername,
  );

  if (wtResult.error) {
    return { success: false, error: wtResult.error };
  }

  const createdWorktreePath = wtResult.worktreePath;

  // 4. Sanity safety net: confirm the directory actually exists. `git worktree
  // add` is reliable -- exit 0 means the worktree is registered -- so this
  // check is expected to fire approximately never. Kept defensively so a
  // genuinely unexpected failure (e.g., filesystem race, out-of-band deletion)
  // does not silently propagate into session creation.
  try {
    await fsPromises.stat(createdWorktreePath);
  } catch (statErr) {
    logger.warn(
      { worktreePath: createdWorktreePath, err: statErr },
      'createWorktree reported success but stat failed; rolling back',
    );
    await rollbackWorktree(worktreeService, repoPath, createdWorktreePath, requestUsername);
    return {
      success: false,
      error: `Worktree create reported success but directory is missing: ${createdWorktreePath}`,
    };
  }

  // The freshly-created worktree's authoritative description. `branch` here
  // is the requested branch name (the same string `createWorktree` was called
  // with); `path` is what `git worktree add` actually produced.
  const worktree: Worktree = {
    path: createdWorktreePath,
    branch,
    isMain: false,
    repositoryId: repoId,
    index: wtResult.index,
  };

  try {
    // 5. Execute setup command if configured
    let setupCommandResult: HookCommandResult | undefined;
    if (setupCommand && wtResult.index !== undefined) {
      setupCommandResult = await worktreeService.executeHookCommand(
        setupCommand,
        createdWorktreePath,
        {
          worktreeNum: wtResult.index,
          branch: worktree.branch,
          repo: repoName,
        },
        requestUsername,
      );
    }

    // 6. Create session (unless explicitly skipped)
    let session: Session | undefined;
    if (autoStartSession) {
      session = await sessionManager.createSession({
        type: 'worktree',
        repositoryId: repoId,
        worktreeId: worktree.branch,
        locationPath: worktree.path,
        agentId,
        initialPrompt,
        title,
        parentSessionId: context?.parentSessionId,
        parentWorkerId: context?.parentWorkerId,
        templateVars: context?.templateVars,
      }, context);
    }

    logger.info({ repoId, worktreePath: worktree.path, branch: worktree.branch }, 'Worktree creation completed');

    return {
      success: true,
      worktree,
      session,
      setupCommandResult,
      fetchFailed: fetchFailed || undefined,
      fetchError,
    };
  } catch (postWorktreeErr) {
    // Rollback: remove the worktree that was created before the failure
    logger.warn(
      { worktreePath: createdWorktreePath, err: postWorktreeErr },
      'Post-worktree step failed, rolling back worktree',
    );
    await rollbackWorktree(worktreeService, repoPath, createdWorktreePath, requestUsername);
    const errorMsg = postWorktreeErr instanceof Error ? postWorktreeErr.message : 'Unknown error during worktree creation';
    return { success: false, error: errorMsg };
  }
}
