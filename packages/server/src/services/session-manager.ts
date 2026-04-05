import * as path from 'path';
import { access } from 'fs/promises';
import type {
  Session,
  Worker,
  AgentActivityState,
  CreateSessionRequest,
  CreateWorkerParams,
  WorkerMessage,
  AppServerMessage,
  ExitReason,
} from '@agent-console/shared';
import type {
  PersistedSession,
} from './persistence-service.js';
import type {
  InternalWorker,
  InternalPtyWorker,
  WorkerCallbacks,
} from './worker-types.js';
import type { InternalSession, SessionCreationContext } from './internal-types.js';
import { WorkerManager } from './worker-manager.js';
import { WorkerLifecycleManager, type RestoreWorkerResult } from './worker-lifecycle-manager.js';
import { CLAUDE_CODE_AGENT_ID } from './agent-manager.js';
import type { AgentManager } from './agent-manager.js';
import type { NotificationManager } from './notifications/notification-manager.js';
import { filterRepositoryEnvVars } from './env-filter.js';
import { parseEnvVars } from '../lib/env-parser.js';
import { substituteVariables } from '../lib/template-variables.js';
import { getConfigDir, getServerPid } from '../lib/config.js';
import { stopWatching } from './git-diff-service.js';
import { SessionDataPathResolver } from '../lib/session-data-path-resolver.js';
import type { UserMode } from './user-mode.js';
import {
  getCurrentBranch as gitGetCurrentBranch,
} from '../lib/git.js';
import type { SessionLifecycleCallbacks } from './session-lifecycle-types.js';
import { MessageService } from './message-service.js';
import { InterSessionMessageService } from './inter-session-message-service.js';
import { AnnotationService } from './annotation-service.js';
import { MemoService } from './memo-service.js';
import { PtyMessageInjectionService } from './pty-message-injection-service.js';
import { SessionMetadataService } from './session-metadata-service.js';
import { createLogger } from '../lib/logger.js';
import { WorkerOutputFileManager, type HistoryReadResult } from '../lib/worker-output-file.js';
import { JsonSessionRepository, type SessionRepository } from '../repositories/index.js';
import type { UserRepository } from '../repositories/user-repository.js';
import { resolveSpawnUsername } from './resolve-spawn-username.js';
import type { JobQueue } from '../jobs/index.js';
import { SessionInitializationService } from './session-initialization-service.js';
import { SessionDeletionService } from './session-deletion-service.js';
import { SessionPauseResumeService } from './session-pause-resume-service.js';
import { SessionConverterService } from './session-converter-service.js';

/**
 * Callbacks for resolving dependencies without circular imports.
 * Injected by index.ts after both SessionManager and RepositoryManager are initialized.
 */
export interface SessionRepositoryCallbacks {
  getRepository: (repositoryId: string) => { name: string; path: string; envVars?: string | null } | undefined;
  isInitialized: () => boolean;
  getWorktreeIndexNumber: (worktreePath: string) => Promise<number>;
}

/**
 * Callbacks for WebSocket operations.
 * Injected to avoid circular dependency with websocket/routes.ts.
 */
export interface WebSocketCallbacks {
  /** Notify all Worker WebSocket connections for a session that it's being deleted */
  notifySessionDeleted: (sessionId: string) => void;
  /** Notify all Worker WebSocket connections for a session that it's being paused */
  notifySessionPaused: (sessionId: string) => void;
  /** Broadcast a message to all connected app clients */
  broadcastToApp: (msg: AppServerMessage) => void;
}

const logger = createLogger('session-manager');

// Re-export worker types for consumers that need them
export type { InternalWorker, InternalPtyWorker } from './worker-types.js';

export type { SessionLifecycleCallbacks } from './session-lifecycle-types.js';

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

