import { v4 as uuidv4 } from 'uuid';
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
} from '@agent-console/shared';
import {
  persistenceService,
  type PersistedSession,
  type PersistedWorker,
  type PersistedAgentWorker,
  type PersistedTerminalWorker,
  type PersistedGitDiffWorker,
} from './persistence-service.js';
import { ActivityDetector } from './activity-detector.js';
import { agentManager, CLAUDE_CODE_AGENT_ID } from './agent-manager.js';
import { getChildProcessEnv } from './env-filter.js';
import { getServerPid } from '../lib/config.js';
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

const logger = createLogger('session-manager');

// Base for all workers
interface InternalWorkerBase {
  id: string;
  name: string;
  createdAt: string;
}

// Callback set for a single WebSocket connection
interface ConnectionCallbacks {
  onData: (data: string) => void;
  onExit: (exitCode: number, signal: string | null) => void;
  onActivityChange?: (state: AgentActivityState) => void;
}

// Base for PTY-based workers (agent, terminal)
// Uses Map to support multiple concurrent WebSocket connections (e.g., multiple browser tabs)
// After server restart, pty may be null until the worker is activated via WebSocket connection
interface InternalPtyWorkerBase extends InternalWorkerBase {
  pty: PtyInstance | null;  // null = not yet activated after server restart
  outputBuffer: string;
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
  onData: (data: string) => void;
  onExit: (exitCode: number, signal: string | null) => void;
  onActivityChange?: (state: AgentActivityState) => void;
}

