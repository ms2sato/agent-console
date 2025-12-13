import { v4 as uuidv4 } from 'uuid';
import type {
  Session,
  WorktreeSession,
  QuickSession,
  Worker,
  AgentWorker,
  TerminalWorker,
  AgentActivityState,
  CreateSessionRequest,
  CreateWorkerRequest,
} from '@agent-console/shared';
import {
  persistenceService,
  type PersistedSession,
  type PersistedWorker,
  type PersistedAgentWorker,
  type PersistedTerminalWorker,
} from './persistence-service.js';
import { ActivityDetector } from './activity-detector.js';
import { agentManager, CLAUDE_CODE_AGENT_ID } from './agent-manager.js';
import { getChildProcessEnv } from './env-filter.js';
import { getServerPid } from '../lib/config.js';
import { bunPtyProvider, type PtyProvider, type PtyInstance } from '../lib/pty-provider.js';
import { processKill, isProcessAlive } from '../lib/process-utils.js';
import {
  getCurrentBranch as gitGetCurrentBranch,
  renameBranch as gitRenameBranch,
} from '../lib/git.js';

interface InternalWorkerBase {
  id: string;
  name: string;
  createdAt: string;
  pty: PtyInstance;
  outputBuffer: string;
  onData: (data: string) => void;
  onExit: (exitCode: number, signal: string | null) => void;
}

interface InternalAgentWorker extends InternalWorkerBase {
  type: 'agent';
  agentId: string;
  activityState: AgentActivityState;
  activityDetector: ActivityDetector;
  onActivityChange?: (state: AgentActivityState) => void;
}

interface InternalTerminalWorker extends InternalWorkerBase {
  type: 'terminal';
}

type InternalWorker = InternalAgentWorker | InternalTerminalWorker;

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

const MAX_BUFFER_SIZE = 100000; // 100KB

interface WorkerCallbacks {
  onData: (data: string) => void;
  onExit: (exitCode: number, signal: string | null) => void;
  onActivityChange?: (state: AgentActivityState) => void;
}

export class SessionManager {
  private sessions: Map<string, InternalSession> = new Map();
  private globalActivityCallback?: (sessionId: string, workerId: string, state: AgentActivityState) => void;
  private ptyProvider: PtyProvider;

  constructor(ptyProvider: PtyProvider = bunPtyProvider) {
    this.ptyProvider = ptyProvider;
    this.cleanupOrphanProcesses();
    this.initializeSessions();
  }

  /**
   * Load persisted sessions into memory (without starting processes)
   * These sessions will have workers=[] until a new worker is created or session is restarted
   */
  private initializeSessions(): void {
    const persistedSessions = persistenceService.loadSessions();

    for (const session of persistedSessions) {
      // Skip if already in memory (shouldn't happen, but safety check)
      if (this.sessions.has(session.id)) continue;

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
    }

    console.log(`Initialized ${this.sessions.size} sessions from persistence`);
  }

  /**
   * Set a global callback for all activity state changes (for dashboard broadcast)
   */
  setGlobalActivityCallback(callback: (sessionId: string, workerId: string, state: AgentActivityState) => void): void {
    this.globalActivityCallback = callback;
  }

  /**
   * Kill orphan processes from previous server run
   */
  private cleanupOrphanProcesses(): void {
    const persistedSessions = persistenceService.loadSessions();
    const currentServerPid = getServerPid();
    let killedCount = 0;
    let preservedCount = 0;

    for (const session of persistedSessions) {
      if (!session.serverPid) {
        console.warn(`[WARN] Session ${session.id} has no serverPid (legacy session), skipping cleanup`);
        preservedCount++;
        continue;
      }

      if (isProcessAlive(session.serverPid)) {
        preservedCount++;
        continue;
      }

      // Kill all workers in this session
      for (const worker of session.workers) {
        if (isProcessAlive(worker.pid)) {
          processKill(worker.pid, 'SIGTERM');
          console.log(`Killed orphan worker process: PID ${worker.pid} (worker ${worker.id}, session ${session.id})`);
          killedCount++;
        }
      }
    }

    console.log(`Orphan process cleanup: killed ${killedCount} workers, preserved ${preservedCount} sessions (server PID: ${currentServerPid})`);
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

    // Optionally create initial agent worker
    if (request.agentId) {
      this.createWorker(id, {
        type: 'agent',
        agentId: request.agentId,
        name: 'Claude',
      }, request.continueConversation ?? false, request.initialPrompt);
    }

    this.persistSession(internalSession);

    console.log(`[${new Date().toISOString()}] Session created: ${id}`);

    return this.toPublicSession(internalSession);
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
      worker.pty.kill();
      if (worker.type === 'agent') {
        worker.activityDetector.dispose();
      }
    }

