import * as path from 'path';
import { access } from 'fs/promises';
import type {
  Session,
  WorktreeSession,
  QuickSession,
  Worker,
  AgentActivityState,
  CreateSessionRequest,
  CreateWorkerParams,
  WorkerErrorCode,
  SessionActivationState,
  WorkerMessage,
} from '@agent-console/shared';
import type {
  PersistedSession,
  PersistedWorker,
} from './persistence-service.js';
import type {
  InternalWorker,
  InternalPtyWorker,
  InternalAgentWorker,
  InternalTerminalWorker,
  WorkerCallbacks,
} from './worker-types.js';
import { WorkerManager } from './worker-manager.js';
import { getAgentManager, CLAUDE_CODE_AGENT_ID } from './agent-manager.js';
import { filterRepositoryEnvVars } from './env-filter.js';
import { parseEnvVars } from '../lib/env-parser.js';

/**
 * Callbacks for resolving dependencies without circular imports.
 * Injected by index.ts after both SessionManager and RepositoryManager are initialized.
 */
export interface SessionRepositoryCallbacks {
  getRepository: (repositoryId: string) => { name: string; path: string; envVars?: string | null } | undefined;
  isInitialized: () => boolean;
}
import { getConfigDir, getServerPid } from '../lib/config.js';
import { bunPtyProvider, type PtyProvider } from '../lib/pty-provider.js';
import { processKill, isProcessAlive } from '../lib/process-utils.js';
import {
  getCurrentBranch as gitGetCurrentBranch,
  renameBranch as gitRenameBranch,
} from '../lib/git.js';
import { stopWatching } from './git-diff-service.js';
import { getNotificationManager } from './notifications/index.js';
import { notifySessionDeleted, broadcastToApp } from '../websocket/routes.js';
import { MessageService } from './message-service.js';
import { createLogger } from '../lib/logger.js';
import { workerOutputFileManager, type HistoryReadResult } from '../lib/worker-output-file.js';
import type { SessionRepository } from '../repositories/index.js';
import { JsonSessionRepository } from '../repositories/index.js';
import { JOB_TYPES, type JobQueue } from '../jobs/index.js';

const logger = createLogger('session-manager');

// Re-export worker types for consumers that need them
export type { InternalWorker, InternalPtyWorker } from './worker-types.js';

interface InternalSessionBase {
  id: string;
  locationPath: string;
  status: 'active' | 'inactive';
  createdAt: string;
  workers: Map<string, InternalWorker>;
  initialPrompt?: string;
  title?: string;
}

interface InternalWorktreeSession extends InternalSessionBase {
  type: 'worktree';
  repositoryId: string;
  worktreeId: string;
}

interface InternalQuickSession extends InternalSessionBase {
  type: 'quick';
}

type InternalSession = InternalWorktreeSession | InternalQuickSession;

export interface SessionLifecycleCallbacks {
  onSessionCreated?: (session: Session) => void;
  onSessionUpdated?: (session: Session) => void;
  onSessionDeleted?: (sessionId: string) => void;
  onWorkerActivated?: (sessionId: string, workerId: string) => void;
  onSessionPaused?: (sessionId: string) => void;
  onSessionResumed?: (session: Session) => void;
}

/**
 * Result type for restoreWorker operation.
 * Provides detailed error information for specific failure cases.
 * Note: worker type is narrowed to 'agent' | 'terminal' since git-diff workers
 * don't support PTY restoration.
 *
 * @property wasRestored - true if PTY was activated (was hibernated), false if already active.
 *   Used to notify clients about server restart so they can invalidate cached state.
 */
export type RestoreWorkerResult =
  | { success: true; worker: { type: 'agent' | 'terminal' }; wasRestored: boolean }
  | { success: false; errorCode: WorkerErrorCode; message: string };

/**
 * Default path existence checker using fs.access
 */
