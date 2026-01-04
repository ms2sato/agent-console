import type { Worker, AgentActivityState } from './worker.js';
import type { AgentDefinition } from './agent.js';

// Forward declaration of Repository to avoid circular dependency
// The full type is defined in @agent-console/shared/src/index.ts
interface Repository {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  remoteUrl?: string;
  setupCommand?: string | null;
}

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
  | { type: 'image'; data: string; mimeType: string }
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
  | 'HISTORY_LOAD_FAILED';  // History retrieval failed (timeout or error)

export type WorkerServerMessage =
  | { type: 'output'; data: string; offset: number }
  | { type: 'exit'; exitCode: number; signal: string | null }
  | { type: 'history'; data: string; offset: number; timedOut?: boolean }
  | { type: 'activity'; state: AgentActivityState }  // Agent workers only
  | { type: 'error'; message: string; code?: WorkerErrorCode };

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
} as const;

/** @deprecated Use APP_SERVER_MESSAGE_TYPES instead */
export const APP_MESSAGE_TYPES = APP_SERVER_MESSAGE_TYPES;

export type AppServerMessageType = keyof typeof APP_SERVER_MESSAGE_TYPES;

export type AppServerMessage =
  | { type: 'sessions-sync'; sessions: Session[]; activityStates: WorkerActivityInfo[] }
  | { type: 'session-created'; session: Session }
  | { type: 'session-updated'; session: Session }
  | { type: 'session-deleted'; sessionId: string }
  | { type: 'worker-activity'; sessionId: string; workerId: string; activityState: AgentActivityState }
  | { type: 'agents-sync'; agents: AgentDefinition[] }
  | { type: 'agent-created'; agent: AgentDefinition }
  | { type: 'agent-updated'; agent: AgentDefinition }
  | { type: 'agent-deleted'; agentId: string }
  | { type: 'repositories-sync'; repositories: Repository[] }
  | { type: 'repository-created'; repository: Repository }
  | { type: 'repository-updated'; repository: Repository }
  | { type: 'repository-deleted'; repositoryId: string };

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
