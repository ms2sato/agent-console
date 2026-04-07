/**
 * SessionMetadataService - Handles session metadata updates (title and branch).
 *
 * Responsibilities:
 * - Update session title for active and inactive sessions
 * - Rename branch for worktree sessions (active and inactive)
 * - Persist metadata changes to the repository
 * - Broadcast updates via session lifecycle callbacks
 *
 * Supports two code paths:
 * - Active sessions: modifies in-memory InternalSession and persists
 * - Inactive sessions: reads from and writes to SessionRepository directly
 */

import type { Session } from '@agent-console/shared';
import type { InternalSession } from './internal-types.js';
import type { PersistedSession, PersistedWorker } from './persistence-service.js';
import type { SessionRepository } from '../repositories/index.js';
import type { SessionLifecycleCallbacks } from './session-lifecycle-types.js';
import {
  getCurrentBranch as gitGetCurrentBranch,
  renameBranch as gitRenameBranch,
} from '../lib/git.js';
import { calculateBaseCommit } from './git-diff-service.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('session-metadata');

export type SessionMetadataUpdateResult = {
  success: boolean;
  title?: string;
  branch?: string;
  error?: string;
};

/**
 * Dependencies injected by SessionManager.
 * Uses closures to capture late-bound state so values are always current at call time.
 */
export interface SessionMetadataDeps {
  getSession: (id: string) => InternalSession | undefined;
  sessionRepository: SessionRepository;
  persistSession: (session: InternalSession) => Promise<void>;
  toPublicSession: (session: InternalSession) => Session;
  getSessionLifecycleCallbacks: () => SessionLifecycleCallbacks | undefined;
  updateGitDiffWorkersAfterBranchRename: (sessionId: string) => Promise<void>;
}

export class SessionMetadataService {
  constructor(private readonly deps: SessionMetadataDeps) {}

  /**
   * Update session metadata (title and/or branch).
   *
   * For active sessions: modifies the in-memory session, persists, and broadcasts.
   * For inactive sessions: reads from and writes to the session repository directly.
   */
  async updateSessionMetadata(
    sessionId: string,
    updates: { title?: string; branch?: string }
  ): Promise<SessionMetadataUpdateResult> {
    const session = this.deps.getSession(sessionId);

    if (!session) {
      return this.updateInactiveSession(sessionId, updates);
    }

    return this.updateActiveSession(session, sessionId, updates);
  }

  /**
   * @deprecated Use updateSessionMetadata instead
   * Rename the branch for a worktree session.
   */
  async renameBranch(
    sessionId: string,
    newBranch: string
  ): Promise<{ success: boolean; branch?: string; error?: string }> {
    return this.updateSessionMetadata(sessionId, { branch: newBranch });
  }

  /**
   * Update worktreeId after an external branch change (e.g., detected by fs.watch).
   *
   * Unlike updateSessionMetadata, this does NOT call gitRenameBranch because
   * the branch has already changed in git. It only updates in-memory state,
   * persists, and broadcasts.
   */
  async syncBranchFromGit(
    sessionId: string,
    newBranch: string
  ): Promise<SessionMetadataUpdateResult> {
    const session = this.deps.getSession(sessionId);

    if (!session) {
      // For inactive sessions, update persistence directly
      return this.syncBranchForInactiveSession(sessionId, newBranch);
    }

    if (session.type !== 'worktree') {
      return { success: false, error: 'Can only sync branch for worktree sessions' };
    }

    if (session.worktreeId === newBranch) {
      return { success: true, branch: newBranch };
    }

    session.worktreeId = newBranch;

    // Update git-diff workers' base commit for the new branch
    try {
      await this.deps.updateGitDiffWorkersAfterBranchRename(sessionId);
    } catch (diffUpdateError) {
      logger.error(
        { sessionId, err: diffUpdateError },
        'Failed to update git-diff workers after branch sync'
      );
    }

    await this.deps.persistSession(session);

    // Broadcast session update via WebSocket
    this.deps.getSessionLifecycleCallbacks()?.onSessionUpdated?.(this.deps.toPublicSession(session));

    logger.info({ sessionId, newBranch }, 'Branch synced from git');

    return { success: true, branch: newBranch };
  }

