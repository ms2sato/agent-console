import * as path from 'path';
import { access } from 'fs/promises';
import type {
  Session,
  WorktreeSession,
  QuickSession,
  Worker,
  AgentWorker,
  TerminalWorker,
  GitDiffWorker,
  AgentActivityState,
  CreateSessionRequest,
  CreateWorkerParams,
  WorkerErrorCode,
} from '@agent-console/shared';
import type {
  PersistedSession,
  PersistedWorker,
  PersistedAgentWorker,
  PersistedTerminalWorker,
  PersistedGitDiffWorker,
} from './persistence-service.js';
import { ActivityDetector } from './activity-detector.js';
import { getAgentManager, CLAUDE_CODE_AGENT_ID } from './agent-manager.js';
import { getChildProcessEnv, getUnsetEnvPrefix } from './env-filter.js';
import { getConfigDir, getServerPid } from '../lib/config.js';
import { serverConfig } from '../lib/server-config.js';
import { bunPtyProvider, type PtyProvider, type PtyInstance } from '../lib/pty-provider.js';
import { processKill, isProcessAlive } from '../lib/process-utils.js';
import { expandTemplate } from '../lib/template.js';
import {
  getCurrentBranch as gitGetCurrentBranch,
  renameBranch as gitRenameBranch,
} from '../lib/git.js';
import {
  calculateBaseCommit,
  resolveRef,
  stopWatching,
} from './git-diff-service.js';
import { createLogger } from '../lib/logger.js';
import { workerOutputFileManager, type HistoryReadResult } from '../lib/worker-output-file.js';
import type { SessionRepository } from '../repositories/index.js';
import { JsonSessionRepository } from '../repositories/index.js';
import { JOB_TYPES, type JobQueue } from '../jobs/index.js';

const logger = createLogger('session-manager');

// Base for all workers
interface InternalWorkerBase {
  id: string;
  name: string;
  createdAt: string;
}

// Callback set for a single WebSocket connection
interface ConnectionCallbacks {
  onData: (data: string, offset: number) => void;
  onExit: (exitCode: number, signal: string | null) => void;
  onActivityChange?: (state: AgentActivityState) => void;
}

// Base for PTY-based workers (agent, terminal)
// Uses Map to support multiple concurrent WebSocket connections (e.g., multiple browser tabs)
// After server restart, pty may be null until the worker is activated via WebSocket connection
interface InternalPtyWorkerBase extends InternalWorkerBase {
  pty: PtyInstance | null;  // null = not yet activated after server restart
  outputBuffer: string;
  outputOffset: number;  // Current output offset in bytes (for incremental sync)
  // Map of connection ID to callbacks - supports multiple simultaneous connections
  connectionCallbacks: Map<string, ConnectionCallbacks>;
}

interface InternalAgentWorker extends InternalPtyWorkerBase {
  type: 'agent';
  agentId: string;
  activityState: AgentActivityState;
  activityDetector: ActivityDetector | null;  // null when pty is null
}

interface InternalTerminalWorker extends InternalPtyWorkerBase {
  type: 'terminal';
}

// GitDiffWorker does not use PTY - runs in server process
interface InternalGitDiffWorker extends InternalWorkerBase {
  type: 'git-diff';
  baseCommit: string;
  // File watcher and callbacks will be added in Phase 2
}

type InternalPtyWorker = InternalAgentWorker | InternalTerminalWorker;
type InternalWorker = InternalAgentWorker | InternalTerminalWorker | InternalGitDiffWorker;

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

interface WorkerCallbacks {
  onData: (data: string, offset: number) => void;
  onExit: (exitCode: number, signal: string | null) => void;
  onActivityChange?: (state: AgentActivityState) => void;
}

export interface SessionLifecycleCallbacks {
  onSessionCreated?: (session: Session) => void;
  onSessionUpdated?: (session: Session) => void;
  onSessionDeleted?: (sessionId: string) => void;
}

/**
 * Result type for restoreWorker operation.
 * Provides detailed error information for specific failure cases.
 * Note: worker type is narrowed to 'agent' | 'terminal' since git-diff workers
 * don't support PTY restoration.
 */
