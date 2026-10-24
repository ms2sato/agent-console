import type { Kysely } from 'kysely';
import type { InternalSession } from './internal-types.js';
import type { Database } from '../database/schema.js';
import type { PersistedSession } from '../repositories/persisted-types.js';
import type { SessionRepository } from '../repositories/index.js';
import type { TodoRepository } from '../repositories/todo-repository.js';
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
import { SessionInitializationService } from './session-initialization-service.js';
import type { sweepOrphanProcesses } from './orphan-process-sweeper.js';

const logger = createLogger('session-deletion');

export interface SessionDeletionDeps {
  getSession: (id: string) => InternalSession | undefined;
  setSession: (id: string, session: InternalSession) => void;
  deleteSessionFromMemory: (id: string) => void;
  sessionRepository: SessionRepository;
  workerManager: WorkerManager;
  jobQueue: JobQueue | null;
  /**
   * Handle the cleanup-job enqueue and the session row delete share a
   * transaction on. Absent: the two writes run separately, as before.
   */
  db?: Kysely<Database> | null;
  /**
   * Withdraws the deleted session's open session-scoped TODO items in the same
   * transaction as the row delete. Absent: no TODO items are touched.
   */
  todoRepository?: TodoRepository | null;
  notificationManager: NotificationManager | null;
  messageService: MessageService;
  interSessionMessageService: InterSessionMessageService;
  memoService: MemoService;
  /**
   * Deactivate an embedded-agent worker's subprocess. Embedded-agent workers
   * are not PTY-backed, so `workerManager.killWorker` silently no-ops on them
   * (subprocess leak). Both worker-kill loops route them here instead.
   */
  deactivateEmbeddedAgentWorker: (sessionId: string, workerId: string) => Promise<void>;
  getPathResolverForSession: (session: InternalSession) => SessionDataPathResolver;
  getPathResolverForPersistedSession: (persisted: PersistedSession) => SessionDataPathResolver;
  /** Return the (scope, slug) pair for an in-memory session, or null if orphaned. */
  getSessionScope: (session: InternalSession) => { scope: 'quick' | 'repository'; slug: string | null } | null;
  /** Return the (scope, slug) pair for a persisted session, or null if orphaned. */
  getPersistedSessionScope: (persisted: PersistedSession) => { scope: 'quick' | 'repository'; slug: string | null } | null;
  getSessionLifecycleCallbacks: () => SessionLifecycleCallbacks | undefined;
  getWebSocketCallbacks: () => {
    notifySessionDeleted: (sessionId: string) => void;
    stopWorkerWatching: (sessionId: string, workerId: string) => void;
  } | null;
  getTimerCleanupCallback: () => ((sessionId: string) => void) | undefined;
  getConditionalWakeupCleanupCallback: () => ((sessionId: string) => void) | undefined;
  getProcessCleanupCallback: () => ((sessionId: string) => void) | undefined;
  stopBranchWatching: (sessionId: string) => void;
  /** Resolve the OS user a session's processes run as (same resolver the startup sweep uses). */
  resolveSpawnUsername: (createdBy?: string) => Promise<string>;
  /** Test seam for the orphan-process sweep; defaults to the real one. */
  sweepOrphanProcessesImpl?: typeof sweepOrphanProcesses;
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

    // NOTE: Do NOT stop branch watching here. This method keeps the session
    // recoverable — branch tracking should continue for surviving sessions.
    // stopBranchWatching is called in deleteSession() which is the final teardown.