interface SessionManagerOptions {
  userMode: UserMode;
  pathExists?: (path: string) => Promise<boolean>;
  sessionRepository?: SessionRepository;
  jobQueue?: JobQueue | null;
  agentManager: AgentManager;
  /** User repository for resolving createdBy → username for PTY spawning */
  userRepository?: UserRepository;
  notificationManager?: NotificationManager | null;
  /** In-memory review annotation store. Defaults to a fresh instance if not provided. */
  annotationService?: AnnotationService;
  /** Worker output file management. Defaults to a fresh instance if not provided. */
  workerOutputFileManager?: WorkerOutputFileManager;
  /** Inter-session message file management. Defaults to a fresh instance if not provided. */
  interSessionMessageService?: InterSessionMessageService;
  /** Memo file management. Defaults to a fresh instance if not provided. */
  memoService?: MemoService;
  /** PTY message injection service. Defaults to a new instance wired to this manager. */
  ptyMessageInjectionService?: PtyMessageInjectionService;
}

export class SessionManager {
  private sessions: Map<string, InternalSession> = new Map();
  private sessionLifecycleCallbacks?: SessionLifecycleCallbacks;
  private repositoryCallbacks: SessionRepositoryCallbacks | null = null;
  private webSocketCallbacks: WebSocketCallbacks | null = null;
  private workerManager: WorkerManager;
  private workerLifecycleManager: WorkerLifecycleManager;
  private messageService = new MessageService();
  private pathExists: (path: string) => Promise<boolean>;
  private sessionRepository: SessionRepository;
  private userRepository: UserRepository | null = null;
  private jobQueue: JobQueue | null = null;
  private notificationManager: NotificationManager | null = null;
  private workerOutputFileManager: WorkerOutputFileManager;
  private interSessionMessageService: InterSessionMessageService;
  private memoService: MemoService;
  private ptyMessageInjectionService: PtyMessageInjectionService;
  private sessionMetadataService: SessionMetadataService;
  private sessionInitializationService: SessionInitializationService;
  private sessionDeletionService: SessionDeletionService;
  private sessionPauseResumeService: SessionPauseResumeService;
  private sessionConverterService: SessionConverterService;
  private timerCleanupCallback?: (sessionId: string) => void;
  private processCleanupCallback?: (sessionId: string) => void;

  /**
   * Create a SessionManager instance with async initialization.
   * This is the preferred way to create a SessionManager.
   * @param options.jobQueue - JobQueue instance for background cleanup tasks.
   *                           Must be provided for proper cleanup operations.
   */
  static async create(options: SessionManagerOptions): Promise<SessionManager> {
    const manager = new SessionManager(options);
    await manager.initialize();
    return manager;
  }