    this.sessions.delete(id);
    persistenceService.removeSession(id);
    console.log(`Session deleted: ${id}`);
    return true;
  }

  getAllSessions(): Session[] {
    return Array.from(this.sessions.values()).map((s) => this.toPublicSession(s));
  }

  createWorker(
    sessionId: string,
    request: CreateWorkerRequest,
    continueConversation: boolean = false,
    initialPrompt?: string
  ): Worker | null {
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
    } else {
      worker = this.initializeTerminalWorker({
        id: workerId,
        name: workerName,
        createdAt,
        locationPath: session.locationPath,
      });
    }

    session.workers.set(workerId, worker);
    this.persistSession(session);

    console.log(`[${new Date().toISOString()}] Worker created: ${workerId} (type: ${request.type}, session: ${sessionId})`);

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

    worker.pty.kill();
    if (worker.type === 'agent') {
      worker.activityDetector.dispose();
    }

    session.workers.delete(workerId);
    this.persistSession(session);

    console.log(`Worker deleted: ${workerId} (session: ${sessionId})`);
    return true;
  }

  private generateWorkerName(session: InternalSession, type: 'agent' | 'terminal'): string {
    if (type === 'agent') {
      return 'Claude';
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

    const args: string[] = [];
    if (continueConversation && agent.continueArgs) {
      args.push(...agent.continueArgs);
    }

    // If initialPromptMode is 'arg', add the prompt as a command argument
    if (initialPrompt && agent.initialPromptMode === 'arg') {
      // Escape the prompt for shell and add as argument
      const escapedPrompt = initialPrompt.replace(/'/g, "'\\''");
      args.push(`'${escapedPrompt}'`);
    }

    const shell = process.env.SHELL || '/bin/bash';
    const fullCommand = [agent.command, ...args].join(' ');
    const ptyProcess = this.ptyProvider.spawn(shell, ['-l', '-c', fullCommand], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: locationPath,
      env: getChildProcessEnv(),
    });

    const worker: InternalAgentWorker = {
      id,
      type: 'agent',
      name,
      createdAt,
      agentId: agent.id,
      pty: ptyProcess,
      outputBuffer: '',
      activityState: 'unknown',
      activityDetector: null as unknown as ActivityDetector, // Set below
      onData: () => {},
      onExit: () => {},
    };

    worker.activityDetector = new ActivityDetector({
      onStateChange: (state) => {
        worker.activityState = state;
        worker.onActivityChange?.(state);
        this.globalActivityCallback?.(sessionId, id, state);
      },
      activityPatterns: agent.activityPatterns,
    });

    this.setupWorkerEventHandlers(worker, sessionId);

    // Send initial prompt via stdin if mode is 'stdin' (arg mode is handled in command construction above)
    if (initialPrompt && agent.initialPromptMode === 'stdin') {
      const delay = agent.initialPromptDelayMs ?? 1000;
      setTimeout(() => {
        worker.pty.write(initialPrompt + '\r');
        console.log(`[${new Date().toISOString()}] Initial prompt sent to worker ${worker.id}`);
      }, delay);
    }

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

  private setupWorkerEventHandlers(worker: InternalWorker, _sessionId: string | null): void {
    worker.pty.onData((data) => {
      worker.outputBuffer += data;
      if (worker.outputBuffer.length > MAX_BUFFER_SIZE) {
        worker.outputBuffer = worker.outputBuffer.slice(-MAX_BUFFER_SIZE);
      }

      if (worker.type === 'agent') {
        worker.activityDetector.processOutput(data);
      }

      worker.onData(data);
    });

    worker.pty.onExit(({ exitCode, signal }) => {
      const signalStr = signal !== undefined ? String(signal) : null;
      console.log(`[${new Date().toISOString()}] Worker exited: ${worker.id} (PID: ${worker.pty.pid}, exitCode: ${exitCode}, signal: ${signalStr})`);

      if (worker.type === 'agent') {
        worker.activityDetector.dispose();
      }

      worker.onExit(exitCode, signalStr);
    });
  }

  attachWorkerCallbacks(sessionId: string, workerId: string, callbacks: WorkerCallbacks): boolean {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker) return false;

    worker.onData = callbacks.onData;
    worker.onExit = callbacks.onExit;

    if (worker.type === 'agent' && callbacks.onActivityChange) {
      worker.onActivityChange = callbacks.onActivityChange;
    }

    return true;
  }

  detachWorkerCallbacks(sessionId: string, workerId: string): boolean {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker) return false;

    worker.onData = () => {};
    worker.onExit = () => {};

    if (worker.type === 'agent') {
      worker.onActivityChange = undefined;
    }

    return true;
  }

  writeWorkerInput(sessionId: string, workerId: string, data: string): boolean {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker) return false;

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
    if (!worker) return false;

    worker.pty.resize(cols, rows);
    return true;
  }

  getWorkerOutputBuffer(sessionId: string, workerId: string): string {
    const worker = this.getWorker(sessionId, workerId);
    return worker?.outputBuffer ?? '';
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

    console.log(`[${new Date().toISOString()}] Agent worker restarted: ${workerId} (session: ${sessionId})${continueConversation ? ' [continuing]' : ''}`);

    return this.toPublicWorker(newWorker);
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
          console.log(`[${new Date().toISOString()}] Agent worker auto-restarted after branch rename: ${agentWorker.id}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: message };
      }
    }

    this.persistSession(session);

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
      } else {
        return {
          id: w.id,
          type: 'terminal',
          name: w.name,
          pid: w.pty.pid,
          createdAt: w.createdAt,
        } as PersistedTerminalWorker;
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
    } else {
      return {
        id: worker.id,
        type: 'terminal',
        name: worker.name,
        createdAt: worker.createdAt,
      } as TerminalWorker;
    }
  }
}

// Singleton instance
export const sessionManager = new SessionManager();
