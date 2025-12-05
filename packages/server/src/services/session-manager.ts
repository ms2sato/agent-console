import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import type { Session, SessionStatus, ClaudeActivityState } from '@agents-web-console/shared';
import { persistenceService, type PersistedSession } from './persistence-service.js';
import { ActivityDetector } from './activity-detector.js';

interface InternalSession {
  id: string;
  pty: pty.IPty;
  outputBuffer: string;
  worktreePath: string;
  repositoryId: string;
  status: SessionStatus;
  activityState: ClaudeActivityState;
  startedAt: string;
  onData: (data: string) => void;
  onExit: (exitCode: number, signal: string | null) => void;
  onActivityChange?: (state: ClaudeActivityState) => void;
  activityDetector: ActivityDetector;
}

const MAX_BUFFER_SIZE = 100000; // 100KB

export class SessionManager {
  private sessions: Map<string, InternalSession> = new Map();
  private globalActivityCallback?: (sessionId: string, state: ClaudeActivityState) => void;

  constructor() {
    this.cleanupOrphanProcesses();
  }

  /**
   * Set a global callback for all activity state changes (for dashboard broadcast)
   */
  setGlobalActivityCallback(callback: (sessionId: string, state: ClaudeActivityState) => void): void {
    this.globalActivityCallback = callback;
  }

  /**
   * Kill orphan processes from previous server run
   * Note: We keep session metadata for reconnection UI
   */
  private cleanupOrphanProcesses(): void {
    const persistedSessions = persistenceService.loadSessions();

    for (const session of persistedSessions) {
      try {
        // Check if process exists and kill it
        process.kill(session.pid, 0); // 0 = check if process exists
        process.kill(session.pid, 'SIGTERM');
        console.log(`Killed orphan process: PID ${session.pid} (session ${session.id})`);
      } catch {
        // Process doesn't exist, that's fine
      }
    }

    // Keep session metadata for reconnection UI
    // Metadata will be cleared when user creates new session or explicitly dismisses
    console.log(`Orphan process cleanup completed (${persistedSessions.length} sessions preserved for reconnection)`);
  }

  private persistSession(session: InternalSession): void {
    const sessions = persistenceService.loadSessions();
    const persisted: PersistedSession = {
      id: session.id,
      worktreePath: session.worktreePath,
      repositoryId: session.repositoryId,
      pid: session.pty.pid,
      createdAt: session.startedAt,
    };
    sessions.push(persisted);
    persistenceService.saveSessions(sessions);
  }

  private unpersistSession(id: string): void {
    persistenceService.removeSession(id);
  }

  createSession(
    worktreePath: string,
    repositoryId: string,
    onData: (data: string) => void,
    onExit: (exitCode: number, signal: string | null) => void,
    continueConversation: boolean = false
  ): Session {
    const id = uuidv4();
    const startedAt = new Date().toISOString();

    // Use -c flag to continue previous conversation
    const args = continueConversation ? ['-c'] : [];

    const ptyProcess = pty.spawn('claude', args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: worktreePath,
      env: process.env as Record<string, string>,
    });

    // Create activity detector for this session
    const activityDetector = new ActivityDetector({
      onStateChange: (state) => {
        session.activityState = state;
        session.onActivityChange?.(state);
        // Broadcast to all dashboard clients
        this.globalActivityCallback?.(id, state);
      },
    });

    const session: InternalSession = {
      id,
      pty: ptyProcess,
      outputBuffer: '',
      worktreePath,
      repositoryId,
      status: 'running',
      activityState: 'idle',
      startedAt,
      onData,
      onExit,
      activityDetector,
    };

    ptyProcess.onData((data) => {
      // Buffer output for reconnection
      session.outputBuffer += data;
      if (session.outputBuffer.length > MAX_BUFFER_SIZE) {
        session.outputBuffer = session.outputBuffer.slice(-MAX_BUFFER_SIZE);
      }

      // Process output for activity detection
      session.activityDetector.processOutput(data);

      session.onData(data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      session.status = 'stopped';
      session.activityDetector.dispose();
      // signal can be a number (signal code) or undefined
      const signalStr = signal !== undefined ? String(signal) : null;
      session.onExit(exitCode, signalStr);
      // Remove from persistence when session ends
      this.unpersistSession(id);
    });

    this.sessions.set(id, session);
    this.persistSession(session);

    console.log(`Session created: ${id} (PID: ${ptyProcess.pid})${continueConversation ? ' [continuing]' : ''}`);

    return this.toPublicSession(session);
  }

  getSession(id: string): Session | undefined {
    const session = this.sessions.get(id);
    return session ? this.toPublicSession(session) : undefined;
  }

  /**
   * Get metadata for a session that may no longer be active
   * Used for reconnection UI
   */
  getSessionMetadata(id: string): PersistedSession | undefined {
    return persistenceService.getSessionMetadata(id);
  }

