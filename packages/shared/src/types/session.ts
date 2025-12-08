import type { Worker, AgentActivityState } from './worker.js';

export type SessionStatus = 'active' | 'inactive';

export interface SessionBase {
  id: string;
  locationPath: string;      // Working directory (always required)
  status: SessionStatus;
  createdAt: string;
  workers: Worker[];
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

interface CreateWorktreeSessionRequest {
  type: 'worktree';
  repositoryId: string;
  worktreeId: string;
  locationPath: string;
  agentId?: string;              // If provided, create initial agent worker
  continueConversation?: boolean;
}

interface CreateQuickSessionRequest {
  type: 'quick';
  locationPath: string;
  agentId?: string;
  continueConversation?: boolean;
}

export type CreateSessionRequest = CreateWorktreeSessionRequest | CreateQuickSessionRequest;

export interface CreateSessionResponse {
  session: Session;
}

// Worker creation
interface CreateAgentWorkerRequest {
  type: 'agent';
  name?: string;
  agentId: string;
}

interface CreateTerminalWorkerRequest {
  type: 'terminal';
  name?: string;
}

export type CreateWorkerRequest = CreateAgentWorkerRequest | CreateTerminalWorkerRequest;

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