  private async syncBranchForInactiveSession(
    sessionId: string,
    newBranch: string
  ): Promise<SessionMetadataUpdateResult> {
    const metadata = await this.deps.sessionRepository.findById(sessionId);
    if (!metadata) {
      return { success: false, error: 'session_not_found' };
    }

    if (metadata.type !== 'worktree') {
      return { success: false, error: 'Can only sync branch for worktree sessions' };
    }

    if (metadata.worktreeId === newBranch) {
      return { success: true, branch: newBranch };
    }

    // Update base commit for git-diff workers
    let updatedWorkers: typeof metadata.workers | undefined;
    try {
      const newBaseCommit = await calculateBaseCommit(metadata.locationPath);
      const resolvedBaseCommit = newBaseCommit ?? 'HEAD';
      updatedWorkers = metadata.workers.map(w => {
        if (w.type === 'git-diff') {
          return { ...w, baseCommit: resolvedBaseCommit };
        }
        return w;
      });
    } catch (diffUpdateError) {
      logger.error(
        { sessionId, err: diffUpdateError },
        'Failed to update git-diff workers after branch sync for inactive session'
      );
    }

    const toSave = { ...metadata, worktreeId: newBranch };
    if (updatedWorkers !== undefined) {
      toSave.workers = updatedWorkers;
    }
    await this.deps.sessionRepository.save(toSave);

    logger.info({ sessionId, newBranch }, 'Branch synced from git (inactive session)');

    return { success: true, branch: newBranch };
  }

  private async updateInactiveSession(
    sessionId: string,
    updates: { title?: string; branch?: string }
  ): Promise<SessionMetadataUpdateResult> {
    const metadata = await this.deps.sessionRepository.findById(sessionId);
    if (!metadata) {
      return { success: false, error: 'session_not_found' };
    }

    const result: SessionMetadataUpdateResult = { success: true };
    let updatedTitle: string | undefined;
    let updatedWorkers: PersistedWorker[] | undefined;
    let updatedWorktreeId: string | undefined;

    // Title update
    if (updates.title !== undefined) {
      updatedTitle = updates.title;
      result.title = updates.title;
    }

    // Branch rename for inactive sessions
    if (updates.branch) {
      if (metadata.type !== 'worktree') {
        return { success: false, error: 'Can only rename branch for worktree sessions' };
      }

      const currentBranch = await gitGetCurrentBranch(metadata.locationPath);

      try {
        await gitRenameBranch(currentBranch, updates.branch, metadata.locationPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: message };
      }

      // Update git-diff workers' base commit after successful branch rename.
      // This is a secondary concern - failure should not abort the branch rename.
      try {
        const newBaseCommit = await calculateBaseCommit(metadata.locationPath);
        const resolvedBaseCommit = newBaseCommit ?? 'HEAD';
        updatedWorkers = metadata.workers.map(w => {
          if (w.type === 'git-diff') {
            return { ...w, baseCommit: resolvedBaseCommit };
          }
          return w;
        });
      } catch (diffUpdateError) {
        logger.error(
          { sessionId, err: diffUpdateError },
          'Failed to update git-diff workers after branch rename for inactive session'
        );
      }

      updatedWorktreeId = updates.branch;
      result.branch = updates.branch;
    }

    // Persist all updates in a single save
    if (updatedTitle !== undefined || updatedWorktreeId !== undefined) {
      const toSave = { ...metadata } as PersistedSession;
      if (updatedTitle !== undefined) {
        toSave.title = updatedTitle;
      }
      if (updatedWorktreeId !== undefined && toSave.type === 'worktree') {
        toSave.worktreeId = updatedWorktreeId;
        // If calculateBaseCommit threw, updatedWorkers is undefined and we preserve
        // the original metadata.workers via the ...metadata spread above.
        if (updatedWorkers !== undefined) {
          toSave.workers = updatedWorkers;
        }
      }
      await this.deps.sessionRepository.save(toSave);
    }

    return result;
  }

  private async updateActiveSession(
    session: InternalSession,
    sessionId: string,
    updates: { title?: string; branch?: string }
  ): Promise<SessionMetadataUpdateResult> {
    // Handle title update
    if (updates.title !== undefined) {
      session.title = updates.title;
    }

    // Handle branch rename for active session
    if (updates.branch) {
      if (session.type !== 'worktree') {
        return { success: false, error: 'Can only rename branch for worktree sessions' };
      }

      const currentBranch = await gitGetCurrentBranch(session.locationPath);

      try {
        await gitRenameBranch(currentBranch, updates.branch, session.locationPath);
        session.worktreeId = updates.branch;

        // Update git-diff workers' base commit after successful branch rename.
        // This is a secondary concern - failure should not abort the branch rename.
        try {
          await this.deps.updateGitDiffWorkersAfterBranchRename(sessionId);
        } catch (diffUpdateError) {
          logger.error(
            { sessionId, err: diffUpdateError },
            'Failed to update git-diff workers after branch rename for active session'
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: message };
      }
    }

    await this.deps.persistSession(session);

    // Broadcast session update via WebSocket
    this.deps.getSessionLifecycleCallbacks()?.onSessionUpdated?.(this.deps.toPublicSession(session));

    return {
      success: true,
      title: updates.title,
      branch: updates.branch,
    };
  }
}
