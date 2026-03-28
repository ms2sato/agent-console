import type { Worktree, HookCommandResult } from '@agent-console/shared';
import type { Session } from '@agent-console/shared';
import type { SessionManager } from './session-manager.js';
import { worktreeService } from './worktree-service.js';
import { fetchRemote } from '../lib/git.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('worktree-creation-service');

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
  parentSessionId?: string;
  parentWorkerId?: string;
  createdBy?: string;
  autoStartSession?: boolean;  // Defaults to true. When false, skip session creation.
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
export async function orchestrateWorktreeCreation(
  params: CreateWorktreeParams,
  sessionManager: SessionManager,
): Promise<CreateWorktreeResult> {
  const {
    repoPath, repoId, repoName, setupCommand, branch, baseBranch,
    useRemote, agentId, initialPrompt, title,
    parentSessionId, parentWorkerId, createdBy,
    autoStartSession = true,
  } = params;

  // 1. Handle remote fetch if requested
  let effectiveBaseBranch = baseBranch;
  let fetchFailed = false;
  let fetchError: string | undefined;

  if (useRemote && baseBranch) {
    try {
      await fetchRemote(baseBranch, repoPath);
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

  // 2. Create worktree
  const wtResult = await worktreeService.createWorktree(repoPath, branch, repoId, effectiveBaseBranch);

  if (wtResult.error) {
    return { success: false, error: wtResult.error };
  }

  const createdWorktreePath = wtResult.worktreePath;

  try {
    // 3. Find created worktree info
    const worktrees = await worktreeService.listWorktrees(repoPath, repoId);
    const worktree = worktrees.find(wt => wt.path === createdWorktreePath);

    if (!worktree) {
      throw new Error('Worktree was created but could not be found in the list');
    }

    // 4. Execute setup command if configured
    let setupCommandResult: HookCommandResult | undefined;
    if (setupCommand && worktree.index !== undefined) {
      setupCommandResult = await worktreeService.executeHookCommand(
        setupCommand,
        createdWorktreePath,
        {
          worktreeNum: worktree.index,
          branch: worktree.branch,
          repo: repoName,
        },
      );
    }

    // 5. Create session (unless explicitly skipped)
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
        parentSessionId,
        parentWorkerId,
      }, { createdBy });
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
    try {
      await worktreeService.removeWorktree(repoPath, createdWorktreePath, true);
    } catch (cleanupErr) {
      logger.warn(
        { worktreePath: createdWorktreePath, err: cleanupErr },
        'Failed to clean up worktree during rollback',
      );
    }
    throw postWorktreeErr;
  }
}
