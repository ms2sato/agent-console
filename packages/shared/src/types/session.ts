import type * as v from 'valibot';
import type { AppServerMessageSchema } from '../schemas/app-server-message.js';
import type { Worker, AgentActivityState } from './worker.js';

// Re-export schema-derived types
export type {
  CreateWorktreeSessionRequest,
  CreateQuickSessionRequest,
  CreateSessionRequest,
  UpdateSessionRequest,
  DeleteSessionRequest,
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

/**
 * Reason a worker's PTY exited.
 * - 'managed': Intentional kill via API (delete, restart, pause, etc.)
 * - 'unexpected': Process exited on its own (crash, user exit, signal)
 */
export type ExitReason = 'managed' | 'unexpected';

export type SessionStatus = 'active' | 'inactive';

/** Whether a session has active PTY processes running */
export type SessionActivationState = 'running' | 'hibernated';

export interface SessionBase {
  id: string;
  locationPath: string;      // Working directory (always required)
  status: SessionStatus;
  activationState: SessionActivationState;  // Whether PTY workers are running
  createdAt: string;
  workers: Worker[];
  initialPrompt?: string;    // The prompt used to start the session
  title?: string;            // Human-readable title for the session
  /** ISO 8601 timestamp when this session was paused (undefined = not paused) */
  pausedAt?: string;
  /** Parent session ID that delegated/created this session */
  parentSessionId?: string;
  /** Parent worker ID that delegated/created this session */
  parentWorkerId?: string;
  /** User UUID (from users table) of the user who created this session (nullable for backwards compatibility) */
  createdBy?: string;
}

export interface WorktreeSession extends SessionBase {
  type: 'worktree';
  repositoryId: string;
  repositoryName: string;    // Human-readable repository name
  worktreeId: string;        // Worktree identifier (branch name)
  isMainWorktree: boolean;   // Whether this session is on the main (non-added) worktree
}

export interface QuickSession extends SessionBase {
  type: 'quick';
}

export type Session = WorktreeSession | QuickSession;

/** A session that has been paused (hibernated with pausedAt timestamp) */
export type PausedSession = (WorktreeSession | QuickSession) & {
  activationState: 'hibernated';
  pausedAt: string;
};

/** A session that is actively running */
export type RunningSession = (WorktreeSession | QuickSession) & {
  activationState: 'running';
};

export interface CreateSessionResponse {
  session: Session;
}

export interface CreateWorkerResponse {
  worker: Worker;
}

export type WorkerClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'request-history'; fromOffset?: number };

/**
 * Valid message types for WorkerServerMessage.
 * Single source of truth for both type definitions and runtime validation.
 */
export const WORKER_SERVER_MESSAGE_TYPES = {
  'output': 1,
  'exit': 2,
  'history': 3,
  'activity': 4,
  'error': 5,
  'output-truncated': 6,
  'server-restarted': 7,
} as const;

export type WorkerServerMessageType = keyof typeof WORKER_SERVER_MESSAGE_TYPES;

/**
 * Error codes for worker errors.
 */
export type WorkerErrorCode =
  | 'PATH_NOT_FOUND'        // Session path no longer exists
  | 'AGENT_NOT_FOUND'       // Agent definition deleted
  | 'ACTIVATION_FAILED'     // PTY spawn failed
  | 'WORKER_NOT_FOUND'      // Worker doesn't exist in session
  | 'HISTORY_LOAD_FAILED'   // History retrieval failed (timeout or error)
  | 'SESSION_DELETED'       // Session was deleted while WebSocket was connected
  | 'SESSION_PAUSED';       // Session was paused while WebSocket was connected

export type WorkerServerMessage =
  | { type: 'output'; data: string; offset: number }
  | { type: 'exit'; exitCode: number; signal: string | null; reason?: ExitReason }
  | { type: 'history'; data: string; offset: number; timedOut?: boolean; generation?: number }
  | { type: 'activity'; state: AgentActivityState }  // Agent workers only
  | { type: 'error'; message: string; code?: WorkerErrorCode }
  | { type: 'output-truncated'; message: string; newOffset: number; generation?: number }
  | { type: 'server-restarted'; serverPid: number };  // Server was restarted, client should invalidate cache

export interface WorkerActivityInfo {
  sessionId: string;
  workerId: string;
  activityState: AgentActivityState;
}

/**
 * Valid message types for AppServerMessage.
 * Single source of truth for both type definitions and runtime validation.
 * Use object keys for easy `in` operator validation.
 *
 * @see docs/design/websocket-protocol.md for protocol specification and design decisions
 */
export const APP_SERVER_MESSAGE_TYPES = {
  'sessions-sync': 1,
  'session-created': 2,
  'session-updated': 3,
  'session-deleted': 4,
  'worker-activity': 5,
  'agents-sync': 6,
  'agent-created': 7,
  'agent-updated': 8,
  'agent-deleted': 9,
  'repositories-sync': 10,
  'repository-created': 11,
  'repository-updated': 12,
  'repository-deleted': 13,
  'worktree-creation-completed': 14,
  'worktree-creation-failed': 15,
  'worker-activated': 16,
  'worktree-deletion-completed': 17,
  'worktree-deletion-failed': 18,
  'worker-message': 19,
  'session-paused': 20,
  'session-resumed': 21,
  'inbound-event': 22,
  'worker-restarted': 23,
  'worktree-pull-completed': 24,
  'worktree-pull-failed': 25,
  'memo-updated': 26,
  'review-queue-updated': 27,
} as const;

/** @deprecated Use APP_SERVER_MESSAGE_TYPES instead */
export const APP_MESSAGE_TYPES = APP_SERVER_MESSAGE_TYPES;

export type AppServerMessageType = keyof typeof APP_SERVER_MESSAGE_TYPES;

export type AppServerMessage = v.InferOutput<typeof AppServerMessageSchema>;

/**
 * Valid message types for AppClientMessage.
 * Single source of truth for both type definitions and runtime validation.
 *
 * - request-sync: Request fresh session data when Dashboard remounts
 *   while WebSocket is already connected (navigation case)
 *
 * @see docs/design/websocket-protocol.md for protocol specification and design decisions
 */
export const APP_CLIENT_MESSAGE_TYPES = {
  'request-sync': 1,
} as const;

export type AppClientMessageType = keyof typeof APP_CLIENT_MESSAGE_TYPES;

export type AppClientMessage = { type: 'request-sync' };

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
