import { v4 as uuidv4 } from 'uuid';
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

const logger = createLogger('session-manager');

// Base for all workers
interface InternalWorkerBase {
  id: string;
  name: string;
  createdAt: string;
}

// Base for PTY-based workers (agent, terminal)
interface InternalPtyWorkerBase extends InternalWorkerBase {
  pty: PtyInstance;
  outputBuffer: string;
  onData: (data: string) => void;
  onExit: (exitCode: number, signal: string | null) => void;
}

interface InternalAgentWorker extends InternalPtyWorkerBase {
  type: 'agent';
  agentId: string;
  activityState: AgentActivityState;
  activityDetector: ActivityDetector;
  onActivityChange?: (state: AgentActivityState) => void;
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

export class SessionManager {
  private sessions: Map<string, InternalSession> = new Map();
  private globalActivityCallback?: (sessionId: string, workerId: string, state: AgentActivityState) => void;
  private sessionLifecycleCallbacks?: SessionLifecycleCallbacks;
  private ptyProvider: PtyProvider;

  constructor(ptyProvider: PtyProvider = bunPtyProvider) {
    this.ptyProvider = ptyProvider;
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
        if (worker.type !== 'git-diff' && isProcessAlive(worker.pid)) {
          processKill(worker.pid, 'SIGTERM');
          logger.info({ pid: worker.pid, workerId: worker.id, sessionId: session.id }, 'Killed orphan worker process');
          killedWorkerCount++;
        }
      }

