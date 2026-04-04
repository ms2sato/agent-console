import type { InternalSession } from './internal-types.js';
import type { PersistedSession } from './persistence-service.js';
import type { SessionRepository } from '../repositories/index.js';
import type { WorkerManager } from './worker-manager.js';
import type { NotificationManager } from './notifications/notification-manager.js';
import type { MessageService } from './message-service.js';
import type { InterSessionMessageService } from './inter-session-message-service.js';
import type { MemoService } from './memo-service.js';
import type { SessionDataPathResolver } from '../lib/session-data-path-resolver.js';
import type { SessionLifecycleCallbacks } from './session-lifecycle-types.js';
import type { JobQueue } from '../jobs/index.js';
import { JOB_TYPES } from '../jobs/index.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('session-deletion');

export interface SessionDeletionDeps {
  getSession: (id: string) => InternalSession | undefined;
  setSession: (id: string, session: InternalSession) => void;
  deleteSessionFromMemory: (id: string) => void;
  sessionRepository: SessionRepository;
  workerManager: WorkerManager;
  jobQueue: JobQueue | null;
  notificationManager: NotificationManager | null;
  messageService: MessageService;
  interSessionMessageService: InterSessionMessageService;
  memoService: MemoService;
  getPathResolverForSession: (session: InternalSession) => SessionDataPathResolver;
  getPathResolverForPersistedSession: (persisted: PersistedSession) => SessionDataPathResolver;
  getSessionLifecycleCallbacks: () => SessionLifecycleCallbacks | undefined;
  getWebSocketCallbacks: () => { notifySessionDeleted: (sessionId: string) => void } | null;
  getTimerCleanupCallback: () => ((sessionId: string) => void) | undefined;
  getProcessCleanupCallback: () => ((sessionId: string) => void) | undefined;
  stopWatching: (locationPath: string) => void;
}

export class SessionDeletionService {
  constructor(private readonly deps: SessionDeletionDeps) {}

  /**
   * Kill all workers in a session without deleting the session itself.
   * Used to release directory handles (e.g., cwd) before worktree deletion
   * while keeping the session recoverable if deletion fails.
   */
  async killSessionWorkers(id: string): Promise<void> {
    const session = this.deps.getSession(id);
    if (!session) return;

    const killPromises: Promise<void>[] = [];
    for (const worker of session.workers.values()) {
      if (worker.type === 'git-diff') {
        this.deps.stopWatching(session.locationPath);
      } else {
        killPromises.push(this.deps.workerManager.killWorker(worker, id));
      }
    }
    await Promise.all(killPromises);
  }

  /**
   * Delete a session with atomic rollback.
   * Kills all workers, cleans up related resources, removes from persistence.
   * If the persistence delete fails, the in-memory session is restored.
   */
  async deleteSession(id: string): Promise<boolean> {
    const session = this.deps.getSession(id);
    if (!session) return false;

    // Notify all active Worker WebSocket connections that session is being deleted
    // This must happen BEFORE killing workers so clients receive the notification
    this.deps.getWebSocketCallbacks()?.notifySessionDeleted(id);

    // Kill all workers first (before removing from memory)
    const killPromises: Promise<void>[] = [];
    for (const worker of session.workers.values()) {
      if (worker.type === 'git-diff') {
        // Stop file watcher for git-diff workers
        this.deps.stopWatching(session.locationPath);
      } else {
        // Kill PTY for agent/terminal workers
        killPromises.push(this.deps.workerManager.killWorker(worker, id));
      }
    }
    await Promise.all(killPromises);

    // Verify jobQueue is available before proceeding
    if (!this.deps.jobQueue) {
      throw new Error('JobQueue not available for session cleanup. Ensure SessionManager.create() was called with jobQueue.');
    }

    // Resolve path resolver before cleanup operations
    const resolver = this.deps.getPathResolverForSession(session);

    // Perform all deletion operations atomically
    // If any fail, restore in-memory state to maintain consistency
    try {
      // 1. Enqueue cleanup job (async but fire-and-forget, failure is non-critical)
      await this.deps.jobQueue.enqueue(JOB_TYPES.CLEANUP_SESSION_OUTPUTS, { sessionId: id, repositoryName: resolver.getRepositoryName() });

      // 2. Clean up notification state (throttle timers, debounce timers)
      this.deps.notificationManager?.cleanupSession(id);

      // 2a. Clean up periodic timers associated with this session
      this.deps.getTimerCleanupCallback()?.(id);

      // 2a2. Clean up interactive processes associated with this session
      this.deps.getProcessCleanupCallback()?.(id);

      // 2b. Clean up inter-worker message history
      this.deps.messageService.clearSession(id);

      // 2c. Clean up inter-session message files
      try {
        await this.deps.interSessionMessageService.deleteSessionMessages(id, resolver);
      } catch (err) {
        logger.warn({ sessionId: id, err }, 'Failed to clean inter-session message files');
      }

      // 2d. Clean up memo file
      try {
        await this.deps.memoService.deleteMemo(id, resolver);
      } catch (err) {
        logger.warn({ sessionId: id, err }, 'Failed to clean memo file');
      }

      // 3. Remove from in-memory map
      this.deps.deleteSessionFromMemory(id);

      // 4. Delete from persistence (this is the critical operation)
      await this.deps.sessionRepository.delete(id);

      logger.info({ sessionId: id }, 'Session deleted');

      // 5. Only broadcast after all operations succeed
      this.deps.getSessionLifecycleCallbacks()?.onSessionDeleted?.(id);

      return true;
    } catch (err) {
      // Restore in-memory session if it was removed
      // This ensures UI and server state remain consistent
      this.deps.setSession(id, session);
      logger.error({ sessionId: id, err }, 'Failed to delete session, restored in-memory state');
      throw err;
    }
  }

  /**
   * Force delete a session, whether it's in memory or only in persistence.
   * Used for orphaned sessions that exist only in sessions.json.
   * @returns true if session was deleted, false if not found
   */
  async forceDeleteSession(id: string): Promise<boolean> {
    // Try in-memory first (handles active sessions)
    const deleted = await this.deleteSession(id);
    if (deleted) {
      return true;
    }

    // Check persistence for orphaned session
    const persisted = await this.deps.sessionRepository.findById(id);
    if (persisted) {
      const resolver = this.deps.getPathResolverForPersistedSession(persisted);
      // Enqueue cleanup of worker output files (same as deleteSession)
      if (this.deps.jobQueue) {
        await this.deps.jobQueue.enqueue(JOB_TYPES.CLEANUP_SESSION_OUTPUTS, { sessionId: id, repositoryName: resolver.getRepositoryName() });
      } else {
        logger.warn(
          { sessionId: id, method: 'forceDeleteSession', skippedJob: JOB_TYPES.CLEANUP_SESSION_OUTPUTS },
          'JobQueue not available, skipping cleanup job for orphaned session'
        );
      }
      await this.deps.sessionRepository.delete(id);
      // Clean up memo file
      try {
        await this.deps.memoService.deleteMemo(id, resolver);
      } catch (err) {
        logger.warn({ sessionId: id, err }, 'Failed to clean memo file');
      }
      // Broadcast deletion to connected clients
      this.deps.getSessionLifecycleCallbacks()?.onSessionDeleted?.(id);
      logger.info({ sessionId: id }, 'Orphaned session deleted from persistence');
      return true;
    }

    return false;
  }
}