async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class SessionManager {
  private sessions: Map<string, InternalSession> = new Map();
  private sessionLifecycleCallbacks?: SessionLifecycleCallbacks;
  private repositoryCallbacks: SessionRepositoryCallbacks | null = null;
  private workerManager: WorkerManager;
  private messageService = new MessageService();
  private pathExists: (path: string) => Promise<boolean>;
  private sessionRepository: SessionRepository;
  private jobQueue: JobQueue | null = null;

  /**
   * Options for creating a SessionManager instance.
   */
  static readonly defaultOptions = {
    ptyProvider: bunPtyProvider,
    pathExists: defaultPathExists,
  };

  /**
   * Create a SessionManager instance with async initialization.
   * This is the preferred way to create a SessionManager.
   * @param options.jobQueue - JobQueue instance for background cleanup tasks.
   *                           Must be provided for proper cleanup operations.
   */
  static async create(options?: {
    ptyProvider?: PtyProvider;
    pathExists?: (path: string) => Promise<boolean>;
    sessionRepository?: SessionRepository;
    jobQueue?: JobQueue | null;
  }): Promise<SessionManager> {
    const manager = new SessionManager(options);
    await manager.initialize();
    return manager;
  }

  /**
   * Private constructor - use SessionManager.create() for async initialization.
   * The constructor is only public for backward compatibility during migration.
   */
  constructor(options?: {
    ptyProvider?: PtyProvider;
    pathExists?: (path: string) => Promise<boolean>;
    sessionRepository?: SessionRepository;
    jobQueue?: JobQueue | null;
  }) {
    const ptyProvider = options?.ptyProvider ?? bunPtyProvider;
    this.workerManager = new WorkerManager(ptyProvider);
    this.pathExists = options?.pathExists ?? defaultPathExists;
    this.sessionRepository = options?.sessionRepository ??
      new JsonSessionRepository(path.join(getConfigDir(), 'sessions.json'));
    this.jobQueue = options?.jobQueue ?? null;
  }

  /**
   * Set the job queue for background task processing.
   * @internal For testing only. In production, pass jobQueue to create() or getSessionManager().
   */
  setJobQueue(jobQueue: JobQueue): void {
    this.jobQueue = jobQueue;
  }

  /**
   * Clean up worker output file via job queue.
   * Used by deleteWorker and other cleanup operations.
   * @throws Error if jobQueue is not available
   */
  private async cleanupWorkerOutput(sessionId: string, workerId: string): Promise<void> {
    if (!this.jobQueue) {
      throw new Error('JobQueue not available for worker output cleanup. Ensure initializeSessionManager() was called with jobQueue.');
    }
    await this.jobQueue.enqueue(JOB_TYPES.CLEANUP_WORKER_OUTPUT, { sessionId, workerId });
  }

  /**
   * Get the session repository used by this manager.
   * Useful for creating services that need to access session persistence directly.
   */
  getSessionRepository(): SessionRepository {
    return this.sessionRepository;
  }

  /**
   * Initialize sessions from persistence and clean up orphan processes.
   * Called by SessionManager.create() factory method.
   */
  private async initialize(): Promise<void> {
    await this.initializeSessions();
    await this.cleanupOrphanProcesses();
  }

  /**
   * Load persisted sessions into memory (without starting processes).
   * Only inherits sessions whose serverPid is dead (or missing).
   * Sessions owned by other live servers are left untouched.
   * Also kills orphan worker processes from inherited sessions.
   * Sessions whose locationPath no longer exists are marked as orphans.
   */
  private async initializeSessions(): Promise<void> {
    const persistedSessions = await this.sessionRepository.findAll();
    const currentServerPid = getServerPid();
    const sessionsToSave: PersistedSession[] = [];
    const orphanSessionIds: string[] = [];
    let inheritedCount = 0;
    let killedWorkerCount = 0;
    let pathNotFoundCount = 0;

    for (const session of persistedSessions) {
      // Skip if already in memory (shouldn't happen, but safety check)
      if (this.sessions.has(session.id)) continue;

      // Paused sessions (serverPid === null) should remain paused until explicitly resumed
      // Keep them in persistence unchanged, don't inherit into memory
      if (session.serverPid === null) {
        sessionsToSave.push(session);
        continue;
      }

      // If serverPid is alive AND belongs to a different server, this session belongs to another active server
      // Keep it in persistence unchanged
      // Note: We must check serverPid !== currentServerPid to handle PID reuse by the OS.
      // If a previous server died and the OS reused its PID for this server, we should inherit the sessions.
      if (session.serverPid && session.serverPid !== currentServerPid && isProcessAlive(session.serverPid)) {
        sessionsToSave.push(session);
        continue;
      }

      // serverPid is dead or missing - validate path before inheriting
      // Validate that locationPath still exists before inheriting session
      const pathExistsResult = await this.pathExists(session.locationPath);
      if (!pathExistsResult) {
        logger.warn({ sessionId: session.id, locationPath: session.locationPath },
          'Session path no longer exists, marking as orphan');
        orphanSessionIds.push(session.id);
        pathNotFoundCount++;
        continue;
      }

      // Kill any orphan worker processes first
      for (const worker of session.workers) {
        // Skip git-diff workers (no process) and workers with no pid (not yet activated)
        if (worker.type === 'git-diff' || worker.pid === null) continue;

        if (isProcessAlive(worker.pid)) {
          try {
            processKill(worker.pid, 'SIGTERM');
            logger.info({ pid: worker.pid, workerId: worker.id, sessionId: session.id }, 'Killed orphan worker process');
            killedWorkerCount++;
          } catch (error) {
            logger.error({ pid: worker.pid, workerId: worker.id, sessionId: session.id, err: error }, 'Failed to kill orphan worker with SIGTERM');
            // Try SIGKILL as fallback for stubborn processes
            try {
              processKill(worker.pid, 'SIGKILL');
              logger.info({ pid: worker.pid, workerId: worker.id, sessionId: session.id }, 'Killed orphan worker with SIGKILL');
              killedWorkerCount++;
            } catch {
              // Process may have exited between checks, log but continue
              logger.warn({ pid: worker.pid, workerId: worker.id, sessionId: session.id }, 'Failed to kill orphan worker (process may have already exited)');
            }
          }
        }
      }

      // Create internal session with workers restored from persistence (pty: null)
      const workers = this.workerManager.restoreWorkersFromPersistence(session.workers);
      const baseSession = {
        id: session.id,
        locationPath: session.locationPath,
        status: 'active' as const, // Mark as active so it appears in the list
        createdAt: session.createdAt,
        workers,
        initialPrompt: session.initialPrompt,
        title: session.title,
      };

      const internalSession: InternalSession = session.type === 'worktree'
        ? {
            ...baseSession,
            type: 'worktree',
            repositoryId: session.repositoryId,
            worktreeId: session.worktreeId,
          }
        : {
            ...baseSession,
            type: 'quick',
          };

      this.sessions.set(session.id, internalSession);
      inheritedCount++;

      // Update serverPid to claim ownership
      sessionsToSave.push({
        ...session,
        serverPid: currentServerPid,
      });
    }

    // Delete orphan sessions (path no longer exists)
    for (const sessionId of orphanSessionIds) {
      // Clean up worker output files
      try {
        await workerOutputFileManager.deleteSessionOutputs(sessionId);
      } catch (error) {
        logger.error({ sessionId, err: error }, 'Failed to delete worker output files for orphan session');
      }
      // Delete from database
      try {
        await this.sessionRepository.delete(sessionId);
        logger.info({ sessionId }, 'Removed orphan session with non-existent path');
      } catch (error) {
        logger.error({ sessionId, err: error }, 'Failed to delete orphan session from database');
      }
    }

    // Save all sessions (inherited with updated PID, others unchanged)
    if (sessionsToSave.length > 0 || persistedSessions.length > 0) {
      await this.sessionRepository.saveAll(sessionsToSave);
    }

    logger.info({
      inheritedSessions: inheritedCount,
      killedWorkerProcesses: killedWorkerCount,
      removedOrphanSessions: pathNotFoundCount,
      serverPid: currentServerPid,
    }, 'Initialized sessions from persistence');
  }

  /**
   * Set a global callback for all activity state changes (for dashboard broadcast)
   */
  setGlobalActivityCallback(callback: (sessionId: string, workerId: string, state: AgentActivityState) => void): void {
    this.workerManager.setGlobalActivityCallback(callback);
  }

  /**
   * Set up the PTY exit callback to update session activation state when workers exit.
   * This broadcasts session-updated events to keep clients in sync.
   */
  setupPtyExitCallback(): void {
    this.workerManager.setGlobalPtyExitCallback((sessionId, _workerId) => {
      const session = this.sessions.get(sessionId);
      if (session) {
        // Broadcast session update with new activation state
        this.sessionLifecycleCallbacks?.onSessionUpdated?.(this.toPublicSession(session));
      }
    });
  }

  /**
   * Send a message from the user to a worker via API.
   * If fromWorkerId is null, the message is sent as "User".
   */
  sendMessage(sessionId: string, fromWorkerId: string | null, toWorkerId: string, content: string, filePaths?: string[]): WorkerMessage | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const targetWorker = session.workers.get(toWorkerId);
    if (!targetWorker || targetWorker.type === 'git-diff') return null;

    let fromWorkerName = 'User';
    let effectiveFromWorkerId = 'user';
    if (fromWorkerId) {
      const fromWorker = session.workers.get(fromWorkerId);
      if (!fromWorker || fromWorker.type === 'git-diff') return null;
      fromWorkerName = fromWorker.name;
      effectiveFromWorkerId = fromWorkerId;
    }

    const message: WorkerMessage = {
      id: crypto.randomUUID(),
      sessionId,
      fromWorkerId: effectiveFromWorkerId,
      fromWorkerName,
      toWorkerId,
      toWorkerName: targetWorker.name,
      content,
      timestamp: new Date().toISOString(),
    };

    // Inject message into target worker's PTY
    // Send each part with delays so TUI agents can process input sequentially
    const parts: string[] = [];
    if (content) parts.push(content);
    if (filePaths && filePaths.length > 0) {
      parts.push(...filePaths);
    }

    if (parts.length === 0) {
      logger.warn({ sessionId, toWorkerId }, 'No content or files to send');
      return null;
    }

    const injected = this.writeWorkerInput(sessionId, toWorkerId, parts[0]);
    if (!injected) {
      logger.warn({ sessionId, toWorkerId }, 'Failed to inject worker message (PTY inactive)');
      return null;
    }

    // Send remaining parts and final Enter with delays
    // Use longer delays to ensure TUI processes each input before the next
    const DELAY_MS = 150;
    const sendQueue: Array<() => void> = [];

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      sendQueue.push(() => this.writeWorkerInput(sessionId, toWorkerId, `\r${part}`));
    }
    // Final Enter to submit
    sendQueue.push(() => this.writeWorkerInput(sessionId, toWorkerId, '\r'));

    // Execute queue with delays
    sendQueue.forEach((fn, i) => {
      setTimeout(fn, DELAY_MS * (i + 1));
    });

    // Store and broadcast
    this.messageService.addMessage(message);
    broadcastToApp({ type: 'worker-message', message });

    return message;
  }

  /**
   * Set a global callback for all worker exit events (for notifications)
   */
  setGlobalWorkerExitCallback(callback: (sessionId: string, workerId: string, exitCode: number) => void): void {
    this.workerManager.setGlobalWorkerExitCallback(callback);
  }

  /**
   * Set callbacks for session lifecycle events (for dashboard broadcast)
   */
  setSessionLifecycleCallbacks(callbacks: SessionLifecycleCallbacks): void {
    this.sessionLifecycleCallbacks = callbacks;
  }

  /**
   * Set callbacks for resolving repository dependencies without circular imports.
   * Must be called after both SessionManager and RepositoryManager are initialized.
   */
  setRepositoryCallbacks(callbacks: SessionRepositoryCallbacks): void {
    this.repositoryCallbacks = callbacks;
  }

  /**
   * Kill orphan processes from previous server run and remove orphan sessions.
   * Sessions that have been loaded into this.sessions (by initializeSessions) are preserved.
   * Only sessions from OTHER dead servers are considered orphans.
   */
  private async cleanupOrphanProcesses(): Promise<void> {
    const persistedSessions = await this.sessionRepository.findAll();
    const currentServerPid = getServerPid();
    let killedCount = 0;
    let preservedCount = 0;
    const orphanSessionIds: string[] = [];

    for (const session of persistedSessions) {
      // Skip sessions that this server has inherited (already in memory)
      if (this.sessions.has(session.id)) {
        preservedCount++;
        continue;
      }

      if (!session.serverPid) {
        logger.warn({ sessionId: session.id }, 'Session has no serverPid (legacy session), skipping cleanup');
        preservedCount++;
        continue;
      }

      if (isProcessAlive(session.serverPid)) {
        preservedCount++;
        continue;
      }

      // This session's server is dead AND not inherited by this server - mark for removal
      orphanSessionIds.push(session.id);

      // Kill all workers in this session (only PTY workers have pid)
      for (const worker of session.workers) {
        // Skip git-diff workers (no process) and workers with no pid (not yet activated)
        if (worker.type === 'git-diff' || worker.pid === null) continue;

        if (isProcessAlive(worker.pid)) {
          try {
            processKill(worker.pid, 'SIGTERM');
            logger.info({ pid: worker.pid, workerId: worker.id, sessionId: session.id }, 'Killed orphan worker process');
            killedCount++;
          } catch (error) {
            logger.error({ pid: worker.pid, workerId: worker.id, sessionId: session.id, err: error }, 'Failed to kill orphan worker with SIGTERM');
            // Try SIGKILL as fallback
            try {
              processKill(worker.pid, 'SIGKILL');
              logger.info({ pid: worker.pid, workerId: worker.id, sessionId: session.id }, 'Killed orphan worker with SIGKILL');
              killedCount++;
            } catch {
              logger.warn({ pid: worker.pid, workerId: worker.id, sessionId: session.id }, 'Failed to kill orphan worker (process may have already exited)');
            }
          }
        }
      }
    }

    // Remove orphan sessions from persistence and delete output files
    if (orphanSessionIds.length > 0) {
      // Verify jobQueue is available for cleanup operations
      if (!this.jobQueue) {
        throw new Error('JobQueue not available for orphan session cleanup. Ensure jobQueue is passed to SessionManager.create().');
      }
      for (const sessionId of orphanSessionIds) {
        await this.sessionRepository.delete(sessionId);
        // Delete output files for orphan session via job queue
        await this.jobQueue.enqueue(JOB_TYPES.CLEANUP_SESSION_OUTPUTS, { sessionId });
        logger.info({ sessionId }, 'Removed orphan session from persistence');
      }
    }

    logger.info({
      killedProcesses: killedCount,
      removedSessions: orphanSessionIds.length,
      preservedSessions: preservedCount,
      serverPid: currentServerPid,
    }, 'Orphan cleanup completed');
  }

  // ========== Session Lifecycle ==========

  async createSession(request: CreateSessionRequest): Promise<Session> {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    const baseSession = {
      id,
      locationPath: request.locationPath,
      status: 'active' as const,
      createdAt,
      workers: new Map<string, InternalWorker>(),
      initialPrompt: request.initialPrompt,
      title: request.title,
    };

    const internalSession: InternalSession = request.type === 'worktree'
      ? {
          ...baseSession,
          type: 'worktree',
          repositoryId: request.repositoryId,
          worktreeId: request.worktreeId,
        }
      : {
          ...baseSession,
          type: 'quick',
        };

    this.sessions.set(id, internalSession);

    // Create initial workers in parallel
    // Note: Each createWorker calls persistSession internally
    const effectiveAgentId = request.agentId ?? CLAUDE_CODE_AGENT_ID;
    await Promise.all([
      this.createWorker(id, {
        type: 'agent',
        agentId: effectiveAgentId,
        // name is not specified; generateWorkerName will use the agent's name
      }, request.continueConversation ?? false, request.initialPrompt),
      this.createWorker(id, {
        type: 'git-diff',
        name: 'Diff',
      }),
    ]);

    logger.info({ sessionId: id, type: internalSession.type }, 'Session created');

    const publicSession = this.toPublicSession(internalSession);
    this.sessionLifecycleCallbacks?.onSessionCreated?.(publicSession);

    return publicSession;
  }

  getSession(id: string): Session | undefined {
    const session = this.sessions.get(id);
    return session ? this.toPublicSession(session) : undefined;
  }

  async getSessionMetadata(id: string): Promise<PersistedSession | null> {
    return this.sessionRepository.findById(id);
  }

  async deleteSession(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;

    // Notify all active Worker WebSocket connections that session is being deleted
    // This must happen BEFORE killing workers so clients receive the notification
    notifySessionDeleted(id);

    // Kill all workers first (before removing from memory)
    for (const worker of session.workers.values()) {
      if (worker.type === 'git-diff') {
        // Stop file watcher for git-diff workers
        stopWatching(session.locationPath);
      } else {
        // Kill PTY for agent/terminal workers
        this.workerManager.killWorker(worker);
      }
    }

    // Verify jobQueue is available before proceeding
    if (!this.jobQueue) {
      throw new Error('JobQueue not available for session cleanup. Ensure initializeSessionManager() was called with jobQueue.');
    }

    // Perform all deletion operations atomically
    // If any fail, restore in-memory state to maintain consistency
    try {
      // 1. Enqueue cleanup job (async but fire-and-forget, failure is non-critical)
      await this.jobQueue.enqueue(JOB_TYPES.CLEANUP_SESSION_OUTPUTS, { sessionId: id });

      // 2. Clean up notification state (throttle timers, debounce timers)
      try {
        const notificationManager = getNotificationManager();
        notificationManager.cleanupSession(id);
      } catch {
        // NotificationManager not initialized yet, skip
      }

      // 2b. Clean up inter-worker message history
      this.messageService.clearSession(id);

      // 3. Remove from in-memory map
      this.sessions.delete(id);

      // 4. Delete from persistence (this is the critical operation)
      await this.sessionRepository.delete(id);

      logger.info({ sessionId: id }, 'Session deleted');

      // 5. Only broadcast after all operations succeed
      this.sessionLifecycleCallbacks?.onSessionDeleted?.(id);

      return true;
    } catch (err) {
      // Restore in-memory session if it was removed
      // This ensures UI and server state remain consistent
      this.sessions.set(id, session);
      logger.error({ sessionId: id, err }, 'Failed to delete session, restored in-memory state');
      throw err;
    }
  }

  getAllSessions(): Session[] {
    return Array.from(this.sessions.values()).map((s) => this.toPublicSession(s));
  }

  /**
   * Get all paused sessions from persistence.
   * Paused sessions are not in memory but exist in the database with serverPid = null.
   * Used to include paused sessions in sessions-sync WebSocket messages.
   *
   * @returns Array of paused sessions converted to public Session format
   */
  async getAllPausedSessions(): Promise<Session[]> {
    // Get paused sessions from database (those with serverPid = null)
    const pausedPersisted = await this.sessionRepository.findPaused();

    // Filter out any that are actually active in memory (shouldn't happen, but be safe)
    const trulyPaused = pausedPersisted.filter((p) => !this.sessions.has(p.id));

    return trulyPaused.map((p) => this.persistedToPublicSession(p));
  }

  /**
   * Convert a persisted session to public Session format.
   * Used for paused sessions that aren't in memory.
   */
  private persistedToPublicSession(p: PersistedSession): Session {
    const workers: Worker[] = p.workers.map((w) => {
      if (w.type === 'agent') {
        return {
          id: w.id,
          type: 'agent' as const,
          name: w.name,
          agentId: w.agentId,
          createdAt: w.createdAt,
          activated: false, // Paused sessions have no active PTY
        };
      } else if (w.type === 'terminal') {
        return {
          id: w.id,
          type: 'terminal' as const,
          name: w.name,
          createdAt: w.createdAt,
          activated: false, // Paused sessions have no active PTY
        };
      } else {
        return {
          id: w.id,
          type: 'git-diff' as const,
          name: w.name,
          createdAt: w.createdAt,
          baseCommit: w.baseCommit,
        };
      }
    });

    const base = {
      id: p.id,
      locationPath: p.locationPath,
      status: 'active' as const, // Session exists, it's just paused
      activationState: 'hibernated' as const, // Paused sessions are always hibernated
      createdAt: p.createdAt,
      workers,
      initialPrompt: p.initialPrompt,
      title: p.title,
    };

    if (p.type === 'worktree') {
      // Get repository name via callback to avoid circular dependency
      const repository = this.repositoryCallbacks?.isInitialized()
        ? this.repositoryCallbacks.getRepository(p.repositoryId)
        : undefined;

      return {
        ...base,
        type: 'worktree',
        repositoryId: p.repositoryId,
        repositoryName: repository?.name ?? 'Unknown',
        worktreeId: p.worktreeId,
        isMainWorktree: repository?.path === p.locationPath,
      } as WorktreeSession;
    }

    return { ...base, type: 'quick' } as QuickSession;
  }

  /**
   * Pause a session: kill all PTY workers, remove from memory, preserve persistence.
   * Only available for worktree sessions. Quick sessions should use deleteSession instead.
   *
   * @param id - Session ID to pause
   * @returns true if session was paused, false if not found or is a quick session
   */
  async pauseSession(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) {
      logger.warn({ sessionId: id }, 'Cannot pause session: not found in memory');
      return false;
    }

    // Quick sessions cannot be paused - they should be deleted instead
    if (session.type === 'quick') {
      logger.warn({ sessionId: id }, 'Cannot pause quick session: use delete instead');
      return false;
    }

    // Kill all PTY workers (preserve output files) and clear PTY references
    // Clearing PTY references ensures worker PIDs are saved as null in persistence
    for (const worker of session.workers.values()) {
      if (worker.type === 'git-diff') {
        // Stop file watcher for git-diff workers
        stopWatching(session.locationPath);
      } else {
        // Kill PTY for agent/terminal workers (don't delete output files)
        this.workerManager.killWorker(worker);
        // Clear PTY reference so toPersistedWorker will return pid: null
        worker.pty = null;
      }
    }

    // Clean up notification state (throttle timers, debounce timers)
    try {
      const notificationManager = getNotificationManager();
      notificationManager.cleanupSession(id);
    } catch {
      // NotificationManager not initialized yet, skip
    }

    // Clean up inter-worker message history
    this.messageService.clearSession(id);

    // Save session with serverPid = null and worker PIDs cleared
    // Using save() instead of update() to persist the full session state including worker PID changes
    const persistedSession = this.toPersistedSessionWithServerPid(session, null);
    await this.sessionRepository.save(persistedSession);

    // Remove from in-memory sessions Map (after successful persistence)
    this.sessions.delete(id);

    logger.info({ sessionId: id }, 'Session paused');

    // Call lifecycle callback
    this.sessionLifecycleCallbacks?.onSessionPaused?.(id);

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
    const existingSession = this.sessions.get(id);
    if (existingSession) {
      logger.debug({ sessionId: id }, 'Session already active, returning existing');
      return this.toPublicSession(existingSession);
    }

    // Load from database
    const persisted = await this.sessionRepository.findById(id);
    if (!persisted) {
      logger.warn({ sessionId: id }, 'Cannot resume session: not found in database');
      return null;
    }

    // Validate that locationPath still exists
    const pathExistsResult = await this.pathExists(persisted.locationPath);
    if (!pathExistsResult) {
      logger.warn({ sessionId: id, locationPath: persisted.locationPath },
        'Cannot resume session: path no longer exists');
      return null;
    }

    // Create in-memory InternalSession from persisted data
    const workers = this.workerManager.restoreWorkersFromPersistence(persisted.workers);
    const baseSession = {
      id: persisted.id,
      locationPath: persisted.locationPath,
      status: 'active' as const,
      createdAt: persisted.createdAt,
      workers,
      initialPrompt: persisted.initialPrompt,
      title: persisted.title,
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
    this.sessions.set(id, internalSession);

    // Track activated workers for cleanup on failure
    const activatedWorkers: InternalPtyWorker[] = [];

    // Restore all PTY workers with continueConversation: true
    const repositoryEnvVars = this.getRepositoryEnvVars(id);
    const repositoryId = internalSession.type === 'worktree' ? internalSession.repositoryId : undefined;
    try {
      for (const worker of workers.values()) {
        if (worker.type === 'agent') {
          await this.workerManager.activateAgentWorkerPty(worker, {
            sessionId: id,
            locationPath: persisted.locationPath,
            repositoryEnvVars,
            agentId: worker.agentId,
            continueConversation: true,
            repositoryId,
          });
          activatedWorkers.push(worker);
        } else if (worker.type === 'terminal') {
          this.workerManager.activateTerminalWorkerPty(worker, {
            sessionId: id,
            locationPath: persisted.locationPath,
            repositoryEnvVars,
          });
          activatedWorkers.push(worker);
        }
        // git-diff workers don't need PTY activation
      }
    } catch (err) {
      // PTY activation failed - clean up and return null
      logger.error({ sessionId: id, err }, 'Failed to activate PTY workers during session resume');

      // Kill all workers that were successfully activated
      for (const worker of activatedWorkers) {
        this.workerManager.killWorker(worker);
      }

      // Remove session from memory
      this.sessions.delete(id);

      return null;
    }

    // Update DB: set serverPid = process.pid (marks session as owned by this server)
    await this.sessionRepository.update(id, { serverPid: getServerPid() });

    logger.info({ sessionId: id }, 'Session resumed');

    const publicSession = this.toPublicSession(internalSession);

    // Call lifecycle callback
    this.sessionLifecycleCallbacks?.onSessionResumed?.(publicSession);

    return publicSession;
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
    const persisted = await this.sessionRepository.findById(id);
    if (persisted) {
      await this.sessionRepository.delete(id);
      // Broadcast deletion to connected clients
      this.sessionLifecycleCallbacks?.onSessionDeleted?.(id);
      logger.info({ sessionId: id }, 'Orphaned session deleted from persistence');
      return true;
    }

    return false;
  }

  /**
   * Get all persisted sessions from the repository.
   * Useful for checking inactive sessions.
   */
  async getAllPersistedSessions(): Promise<PersistedSession[]> {
    return this.sessionRepository.findAll();
  }

  /**
   * Get all sessions that have agent workers using the specified agent ID.
   * Used to check if an agent can be safely deleted.
   */
  getSessionsUsingAgent(agentId: string): Session[] {
    const matchingSessions: Session[] = [];

    for (const session of this.sessions.values()) {
      const hasAgentWorker = Array.from(session.workers.values()).some(
        (worker) => worker.type === 'agent' && worker.agentId === agentId
      );
      if (hasAgentWorker) {
        matchingSessions.push(this.toPublicSession(session));
      }
    }

    return matchingSessions;
  }

  /**
   * Get all active sessions that belong to the specified repository.
   * Used to check if a repository can be safely deleted.
   */
  getSessionsUsingRepository(repositoryId: string): Session[] {
    const matchingSessions: Session[] = [];

    for (const session of this.sessions.values()) {
      if (session.type === 'worktree' && session.repositoryId === repositoryId) {
        matchingSessions.push(this.toPublicSession(session));
      }
    }

    return matchingSessions;
  }

  // ========== Worker Operations (delegated to WorkerManager) ==========

  async createWorker(
    sessionId: string,
    request: CreateWorkerParams,
    continueConversation: boolean = false,
    initialPrompt?: string
  ): Promise<Worker | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const workerId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const agentIdForName = request.type === 'agent' ? request.agentId : undefined;
    const workerName = request.name ?? await this.generateWorkerName(session, request.type, agentIdForName);

    let worker: InternalWorker;
    const repositoryEnvVars = this.getRepositoryEnvVars(sessionId);
    const repositoryId = session.type === 'worktree' ? session.repositoryId : undefined;

    if (request.type === 'agent') {
      const agentWorker = await this.workerManager.initializeAgentWorker({
        id: workerId,
        name: workerName,
        createdAt,
        agentId: request.agentId,
      });
      await this.workerManager.activateAgentWorkerPty(agentWorker, {
        sessionId,
        locationPath: session.locationPath,
        repositoryEnvVars,
        agentId: agentWorker.agentId,
        continueConversation,
        initialPrompt,
        repositoryId,
      });
      worker = agentWorker;
    } else if (request.type === 'terminal') {
      const terminalWorker = this.workerManager.initializeTerminalWorker({
        id: workerId,
        name: workerName,
        createdAt,
      });
      this.workerManager.activateTerminalWorkerPty(terminalWorker, {
        sessionId,
        locationPath: session.locationPath,
        repositoryEnvVars,
      });
      worker = terminalWorker;
    } else {
      // git-diff worker (async initialization for base commit calculation)
      worker = await this.workerManager.initializeGitDiffWorker({
        id: workerId,
        name: workerName,
        createdAt,
        locationPath: session.locationPath,
        baseCommit: request.baseCommit,
      });
    }

    session.workers.set(workerId, worker);

    // Initialize output file immediately for PTY workers (agent/terminal)
    // This prevents race conditions where WebSocket connects before any output is buffered
    if (request.type === 'agent' || request.type === 'terminal') {
      await workerOutputFileManager.initializeWorkerOutput(sessionId, workerId);
    }

    await this.persistSession(session);

    logger.info({ workerId, workerType: request.type, sessionId }, 'Worker created');

    return this.workerManager.toPublicWorker(worker);
  }

  getWorker(sessionId: string, workerId: string): InternalWorker | undefined {
    const session = this.sessions.get(sessionId);
    return session?.workers.get(workerId);
  }

  /**
   * Get a worker that is ready for PTY operations.
   * If the worker exists but PTY is not activated (after server restart),
   * this method will activate the PTY before returning the worker.
   * Returns null if worker doesn't exist or activation fails.
   */
  async getAvailableWorker(sessionId: string, workerId: string): Promise<InternalPtyWorker | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const worker = session.workers.get(workerId);
    if (!worker) return null;

    // git-diff workers don't have PTY
    if (worker.type === 'git-diff') return null;

    // If PTY is already active, return the worker
    if (worker.pty) {
      return worker;
    }

    // PTY is not active - need to activate it
    // SECURITY: Verify session's locationPath still exists before activating
    const pathExistsResult = await this.pathExists(session.locationPath);
    if (!pathExistsResult) {
      logger.warn({ sessionId, workerId, locationPath: session.locationPath }, 'Cannot activate worker: session path no longer exists');
      return null;
    }

    const repositoryEnvVars = this.getRepositoryEnvVars(sessionId);
    const repositoryId = session.type === 'worktree' ? session.repositoryId : undefined;

    // Activate PTY based on worker type
    if (worker.type === 'agent') {
      // SECURITY: Verify agentId is still valid
      const agentManager = await getAgentManager();
      const agent = agentManager.getAgent(worker.agentId);
      if (!agent) {
        logger.warn({ sessionId, workerId, agentId: worker.agentId }, 'Agent no longer valid, falling back to default');
      }

      await this.workerManager.activateAgentWorkerPty(worker, {
        sessionId,
        locationPath: session.locationPath,
        repositoryEnvVars,
        agentId: agent ? worker.agentId : CLAUDE_CODE_AGENT_ID,
        continueConversation: true,
        repositoryId,
      });
    } else {
      // terminal worker
      this.workerManager.activateTerminalWorkerPty(worker, {
        sessionId,
        locationPath: session.locationPath,
        repositoryEnvVars,
      });
    }

    await this.persistSession(session);
    logger.info({ workerId, sessionId, workerType: worker.type }, 'Worker PTY activated');

    return worker;
  }

  async deleteWorker(sessionId: string, workerId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const worker = session.workers.get(workerId);
    if (!worker) return false;

    // Clean up based on worker type
    if (worker.type === 'agent' || worker.type === 'terminal') {
      this.workerManager.killWorker(worker);
      await this.cleanupWorkerOutput(sessionId, workerId);
    } else {
      // git-diff worker: stop file watcher (synchronous operation)
      stopWatching(session.locationPath);
    }

    // Clean up notification state (debounce timers, previous state)
    try {
      const notificationManager = getNotificationManager();
      notificationManager.cleanupWorker(sessionId, workerId);
    } catch {
      // NotificationManager not initialized yet, skip
    }

    session.workers.delete(workerId);
    await this.persistSession(session);

    logger.info({ workerId, sessionId }, 'Worker deleted');
    return true;
  }

  private async generateWorkerName(session: InternalSession, type: 'agent' | 'terminal' | 'git-diff', agentId?: string): Promise<string> {
    if (type === 'agent') {
      // Get agent name from agentManager
      const agentManager = await getAgentManager();
      const agent = agentId ? agentManager.getAgent(agentId) : undefined;
      // Fall back to generic "AI" if agent not found
      return agent?.name ?? 'AI';
    }

    if (type === 'git-diff') {
      return 'Git Diff';
    }

    // Count existing terminal workers
    let count = 0;
    for (const worker of session.workers.values()) {
      if (worker.type === 'terminal') {
        count++;
      }
    }
    return `Terminal ${count + 1}`;
  }

  /**
   * Attach callbacks for a WebSocket connection to a worker.
   * Supports multiple concurrent connections (e.g., multiple browser tabs).
   * @returns Connection ID for later detachment, or null if worker not found
   */
  attachWorkerCallbacks(sessionId: string, workerId: string, callbacks: WorkerCallbacks): string | null {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return null;

    return this.workerManager.attachCallbacks(worker, callbacks);
  }

  /**
   * Detach callbacks for a specific WebSocket connection.
   * @param connectionId The connection ID returned by attachWorkerCallbacks
   */
  detachWorkerCallbacks(sessionId: string, workerId: string, connectionId: string): boolean {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return false;

    return this.workerManager.detachCallbacks(worker, connectionId);
  }

  writeWorkerInput(sessionId: string, workerId: string, data: string): boolean {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return false;

    return this.workerManager.writeInput(worker, data);
  }

  resizeWorker(sessionId: string, workerId: string, cols: number, rows: number): boolean {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return false;

    return this.workerManager.resize(worker, cols, rows);
  }

  getWorkerOutputBuffer(sessionId: string, workerId: string): string {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return '';
    return this.workerManager.getOutputBuffer(worker);
  }

  getWorkerActivityState(sessionId: string, workerId: string): AgentActivityState | undefined {
    const worker = this.getWorker(sessionId, workerId);
    if (worker?.type === 'agent') {
      return this.workerManager.getActivityState(worker);
    }
    return undefined;
  }

  /**
   * Get worker output history from file with optional offset for incremental sync.
   * @param sessionId Session ID
   * @param workerId Worker ID
   * @param fromOffset If specified, return only data after this offset
   * @param maxLines If specified and fromOffset is 0 or undefined, limit to last N lines
   * @returns History data and current offset, or null if not available
   */
  async getWorkerOutputHistory(
    sessionId: string,
    workerId: string,
    fromOffset?: number,
    maxLines?: number
  ): Promise<HistoryReadResult | null> {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return null;

    // Use line-limited read for initial connection (fromOffset is 0 or undefined)
    if (maxLines !== undefined && (fromOffset === undefined || fromOffset === 0)) {
      return workerOutputFileManager.readLastNLines(sessionId, workerId, maxLines);
    }

    return workerOutputFileManager.readHistoryWithOffset(sessionId, workerId, fromOffset);
  }

  /**
   * Get current output offset for a worker.
   * Used to mark the boundary before registering callbacks.
   * @returns Current file offset (0 if file doesn't exist)
   */
  async getCurrentOutputOffset(sessionId: string, workerId: string): Promise<number> {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return 0;

    return workerOutputFileManager.getCurrentOffset(sessionId, workerId);
  }

  async restartAgentWorker(
    sessionId: string,
    workerId: string,
    continueConversation: boolean
  ): Promise<Worker | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const existingWorker = session.workers.get(workerId);
    if (!existingWorker || existingWorker.type !== 'agent') return null;

    // Capture worker metadata before killing (needed for new worker creation)
    const workerName = existingWorker.name;
    const workerCreatedAt = existingWorker.createdAt;
    const workerAgentId = existingWorker.agentId;
    const locationPath = session.locationPath;

    // Kill existing worker
    this.workerManager.killWorker(existingWorker);

    // Reset the output file to prevent offset mismatch with client cache.
    await workerOutputFileManager.resetWorkerOutput(sessionId, workerId);

    // Create new worker with same ID, preserving original createdAt for tab order
    const repositoryEnvVars = this.getRepositoryEnvVars(sessionId);
    const repositoryId = session.type === 'worktree' ? session.repositoryId : undefined;
    const newWorker = await this.workerManager.initializeAgentWorker({
      id: workerId,
      name: workerName,
      createdAt: workerCreatedAt,
      agentId: workerAgentId,
    });
    await this.workerManager.activateAgentWorkerPty(newWorker, {
      sessionId,
      locationPath,
      repositoryEnvVars,
      agentId: workerAgentId,
      continueConversation,
      repositoryId,
    });

    // Re-check session still exists after async gap
    // Session may have been deleted during async operations above
    const currentSession = this.sessions.get(sessionId);
    if (!currentSession) {
      logger.warn({ sessionId, workerId }, 'Session deleted during worker restart, killing new worker');
      this.workerManager.killWorker(newWorker);
      return null;
    }

    currentSession.workers.set(workerId, newWorker);
    await this.persistSession(currentSession);

    logger.info({ workerId, sessionId, continueConversation }, 'Agent worker restarted');

    return this.workerManager.toPublicWorker(newWorker);
  }

  /**
   * Restore a PTY worker and ensure its PTY is active.
   * Called when WebSocket connection is established to ensure the worker is ready for I/O.
   *
   * - If worker exists with active PTY, return it as-is
   * - If worker exists without PTY (loaded from persistence), activate its PTY
   * - Returns error for git-diff workers (they don't need PTY restoration)
   * - Returns error with specific code if worker cannot be restored
   */
  async restoreWorker(sessionId: string, workerId: string): Promise<RestoreWorkerResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        success: false,
        errorCode: 'WORKER_NOT_FOUND',
        message: 'Session not found',
      };
    }

    const existingWorker = session.workers.get(workerId);
    if (!existingWorker) {
      return {
        success: false,
        errorCode: 'WORKER_NOT_FOUND',
        message: 'Worker not found in session',
      };
    }

    // Git-diff workers don't need PTY restoration
    if (existingWorker.type === 'git-diff') {
      return {
        success: false,
        errorCode: 'WORKER_NOT_FOUND',
        message: 'Git-diff workers do not support PTY restoration',
      };
    }

    // If PTY is already active, return as-is (normal browser reload case)
    if (existingWorker.pty) {
      return { success: true, worker: existingWorker, wasRestored: false };
    }

    // SECURITY: Verify session's locationPath still exists before activating PTY
    const pathExistsResult = await this.pathExists(session.locationPath);
    if (!pathExistsResult) {
      logger.warn({ sessionId, workerId, locationPath: session.locationPath }, 'Cannot restore worker: session path no longer exists');
      return {
        success: false,
        errorCode: 'PATH_NOT_FOUND',
        message: 'Session directory was deleted or is inaccessible',
      };
    }

    // Activate PTY for the worker
    try {
      const repositoryEnvVars = this.getRepositoryEnvVars(sessionId);
      const repositoryId = session.type === 'worktree' ? session.repositoryId : undefined;

      if (existingWorker.type === 'agent') {
        // SECURITY: Verify agentId is still valid before activating
        const agentManager = await getAgentManager();
        const agent = agentManager.getAgent(existingWorker.agentId);
        const effectiveAgentId = agent ? existingWorker.agentId : CLAUDE_CODE_AGENT_ID;
        if (!agent) {
          logger.warn({ sessionId, workerId, originalAgentId: existingWorker.agentId, fallbackAgentId: effectiveAgentId }, 'Agent no longer valid, falling back to default');
        }

        await this.workerManager.activateAgentWorkerPty(existingWorker, {
          sessionId,
          locationPath: session.locationPath,
          repositoryEnvVars,
          agentId: effectiveAgentId,
          continueConversation: true,
          repositoryId,
        });
      } else {
        this.workerManager.activateTerminalWorkerPty(existingWorker, {
          sessionId,
          locationPath: session.locationPath,
          repositoryEnvVars,
        });
      }
    } catch (err) {
      logger.error({ sessionId, workerId, err }, 'Failed to activate PTY for worker');
      return {
        success: false,
        errorCode: 'ACTIVATION_FAILED',
        message: 'Failed to start process. Check permissions and system resources.',
      };
    }

    await this.persistSession(session);

    logger.info({ workerId, sessionId, workerType: existingWorker.type }, 'Worker PTY activated');

    // Notify listeners that the worker was activated (broadcasts to app clients)
    this.sessionLifecycleCallbacks?.onWorkerActivated?.(sessionId, workerId);

    return { success: true, worker: existingWorker, wasRestored: true };
  }

  /**
   * Get current branch name for a given path
   */
  async getBranchForPath(locationPath: string): Promise<string> {
    return gitGetCurrentBranch(locationPath);
  }

  /**
   * Update session metadata (title and/or branch)
   * If branch is changed, automatically restarts the agent worker
   */
  async updateSessionMetadata(
    sessionId: string,
    updates: { title?: string; branch?: string }
  ): Promise<{ success: boolean; title?: string; branch?: string; error?: string }> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      // Check persisted metadata for inactive sessions
      const metadata = await this.sessionRepository.findById(sessionId);
      if (!metadata) {
        return { success: false, error: 'session_not_found' };
      }

      // For inactive sessions, title update is supported via database persistence
      if (updates.title !== undefined) {
        await this.sessionRepository.save({
          ...metadata,
          title: updates.title,
        });
        return { success: true, title: updates.title };
      }

      // For inactive sessions, branch rename is also supported (no restart possible)
      if (updates.branch) {
        if (metadata.type !== 'worktree') {
          return { success: false, error: 'Can only rename branch for worktree sessions' };
        }

        const currentBranch = await gitGetCurrentBranch(metadata.locationPath);

        try {
          await gitRenameBranch(currentBranch, updates.branch, metadata.locationPath);

          // Persist the updated branch name (worktreeId) for inactive sessions
          await this.sessionRepository.save({
            ...metadata,
            worktreeId: updates.branch,
          });

          return { success: true, branch: updates.branch };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      return { success: true };
    }

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

        // Automatically restart agent worker to pick up new branch name
        const agentWorker = Array.from(session.workers.values()).find(w => w.type === 'agent');
        if (agentWorker) {
          await this.restartAgentWorker(sessionId, agentWorker.id, true);
          logger.info({ workerId: agentWorker.id, sessionId }, 'Agent worker auto-restarted after branch rename');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: message };
      }
    }

    await this.persistSession(session);

    // Broadcast session update via WebSocket
    this.sessionLifecycleCallbacks?.onSessionUpdated?.(this.toPublicSession(session));

    return {
      success: true,
      title: updates.title,
      branch: updates.branch,
    };
  }

  /**
   * @deprecated Use updateSessionMetadata instead
   * Rename the branch for a worktree session
   */
  async renameBranch(
    sessionId: string,
    newBranch: string
  ): Promise<{ success: boolean; branch?: string; error?: string }> {
    return this.updateSessionMetadata(sessionId, { branch: newBranch });
  }

  /**
   * Get parsed environment variables from the repository associated with a session.
   * Returns an empty object if:
   * - Session is not a worktree session (quick sessions have no repository)
   * - RepositoryManager is not initialized (repositoryCallbacks not set)
   * - Repository is not found
   * - Repository has no envVars configured
   *
   * @param sessionId - Session ID to get repository env vars for
   * @returns Parsed environment variables as key-value pairs
   */
  private getRepositoryEnvVars(sessionId: string): Record<string, string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {};
    }

    // Only worktree sessions have an associated repository
    if (session.type !== 'worktree') {
      return {};
    }

    // Check if RepositoryManager is available via callback (edge case: early startup)
    // Uses callback to avoid circular dependency with RepositoryManager
    if (!this.repositoryCallbacks?.isInitialized()) {
      return {};
    }

    const repository = this.repositoryCallbacks.getRepository(session.repositoryId);
    if (!repository) {
      return {};
    }

    // Parse and filter repository env vars to remove protected/dangerous variables
    const parsedEnvVars = parseEnvVars(repository.envVars);
    return filterRepositoryEnvVars(parsedEnvVars);
  }

  /**
   * Compute the activation state of a session based on its workers' PTY state.
   * A session is 'running' if at least one PTY worker has an active PTY.
   * A session is 'hibernated' if all PTY workers have no PTY (after server restart).
   * Sessions with no PTY workers (only git-diff) are considered 'running'.
   */
  private computeActivationState(session: InternalSession): SessionActivationState {
    const ptyWorkers = Array.from(session.workers.values()).filter(
      (w): w is InternalAgentWorker | InternalTerminalWorker =>
        w.type === 'agent' || w.type === 'terminal'
    );
    if (ptyWorkers.length === 0) return 'running';
    const hasActivePty = ptyWorkers.some((w) => w.pty !== null);
    return hasActivePty ? 'running' : 'hibernated';
  }

  private async persistSession(session: InternalSession): Promise<void> {
    const persisted = this.toPersistedSession(session);
    await this.sessionRepository.save(persisted);
  }

  private toPersistedSession(session: InternalSession): PersistedSession {
    return this.toPersistedSessionWithServerPid(session, getServerPid());
  }

  /**
   * Convert an internal session to persisted format with a specific serverPid.
   * Used by pauseSession to save with serverPid = null.
   */
  private toPersistedSessionWithServerPid(session: InternalSession, serverPid: number | null): PersistedSession {
    // session.workers is the source of truth (all workers loaded on init)
    const workers: PersistedWorker[] = Array.from(session.workers.values()).map(w =>
      this.workerManager.toPersistedWorker(w)
    );

    const base = {
      id: session.id,
      locationPath: session.locationPath,
      serverPid,
      createdAt: session.createdAt,
      workers,
      initialPrompt: session.initialPrompt,
      title: session.title,
    };

    return session.type === 'worktree'
      ? { ...base, type: 'worktree', repositoryId: session.repositoryId, worktreeId: session.worktreeId }
      : { ...base, type: 'quick' };
  }

  private toPublicSession(session: InternalSession): Session {
    // session.workers is the source of truth (all workers loaded on init)
    const workers = Array.from(session.workers.values())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(w => this.workerManager.toPublicWorker(w));

    const base = {
      id: session.id,
      locationPath: session.locationPath,
      status: session.status,
      activationState: this.computeActivationState(session),
      createdAt: session.createdAt,
      workers,
      initialPrompt: session.initialPrompt,
      title: session.title,
    };

    if (session.type === 'worktree') {
      // Get repository name via callback to avoid circular dependency
      const repository = this.repositoryCallbacks?.isInitialized()
        ? this.repositoryCallbacks.getRepository(session.repositoryId)
        : undefined;

      return {
        ...base,
        type: 'worktree',
        repositoryId: session.repositoryId,
        repositoryName: repository?.name ?? 'Unknown',
        worktreeId: session.worktreeId,
        isMainWorktree: repository?.path === session.locationPath,
      } as WorktreeSession;
    }

    return { ...base, type: 'quick' } as QuickSession;
  }
}

