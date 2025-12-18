import type { Worker, AgentActivityState } from './worker.js';
import type { AgentDefinition } from './agent.js';

// Re-export schema-derived types
export type {
  CreateWorktreeSessionRequest,
  CreateQuickSessionRequest,
  CreateSessionRequest,
  UpdateSessionRequest,
} from '../schemas/session.js';

export type {
  // Internal types for server-side worker creation
  CreateAgentWorkerParams,
  CreateTerminalWorkerParams,
  CreateGitDiffWorkerParams,
  CreateWorkerParams,
  // API types (client can only create terminal workers)
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

export interface WorkerActivityInfo {
  sessionId: string;
  workerId: string;
  activityState: AgentActivityState;
}

/**
 * Valid message types for AppServerMessage.
 * Single source of truth for both type definitions and runtime validation.
 * Use object keys for easy `in` operator validation.
 */
export const APP_MESSAGE_TYPES = {
  'sessions-sync': 1,
  'session-created': 2,
  'session-updated': 3,
  'session-deleted': 4,
  'worker-activity': 5,
  'agents-sync': 6,
  'agent-created': 7,
  'agent-updated': 8,
  'agent-deleted': 9,
} as const;

export type AppServerMessageType = keyof typeof APP_MESSAGE_TYPES;

export type AppServerMessage =
  | { type: 'sessions-sync'; sessions: Session[]; activityStates: WorkerActivityInfo[] }
  | { type: 'session-created'; session: Session }
  | { type: 'session-updated'; session: Session }
  | { type: 'session-deleted'; sessionId: string }
  | { type: 'worker-activity'; sessionId: string; workerId: string; activityState: AgentActivityState }
  | { type: 'agents-sync'; agents: AgentDefinition[] }
  | { type: 'agent-created'; agent: AgentDefinition }
  | { type: 'agent-updated'; agent: AgentDefinition }
  | { type: 'agent-deleted'; agentId: string };

// Session validation types
export type SessionValidationIssueType =
  | 'directory_not_found'
  | 'not_git_repository'
  | 'branch_not_found';

export interface SessionValidationIssue {
  type: SessionValidationIssueType;
  message: string;
}

export interface SessionValidationResult {
  sessionId: string;
  session: {
    type: 'worktree' | 'quick';
    locationPath: string;
    worktreeId?: string;
    title?: string;
  };
  valid: boolean;
  issues: SessionValidationIssue[];
}

export interface SessionsValidationResponse {
  results: SessionValidationResult[];
  hasIssues: boolean;
}
