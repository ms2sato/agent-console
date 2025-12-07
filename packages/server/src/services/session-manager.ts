import * as pty from 'node-pty';
import { execSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import type { Session, SessionStatus, ClaudeActivityState } from '@agent-console/shared';
import { persistenceService, type PersistedSession } from './persistence-service.js';
import { ActivityDetector } from './activity-detector.js';
import { agentManager, CLAUDE_CODE_AGENT_ID } from './agent-manager.js';
import { getChildProcessEnv } from './env-filter.js';
import { getServerPid } from '../lib/config.js';

/**
 * Get current branch name for a directory
 */
function getCurrentBranch(cwd: string): string {
  try {
    return execSync('git branch --show-current', {
      cwd,
      encoding: 'utf-8',
    }).trim() || '(detached)';
  } catch {
    return '(unknown)';
  }
}

interface InternalSession {
  id: string;
  pty: pty.IPty;
  outputBuffer: string;
  worktreePath: string;
  repositoryId: string;
  agentId: string;
  branch: string;
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
   * Only kills sessions where the parent server is no longer running
   * Note: We keep session metadata for reconnection UI
   */
  private cleanupOrphanProcesses(): void {
    const persistedSessions = persistenceService.loadSessions();
    const currentServerPid = getServerPid();
    let killedCount = 0;
    let preservedCount = 0;

    for (const session of persistedSessions) {
      // If serverPid is not set (legacy session), don't kill it - be safe
      if (!session.serverPid) {
        console.warn(`[WARN] Session ${session.id} has no serverPid (legacy session), skipping cleanup`);
        preservedCount++;
        continue;
      }

      // Check if the server that created this session is still alive
      if (this.isProcessAlive(session.serverPid)) {
        // Parent server is still running, don't touch this session
        preservedCount++;
        continue;
      }

      try {
        // Check if session process exists and kill it
        process.kill(session.pid, 0); // 0 = check if process exists
        process.kill(session.pid, 'SIGTERM');
        console.log(`Killed orphan process: PID ${session.pid} (session ${session.id}, parent server ${session.serverPid} is dead)`);
        killedCount++;
      } catch {
        // Process doesn't exist, that's fine
      }
    }

    // Keep session metadata for reconnection UI
    // Metadata will be cleared when user creates new session or explicitly dismisses
    console.log(`Orphan process cleanup: killed ${killedCount}, preserved ${preservedCount} (server PID: ${currentServerPid})`);
  }

  /**
   * Check if a process is still alive
   */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0); // 0 = check if process exists without killing
      return true;
    } catch {
      return false;
    }
  }

  private persistSession(session: InternalSession): void {
    const sessions = persistenceService.loadSessions();
    const persisted: PersistedSession = {
      id: session.id,
      worktreePath: session.worktreePath,
      repositoryId: session.repositoryId,
      pid: session.pty.pid,
      serverPid: getServerPid(),
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
    continueConversation: boolean = false,
    agentId?: string
  ): Session {
    const id = uuidv4();
    const startedAt = new Date().toISOString();
    const branch = getCurrentBranch(worktreePath);

    // Resolve agent - use provided agentId or default to Claude Code
    const resolvedAgentId = agentId ?? CLAUDE_CODE_AGENT_ID;
    const agent = agentManager.getAgent(resolvedAgentId) ?? agentManager.getDefaultAgent();

    // Build command arguments
    const args: string[] = [];
    if (continueConversation && agent.continueArgs) {
      args.push(...agent.continueArgs);
    }

    const ptyProcess = pty.spawn(agent.command, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: worktreePath,
      env: getChildProcessEnv(),
    });

    // Create activity detector for this session with agent-specific patterns
    const activityDetector = new ActivityDetector({
      onStateChange: (state) => {
        session.activityState = state;
        session.onActivityChange?.(state);
        // Broadcast to all dashboard clients
        this.globalActivityCallback?.(id, state);
      },
      activityPatterns: agent.activityPatterns,
    });

    const session: InternalSession = {
      id,
      pty: ptyProcess,
      outputBuffer: '',
      worktreePath,
      repositoryId,
      agentId: agent.id,
      branch,
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
      console.log(`[${new Date().toISOString()}] Session exited: ${id} (PID: ${ptyProcess.pid}, exitCode: ${exitCode}, signal: ${signalStr})`);
      session.onExit(exitCode, signalStr);
      // Keep session metadata for restart - only remove on explicit delete
    });

    this.sessions.set(id, session);
    this.persistSession(session);

    console.log(`[${new Date().toISOString()}] Session created: ${id} (PID: ${ptyProcess.pid})${continueConversation ? ' [continuing]' : ''}`);

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
    continueConversation: boolean = false,
    agentId?: string
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
    const branch = getCurrentBranch(metadata.worktreePath);

    // Resolve agent - use provided agentId or default to Claude Code
    const resolvedAgentId = agentId ?? CLAUDE_CODE_AGENT_ID;
    const agent = agentManager.getAgent(resolvedAgentId) ?? agentManager.getDefaultAgent();

    // Build command arguments
    const args: string[] = [];
    if (continueConversation && agent.continueArgs) {
      args.push(...agent.continueArgs);
    }

    const ptyProcess = pty.spawn(agent.command, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: metadata.worktreePath,
      env: getChildProcessEnv(),
    });

    // Create activity detector for this session with agent-specific patterns
    const activityDetector = new ActivityDetector({
      onStateChange: (state) => {
        session.activityState = state;
        session.onActivityChange?.(state);
        // Broadcast to all dashboard clients
        this.globalActivityCallback?.(id, state);
      },
      activityPatterns: agent.activityPatterns,
    });

    const session: InternalSession = {
      id,
      pty: ptyProcess,
      outputBuffer: '',
      worktreePath: metadata.worktreePath,
      repositoryId: metadata.repositoryId,
      agentId: agent.id,
      branch,
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
      console.log(`[${new Date().toISOString()}] Session exited: ${id} (PID: ${ptyProcess.pid}, exitCode: ${exitCode}, signal: ${signalStr})`);
      session.onExit(exitCode, signalStr);
      // Keep session metadata for restart - only remove on explicit delete
    });

    this.sessions.set(id, session);

    // Update persistence with new PID
    this.updatePersistedSession(id, ptyProcess.pid, startedAt);

    console.log(`[${new Date().toISOString()}] Session restarted: ${id} (PID: ${ptyProcess.pid})${continueConversation ? ' [continuing]' : ''}`);

    return this.toPublicSession(session);
  }

  private updatePersistedSession(id: string, pid: number, startedAt: string): void {
    const sessions = persistenceService.loadSessions();
    const idx = sessions.findIndex(s => s.id === id);
    if (idx >= 0) {
      sessions[idx].pid = pid;
      sessions[idx].serverPid = getServerPid();
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

    // Check if this is a submit (CR = Enter), cancel (ESC), or focus event
    if (data.includes('\r')) {
      // User pressed Enter to submit - clear typing flag immediately
      session.activityDetector.clearUserTyping(false);
    } else if (data === '\x1b') {
      // User pressed ESC to cancel - clear typing flag but handle 'asking' state specially
      session.activityDetector.clearUserTyping(true);
    } else if (data === '\x1b[I' || data === '\x1b[O') {
      // Focus in/out events from xterm - ignore for activity detection
      // These are not user typing, just terminal focus reporting
      console.log(`[SessionManager] Ignoring focus event: ${JSON.stringify(data)}`);
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

  /**
   * Get current branch name for a given path
   */
  getBranchForPath(worktreePath: string): string {
    return getCurrentBranch(worktreePath);
  }

  /**
   * Rename the branch for a session
   * Uses git branch -m to rename the current branch
   */
  renameBranch(
    sessionId: string,
    newBranch: string
  ): { success: boolean; branch?: string; error?: string } {
    // Check active sessions first
    const session = this.sessions.get(sessionId);
    if (session) {
      const currentBranch = session.branch;

      try {
        execSync(`git branch -m "${currentBranch}" "${newBranch}"`, {
          cwd: session.worktreePath,
          encoding: 'utf-8',
        });
        session.branch = newBranch;
        return { success: true, branch: newBranch };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: message };
      }
    }

    // Check persisted metadata for dead sessions
    const metadata = persistenceService.getSessionMetadata(sessionId);
    if (!metadata) {
      return { success: false, error: 'session_not_found' };
    }

    // For dead sessions, get current branch from git and rename
    const currentBranch = getCurrentBranch(metadata.worktreePath);

    try {
      execSync(`git branch -m "${currentBranch}" "${newBranch}"`, {
        cwd: metadata.worktreePath,
        encoding: 'utf-8',
      });
      return { success: true, branch: newBranch };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
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
      agentId: session.agentId,
      branch: session.branch,
    };
  }
}

// Singleton instance
export const sessionManager = new SessionManager();