  /**
   * Use SessionManager.create() for async initialization.
   */
  private constructor(options: SessionManagerOptions) {
    const userMode = options.userMode;
    const agentManager = options.agentManager;
    this.notificationManager = options?.notificationManager ?? null;
    this.userRepository = options?.userRepository ?? null;
    const workerOutputFileManager = options.workerOutputFileManager ?? new WorkerOutputFileManager();
    this.workerOutputFileManager = workerOutputFileManager;
    this.interSessionMessageService = options.interSessionMessageService ?? new InterSessionMessageService();
    this.memoService = options.memoService ?? new MemoService();
    this.workerManager = new WorkerManager(userMode, agentManager, workerOutputFileManager);
    this.pathExists = options?.pathExists ?? defaultPathExists;
    this.sessionRepository = options?.sessionRepository ??
      new JsonSessionRepository(path.join(getConfigDir(), 'sessions.json'));
    this.jobQueue = options?.jobQueue ?? null;

    this.sessionConverterService = new SessionConverterService({
      getRepositoryCallbacks: () => this.repositoryCallbacks,
      toPublicWorker: (w) => this.workerManager.toPublicWorker(w),
      toPersistedWorker: (w) => this.workerManager.toPersistedWorker(w),
      getServerPid: () => getServerPid(),
    });

    this.workerLifecycleManager = new WorkerLifecycleManager({
      workerManager: this.workerManager,
      agentManager,
      notificationManager: this.notificationManager,
      pathExists: this.pathExists,
      getSession: (id) => this.sessions.get(id),
      persistSession: (session) => this.persistSession(session),
      getRepositoryEnvVars: (id) => this.getRepositoryEnvVars(id),
      toPublicSession: (session) => this.toPublicSession(session),
      getJobQueue: () => this.jobQueue,
      getSessionLifecycleCallbacks: () => this.sessionLifecycleCallbacks,
      resolveSpawnUsername: (createdBy) => resolveSpawnUsername(createdBy, this.userRepository),
      getPathResolver: (session) => this.getPathResolverForSession(session),
      annotationService: options.annotationService ?? new AnnotationService(),
      workerOutputFileManager,
      interSessionMessageService: this.interSessionMessageService,
    });

    this.ptyMessageInjectionService = options.ptyMessageInjectionService
      ?? new PtyMessageInjectionService(
        (sessionId, workerId, data) => this.writeWorkerInput(sessionId, workerId, data),
        (sessionId, workerId) => {
          const s = this.sessions.get(sessionId);
          return !!s && s.workers.has(workerId);
        },
      );

    this.sessionMetadataService = new SessionMetadataService({
      getSession: (id) => this.sessions.get(id),
      sessionRepository: this.sessionRepository,
      persistSession: (session) => this.persistSession(session),
      toPublicSession: (session) => this.toPublicSession(session),
      getSessionLifecycleCallbacks: () => this.sessionLifecycleCallbacks,
      updateGitDiffWorkersAfterBranchRename: (sessionId) =>
        this.workerLifecycleManager.updateGitDiffWorkersAfterBranchRename(sessionId),
    });

    this.sessionInitializationService = new SessionInitializationService({
      sessionRepository: this.sessionRepository,
      pathExists: this.pathExists,
      isSessionInMemory: (id) => this.sessions.has(id),
      workerOutputFileManager: this.workerOutputFileManager,
      jobQueue: this.jobQueue,
      getPathResolverForPersistedSession: (persisted) => this.getPathResolverForPersistedSession(persisted),
      getServerPid,
    });

    this.sessionDeletionService = new SessionDeletionService({
      getSession: (id) => this.sessions.get(id),
      setSession: (id, session) => this.sessions.set(id, session),
      deleteSessionFromMemory: (id) => this.sessions.delete(id),
      sessionRepository: this.sessionRepository,
      workerManager: this.workerManager,
      jobQueue: this.jobQueue,
      notificationManager: this.notificationManager,
      messageService: this.messageService,
      interSessionMessageService: this.interSessionMessageService,
      memoService: this.memoService,
      getPathResolverForSession: (session) => this.getPathResolverForSession(session),
      getPathResolverForPersistedSession: (persisted) => this.getPathResolverForPersistedSession(persisted),
      getSessionLifecycleCallbacks: () => this.sessionLifecycleCallbacks,
      getWebSocketCallbacks: () => this.webSocketCallbacks,
      getTimerCleanupCallback: () => this.timerCleanupCallback,
      getProcessCleanupCallback: () => this.processCleanupCallback,
      stopWatching,
    });

    this.sessionPauseResumeService = new SessionPauseResumeService({
      getSession: (id) => this.sessions.get(id),
      setSession: (id, session) => this.sessions.set(id, session),
      deleteSession: (id) => { this.sessions.delete(id); },
      sessionRepository: this.sessionRepository,
      workerManager: this.workerManager,
      pathExists: this.pathExists,
      getRepositoryEnvVars: (id) => this.getRepositoryEnvVars(id),
      getPathResolverForSession: (session) => this.getPathResolverForSession(session),
      toPublicSession: (session) => this.toPublicSession(session),
      toPersistedSessionWithServerPid: (session, serverPid) => this.toPersistedSessionWithServerPid(session, serverPid),
      persistedToPublicSession: (p) => this.persistedToPublicSession(p),
      getWorkerActivityState: (sessionId, workerId) => this.getWorkerActivityState(sessionId, workerId),
      getSessionLifecycleCallbacks: () => this.sessionLifecycleCallbacks,
      getWebSocketCallbacks: () => this.webSocketCallbacks,
      notificationManager: this.notificationManager,
      messageService: this.messageService,
      userRepository: this.userRepository,
      resolveSpawnUsername,
      stopWatching,
      getServerPid,
    });
  }

