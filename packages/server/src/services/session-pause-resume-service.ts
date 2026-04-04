/**
 * SessionPauseResumeService - Handles pausing and resuming sessions.
 *
 * Responsibilities:
 * - Pause: kill PTY workers, persist paused state, remove from memory
 * - Resume: load from DB, create in-memory session, restore PTY workers with rollback on failure
 * - Concurrency guard to prevent duplicate resume attempts
 */

import type {
  Session,
  PausedSession,
  RunningSession,
  AgentActivityState,
  WorkerActivityInfo,
} from '@agent-console/shared';
import type { PersistedSession } from './persistence-service.js';
import type { InternalSession } from './internal-types.js';
import type { InternalPtyWorker } from './worker-types.js';
import type { SessionRepository } from '../repositories/index.js';
import type { WorkerManager } from './worker-manager.js';
import type { NotificationManager } from './notifications/notification-manager.js';
import type { SessionLifecycleCallbacks } from './session-lifecycle-types.js';
import type { WebSocketCallbacks } from './session-manager.js';
import type { MessageService } from './message-service.js';
import type { UserRepository } from '../repositories/user-repository.js';
import type { SessionDataPathResolver } from '../lib/session-data-path-resolver.js';
import { stopWatching } from './git-diff-service.js';
import { getServerPid } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('session-pause-resume');

/**
 * Dependencies injected by SessionManager.
 * Uses closures to capture late-bound state so values are always current at call time.
 */
export interface SessionPauseResumeDeps {
  getSession: (id: string) => InternalSession | undefined;
  setSession: (id: string, session: InternalSession) => void;
  deleteSession: (id: string) => void;
  sessionRepository: SessionRepository;
  workerManager: WorkerManager;
  pathExists: (path: string) => Promise<boolean>;
  getRepositoryEnvVars: (sessionId: string) => Promise<Record<string, string>>;
  getPathResolverForSession: (session: InternalSession) => SessionDataPathResolver;
  toPublicSession: (session: InternalSession) => Session;
  toPersistedSessionWithServerPid: (session: InternalSession, serverPid: number | null) => PersistedSession;
  persistedToPublicSession: (p: PersistedSession) => Session;
  getWorkerActivityState: (sessionId: string, workerId: string) => AgentActivityState | undefined;
  getSessionLifecycleCallbacks: () => SessionLifecycleCallbacks | undefined;
  getWebSocketCallbacks: () => WebSocketCallbacks | null;
  notificationManager: NotificationManager | null;
  messageService: MessageService;
  userRepository: UserRepository | null;
  resolveSpawnUsername: (createdBy: string | undefined, userRepo: UserRepository | null) => Promise<string>;
}

export class SessionPauseResumeService {
  private resumingSessionIds = new Set<string>();

  constructor(private readonly deps: SessionPauseResumeDeps) {}