      // Create internal session without workers (they were killed or died)
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
          workers: new Map(),
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
          workers: new Map(),
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
        if (worker.type === 'git-diff') continue; // Git diff workers have no process
        if (isProcessAlive(worker.pid)) {
          processKill(worker.pid, 'SIGTERM');
          logger.info({ pid: worker.pid, workerId: worker.id, sessionId: session.id }, 'Killed orphan worker process');
          killedCount++;
        }
      }
    }

    // Remove orphan sessions from persistence
    if (orphanSessionIds.length > 0) {
      for (const sessionId of orphanSessionIds) {
        persistenceService.removeSession(sessionId);
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

  createSession(request: CreateSessionRequest): Session {
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

    // Create initial agent worker (use default agent if not specified)
    const effectiveAgentId = request.agentId ?? CLAUDE_CODE_AGENT_ID;
    this.createWorker(id, {
      type: 'agent',
      agentId: effectiveAgentId,
      name: 'Claude',
    }, request.continueConversation ?? false, request.initialPrompt);

    // Also create git-diff worker
    this.createWorker(id, {
      type: 'git-diff',
      name: 'Diff',
    });

    this.persistSession(internalSession);

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
        // Kill PTY for agent/terminal workers
        worker.pty.kill();
        if (worker.type === 'agent') {
          worker.activityDetector.dispose();
        }
      }
    }

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

  deleteWorker(sessionId: string, workerId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const worker = session.workers.get(workerId);
    if (!worker) return false;

    // Clean up based on worker type
    if (worker.type === 'agent') {
      worker.pty.kill();
      worker.activityDetector.dispose();
    } else if (worker.type === 'terminal') {
      worker.pty.kill();
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
        worker.onActivityChange?.(state);
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
      onData: () => {},
      onExit: () => {},
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
      onData: () => {},
      onExit: () => {},
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

  private setupWorkerEventHandlers(worker: InternalPtyWorker, _sessionId: string | null): void {
    worker.pty.onData((data) => {
      worker.outputBuffer += data;
      const maxBufferSize = serverConfig.WORKER_OUTPUT_BUFFER_SIZE;
      if (worker.outputBuffer.length > maxBufferSize) {
        worker.outputBuffer = worker.outputBuffer.slice(-maxBufferSize);
      }

      if (worker.type === 'agent') {
        worker.activityDetector.processOutput(data);
      }

      worker.onData(data);
    });

    worker.pty.onExit(({ exitCode, signal }) => {
      const signalStr = signal !== undefined ? String(signal) : null;
      logger.info({ workerId: worker.id, pid: worker.pty.pid, exitCode, signal: signalStr }, 'Worker exited');

      if (worker.type === 'agent') {
        worker.activityDetector.dispose();
      }

      worker.onExit(exitCode, signalStr);
    });
  }

  attachWorkerCallbacks(sessionId: string, workerId: string, callbacks: WorkerCallbacks): boolean {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return false;

    worker.onData = callbacks.onData;
    worker.onExit = callbacks.onExit;

    if (worker.type === 'agent' && callbacks.onActivityChange) {
      worker.onActivityChange = callbacks.onActivityChange;
    }

    return true;
  }

  detachWorkerCallbacks(sessionId: string, workerId: string): boolean {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return false;

    worker.onData = () => {};
    worker.onExit = () => {};

    if (worker.type === 'agent') {
      worker.onActivityChange = undefined;
    }

    return true;
  }

  writeWorkerInput(sessionId: string, workerId: string, data: string): boolean {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return false;

    // Handle activity detection for agent workers
    if (worker.type === 'agent') {
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

  restartAgentWorker(
    sessionId: string,
    workerId: string,
    continueConversation: boolean
  ): Worker | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const existingWorker = session.workers.get(workerId);
    if (!existingWorker || existingWorker.type !== 'agent') return null;

    // Kill existing worker
    existingWorker.pty.kill();
    existingWorker.activityDetector.dispose();

    // Create new worker with same ID
    const newWorker = this.initializeAgentWorker({
      id: workerId,
      name: existingWorker.name,
      createdAt: new Date().toISOString(),
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
   * Restore a PTY worker from persisted metadata.
   * Called when WebSocket connection is established but the internal worker doesn't exist
   * (e.g., after server restart).
   *
   * Returns the existing internal worker if it exists, or creates a new one from persisted data.
   * Returns null if the worker cannot be restored (session not found, worker not in persistence, etc.)
   */
  restoreWorker(sessionId: string, workerId: string): InternalWorker | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // If internal worker already exists, return it (normal browser reload case)
    const existingWorker = session.workers.get(workerId);
    if (existingWorker) return existingWorker;

    // Get persisted worker metadata
    const metadata = persistenceService.getSessionMetadata(sessionId);
    const persistedWorker = metadata?.workers.find(w => w.id === workerId);
    if (!persistedWorker) return null;

    // Only restore PTY workers (agent/terminal)
    if (persistedWorker.type === 'git-diff') return null;

    let worker: InternalWorker;

    if (persistedWorker.type === 'agent') {
      worker = this.initializeAgentWorker({
        id: workerId,
        name: persistedWorker.name,
        createdAt: persistedWorker.createdAt,
        sessionId,
        locationPath: session.locationPath,
        agentId: persistedWorker.agentId,
        continueConversation: true, // Continue existing session
      });
    } else {
      worker = this.initializeTerminalWorker({
        id: workerId,
        name: persistedWorker.name,
        createdAt: persistedWorker.createdAt,
        locationPath: session.locationPath,
      });
    }

    session.workers.set(workerId, worker);
    this.persistSession(session);

    logger.info({ workerId, sessionId, workerType: persistedWorker.type }, 'Worker restored from persistence');

    return worker;
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
    const workers: PersistedWorker[] = Array.from(session.workers.values()).map(w => {
      if (w.type === 'agent') {
        return {
          id: w.id,
          type: 'agent',
          name: w.name,
          agentId: w.agentId,
          pid: w.pty.pid,
          createdAt: w.createdAt,
        } as PersistedAgentWorker;
      } else if (w.type === 'terminal') {
        return {
          id: w.id,
          type: 'terminal',
          name: w.name,
          pid: w.pty.pid,
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
    let workers = Array.from(session.workers.values())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(w => this.toPublicWorker(w));

    // If workers are empty (after server restart), restore from persisted data
    if (workers.length === 0) {
      const metadata = persistenceService.getSessionMetadata(session.id);
      if (metadata && metadata.workers.length > 0) {
        workers = metadata.workers.map(w => this.persistedWorkerToPublic(w));
      }
    }

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

  private persistedWorkerToPublic(worker: PersistedWorker): Worker {
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
}

// Singleton instance
export const sessionManager = new SessionManager();
