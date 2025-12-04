import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import type { Session, SessionStatus } from '@agents-web-console/shared';

interface InternalSession {
  id: string;
  pty: pty.IPty;
  outputBuffer: string;
  worktreePath: string;
  repositoryId: string;
  status: SessionStatus;
  startedAt: string;
  onData: (data: string) => void;
  onExit: (exitCode: number, signal: string | null) => void;
}

const MAX_BUFFER_SIZE = 100000; // 100KB

export class SessionManager {
  private sessions: Map<string, InternalSession> = new Map();

  createSession(
    worktreePath: string,
    repositoryId: string,
    onData: (data: string) => void,
    onExit: (exitCode: number, signal: string | null) => void
  ): Session {
    const id = uuidv4();
    const startedAt = new Date().toISOString();

    const ptyProcess = pty.spawn('claude', [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: worktreePath,
      env: process.env as Record<string, string>,
    });

    const session: InternalSession = {
      id,
      pty: ptyProcess,
      outputBuffer: '',
      worktreePath,
      repositoryId,
      status: 'running',
      startedAt,
      onData,
      onExit,
    };

    ptyProcess.onData((data) => {
      // Buffer output for reconnection
      session.outputBuffer += data;
      if (session.outputBuffer.length > MAX_BUFFER_SIZE) {
        session.outputBuffer = session.outputBuffer.slice(-MAX_BUFFER_SIZE);
      }
      session.onData(data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      session.status = 'stopped';
      // signal can be a number (signal code) or undefined
      const signalStr = signal !== undefined ? String(signal) : null;
      session.onExit(exitCode, signalStr);
    });

    this.sessions.set(id, session);

    console.log(`Session created: ${id} (PID: ${ptyProcess.pid})`);

    return this.toPublicSession(session);
  }

  getSession(id: string): Session | undefined {
    const session = this.sessions.get(id);
    return session ? this.toPublicSession(session) : undefined;
  }

  getOutputBuffer(id: string): string {
    const session = this.sessions.get(id);
    return session?.outputBuffer ?? '';
  }

  writeInput(id: string, data: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
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
    console.log(`Session killed: ${id}`);
    return true;
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
      pid: session.pty.pid,
      startedAt: session.startedAt,
    };
  }
}

// Singleton instance
export const sessionManager = new SessionManager();