  /**
   * Restart a dead session with the same ID
   * Used when user clicks Continue or New Session in reconnection UI
   */
  restartSession(
    id: string,
    onData: (data: string) => void,
    onExit: (exitCode: number, signal: string | null) => void,
    continueConversation: boolean = false
  ): Session | null {
    // Check if session is already active
    if (this.sessions.has(id)) {
      console.log(`Session ${id} is already active, cannot restart`);
      return null;
    }

    // Get metadata from persistence
    const metadata = persistenceService.getSessionMetadata(id);
    if (!metadata) {
      console.log(`No metadata found for session ${id}`);
      return null;
    }

    const startedAt = new Date().toISOString();

    // Use -c flag to continue previous conversation
    const args = continueConversation ? ['-c'] : [];

    const ptyProcess = pty.spawn('claude', args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: metadata.worktreePath,
      env: process.env as Record<string, string>,
    });

    // Create activity detector for this session
    const activityDetector = new ActivityDetector({
      onStateChange: (state) => {
        session.activityState = state;
        session.onActivityChange?.(state);
        // Broadcast to all dashboard clients
        this.globalActivityCallback?.(id, state);
      },
    });

    const session: InternalSession = {
      id,
      pty: ptyProcess,
      outputBuffer: '',
      worktreePath: metadata.worktreePath,
      repositoryId: metadata.repositoryId,
      status: 'running',
      activityState: 'idle',
      startedAt,
      onData,
      onExit,
      activityDetector,
    };

    ptyProcess.onData((data) => {
      // Buffer output for reconnection
      session.outputBuffer += data;
      if (session.outputBuffer.length > MAX_BUFFER_SIZE) {
        session.outputBuffer = session.outputBuffer.slice(-MAX_BUFFER_SIZE);
      }

      // Process output for activity detection
      session.activityDetector.processOutput(data);

      session.onData(data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      session.status = 'stopped';
      session.activityDetector.dispose();
      const signalStr = signal !== undefined ? String(signal) : null;
      session.onExit(exitCode, signalStr);
      this.unpersistSession(id);
    });

    this.sessions.set(id, session);

    // Update persistence with new PID
    this.updatePersistedSession(id, ptyProcess.pid, startedAt);

    console.log(`Session restarted: ${id} (PID: ${ptyProcess.pid})${continueConversation ? ' [continuing]' : ''}`);

    return this.toPublicSession(session);
  }

  private updatePersistedSession(id: string, pid: number, startedAt: string): void {
    const sessions = persistenceService.loadSessions();
    const idx = sessions.findIndex(s => s.id === id);
    if (idx >= 0) {
      sessions[idx].pid = pid;
      sessions[idx].createdAt = startedAt;
      persistenceService.saveSessions(sessions);
    }
  }

  getOutputBuffer(id: string): string {
    const session = this.sessions.get(id);
    return session?.outputBuffer ?? '';
  }

  writeInput(id: string, data: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    // Debug: log input data
    console.log(`[SessionManager] writeInput: ${JSON.stringify(data)}`);

    // Check if this is a submit (CR = Enter) or cancel (ESC)
    if (data.includes('\r') || data === '\x1b') {
      // User pressed Enter to submit or ESC to cancel - clear typing flag immediately
      session.activityDetector.clearUserTyping();
    } else {
      // Regular typing - set typing flag
      session.activityDetector.setUserTyping();
    }

    session.pty.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.pty.resize(cols, rows);
    return true;
  }

  killSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    session.pty.kill();
    this.sessions.delete(id);
    this.unpersistSession(id);
    console.log(`Session killed: ${id}`);
    return true;
  }

  /**
   * Update the callbacks for a session (used when WebSocket reconnects)
   */
  attachCallbacks(
    id: string,
    onData: (data: string) => void,
    onExit: (exitCode: number, signal: string | null) => void,
    onActivityChange?: (state: ClaudeActivityState) => void
  ): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    session.onData = onData;
    session.onExit = onExit;
    session.onActivityChange = onActivityChange;
    return true;
  }

  /**
   * Detach callbacks (set to no-op) when WebSocket disconnects
   */
  detachCallbacks(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    session.onData = () => {};
    session.onExit = () => {};
    session.onActivityChange = undefined;
    return true;
  }

  /**
   * Get activity state for a session
   */
  getActivityState(id: string): ClaudeActivityState | undefined {
    const session = this.sessions.get(id);
    return session?.activityState;
  }

  getAllSessions(): Session[] {
    return Array.from(this.sessions.values()).map((s) => this.toPublicSession(s));
  }

  private toPublicSession(session: InternalSession): Session {
    return {
      id: session.id,
      worktreePath: session.worktreePath,
      repositoryId: session.repositoryId,
      status: session.status,
      activityState: session.activityState,
      pid: session.pty.pid,
      startedAt: session.startedAt,
    };
  }
}

// Singleton instance
export const sessionManager = new SessionManager();
