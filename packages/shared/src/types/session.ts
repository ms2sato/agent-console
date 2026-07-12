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
  /**
   * OS username derived server-side from `createdBy` UUID via UserRepository.
   * Set on Session responses for client display. Null when `createdBy` is
   * undefined (legacy sessions) or when the user record is no longer
   * resolvable (deleted user account).
   *
   * Same `derived field on shared type + conditional client render` pattern
   * as Repository's `clonedSourceRepoPath`. The client decides visibility
   * (e.g., only show in multi-user mode).
   */
  createdByUsername?: string | null;
  /**
   * User UUID of the authenticated user who actually created this session.
   * For shared sessions, this differs from `createdBy` (which is the shared
   * account). For personal sessions, this is left undefined.
   * See docs/design/shared-orchestrator-session.md §"Schema Notes".
   */
  initiatedBy?: string;
  /**
   * Whether this session is owned by a configured shared account. Derived
   * server-side from `createdBy` resolving to a registered shared account
   * via SharedAccountRegistry; clients consume this boolean only and never
   * see the underlying set of shared-account user-ids. `false` when
   * `createdBy` is null/undefined (legacy sessions) or refers to a regular
   * user. See docs/design/shared-orchestrator-session.md §UI.
   */
  isShared: boolean;
  /** Session recovery state, surfaced from server. 'healthy' | 'orphaned'. */
  recoveryState: 'healthy' | 'orphaned';
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
  | { type: 'request-history'; fromOffset?: number }
  // Backwards range fetch (§5.1). Request history bytes strictly before the
  // absolute `beforeOffset`. `maxBytes` is a client hint; the server applies
  // its own cap. `requestId` is a per-connection client counter echoed back on
  // both the `history-range` response and its `HISTORY_LOAD_FAILED` error path
  // for correlation of the single in-flight range request.
  | { type: 'request-history-range'; requestId: number; beforeOffset: number; maxBytes?: number };

/**
 * Client -> server messages valid only on an `embedded-agent` worker's
 * WebSocket channel. `request-history` / `request-history-range` are shared
 * with `WorkerClientMessage` (the byte-offset/epoch history machinery is
 * content-agnostic) — routes.ts's `onMessage` parses the incoming message
 * once and dispatches those shared types BEFORE branching on `worker.type`,
 * so they never reach this union. `input` / `resize` (and any other
 * unrecognized type) are explicitly rejected for this worker type once that
 * worker-type branch runs (PTY-only semantics; the branch is terminal — every
 * message for an embedded-agent worker is either handled or rejected there,
 * never passed through to PTY handling).
 *
 * Deliberately NOT folded into `WorkerClientMessage`: after the shared parse,
 * routes.ts branches on `worker.type` to dispatch the embedded-agent-specific
 * types, so keeping this union separate mirrors that branch and avoids
 * widening the PTY-side exhaustive switch in worker-handler.ts for message
 * types it will never receive.
 */
export type EmbeddedAgentClientMessage =
  | { type: 'embedded-user-message'; text: string }
  | { type: 'embedded-cancel' };

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
  // Ordinal 6 ('output-truncated') is retired and intentionally NOT reused:
  // archival never rebases offsets, so the message has no remaining meaning
  // (terminal-history-paging.md §3.2).
  'server-restarted': 7,
  'history-range': 8,
} as const;

export type WorkerServerMessageType = keyof typeof WORKER_SERVER_MESSAGE_TYPES;

/**
 * Error codes for worker errors.
 */
export type WorkerErrorCode =
  | 'PATH_NOT_FOUND'        // Session path no longer exists
  | 'AGENT_NOT_FOUND'       // Agent definition deleted
  | 'ACTIVATION_FAILED'     // PTY spawn failed, or embedded-agent activation/dispatch failed
  | 'WORKER_NOT_FOUND'      // Worker doesn't exist in session
  | 'HISTORY_LOAD_FAILED'   // History retrieval failed (timeout or error)
  | 'SESSION_DELETED'       // Session was deleted while WebSocket was connected
  | 'SESSION_PAUSED'        // Session was paused while WebSocket was connected
  | 'TURN_IN_PROGRESS'      // embedded-user-message rejected: a turn is already active
  | 'UNSUPPORTED_OPERATION' // Client message not valid for this worker type (e.g. input/resize on an embedded-agent worker)
  | 'MESSAGE_TOO_LARGE';    // embedded-user-message.text exceeds the wire byte cap

export type WorkerServerMessage =
  // `offset` is the absolute end position in the worker's cumulative output
  // stream; `epoch` is the incarnation generation identifier (§3.1 / §3.4).
  | { type: 'output'; data: string; offset: number; epoch: number }
  | { type: 'exit'; exitCode: number; signal: string | null; reason?: ExitReason }
  // `startOffset` is the absolute start of `data`; `offset` its absolute end.
  | { type: 'history'; data: string; offset: number; startOffset: number; epoch: number; timedOut?: boolean }
  | { type: 'activity'; state: AgentActivityState }  // Agent workers only
  | { type: 'error'; message: string; code?: WorkerErrorCode; requestId?: number }
  // Backwards range response (§5.1). `data` covers absolute [startOffset, endOffset)
  // with endOffset <= the request's beforeOffset. `hasMore` is
  // `startOffset > firstAvailableOffset`. An unavailable range (pruned, invalid
  // request, or beforeOffset <= firstAvailableOffset) returns data: '',
  // startOffset = endOffset = beforeOffset, hasMore: false. `requestId` echoes
  // the request; `epoch` is captured under the per-worker lock (§3.4).
  | {
      type: 'history-range';
      requestId: number;
      data: string;
      startOffset: number;
      endOffset: number;
      hasMore: boolean;
      epoch: number;
    }
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
  // Sent as the first frame on /ws/app so the client can detect a
  // server/client schema mismatch. See docs/design/websocket-protocol.md.
  'schema-version': 28,
  'embedded-agent-created': 29,
  'embedded-agent-updated': 30,
  'embedded-agent-deleted': 31,
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