    const killPromises: Promise<void>[] = [];
    for (const worker of session.workers.values()) {
      if (worker.type === 'git-diff' || worker.type === 'file-viewer') {
        // Nothing to tear down here, on purpose: this path also runs when a worktree removal
        // fails recoverably and the session is KEPT for a retry, and a diff or viewer watch
        // must survive that. The subscriptions are released by the final deleteSession() below
        // and by the pause branch.
      } else if (worker.type === 'embedded-agent') {
        killPromises.push(this.deps.deactivateEmbeddedAgentWorker(id, worker.id));
      } else {
        killPromises.push(this.deps.workerManager.killWorker(worker, id));
      }
    }
    await Promise.all(killPromises);
  }

  /**
   * Delete the session row and schedule its output cleanup in ONE transaction,
   * so a failed row delete cannot leave a live session whose output files are
   * already scheduled for deletion. With no job queue or no scope there is
   * nothing to schedule and the row delete runs alone. The transaction body is
   * exactly the statements below: process and filesystem work stays outside it.
   * The queue is woken after commit because an enqueue on a transaction does
   * not emit by itself.
   *
   * Every path that deletes the row also withdraws the session's open
   * session-scoped TODO items (`TodoRepository.withdrawOpenSessionScoped`), in
   * the same transaction wherever one exists, so no open item outlives the
   * session that was its only audience.
   *
   * Without an injected `db` the writes run separately (enqueue first, as
   * before) and a warning says so.
   */
  private async deleteRowWithCleanupJob(
    id: string,
    scopeInfo: { scope: 'quick' | 'repository'; slug: string | null } | null,
  ): Promise<void> {
    const { jobQueue, db, sessionRepository, todoRepository } = this.deps;
    if (!jobQueue || !scopeInfo) {
      if (db && todoRepository) {
        await db.transaction().execute(async (trx) => {
          await sessionRepository.delete(id, trx);
          await todoRepository.withdrawOpenSessionScoped(id, trx);
        });
        return;
      }
      await sessionRepository.delete(id);
      await todoRepository?.withdrawOpenSessionScoped(id);
      return;
    }
    const payload = { sessionId: id, scope: scopeInfo.scope, slug: scopeInfo.slug };
    if (!db) {
      logger.warn(
        { sessionId: id },
        'No database handle injected; session-outputs cleanup enqueue and session row delete are not atomic',
      );
      await jobQueue.enqueue(JOB_TYPES.CLEANUP_SESSION_OUTPUTS, payload);
      await sessionRepository.delete(id);
      await todoRepository?.withdrawOpenSessionScoped(id);
      return;
    }
    await db.transaction().execute(async (trx) => {
      await jobQueue.enqueue(JOB_TYPES.CLEANUP_SESSION_OUTPUTS, payload, { executor: trx });
      await sessionRepository.delete(id, trx);
      await todoRepository?.withdrawOpenSessionScoped(id, trx);
    });
    jobQueue.wake();
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

    // Stop branch watcher
    this.deps.stopBranchWatching(id);

    // Kill all workers first (before removing from memory)
    const killPromises: Promise<void>[] = [];
    for (const worker of session.workers.values()) {
      if (worker.type === 'git-diff' || worker.type === 'file-viewer') {
        // Close the worker's watch subscriptions (idempotent).
        this.deps.getWebSocketCallbacks()?.stopWorkerWatching(id, worker.id);
      } else if (worker.type === 'embedded-agent') {
        // Tear down the loop subprocess (killWorker no-ops on non-PTY workers).
        killPromises.push(this.deps.deactivateEmbeddedAgentWorker(id, worker.id));
      } else {
        // Kill PTY for agent/terminal workers
        killPromises.push(this.deps.workerManager.killWorker(worker, id));
      }
    }
    await Promise.all(killPromises);

    // Broader net after the tracked kills: reap any process still carrying this
    // session's AGENT_CONSOLE_SESSION_ID marker (run_process descendants and
    // other untracked children). Best-effort: a sweep failure never fails the
    // delete.
    try {
      await SessionInitializationService.sweepSessionProcesses(
        session,
        this.deps.resolveSpawnUsername,
        { sweepImpl: this.deps.sweepOrphanProcessesImpl },
      );
    } catch (err) {
      logger.warn({ sessionId: id, err }, 'Session-deletion process sweep failed (best-effort, continuing)');
    }

    // Verify jobQueue is available before proceeding
    if (!this.deps.jobQueue) {
      throw new Error('JobQueue not available for session cleanup. Ensure SessionManager.create() was called with jobQueue.');
    }

    // Resolve path resolver (may throw for orphaned sessions — handled below
    // via getSessionScope which returns null for orphaned).
    let resolver: SessionDataPathResolver | null;
    try {
      resolver = this.deps.getPathResolverForSession(session);
    } catch {
      resolver = null;
    }

    const scopeInfo = this.deps.getSessionScope(session);

    // Perform all deletion operations atomically
    // If any fail, restore in-memory state to maintain consistency
    try {
      // 2. Clean up notification state (throttle timers, debounce timers)
      this.deps.notificationManager?.cleanupSession(id);

      // 2a. Clean up periodic timers associated with this session
      this.deps.getTimerCleanupCallback()?.(id);

      // 2a1. Clean up conditional wakeups associated with this session
      this.deps.getConditionalWakeupCleanupCallback()?.(id);

      // 2a2. Clean up interactive processes associated with this session
      this.deps.getProcessCleanupCallback()?.(id);

      // 2b. Clean up inter-worker message history
      this.deps.messageService.clearSession(id);

      // 2c. Clean up inter-session message files
      if (resolver) {
        try {
          await this.deps.interSessionMessageService.deleteSessionMessages(id, resolver);
        } catch (err) {
          logger.warn({ sessionId: id, err }, 'Failed to clean inter-session message files');
        }
      } else {
        logger.warn({ sessionId: id }, 'No resolver; skipping inter-session message cleanup');
      }

      // 2d. Clean up memo file
      if (resolver) {
        try {
          await this.deps.memoService.deleteMemo(id, resolver);
        } catch (err) {
          logger.warn({ sessionId: id, err }, 'Failed to clean memo file');
        }
      } else {
        logger.warn({ sessionId: id }, 'No resolver; skipping memo cleanup');
      }

      // A socket accepted before the deletion can finish opening during the awaited cleanup above, while the
      // session still exists, and start a diff or viewer watch. After the session leaves memory its socket's
      // cleanup cannot find the worker, so release the worker-wide watches once more right before removal
      // (idempotent; the first teardown above stays for sockets that were already open).
      for (const worker of session.workers.values()) {
        if (worker.type === 'git-diff' || worker.type === 'file-viewer') {
          this.deps.getWebSocketCallbacks()?.stopWorkerWatching(id, worker.id);
        }
      }

      // 3. Remove from in-memory map
      this.deps.deleteSessionFromMemory(id);

      // 4. Delete from persistence (this is the critical operation), together
      // with the cleanup-job enqueue so the output files are only scheduled for
      // deletion if the row delete commits. Skipped when the scope is missing --
      // never fall back to _quick/.
      if (!scopeInfo) {
        logger.warn({ sessionId: id }, 'Session has no valid scope; skipping session-outputs cleanup');
      }
      await this.deleteRowWithCleanupJob(id, scopeInfo);

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
      let resolver: SessionDataPathResolver | null;
      try {
        resolver = this.deps.getPathResolverForPersistedSession(persisted);
      } catch {
        resolver = null;
      }
      const scopeInfo = this.deps.getPersistedSessionScope(persisted);

      // Cleanup of worker output files (same job as deleteSession), committed
      // together with the row delete.
      if (!this.deps.jobQueue || !scopeInfo) {
        logger.warn(
          {
            sessionId: id,
            method: 'forceDeleteSession',
            skippedJob: JOB_TYPES.CLEANUP_SESSION_OUTPUTS,
            missingJobQueue: !this.deps.jobQueue,
            missingScope: !scopeInfo,
          },
          'Skipping session-outputs cleanup for orphaned session'
        );
      }
      await this.deleteRowWithCleanupJob(id, scopeInfo);
      // Clean up memo file
      if (resolver) {
        try {
          await this.deps.memoService.deleteMemo(id, resolver);
        } catch (err) {
          logger.warn({ sessionId: id, err }, 'Failed to clean memo file');
        }
      } else {
        logger.warn({ sessionId: id, method: 'forceDeleteSession' }, 'No resolver; skipping memo cleanup');
      }
      // Broadcast deletion to connected clients
      this.deps.getSessionLifecycleCallbacks()?.onSessionDeleted?.(id);
      logger.info({ sessionId: id }, 'Orphaned session deleted from persistence');
      return true;
    }

    return false;
  }
}
