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
import type { InternalSession } from './internal-types.js';
import { WorkerManager } from './worker-manager.js';
import { WorkerLifecycleManager, type RestoreWorkerResult } from './worker-lifecycle-manager.js';
import { CLAUDE_CODE_AGENT_ID } from './agent-manager.js';
import { filterRepositoryEnvVars } from './env-filter.js';
import { parseEnvVars } from '../lib/env-parser.js';
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
import { JsonSessionRepository, type SessionRepository } from '../repositories/index.js';
import { JOB_TYPES, type JobQueue } from '../jobs/index.js';

/**
 * Callbacks for resolving dependencies without circular imports.
 * Injected by index.ts after both SessionManager and RepositoryManager are initialized.
 */
export interface SessionRepositoryCallbacks {
  getRepository: (repositoryId: string) => { name: string; path: string; envVars?: string | null } | undefined;
  isInitialized: () => boolean;
}

const logger = createLogger('session-manager');

// Re-export worker types for consumers that need them
export type { InternalWorker, InternalPtyWorker } from './worker-types.js';

export interface SessionLifecycleCallbacks {
  onSessionCreated?: (session: Session) => void;
  onSessionUpdated?: (session: Session) => void;
  onSessionDeleted?: (sessionId: string) => void;
  onWorkerActivated?: (sessionId: string, workerId: string) => void;
  onSessionPaused?: (sessionId: string) => void;
  onSessionResumed?: (session: Session) => void;
}

export type { RestoreWorkerResult } from './worker-lifecycle-manager.js';

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
  private workerLifecycleManager: WorkerLifecycleManager;
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

    this.workerLifecycleManager = new WorkerLifecycleManager({
      workerManager: this.workerManager,
      pathExists: this.pathExists,
      getSession: (id) => this.sessions.get(id),
      persistSession: (session) => this.persistSession(session),
      getRepositoryEnvVars: (id) => this.getRepositoryEnvVars(id),
      toPublicSession: (session) => this.toPublicSession(session),
      getJobQueue: () => this.jobQueue,
      getSessionLifecycleCallbacks: () => this.sessionLifecycleCallbacks,
    });
  }

  /**
   * Set the job queue for background task processing.
   * @internal For testing only. In production, pass jobQueue to create() or getSessionManager().
   */
  setJobQueue(jobQueue: JobQueue): void {
    this.jobQueue = jobQueue;
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

  // ========== Worker Operations (delegated to WorkerLifecycleManager) ==========

  /** Create a worker in the session. Delegates to WorkerLifecycleManager. */
  async createWorker(
    sessionId: string,
    request: CreateWorkerParams,
    continueConversation: boolean = false,
    initialPrompt?: string
  ): Promise<Worker | null> {
    return this.workerLifecycleManager.createWorker(sessionId, request, continueConversation, initialPrompt);
  }

  /** Get a worker by session and worker ID. */
  getWorker(sessionId: string, workerId: string): InternalWorker | undefined {
    return this.workerLifecycleManager.getWorker(sessionId, workerId);
  }

  /**
   * Get a worker that is ready for PTY operations.
   * Activates PTY if needed (after server restart).
   */
  async getAvailableWorker(sessionId: string, workerId: string): Promise<InternalPtyWorker | null> {
    return this.workerLifecycleManager.getAvailableWorker(sessionId, workerId);
  }

  /** Delete a worker from the session. */
  async deleteWorker(sessionId: string, workerId: string): Promise<boolean> {
    return this.workerLifecycleManager.deleteWorker(sessionId, workerId);
  }

  /** Attach callbacks for a WebSocket connection to a worker. */
  attachWorkerCallbacks(sessionId: string, workerId: string, callbacks: WorkerCallbacks): string | null {
    return this.workerLifecycleManager.attachWorkerCallbacks(sessionId, workerId, callbacks);
  }

  /** Detach callbacks for a specific WebSocket connection. */
  detachWorkerCallbacks(sessionId: string, workerId: string, connectionId: string): boolean {
    return this.workerLifecycleManager.detachWorkerCallbacks(sessionId, workerId, connectionId);
  }

  /** Write input data to a worker's PTY. */
  writeWorkerInput(sessionId: string, workerId: string, data: string): boolean {
    return this.workerLifecycleManager.writeWorkerInput(sessionId, workerId, data);
  }

  /** Resize a worker's PTY. */
  resizeWorker(sessionId: string, workerId: string, cols: number, rows: number): boolean {
    return this.workerLifecycleManager.resizeWorker(sessionId, workerId, cols, rows);
  }

  /** Get the output buffer for a worker. */
  getWorkerOutputBuffer(sessionId: string, workerId: string): string {
    return this.workerLifecycleManager.getWorkerOutputBuffer(sessionId, workerId);
  }

  /** Get the activity state for an agent worker. */
  getWorkerActivityState(sessionId: string, workerId: string): AgentActivityState | undefined {
    return this.workerLifecycleManager.getWorkerActivityState(sessionId, workerId);
  }

  /** Get worker output history from file with optional offset for incremental sync. */
  async getWorkerOutputHistory(
    sessionId: string,
    workerId: string,
    fromOffset?: number,
    maxLines?: number
  ): Promise<HistoryReadResult | null> {
    return this.workerLifecycleManager.getWorkerOutputHistory(sessionId, workerId, fromOffset, maxLines);
  }

  /** Get current output offset for a worker. */
  async getCurrentOutputOffset(sessionId: string, workerId: string): Promise<number> {
    return this.workerLifecycleManager.getCurrentOutputOffset(sessionId, workerId);
  }

  /** Restart an agent worker, optionally changing agent or branch. */
  async restartAgentWorker(
    sessionId: string,
    workerId: string,
    continueConversation: boolean,
    agentId?: string,
    branch?: string
  ): Promise<Worker | null> {
    return this.workerLifecycleManager.restartAgentWorker(sessionId, workerId, continueConversation, agentId, branch);
  }

  /** Restore a PTY worker, activating its PTY if needed after server restart. */
  async restoreWorker(sessionId: string, workerId: string): Promise<RestoreWorkerResult> {
    return this.workerLifecycleManager.restoreWorker(sessionId, workerId);
  }

  /**
   * Get current branch name for a given path
   */
  async getBranchForPath(locationPath: string): Promise<string> {
    return gitGetCurrentBranch(locationPath);
  }

  /**
   * Update session metadata (title and/or branch)
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