  /**
   * Get the session repository used by this manager.
   * Useful for creating services that need to access session persistence directly.
   */
  getSessionRepository(): SessionRepository {
    return this.sessionRepository;
  }

  /**
   * Initialize sessions from persistence, clean up orphan processes,
   * and auto-resume sessions that were active before the server stopped.
   * Called by SessionManager.create() factory method.
   */
  private async initialize(): Promise<void> {
    const autoResumeSessionIds = await this.sessionInitializationService.initialize();

    // Auto-resume sessions that were active before the server died.
    // Resume sequentially to avoid resource spikes.
    for (const sessionId of autoResumeSessionIds) {
      try {
        await this.sessionPauseResumeService.resumeSession(sessionId);
        logger.info({ sessionId }, 'Auto-resumed previously active session');
      } catch (error) {
        logger.error({ sessionId, err: error }, 'Failed to auto-resume session');
      }
    }

    if (autoResumeSessionIds.length > 0) {
      logger.info({ count: autoResumeSessionIds.length }, 'Auto-resume completed');
    }
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
    this.workerManager.setGlobalPtyExitCallback((sessionId, _workerId, _reason) => {
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

    // Inject message parts into target worker's PTY
    const injected = this.ptyMessageInjectionService.injectMessage(sessionId, toWorkerId, content, filePaths);
    if (!injected) return null;

    // Store and broadcast
    this.messageService.addMessage(message);
    this.webSocketCallbacks?.broadcastToApp({ type: 'worker-message', message });

    return message;
  }

  /**
   * Set a global callback for all worker exit events (for notifications)
   */
  setGlobalWorkerExitCallback(callback: (sessionId: string, workerId: string, exitCode: number, reason: ExitReason) => void): void {
    this.workerManager.setGlobalWorkerExitCallback(callback);
  }

  /**
   * Set callbacks for session lifecycle events (for dashboard broadcast)
   */
  setSessionLifecycleCallbacks(callbacks: SessionLifecycleCallbacks): void {
    this.sessionLifecycleCallbacks = callbacks;
  }

  /**
   * Set callbacks for WebSocket operations.
   * Must be called after WebSocket routes are set up.
   */
  setWebSocketCallbacks(callbacks: WebSocketCallbacks): void {
    this.webSocketCallbacks = callbacks;
  }

  /**
   * Set callbacks for resolving repository dependencies without circular imports.
   * Must be called after both SessionManager and RepositoryManager are initialized.
   */
  setRepositoryCallbacks(callbacks: SessionRepositoryCallbacks): void {
    this.repositoryCallbacks = callbacks;
  }

  /**
   * Set a callback to clean up timers when a session is deleted.
   * Wired in app-context to connect SessionManager with TimerManager
   * without creating a direct dependency.
   */
  setTimerCleanupCallback(callback: (sessionId: string) => void): void {
    this.timerCleanupCallback = callback;
  }

  /**
   * Set a callback to clean up interactive processes when a session is deleted.
   * Wired in app-context to connect SessionManager with InteractiveProcessManager
   * without creating a direct dependency.
   */
  setProcessCleanupCallback(callback: (sessionId: string) => void): void {
    this.processCleanupCallback = callback;
  }

  // ========== Session Lifecycle ==========

  async createSession(request: CreateSessionRequest, context?: SessionCreationContext): Promise<Session> {
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
      parentSessionId: request.parentSessionId,
      parentWorkerId: request.parentWorkerId,
      createdBy: context?.createdBy,
      templateVars: request.templateVars ?? context?.templateVars,
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
      }, request.continueConversation ?? false, request.initialPrompt, request.templateVars ?? context?.templateVars),
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

  /**
   * Get a persisted session as a public Session type.
   * Used for inactive/paused sessions that aren't in memory.
   */
  async getPersistedSession(id: string): Promise<Session | null> {
    const persisted = await this.sessionRepository.findById(id);
    if (!persisted) return null;
    return this.persistedToPublicSession(persisted);
  }

  /**
   * Kill all workers in a session without deleting the session itself.
   * Used to release directory handles (e.g., cwd) before worktree deletion
   * while keeping the session recoverable if deletion fails.
   */
  async killSessionWorkers(id: string): Promise<void> {
    return this.sessionDeletionService.killSessionWorkers(id);
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.sessionDeletionService.deleteSession(id);
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

  private persistedToPublicSession(p: PersistedSession): Session {
    return this.sessionConverterService.persistedToPublicSession(p);
  }

  /**
   * Pause a session: kill all PTY workers, remove from memory, preserve persistence.
   * Delegates to SessionPauseResumeService.
   */
  async pauseSession(id: string): Promise<boolean> {
    return this.sessionPauseResumeService.pauseSession(id);
  }

  /**
   * Resume a paused session: load from DB, create in-memory session, restore workers.
   * Delegates to SessionPauseResumeService.
   */
  async resumeSession(id: string): Promise<Session | null> {
    return this.sessionPauseResumeService.resumeSession(id);
  }

  /**
   * Force delete a session, whether it's in memory or only in persistence.
   * Used for orphaned sessions that exist only in sessions.json.
   * @returns true if session was deleted, false if not found
   */
  async forceDeleteSession(id: string): Promise<boolean> {
    return this.sessionDeletionService.forceDeleteSession(id);
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
    initialPrompt?: string,
    templateVars?: Record<string, string>
  ): Promise<Worker | null> {
    return this.workerLifecycleManager.createWorker(sessionId, request, continueConversation, initialPrompt, templateVars);
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

  /** Inject content into a worker's PTY as submitted input (with CR conversion and delayed Enter). */
  injectPtyMessage(sessionId: string, workerId: string, content: string): boolean {
    return this.ptyMessageInjectionService.injectMessage(sessionId, workerId, content);
  }

  /** Write raw data to a worker's PTY (no CR conversion, no delayed Enter). */
  writePtyData(sessionId: string, workerId: string, data: string): boolean {
    return this.writeWorkerInput(sessionId, workerId, data);
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
   * Write a memo for a session. Validates the session exists, writes to disk,
   * and fires the onMemoUpdated lifecycle callback for WebSocket broadcast.
   *
   * @returns The absolute file path of the written memo.
   */
  async writeMemo(sessionId: string, content: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const resolver = this.getPathResolverForSession(session);
    const filePath = await this.memoService.writeMemo(sessionId, content, resolver);
    // Re-check after async write: session may have been deleted during the write
    if (!this.sessions.has(sessionId)) {
      await this.memoService.deleteMemo(sessionId, resolver).catch(() => {});
      throw new Error(`Session deleted during memo write: ${sessionId}`);
    }
    this.sessionLifecycleCallbacks?.onMemoUpdated?.(sessionId, content);
    return filePath;
  }

  /**
   * Read a memo for a session.
   *
   * @returns The memo content, or null if no memo exists.
   */
  async readMemo(sessionId: string): Promise<string | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const resolver = this.getPathResolverForSession(session);
    return this.memoService.readMemo(sessionId, resolver);
  }

  /**
   * Update session metadata (title and/or branch)
   */
  async updateSessionMetadata(
    sessionId: string,
    updates: { title?: string; branch?: string }
  ): Promise<{ success: boolean; title?: string; branch?: string; error?: string }> {
    return this.sessionMetadataService.updateSessionMetadata(sessionId, updates);
  }

  /**
   * @deprecated Use updateSessionMetadata instead
   * Rename the branch for a worktree session
   */
  async renameBranch(
    sessionId: string,
    newBranch: string
  ): Promise<{ success: boolean; branch?: string; error?: string }> {
    return this.sessionMetadataService.renameBranch(sessionId, newBranch);
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
  // resolveSpawnUsername is now an imported standalone function from ./resolve-spawn-username.ts

  private async getRepositoryEnvVars(sessionId: string): Promise<Record<string, string>> {
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
    const filtered = filterRepositoryEnvVars(parsedEnvVars);

    // Fast path: skip DB + git calls when no values contain template placeholders.
    // Uses {{ as a heuristic signal. False positives (e.g., JSON values containing {{)
    // only cause unnecessary variable resolution, not incorrect behavior.
    const hasTemplates = Object.values(filtered).some(v => v.includes('{{'));
    if (!hasTemplates) return filtered;

    // Resolve template variables and apply substitution
    const worktreeNum = await this.repositoryCallbacks.getWorktreeIndexNumber(session.locationPath);
    const branch = await gitGetCurrentBranch(session.locationPath);
    const vars = {
      worktreeNum,
      branch,
      repo: repository.name,
      worktreePath: session.locationPath,
    };

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(filtered)) {
      result[key] = substituteVariables(value, vars);
    }
    return result;
  }

  private async persistSession(session: InternalSession): Promise<void> {
    const persisted = this.sessionConverterService.toPersistedSession(session);
    await this.sessionRepository.save(persisted);
  }

  private toPersistedSessionWithServerPid(session: InternalSession, serverPid: number | null): PersistedSession {
    return this.sessionConverterService.toPersistedSessionWithServerPid(session, serverPid);
  }

  /**
   * Resolve the session data path resolver for a session.
   * Returns a resolver scoped to the repository for worktree sessions,
   * or a quick-session resolver for quick sessions.
   */
  private getPathResolverForSession(session: InternalSession): SessionDataPathResolver {
    if (session.type !== 'worktree') return new SessionDataPathResolver();
    if (!this.repositoryCallbacks?.isInitialized()) return new SessionDataPathResolver();
    return new SessionDataPathResolver(this.repositoryCallbacks.getRepository(session.repositoryId)?.name);
  }

  /**
   * Resolve the session data path resolver from a persisted session's repositoryId.
   * Returns a quick-session resolver for quick sessions or when repository callbacks are unavailable.
   */
  private getPathResolverForPersistedSession(persisted: PersistedSession): SessionDataPathResolver {
    if (persisted.type !== 'worktree') return new SessionDataPathResolver();
    if (!this.repositoryCallbacks?.isInitialized()) return new SessionDataPathResolver();
    return new SessionDataPathResolver(this.repositoryCallbacks.getRepository(persisted.repositoryId)?.name);
  }

  private toPublicSession(session: InternalSession): Session {
    return this.sessionConverterService.toPublicSession(session);
  }

  // ========== Bulk Operations ==========

  /**
   * Restart all active agent workers across all in-memory sessions.
   * Executes sequentially to avoid resource spikes.
   * Each failure is logged and recorded but doesn't block other restarts.
   */
  async restartAllAgentWorkers(): Promise<{
    restarted: number;
    failed: number;
    results: Array<{ sessionId: string; workerId: string; success: boolean; error?: string }>;
  }> {
    const results: Array<{ sessionId: string; workerId: string; success: boolean; error?: string }> = [];

    for (const session of this.sessions.values()) {
      for (const worker of session.workers.values()) {
        if (worker.type !== 'agent') continue;

        try {
          const restarted = await this.restartAgentWorker(session.id, worker.id, false);
          if (restarted) {
            results.push({ sessionId: session.id, workerId: worker.id, success: true });
          } else {
            results.push({ sessionId: session.id, workerId: worker.id, success: false, error: 'restart returned null' });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          logger.error({ sessionId: session.id, workerId: worker.id, err }, 'Failed to restart agent worker in bulk operation');
          results.push({ sessionId: session.id, workerId: worker.id, success: false, error: message });
        }
      }
    }

    const restarted = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    logger.info({ restarted, failed }, 'Bulk restart all agent workers completed');

    return { restarted, failed, results };
  }
}
