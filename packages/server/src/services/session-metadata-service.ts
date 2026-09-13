/**
 * SessionMetadataService - Handles session metadata updates (title).
 *
 * Responsibilities:
 * - Update session title for active and inactive sessions
 * - Persist metadata changes to the repository
 * - Broadcast updates via session lifecycle callbacks
 *
 * Supports two code paths:
 * - Active sessions: modifies in-memory InternalSession and persists
 * - Inactive sessions: reads from and writes to SessionRepository directly
 *
 * Also provides syncBranchFromGit, which updates worktreeId after an
 * external branch change detected by fs.watch. This does NOT call git
 * itself -- the branch has already changed in git by the time it runs.
 */

import type { Session } from '@agent-console/shared';
import type { InternalSession } from './internal-types.js';
import type { PersistedSession } from './persistence-service.js';
import type { SessionRepository } from '../repositories/index.js';
import type { SessionLifecycleCallbacks } from './session-lifecycle-types.js';
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
   * Update session metadata (title).
   *
   * For active sessions: modifies the in-memory session, persists, and broadcasts.
   * For inactive sessions: reads from and writes to the session repository directly.
   */
  async updateSessionMetadata(
    sessionId: string,
    updates: { title?: string }
  ): Promise<SessionMetadataUpdateResult> {
    const session = this.deps.getSession(sessionId);

    if (!session) {
      return this.updateInactiveSession(sessionId, updates);
    }

    return this.updateActiveSession(session, updates);
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

    // Git-diff workers persist a branch-agnostic base *spec* that re-resolves on
    // every diff, so a branch sync does NOT require recomputing or freezing a
    // base hash here. Leave each worker's spec unchanged.
    const toSave = { ...metadata, worktreeId: newBranch };
    await this.deps.sessionRepository.save(toSave);

    logger.info({ sessionId, newBranch }, 'Branch synced from git (inactive session)');

    return { success: true, branch: newBranch };
  }

  private async updateInactiveSession(
    sessionId: string,
    updates: { title?: string }
  ): Promise<SessionMetadataUpdateResult> {
    const metadata = await this.deps.sessionRepository.findById(sessionId);
    if (!metadata) {
      return { success: false, error: 'session_not_found' };
    }

    const result: SessionMetadataUpdateResult = { success: true };

    if (updates.title !== undefined) {
      const toSave = { ...metadata, title: updates.title } as PersistedSession;
      await this.deps.sessionRepository.save(toSave);
      result.title = updates.title;
    }

    return result;
  }

  private async updateActiveSession(
    session: InternalSession,
    updates: { title?: string }
  ): Promise<SessionMetadataUpdateResult> {
    if (updates.title !== undefined) {
      session.title = updates.title;
    }

    await this.deps.persistSession(session);

    // Broadcast session update via WebSocket
    this.deps.getSessionLifecycleCallbacks()?.onSessionUpdated?.(this.deps.toPublicSession(session));

    return {
      success: true,
      title: updates.title,
    };
  }
}