export interface SessionLifecycleCallbacks {
  onSessionCreated?: (session: Session) => void;
  onSessionUpdated?: (session: Session) => void;
  onSessionDeleted?: (sessionId: string) => void;
}

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

  constructor(
    ptyProvider: PtyProvider = bunPtyProvider,
    pathExists: (path: string) => Promise<boolean> = defaultPathExists
  ) {
    this.ptyProvider = ptyProvider;
    this.pathExists = pathExists;
    // First load sessions into memory, then cleanup orphans from OTHER dead servers
    // Order matters: initializeSessions must run before cleanupOrphanProcesses
    // to avoid deleting sessions that should be inherited by this server
    this.initializeSessions();
    this.cleanupOrphanProcesses();
  }

  /**
   * Load persisted sessions into memory (without starting processes).
   * Only inherits sessions whose serverPid is dead (or missing).
   * Sessions owned by other live servers are left untouched.
   * Also kills orphan worker processes from inherited sessions.
   */
  private initializeSessions(): void {
    const persistedSessions = persistenceService.loadSessions();
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
      persistenceService.saveSessions(sessionsToSave);
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
  private cleanupOrphanProcesses(): void {
    const persistedSessions = persistenceService.loadSessions();
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
      for (const sessionId of orphanSessionIds) {
        persistenceService.removeSession(sessionId);
        // Also delete output files for orphan session (fire-and-forget)
        void workerOutputFileManager.deleteSessionOutputs(sessionId).catch((err) => {
          logger.error({ sessionId, err }, 'Failed to delete orphan session output files');
        });
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
    const id = uuidv4();
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
        name: 'Claude',
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

  getSessionMetadata(id: string): PersistedSession | undefined {
    return persistenceService.getSessionMetadata(id);
  }

  deleteSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    // Kill all workers
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

    // Delete all output files for this session (fire-and-forget)
    void workerOutputFileManager.deleteSessionOutputs(id).catch((err) => {
      logger.error({ sessionId: id, err }, 'Failed to delete session output files');
    });

    this.sessions.delete(id);
    persistenceService.removeSession(id);
    logger.info({ sessionId: id }, 'Session deleted');

    this.sessionLifecycleCallbacks?.onSessionDeleted?.(id);

    return true;
  }

  getAllSessions(): Session[] {
    return Array.from(this.sessions.values()).map((s) => this.toPublicSession(s));
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

  async createWorker(
    sessionId: string,
    request: CreateWorkerParams,
    continueConversation: boolean = false,
    initialPrompt?: string
  ): Promise<Worker | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const workerId = uuidv4();
    const createdAt = new Date().toISOString();
    const workerName = request.name ?? this.generateWorkerName(session, request.type);

    let worker: InternalWorker;

    if (request.type === 'agent') {
      worker = this.initializeAgentWorker({
        id: workerId,
        name: workerName,
        createdAt,
        sessionId,
        locationPath: session.locationPath,
        agentId: request.agentId,
        continueConversation,
        initialPrompt,
      });
    } else if (request.type === 'terminal') {
      worker = this.initializeTerminalWorker({
        id: workerId,
        name: workerName,
        createdAt,
        locationPath: session.locationPath,
      });
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
    this.persistSession(session);

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
      const agent = agentManager.getAgent(worker.agentId);
      if (!agent) {
        logger.warn({ sessionId, workerId, agentId: worker.agentId }, 'Agent no longer valid, falling back to default');
      }

      this.activateAgentWorkerPty(worker, {
        sessionId,
        locationPath: session.locationPath,
        agentId: agent ? worker.agentId : CLAUDE_CODE_AGENT_ID,
        continueConversation: true,
      });
    } else {
      // terminal worker
      this.activateTerminalWorkerPty(worker, {
        locationPath: session.locationPath,
      });
    }

    this.persistSession(session);
    logger.info({ workerId, sessionId, workerType: worker.type }, 'Worker PTY activated');

    return worker;
  }

  deleteWorker(sessionId: string, workerId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const worker = session.workers.get(workerId);
    if (!worker) return false;

    // Clean up based on worker type
    if (worker.type === 'agent') {
      if (worker.pty) worker.pty.kill();
      if (worker.activityDetector) worker.activityDetector.dispose();
      // Delete output file (fire-and-forget)
      void workerOutputFileManager.deleteWorkerOutput(sessionId, workerId).catch((err) => {
        logger.error({ sessionId, workerId, err }, 'Failed to delete worker output file');
      });
    } else if (worker.type === 'terminal') {
      if (worker.pty) worker.pty.kill();
      // Delete output file (fire-and-forget)
      void workerOutputFileManager.deleteWorkerOutput(sessionId, workerId).catch((err) => {
        logger.error({ sessionId, workerId, err }, 'Failed to delete worker output file');
      });
    } else {
      // git-diff worker: stop file watcher (fire-and-forget)
      void stopWatching(session.locationPath);
    }

    session.workers.delete(workerId);
    this.persistSession(session);

    logger.info({ workerId, sessionId }, 'Worker deleted');
    return true;
  }

  private generateWorkerName(session: InternalSession, type: 'agent' | 'terminal' | 'git-diff'): string {
    if (type === 'agent') {
      return 'Claude';
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

  private initializeAgentWorker(params: {
    id: string;
    name: string;
    createdAt: string;
    sessionId: string;
    locationPath: string;
    agentId: string;
    continueConversation: boolean;
    initialPrompt?: string;
  }): InternalAgentWorker {
    const { id, name, createdAt, sessionId, locationPath, agentId, continueConversation, initialPrompt } = params;

    const resolvedAgentId = agentId ?? CLAUDE_CODE_AGENT_ID;
    const agent = agentManager.getAgent(resolvedAgentId) ?? agentManager.getDefaultAgent();

    // Select the appropriate template based on whether we're continuing a conversation
    const template = continueConversation && agent.continueTemplate
      ? agent.continueTemplate
      : agent.commandTemplate;

    // Expand the template with prompt and cwd
    // For continue mode without initial prompt, we don't need to pass prompt
    const { command, env: templateEnv } = expandTemplate({
      template,
      prompt: initialPrompt,
      cwd: locationPath,
    });

    // Merge template environment variables with child process environment
    const processEnv = {
      ...getChildProcessEnv(),
      ...templateEnv,
    };

    // Spawn via shell to execute the expanded template command
    // The prompt is safely passed via environment variable to prevent injection
    const ptyProcess = this.ptyProvider.spawn('sh', ['-c', command], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: locationPath,
      env: processEnv,
    });

    // Declare worker first - the callback closure captures the variable reference,
    // not the value, so worker will be defined when the callback executes
    let worker!: InternalAgentWorker;

    // Create ActivityDetector first (callback executes later, when worker is assigned)
    const activityDetector = new ActivityDetector({
      onStateChange: (state) => {
        worker.activityState = state;
        // Snapshot callbacks before iteration to avoid concurrent modification issues
        const callbacksSnapshot = Array.from(worker.connectionCallbacks.values());
        for (const callbacks of callbacksSnapshot) {
          callbacks.onActivityChange?.(state);
        }
        this.globalActivityCallback?.(sessionId, id, state);
      },
      activityPatterns: agent.activityPatterns,
    });

    // Now create the complete worker object with activityDetector
    worker = {
      id,
      type: 'agent',
      name,
      createdAt,
      agentId: agent.id,
      pty: ptyProcess,
      outputBuffer: '',
      activityState: 'unknown',
      activityDetector,
      connectionCallbacks: new Map(),
    };

    this.setupWorkerEventHandlers(worker, sessionId);

    return worker;
  }

  private initializeTerminalWorker(params: {
    id: string;
    name: string;
    createdAt: string;
    locationPath: string;
  }): InternalTerminalWorker {
    const { id, name, createdAt, locationPath } = params;

    const shell = process.env.SHELL || '/bin/bash';
    const ptyProcess = this.ptyProvider.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: locationPath,
      env: getChildProcessEnv(),
    });

    const worker: InternalTerminalWorker = {
      id,
      type: 'terminal',
      name,
      createdAt,
      pty: ptyProcess,
      outputBuffer: '',
      connectionCallbacks: new Map(),
    };

    this.setupWorkerEventHandlers(worker, null);

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
  private activateAgentWorkerPty(
    worker: InternalAgentWorker,
    params: {
      sessionId: string;
      locationPath: string;
      agentId: string;
      continueConversation: boolean;
      initialPrompt?: string;
    }
  ): void {
    // Idempotent: If PTY already active, skip (prevents resource leaks from concurrent activations)
    if (worker.pty !== null) {
      logger.debug({ workerId: worker.id, existingPid: worker.pty.pid }, 'Agent worker PTY already active, skipping activation');
      return;
    }

    const { sessionId, locationPath, agentId, continueConversation, initialPrompt } = params;

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

    const ptyProcess = this.ptyProvider.spawn('sh', ['-c', command], {
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
    params: { locationPath: string }
  ): void {
    // Idempotent: If PTY already active, skip (prevents resource leaks from concurrent activations)
    if (worker.pty !== null) {
      logger.debug({ workerId: worker.id, existingPid: worker.pty.pid }, 'Terminal worker PTY already active, skipping activation');
      return;
    }

    const { locationPath } = params;

    const shell = process.env.SHELL || '/bin/bash';
    const ptyProcess = this.ptyProvider.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: locationPath,
      env: getChildProcessEnv(),
    });

    // Mutate the existing worker to add PTY
    worker.pty = ptyProcess;

    this.setupWorkerEventHandlers(worker, null);
  }

  private setupWorkerEventHandlers(worker: InternalPtyWorker, sessionId: string | null): void {
    if (!worker.pty) {
      throw new Error('Cannot setup event handlers: worker.pty is null');
    }
    worker.pty.onData((data) => {
      worker.outputBuffer += data;
      const maxBufferSize = serverConfig.WORKER_OUTPUT_BUFFER_SIZE;
      if (worker.outputBuffer.length > maxBufferSize) {
        worker.outputBuffer = worker.outputBuffer.slice(-maxBufferSize);
      }

      // Buffer output to file for persistence (if sessionId is available)
      if (sessionId) {
        workerOutputFileManager.bufferOutput(sessionId, worker.id, data);
      }

      if (worker.type === 'agent' && worker.activityDetector) {
        worker.activityDetector.processOutput(data);
      }

      // Snapshot callbacks before iteration to avoid concurrent modification issues
      const callbacksSnapshot = Array.from(worker.connectionCallbacks.values());
      for (const callbacks of callbacksSnapshot) {
        callbacks.onData(data);
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
   * @returns History data and current offset, or null if not available
   */
  async getWorkerOutputHistory(
    sessionId: string,
    workerId: string,
    fromOffset?: number
  ): Promise<HistoryReadResult | null> {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return null;

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

  restartAgentWorker(
    sessionId: string,
    workerId: string,
    continueConversation: boolean
  ): Worker | null {
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

    // Create new worker with same ID, preserving original createdAt for tab order
    const newWorker = this.initializeAgentWorker({
      id: workerId,
      name: existingWorker.name,
      createdAt: existingWorker.createdAt,
      sessionId,
      locationPath: session.locationPath,
      agentId: existingWorker.agentId,
      continueConversation,
    });

    session.workers.set(workerId, newWorker);
    this.persistSession(session);

    logger.info({ workerId, sessionId, continueConversation }, 'Agent worker restarted');

    return this.toPublicWorker(newWorker);
  }

  /**
   * Restore a PTY worker and ensure its PTY is active.
   * Called when WebSocket connection is established to ensure the worker is ready for I/O.
   *
   * - If worker exists with active PTY, return it as-is
   * - If worker exists without PTY (loaded from persistence), activate its PTY
   * - Returns null for git-diff workers (they don't need PTY restoration)
   * - Returns null if worker cannot be restored (session not found, etc.)
   */
  async restoreWorker(sessionId: string, workerId: string): Promise<InternalWorker | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const existingWorker = session.workers.get(workerId);
    if (!existingWorker) return null;

    // Git-diff workers don't need PTY restoration
    if (existingWorker.type === 'git-diff') return null;

    // If PTY is already active, return as-is (normal browser reload case)
    if (existingWorker.pty) return existingWorker;

    // SECURITY: Verify session's locationPath still exists before activating PTY
    const pathExistsResult = await this.pathExists(session.locationPath);
    if (!pathExistsResult) {
      logger.warn({ sessionId, workerId, locationPath: session.locationPath }, 'Cannot restore worker: session path no longer exists');
      return null;
    }

    // Activate PTY for the worker
    if (existingWorker.type === 'agent') {
      // SECURITY: Verify agentId is still valid before activating
      const agent = agentManager.getAgent(existingWorker.agentId);
      const effectiveAgentId = agent ? existingWorker.agentId : CLAUDE_CODE_AGENT_ID;
      if (!agent) {
        logger.warn({ sessionId, workerId, originalAgentId: existingWorker.agentId, fallbackAgentId: effectiveAgentId }, 'Agent no longer valid, falling back to default');
      }

      this.activateAgentWorkerPty(existingWorker, {
        sessionId,
        locationPath: session.locationPath,
        agentId: effectiveAgentId,
        continueConversation: true,
      });
    } else {
      this.activateTerminalWorkerPty(existingWorker, {
        locationPath: session.locationPath,
      });
    }

    this.persistSession(session);

    logger.info({ workerId, sessionId, workerType: existingWorker.type }, 'Worker PTY activated');

    return existingWorker;
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
      const metadata = persistenceService.getSessionMetadata(sessionId);
      if (!metadata) {
        return { success: false, error: 'session_not_found' };
      }

      // For inactive sessions, only branch rename is supported (no restart possible)
      // Title update for inactive sessions is not supported yet
      if (updates.branch) {
        if (metadata.type !== 'worktree') {
          return { success: false, error: 'Can only rename branch for worktree sessions' };
        }

        const currentBranch = await gitGetCurrentBranch(metadata.locationPath);

        try {
          await gitRenameBranch(currentBranch, updates.branch, metadata.locationPath);
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
          this.restartAgentWorker(sessionId, agentWorker.id, true);
          logger.info({ workerId: agentWorker.id, sessionId }, 'Agent worker auto-restarted after branch rename');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: message };
      }
    }

    this.persistSession(session);

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

  private persistSession(session: InternalSession): void {
    const sessions = persistenceService.loadSessions();
    const existingIdx = sessions.findIndex(s => s.id === session.id);

    const persisted = this.toPersistedSession(session);

    if (existingIdx >= 0) {
      sessions[existingIdx] = persisted;
    } else {
      sessions.push(persisted);
    }

    persistenceService.saveSessions(sessions);
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
export const sessionManager = new SessionManager();