// Singleton instance
let sessionManagerInstance: SessionManager | null = null;

/**
 * Initialize the SessionManager singleton.
 * Must be called once at application startup before getSessionManager().
 * @param options.sessionRepository - Repository for session persistence
 * @param options.jobQueue - JobQueue for background cleanup tasks
 */
export async function initializeSessionManager(options: {
  sessionRepository: SessionRepository;
  jobQueue: JobQueue;
}): Promise<void> {
  if (sessionManagerInstance) {
    throw new Error('SessionManager already initialized');
  }
  sessionManagerInstance = await SessionManager.create(options);
}

/**
 * Get the SessionManager singleton.
 * @throws Error if initializeSessionManager() has not been called
 */
export function getSessionManager(): SessionManager {
  if (!sessionManagerInstance) {
    throw new Error('SessionManager not initialized. Call initializeSessionManager() first.');
  }
  return sessionManagerInstance;
}

/**
 * Check if SessionManager has been initialized.
 */
export function isSessionManagerInitialized(): boolean {
  return sessionManagerInstance !== null;
}

/**
 * Reset the singleton for testing.
 * @internal For testing only.
 */
export function resetSessionManager(): void {
  sessionManagerInstance = null;
}

/**
 * Set the SessionManager singleton from an existing instance.
 * Used by AppContext to set the singleton without re-creating.
 * @internal For AppContext initialization only.
 */
export function setSessionManager(instance: SessionManager): void {
  if (sessionManagerInstance) {
    throw new Error('SessionManager already initialized');
  }
  sessionManagerInstance = instance;
}