  /**
   * Pause a session: kill all PTY workers, remove from memory, preserve persistence.
   * Only available for worktree sessions. Quick sessions should use deleteSession instead.
   *
   * @param id - Session ID to pause
   * @returns true if session was paused, false if not found or is a quick session
   */
  async pauseSession(id: string): Promise<boolean> {
    const session = this.deps.getSession(id);
    if (!session) {
      logger.warn({ sessionId: id }, 'Cannot pause session: not found in memory');
      return false;
    }

    // Quick sessions cannot be paused - they should be deleted instead
    if (session.type === 'quick') {
      logger.warn({ sessionId: id }, 'Cannot pause quick session: use delete instead');
      return false;
    }

    // Notify all active Worker WebSocket connections that session is being paused
    // This must happen BEFORE killing workers so clients receive the notification
    this.deps.getWebSocketCallbacks()?.notifySessionPaused(id);

    // Kill all PTY workers (preserve output files) and clear PTY references.
    // killWorker awaits PTY exit and calls detachPty, ensuring PIDs are saved as null.
    const killPromises: Promise<void>[] = [];
    for (const worker of session.workers.values()) {
      if (worker.type === 'git-diff') {
        // Stop file watcher for git-diff workers
        stopWatching(session.locationPath);
      } else {
        // Kill PTY for agent/terminal workers (don't delete output files)
        killPromises.push(this.deps.workerManager.killWorker(worker, id));
      }
    }
    await Promise.all(killPromises);

    // Clean up notification state (throttle timers, debounce timers)
    this.deps.notificationManager?.cleanupSession(id);

    // Clean up inter-worker message history
    this.deps.messageService.clearSession(id);

    // Save session with serverPid = null, worker PIDs cleared, and pausedAt timestamp
    // Using save() instead of update() to persist the full session state including worker PID changes
    const persistedSession = this.deps.toPersistedSessionWithServerPid(session, null);
    const pausedAt = new Date().toISOString();
    persistedSession.pausedAt = pausedAt;
    await this.deps.sessionRepository.save(persistedSession);

    // Remove from in-memory sessions Map (after successful persistence)
    this.deps.deleteSession(id);

    logger.info({ sessionId: id }, 'Session paused');

    // Call lifecycle callback with full public Session (includes activationState: 'hibernated')
    // persistedToPublicSession always returns hibernated state for persisted sessions
    const pausedPublicSession = this.deps.persistedToPublicSession(persistedSession) as PausedSession;
    this.deps.getSessionLifecycleCallbacks()?.onSessionPaused?.(pausedPublicSession);

    return true;
  }

  /**
   * Resume a paused session: load from DB, create in-memory session, restore workers.
   *
   * @param id - Session ID to resume
   * @returns The resumed session, or null if not found in database or activation fails
   */
  async resumeSession(id: string): Promise<Session | null> {
    // Check if session is already active in memory
    const existingSession = this.deps.getSession(id);
    if (existingSession) {
      logger.debug({ sessionId: id }, 'Session already active, returning existing');
      return this.deps.toPublicSession(existingSession);
    }

    // Prevent concurrent resume attempts for the same session
    if (this.resumingSessionIds.has(id)) {
      logger.warn({ sessionId: id }, 'Resume already in progress');
      return null;
    }

    this.resumingSessionIds.add(id);

    try {
      return await this.resumeSessionInternal(id);
    } finally {
      this.resumingSessionIds.delete(id);
    }
  }