export type RestoreWorkerResult =
  | { success: true; worker: { type: 'agent' | 'terminal' } }
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
  private globalActivityCallback?: (sessionId: string, workerId: string, state: AgentActivityState) => void;
  private sessionLifecycleCallbacks?: SessionLifecycleCallbacks;
  private ptyProvider: PtyProvider;
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
    // Note: jobQueue is set via constructor options, making it available during initialize()
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
    this.ptyProvider = options?.ptyProvider ?? bunPtyProvider;
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
   */
  private async initializeSessions(): Promise<void> {
    const persistedSessions = await this.sessionRepository.findAll();
    const currentServerPid = getServerPid();
    const sessionsToSave: PersistedSession[] = [];
    let inheritedCount = 0;
    let killedWorkerCount = 0;

    for (const session of persistedSessions) {
      // Skip if already in memory (shouldn't happen, but safety check)
      if (this.sessions.has(session.id)) continue;

      // If serverPid is alive, this session belongs to another active server
      // Keep it in persistence unchanged
      if (session.serverPid && isProcessAlive(session.serverPid)) {
        sessionsToSave.push(session);
        continue;
      }

      // serverPid is dead or missing - inherit this session
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
      const workers = this.restoreWorkersFromPersistence(session.workers);
      let internalSession: InternalSession;

      if (session.type === 'worktree') {
        internalSession = {
          id: session.id,
          type: 'worktree',
          locationPath: session.locationPath,
          repositoryId: session.repositoryId,
          worktreeId: session.worktreeId,
          status: 'active', // Mark as active so it appears in the list
          createdAt: session.createdAt,
          workers,
          initialPrompt: session.initialPrompt,
          title: session.title,
        };
      } else {
        internalSession = {
          id: session.id,
          type: 'quick',
          locationPath: session.locationPath,
          status: 'active',
          createdAt: session.createdAt,
          workers,
          initialPrompt: session.initialPrompt,
          title: session.title,
        };
      }

      this.sessions.set(session.id, internalSession);
      inheritedCount++;

      // Update serverPid to claim ownership
      sessionsToSave.push({
        ...session,
        serverPid: currentServerPid,
      });
    }

    // Save all sessions (inherited with updated PID, others unchanged)
    if (sessionsToSave.length > 0 || persistedSessions.length > 0) {
      await this.sessionRepository.saveAll(sessionsToSave);
    }

    logger.info({
      inheritedSessions: inheritedCount,
      killedWorkerProcesses: killedWorkerCount,
      serverPid: currentServerPid,
    }, 'Initialized sessions from persistence');
  }

  /**
   * Set a global callback for all activity state changes (for dashboard broadcast)
   */
  setGlobalActivityCallback(callback: (sessionId: string, workerId: string, state: AgentActivityState) => void): void {
    this.globalActivityCallback = callback;
  }

  /**
   * Set callbacks for session lifecycle events (for dashboard broadcast)
   */
  setSessionLifecycleCallbacks(callbacks: SessionLifecycleCallbacks): void {
    this.sessionLifecycleCallbacks = callbacks;
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

    let internalSession: InternalSession;

    if (request.type === 'worktree') {
      internalSession = {
        id,
        type: 'worktree',
        locationPath: request.locationPath,
        repositoryId: request.repositoryId,
        worktreeId: request.worktreeId,
        status: 'active',
        createdAt,
        workers: new Map(),
        initialPrompt: request.initialPrompt,
        title: request.title,
      };
    } else {
      internalSession = {
        id,
        type: 'quick',
        locationPath: request.locationPath,
        status: 'active',
        createdAt,
        workers: new Map(),
        initialPrompt: request.initialPrompt,
        title: request.title,
      };
    }

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

    // Kill all workers first (before removing from memory)
    for (const worker of session.workers.values()) {
      if (worker.type === 'git-diff') {
        // Stop file watcher for git-diff workers
        stopWatching(session.locationPath);
      } else {
        // Kill PTY for agent/terminal workers (if activated)
        if (worker.pty) {
          worker.pty.kill();
        }
        if (worker.type === 'agent' && worker.activityDetector) {
          worker.activityDetector.dispose();
        }
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

      // 2. Remove from in-memory map
      this.sessions.delete(id);

      // 3. Delete from persistence (this is the critical operation)
      await this.sessionRepository.delete(id);

      logger.info({ sessionId: id }, 'Session deleted');

      // 4. Only broadcast after all operations succeed
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

    if (request.type === 'agent') {
      // Initialize worker without PTY, then activate PTY
      const agentWorker = await this.initializeAgentWorker({
        id: workerId,
        name: workerName,
        createdAt,
        agentId: request.agentId,
      });
      await this.activateAgentWorkerPty(agentWorker, {
        sessionId,
        locationPath: session.locationPath,
        agentId: agentWorker.agentId,
        continueConversation,
        initialPrompt,
      });
      worker = agentWorker;
    } else if (request.type === 'terminal') {
      // Initialize worker without PTY, then activate PTY
      const terminalWorker = this.initializeTerminalWorker({
        id: workerId,
        name: workerName,
        createdAt,
      });
      this.activateTerminalWorkerPty(terminalWorker, {
        sessionId,
        locationPath: session.locationPath,
      });
      worker = terminalWorker;
    } else {
      // git-diff worker (async initialization for base commit calculation)
      worker = await this.initializeGitDiffWorker({
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

    return this.toPublicWorker(worker);
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

    // Activate PTY based on worker type
    if (worker.type === 'agent') {
      // SECURITY: Verify agentId is still valid
      const agentManager = await getAgentManager();
      const agent = agentManager.getAgent(worker.agentId);
      if (!agent) {
        logger.warn({ sessionId, workerId, agentId: worker.agentId }, 'Agent no longer valid, falling back to default');
      }

      await this.activateAgentWorkerPty(worker, {
        sessionId,
        locationPath: session.locationPath,
        agentId: agent ? worker.agentId : CLAUDE_CODE_AGENT_ID,
        continueConversation: true,
      });
    } else {
      // terminal worker
      this.activateTerminalWorkerPty(worker, {
        sessionId,
        locationPath: session.locationPath,
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
    if (worker.type === 'agent') {
      if (worker.pty) worker.pty.kill();
      if (worker.activityDetector) worker.activityDetector.dispose();
      await this.cleanupWorkerOutput(sessionId, workerId);
    } else if (worker.type === 'terminal') {
      if (worker.pty) worker.pty.kill();
      await this.cleanupWorkerOutput(sessionId, workerId);
    } else {
      // git-diff worker: stop file watcher (fire-and-forget)
      void stopWatching(session.locationPath);
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
   * Initialize an agent worker WITHOUT starting the PTY.
   * The PTY will be activated later via activateAgentWorkerPty.
   * This ensures PTY creation logic is only in one place.
   */
  private async initializeAgentWorker(params: {
    id: string;
    name: string;
    createdAt: string;
    agentId: string;
  }): Promise<InternalAgentWorker> {
    const { id, name, createdAt, agentId } = params;

    const resolvedAgentId = agentId ?? CLAUDE_CODE_AGENT_ID;
    const agentManager = await getAgentManager();
    const agent = agentManager.getAgent(resolvedAgentId) ?? agentManager.getDefaultAgent();

    // Create worker without PTY (will be activated later)
    const worker: InternalAgentWorker = {
      id,
      type: 'agent',
      name,
      createdAt,
      agentId: agent.id,
      pty: null,  // PTY will be activated via activateAgentWorkerPty
      outputBuffer: '',
      outputOffset: 0,  // Will be updated when output is received
      activityState: 'unknown',
      activityDetector: null,  // Will be created when PTY is activated
      connectionCallbacks: new Map(),
    };

    return worker;
  }

  /**
   * Initialize a terminal worker WITHOUT starting the PTY.
   * The PTY will be activated later via activateTerminalWorkerPty.
   * This ensures PTY creation logic is only in one place.
   */
  private initializeTerminalWorker(params: {
    id: string;
    name: string;
    createdAt: string;
  }): InternalTerminalWorker {
    const { id, name, createdAt } = params;

    // Create worker without PTY (will be activated later)
    const worker: InternalTerminalWorker = {
      id,
      type: 'terminal',
      name,
      createdAt,
      pty: null,  // PTY will be activated via activateTerminalWorkerPty
      outputBuffer: '',
      outputOffset: 0,  // Will be updated when output is received
      connectionCallbacks: new Map(),
    };

    return worker;
  }

  private async initializeGitDiffWorker(params: {
    id: string;
    name: string;
    createdAt: string;
    locationPath: string;
    baseCommit?: string;
  }): Promise<InternalGitDiffWorker> {
    const { id, name, createdAt, locationPath, baseCommit } = params;

    // Calculate or resolve the base commit
    let resolvedBaseCommit: string;

    if (baseCommit) {
      // If baseCommit is provided, resolve it (could be branch name or commit hash)
      const resolved = await resolveRef(baseCommit, locationPath);
      resolvedBaseCommit = resolved ?? 'HEAD';
    } else {
      // Calculate merge-base with default branch
      const mergeBase = await calculateBaseCommit(locationPath);
      resolvedBaseCommit = mergeBase ?? 'HEAD';
    }

    const worker: InternalGitDiffWorker = {
      id,
      type: 'git-diff',
      name,
      createdAt,
      baseCommit: resolvedBaseCommit,
    };

    // Note: File watching is started when WebSocket connects (in git-diff-handler.ts)
    // This allows the watcher callback to send updates via WebSocket

    return worker;
  }

  /**
   * Activate PTY for an existing agent worker (after server restart).
   * Mutates the worker object to add pty and activityDetector.
   */
  private async activateAgentWorkerPty(
    worker: InternalAgentWorker,
    params: {
      sessionId: string;
      locationPath: string;
      agentId: string;
      continueConversation: boolean;
      initialPrompt?: string;
    }
  ): Promise<void> {
    // Idempotent: If PTY already active, skip (prevents resource leaks from concurrent activations)
    if (worker.pty !== null) {
      logger.debug({ workerId: worker.id, existingPid: worker.pty.pid }, 'Agent worker PTY already active, skipping activation');
      return;
    }

    const { sessionId, locationPath, agentId, continueConversation, initialPrompt } = params;

    const agentManager = await getAgentManager();
    const agent = agentManager.getAgent(agentId) ?? agentManager.getDefaultAgent();

    // Select the appropriate template based on whether we're continuing a conversation
    const template = continueConversation && agent.continueTemplate
      ? agent.continueTemplate
      : agent.commandTemplate;

    const { command, env: templateEnv } = expandTemplate({
      template,
      prompt: initialPrompt,
      cwd: locationPath,
    });

    const processEnv = {
      ...getChildProcessEnv(),
      ...templateEnv,
    };

    // Use unset prefix to remove blocked env vars that bun-pty inherits from parent
    const unsetPrefix = getUnsetEnvPrefix();
    const ptyProcess = this.ptyProvider.spawn('sh', ['-c', unsetPrefix + command], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: locationPath,
      env: processEnv,
    });

    const activityDetector = new ActivityDetector({
      onStateChange: (state) => {
        worker.activityState = state;
        const callbacksSnapshot = Array.from(worker.connectionCallbacks.values());
        for (const callbacks of callbacksSnapshot) {
          callbacks.onActivityChange?.(state);
        }
        this.globalActivityCallback?.(sessionId, worker.id, state);
      },
      activityPatterns: agent.activityPatterns,
    });

    // Mutate the existing worker to add PTY
    worker.pty = ptyProcess;
    worker.activityDetector = activityDetector;
    worker.agentId = agentId;

    this.setupWorkerEventHandlers(worker, sessionId);
  }

  /**
   * Activate PTY for an existing terminal worker (after server restart).
   * Mutates the worker object to add pty.
   */
  private activateTerminalWorkerPty(
    worker: InternalTerminalWorker,
    params: { sessionId: string; locationPath: string }
  ): void {
    // Idempotent: If PTY already active, skip (prevents resource leaks from concurrent activations)
    if (worker.pty !== null) {
      logger.debug({ workerId: worker.id, existingPid: worker.pty.pid }, 'Terminal worker PTY already active, skipping activation');
      return;
    }

    const { sessionId, locationPath } = params;

    // Use unset prefix to remove blocked env vars that bun-pty inherits from parent
    const unsetPrefix = getUnsetEnvPrefix();
    const shell = process.env.SHELL || '/bin/bash';
    const ptyProcess = this.ptyProvider.spawn('sh', ['-c', `${unsetPrefix}exec ${shell} -l`], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: locationPath,
      env: getChildProcessEnv(),
    });

    // Mutate the existing worker to add PTY
    worker.pty = ptyProcess;

    this.setupWorkerEventHandlers(worker, sessionId);
  }

  private setupWorkerEventHandlers(worker: InternalPtyWorker, sessionId: string): void {
    // Validate sessionId - it must be a non-empty string
    if (!sessionId || sessionId.trim() === '') {
      throw new Error(`Cannot setup event handlers: sessionId is required (got: ${sessionId === '' ? 'empty string' : String(sessionId)})`);
    }

    if (!worker.pty) {
      throw new Error('Cannot setup event handlers: worker.pty is null');
    }
    worker.pty.onData((data) => {
      worker.outputBuffer += data;
      const maxBufferSize = serverConfig.WORKER_OUTPUT_BUFFER_SIZE;
      if (worker.outputBuffer.length > maxBufferSize) {
        worker.outputBuffer = worker.outputBuffer.slice(-maxBufferSize);
      }

      // Update output offset (byte-based for incremental sync)
      worker.outputOffset += Buffer.byteLength(data, 'utf-8');

      // Buffer output to file for persistence
      workerOutputFileManager.bufferOutput(sessionId, worker.id, data);

      if (worker.type === 'agent' && worker.activityDetector) {
        worker.activityDetector.processOutput(data);
      }

      // Snapshot callbacks before iteration to avoid concurrent modification issues
      const callbacksSnapshot = Array.from(worker.connectionCallbacks.values());
      for (const callbacks of callbacksSnapshot) {
        callbacks.onData(data, worker.outputOffset);
      }
    });

    const pty = worker.pty; // Capture reference for closure
    pty.onExit(({ exitCode, signal }) => {
      const signalStr = signal !== undefined ? String(signal) : null;
      logger.info({ workerId: worker.id, pid: pty.pid, exitCode, signal: signalStr }, 'Worker exited');

      if (worker.type === 'agent' && worker.activityDetector) {
        worker.activityDetector.dispose();
      }

      // Snapshot callbacks before iteration to avoid concurrent modification issues
      const callbacksSnapshot = Array.from(worker.connectionCallbacks.values());
      for (const callbacks of callbacksSnapshot) {
        callbacks.onExit(exitCode, signalStr);
      }
    });
  }

  /**
   * Attach callbacks for a WebSocket connection to a worker.
   * Supports multiple concurrent connections (e.g., multiple browser tabs).
   * @returns Connection ID for later detachment, or null if worker not found
   */
  attachWorkerCallbacks(sessionId: string, workerId: string, callbacks: WorkerCallbacks): string | null {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return null;

    const connectionId = crypto.randomUUID();
    worker.connectionCallbacks.set(connectionId, {
      onData: callbacks.onData,
      onExit: callbacks.onExit,
      onActivityChange: callbacks.onActivityChange,
    });

    return connectionId;
  }

  /**
   * Detach callbacks for a specific WebSocket connection.
   * @param connectionId The connection ID returned by attachWorkerCallbacks
   */
  detachWorkerCallbacks(sessionId: string, workerId: string, connectionId: string): boolean {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return false;

    return worker.connectionCallbacks.delete(connectionId);
  }

  writeWorkerInput(sessionId: string, workerId: string, data: string): boolean {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return false;

    // Worker must have an active PTY to receive input
    if (!worker.pty) {
      logger.warn({ sessionId, workerId }, 'Cannot write input: worker PTY is not active');
      return false;
    }

    // Handle activity detection for agent workers
    if (worker.type === 'agent' && worker.activityDetector) {
      if (data.includes('\r')) {
        worker.activityDetector.clearUserTyping(false);
      } else if (data === '\x1b') {
        worker.activityDetector.clearUserTyping(true);
      } else if (data === '\x1b[I' || data === '\x1b[O') {
        // Ignore focus events
      } else {
        worker.activityDetector.setUserTyping();
      }
    }

    worker.pty.write(data);
    return true;
  }

  resizeWorker(sessionId: string, workerId: string, cols: number, rows: number): boolean {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return false;

    // Worker must have an active PTY to be resized
    if (!worker.pty) {
      logger.warn({ sessionId, workerId }, 'Cannot resize: worker PTY is not active');
      return false;
    }

    worker.pty.resize(cols, rows);
    return true;
  }

  getWorkerOutputBuffer(sessionId: string, workerId: string): string {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return '';
    return worker.outputBuffer;
  }

  getWorkerActivityState(sessionId: string, workerId: string): AgentActivityState | undefined {
    const worker = this.getWorker(sessionId, workerId);
    if (worker?.type === 'agent') {
      return worker.activityState;
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

    // Kill existing worker if PTY is active
    if (existingWorker.pty) {
      existingWorker.pty.kill();
    }
    if (existingWorker.activityDetector) {
      existingWorker.activityDetector.dispose();
    }

    // Reset the output file to prevent offset mismatch with client cache.
    // When worker restarts, the PTY produces new output from offset 0,
    // but the client cache may have a stale offset from the old session.
    // Resetting the file ensures both server and client start fresh.
    await workerOutputFileManager.resetWorkerOutput(sessionId, workerId);

    // Create new worker with same ID, preserving original createdAt for tab order
    // Initialize without PTY, then activate PTY
    const newWorker = await this.initializeAgentWorker({
      id: workerId,
      name: existingWorker.name,
      createdAt: existingWorker.createdAt,
      agentId: existingWorker.agentId,
    });
    await this.activateAgentWorkerPty(newWorker, {
      sessionId,
      locationPath: session.locationPath,
      agentId: existingWorker.agentId,
      continueConversation,
    });

    session.workers.set(workerId, newWorker);
    await this.persistSession(session);

    logger.info({ workerId, sessionId, continueConversation }, 'Agent worker restarted');

    return this.toPublicWorker(newWorker);
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
      return { success: true, worker: existingWorker };
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
      if (existingWorker.type === 'agent') {
        // SECURITY: Verify agentId is still valid before activating
        const agentManager = await getAgentManager();
        const agent = agentManager.getAgent(existingWorker.agentId);
        const effectiveAgentId = agent ? existingWorker.agentId : CLAUDE_CODE_AGENT_ID;
        if (!agent) {
          logger.warn({ sessionId, workerId, originalAgentId: existingWorker.agentId, fallbackAgentId: effectiveAgentId }, 'Agent no longer valid, falling back to default');
        }

        await this.activateAgentWorkerPty(existingWorker, {
          sessionId,
          locationPath: session.locationPath,
          agentId: effectiveAgentId,
          continueConversation: true,
        });
      } else {
        this.activateTerminalWorkerPty(existingWorker, {
          sessionId,
          locationPath: session.locationPath,
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

    return { success: true, worker: existingWorker };
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

  private async persistSession(session: InternalSession): Promise<void> {
    const persisted = this.toPersistedSession(session);
    await this.sessionRepository.save(persisted);
  }

  private toPersistedSession(session: InternalSession): PersistedSession {
    // session.workers is the source of truth (all workers loaded on init)
    const workers: PersistedWorker[] = Array.from(session.workers.values()).map(w => {
      if (w.type === 'agent') {
        return {
          id: w.id,
          type: 'agent',
          name: w.name,
          agentId: w.agentId,
          pid: w.pty?.pid ?? null,
          createdAt: w.createdAt,
        } as PersistedAgentWorker;
      } else if (w.type === 'terminal') {
        return {
          id: w.id,
          type: 'terminal',
          name: w.name,
          pid: w.pty?.pid ?? null,
          createdAt: w.createdAt,
        } as PersistedTerminalWorker;
      } else {
        return {
          id: w.id,
          type: 'git-diff',
          name: w.name,
          baseCommit: w.baseCommit,
          createdAt: w.createdAt,
        } as PersistedGitDiffWorker;
      }
    });

    if (session.type === 'worktree') {
      return {
        id: session.id,
        type: 'worktree',
        locationPath: session.locationPath,
        repositoryId: session.repositoryId,
        worktreeId: session.worktreeId,
        serverPid: getServerPid(),
        createdAt: session.createdAt,
        workers,
        initialPrompt: session.initialPrompt,
        title: session.title,
      };
    } else {
      return {
        id: session.id,
        type: 'quick',
        locationPath: session.locationPath,
        serverPid: getServerPid(),
        createdAt: session.createdAt,
        workers,
        initialPrompt: session.initialPrompt,
        title: session.title,
      };
    }
  }

  private toPublicSession(session: InternalSession): Session {
    // session.workers is the source of truth (all workers loaded on init)
    const workers = Array.from(session.workers.values())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(w => this.toPublicWorker(w));

    if (session.type === 'worktree') {
      return {
        id: session.id,
        type: 'worktree',
        locationPath: session.locationPath,
        repositoryId: session.repositoryId,
        worktreeId: session.worktreeId,
        status: session.status,
        createdAt: session.createdAt,
        workers,
        initialPrompt: session.initialPrompt,
        title: session.title,
      } as WorktreeSession;
    } else {
      return {
        id: session.id,
        type: 'quick',
        locationPath: session.locationPath,
        status: session.status,
        createdAt: session.createdAt,
        workers,
        initialPrompt: session.initialPrompt,
        title: session.title,
      } as QuickSession;
    }
  }

  private toPublicWorker(worker: InternalWorker): Worker {
    if (worker.type === 'agent') {
      return {
        id: worker.id,
        type: 'agent',
        name: worker.name,
        agentId: worker.agentId,
        createdAt: worker.createdAt,
      } as AgentWorker;
    } else if (worker.type === 'terminal') {
      return {
        id: worker.id,
        type: 'terminal',
        name: worker.name,
        createdAt: worker.createdAt,
      } as TerminalWorker;
    } else {
      return {
        id: worker.id,
        type: 'git-diff',
        name: worker.name,
        baseCommit: worker.baseCommit,
        createdAt: worker.createdAt,
      } as GitDiffWorker;
    }
  }

  /**
   * Restore workers from persisted data into InternalWorker format.
   * PTY workers are created with pty: null (will be activated on WebSocket connection).
   * Git-diff workers are fully restored (no PTY needed).
   */
  private restoreWorkersFromPersistence(persistedWorkers: PersistedWorker[]): Map<string, InternalWorker> {
    const workers = new Map<string, InternalWorker>();

    for (const pw of persistedWorkers) {
      if (pw.type === 'agent') {
        const worker: InternalAgentWorker = {
          id: pw.id,
          type: 'agent',
          name: pw.name,
          agentId: pw.agentId,
          createdAt: pw.createdAt,
          pty: null,  // Will be activated on WebSocket connection
          outputBuffer: '',
          outputOffset: 0,  // Will be synced from file when PTY is activated
          connectionCallbacks: new Map(),
          activityState: 'unknown',
          activityDetector: null,  // Will be created when PTY is activated
        };
        workers.set(pw.id, worker);
      } else if (pw.type === 'terminal') {
        const worker: InternalTerminalWorker = {
          id: pw.id,
          type: 'terminal',
          name: pw.name,
          createdAt: pw.createdAt,
          pty: null,  // Will be activated on WebSocket connection
          outputBuffer: '',
          outputOffset: 0,  // Will be synced from file when PTY is activated
          connectionCallbacks: new Map(),
        };
        workers.set(pw.id, worker);
      } else if (pw.type === 'git-diff') {
        // git-diff worker - fully restored (no PTY)
        const worker: InternalGitDiffWorker = {
          id: pw.id,
          type: 'git-diff',
          name: pw.name,
          createdAt: pw.createdAt,
          baseCommit: pw.baseCommit,
        };
        workers.set(pw.id, worker);
      } else {
        // Exhaustive check: throw on unexpected worker type (data corruption or schema change)
        const unknownType: never = pw;
        throw new Error(`Unknown worker type in persistence: ${(unknownType as PersistedWorker).type}`);
      }
    }

    return workers;
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
