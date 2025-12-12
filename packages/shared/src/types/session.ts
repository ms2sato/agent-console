import type { Worker, AgentActivityState } from './worker.js';

// Re-export schema-derived types
export type {
  CreateWorktreeSessionRequest,
  CreateQuickSessionRequest,
  CreateSessionRequest,
  UpdateSessionRequest,
} from '../schemas/session.js';

export type {
  CreateAgentWorkerRequest,
  CreateTerminalWorkerRequest,
  CreateWorkerRequest,
  RestartWorkerRequest,
} from '../schemas/worker.js';

export type SessionStatus = 'active' | 'inactive';

export interface SessionBase {
  id: string;
  locationPath: string;      // Working directory (always required)
  status: SessionStatus;
  createdAt: string;
  workers: Worker[];
  initialPrompt?: string;    // The prompt used to start the session
  title?: string;            // Human-readable title for the session
}

export interface WorktreeSession extends SessionBase {
  type: 'worktree';
  repositoryId: string;
  worktreeId: string;        // Worktree identifier (branch name)
}

export interface QuickSession extends SessionBase {
  type: 'quick';
}

export type Session = WorktreeSession | QuickSession;

export interface CreateSessionResponse {
  session: Session;
}

export interface CreateWorkerResponse {
  worker: Worker;
}

export type WorkerClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'image'; data: string; mimeType: string };

export type WorkerServerMessage =
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number; signal: string | null }
  | { type: 'history'; data: string }
  | { type: 'activity'; state: AgentActivityState };  // Agent workers only

export type DashboardServerMessage =
  | { type: 'sessions-sync'; sessions: Array<{ id: string; workers: Array<{ id: string; activityState?: AgentActivityState }> }> }
  | { type: 'session-created'; session: Session }
  | { type: 'session-updated'; session: Session }
  | { type: 'session-deleted'; sessionId: string }
  | { type: 'worker-activity'; sessionId: string; workerId: string; activityState: AgentActivityState };