  /**
   * Internal implementation of resumeSession, called after concurrency guard.
   */
  private async resumeSessionInternal(id: string): Promise<Session | null> {
    // Load from database
    const persisted = await this.deps.sessionRepository.findById(id);
    if (!persisted) {
      logger.warn({ sessionId: id }, 'Cannot resume session: not found in database');
      return null;
    }

    // Validate that locationPath still exists
    const pathExistsResult = await this.deps.pathExists(persisted.locationPath);
    if (!pathExistsResult) {
      logger.warn({ sessionId: id, locationPath: persisted.locationPath },
        'Cannot resume session: path no longer exists');
      return null;
    }

    // Create in-memory InternalSession from persisted data
    const workers = this.deps.workerManager.restoreWorkersFromPersistence(persisted.workers);
    const baseSession = {
      id: persisted.id,
      locationPath: persisted.locationPath,
      status: 'active' as const,
      createdAt: persisted.createdAt,
      workers,
      initialPrompt: persisted.initialPrompt,
      title: persisted.title,
      parentSessionId: persisted.parentSessionId,
      parentWorkerId: persisted.parentWorkerId,
      createdBy: persisted.createdBy,
      templateVars: persisted.templateVars,
    };

    const internalSession: InternalSession = persisted.type === 'worktree'
      ? {
          ...baseSession,
          type: 'worktree',
          repositoryId: persisted.repositoryId,
          worktreeId: persisted.worktreeId,
        }
      : {
          ...baseSession,
          type: 'quick',
        };

    // Add to sessions Map
    this.deps.setSession(id, internalSession);

    // Track activated workers for cleanup on failure
    const activatedWorkers: InternalPtyWorker[] = [];

    // Restore all PTY workers with continueConversation: true
    const repositoryEnvVars = await this.deps.getRepositoryEnvVars(id);
    const repositoryId = internalSession.type === 'worktree' ? internalSession.repositoryId : undefined;
    const resolver = this.deps.getPathResolverForSession(internalSession);
    try {
      const username = await this.deps.resolveSpawnUsername(internalSession.createdBy, this.deps.userRepository);
      for (const worker of workers.values()) {
        if (worker.type === 'agent') {
          await this.deps.workerManager.activateAgentWorkerPty(worker, {
            sessionId: id,
            locationPath: persisted.locationPath,
            repositoryEnvVars,
            username,
            resolver,
            agentId: worker.agentId,
            continueConversation: true,
            repositoryId,
            context: {
              parentSessionId: internalSession.parentSessionId,
              parentWorkerId: internalSession.parentWorkerId,
              templateVars: internalSession.templateVars,
            },
          });
          activatedWorkers.push(worker);
        } else if (worker.type === 'terminal') {
          this.deps.workerManager.activateTerminalWorkerPty(worker, {
            sessionId: id,
            locationPath: persisted.locationPath,
            repositoryEnvVars,
            username,
            resolver,
          });
          activatedWorkers.push(worker);
        }
        // git-diff workers don't need PTY activation
      }
    } catch (err) {
      // PTY activation failed - clean up and return null
      logger.error({ sessionId: id, err }, 'Failed to activate PTY workers during session resume');

      // Kill all workers that were successfully activated
      await Promise.all(activatedWorkers.map((worker) => this.deps.workerManager.killWorker(worker, id)));

      // Remove session from memory
      this.deps.deleteSession(id);

      // Restore paused state in DB to allow future resume attempts
      try {
        await this.deps.sessionRepository.update(id, {
          serverPid: null,
          pausedAt: persisted.pausedAt ?? new Date().toISOString(),
        });
      } catch (updateErr) {
        logger.error({ sessionId: id, err: updateErr }, 'Failed to restore paused state after resume failure');
      }

      return null;
    }

    // Update DB: set serverPid = process.pid and clear pausedAt (marks session as active)
    try {
      await this.deps.sessionRepository.update(id, { serverPid: getServerPid(), pausedAt: null });
    } catch (err) {
      logger.error({ sessionId: id, err }, 'Failed to persist resumed state, rolling back in-memory resume');

      // Kill all workers that were successfully activated
      await Promise.all(activatedWorkers.map((worker) => this.deps.workerManager.killWorker(worker, id)));

      // Remove session from memory
      this.deps.deleteSession(id);

      // Restore paused state in DB to allow future resume attempts
      try {
        await this.deps.sessionRepository.update(id, {
          serverPid: null,
          pausedAt: persisted.pausedAt ?? new Date().toISOString(),
        });
      } catch (rollbackErr) {
        logger.error({ sessionId: id, err: rollbackErr }, 'Failed to persist rollback after resume persistence failure');
      }

      return null;
    }

    logger.info({ sessionId: id }, 'Session resumed');

    const publicSession = this.deps.toPublicSession(internalSession);

    // Collect activity states for resumed session's workers
    const activityStates: WorkerActivityInfo[] = [];
    for (const worker of publicSession.workers) {
      if (worker.type === 'agent') {
        const state = this.deps.getWorkerActivityState(id, worker.id);
        if (state) {
          activityStates.push({ sessionId: id, workerId: worker.id, activityState: state });
        }
      }
    }

    // Call lifecycle callback with activity states
    // After resume, session is always in running state
    this.deps.getSessionLifecycleCallbacks()?.onSessionResumed?.(publicSession as RunningSession, activityStates);

    return publicSession;
  }
}
