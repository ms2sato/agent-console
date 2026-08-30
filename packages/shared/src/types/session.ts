import type { Worker, AgentActivityState, ExitReason } from './worker.js';

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
  /**
   * Whether `initialPrompt` has already been delivered as the session's
   * initial agent-kind worker's (embedded OR terminal-agent) first message.
   * Once true, delivery never re-fires, including across worker/server
   * restart -- this is intentional (a one-time creation-time prompt,
   * distinct from the ephemeral chat history that DOES reset on restart).
   * Undefined for sessions with no `initialPrompt` or no eligible
   * agent-kind worker.
   */
  initialPromptDelivered?: boolean;
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
  | { type: 'embedded-user-message'; text: string; clientMessageId?: string }
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
  'restore-info': 9,
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

/**
 * Transcript Restore, R4 (#1447 stage 4): what actually happened to the
 * pre-failure transcript on a restore failure. See the `restore-info`
 * failure member of `WorkerServerMessage` below for the full rationale of
 * each value -- this is that field's value type, factored out because it is
 * repeated verbatim (server-internal worker state, wire message, and every
 * client consumer down to `EmbeddedAgentWorkerView`'s copy-selection
 * switches) rather than re-spelled at each site.
 */
export type RestorePreservation = 'in-band' | 'sidecar' | 'lost';

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
  | { type: 'server-restarted'; serverPid: number }  // Server was restarted, client should invalidate cache
  // Transcript Restore (#1123). Sent on BOTH an activation's restore success
  // and its restore FAILURE (#1449) -- never on a first-ever activation
  // (there is nothing to declare there). The two forms are a discriminated
  // union on `failed`: the success form below carries `failed?: false`
  // purely so `failed` is a checkable literal across the whole union; the
  // failure form (further below) carries `failed: true` and none of the
  // success form's reconstruction-shaped fields. Dual delivery, the epoch
  // gate, bootstrap redelivery, and the follow-up correction push are all
  // shared machinery, unchanged by which form is in flight -- see
  // docs/design/embedded-agent-worker.md "Transcript Restore" § UI.
  //
  // Why two forms instead of stating failure via `sdkResumed: false`: a
  // divergence between what the model remembers and what the display shows
  // has a direction (D1: display ahead of memory -- what `sdkResumed: false`
  // on a SUCCESSFUL restore means; D2: memory ahead of display -- a
  // `claude-sdk` restore failure, since `sdkSessionId` survives the restore
  // catch; Loss: both gone -- an `openai-api` restore failure, since
  // reconstruction IS that engine's memory). This channel states WHAT
  // HAPPENED; the client derives D2 vs Loss from engine + resume state.
  // See the design doc's D1/D2/Loss framework for the full account -- not
  // restated here.
  //
  // This failure form is designed to survive into #1447 stage 4 as its
  // declaration channel, unchanged: stage 4 changes what gets PRESERVED
  // (sidecar -> in-band display), not HOW a failure is declared.
  //
  // `epoch` is a cross-incarnation staleness guard: the client feeds it
  // through the same acceptEpoch gate `history`/`output` already use.
  // `restoredMessageCount` counts restored entries by a criterion, not a
  // list: an entry counts if and only if its content originates from a line
  // of the persisted transcript. Replayed messages and a compaction summary
  // do; the synthetic system prompt and a Tier C repair marker do not, both
  // being invented by the reconstruction so the provider accepts the array.
  // It is therefore 0 for a worker that was activated but never spoken to,
  // which is what lets the client gate its "may not have carried over"
  // notice on `> 0`. Computed by the embedded-agent restore module, which
  // owns the identity of every synthetic entry; never recomputed from a
  // message array on this side.
  // `sdkResumed` (R1): whether the `claude-sdk` engine's SDK session
  // actually resumed. Set ONLY by that engine -- `openai-api` omits it,
  // because it has no such concept. THREE-VALUED: absent means "this engine
  // does not have the concept", `false` means "this incarnation's SDK
  // session did not resume". This applies IDENTICALLY to both the success
  // and the failure form below -- the failure form's `sdkResumed` uses the
  // exact same optimistic-then-corrected semantics (set from
  // `resumeId !== null` at construction time, corrected downward later by
  // the same `sdk-resume-failed` / session-id-mismatch machinery).
  //
  // Defined by the OUTCOME, never by an attempt. Four routes reach `false`
  // and only the last of them sends a `resume` at all: no session id was
  // persisted to resume from; the activation-time pre-flight found no such
  // session; the pre-flight could not run; the SDK refused a resume that was
  // sent. Defining the value by the attempt would leave the first three
  // undefined while they still set it. This comment is the code-side writer
  // of that list -- the other sites that describe this field point here, and
  // docs/design/embedded-agent-sdk-engine.md 4.3 carries the full account of
  // why the wider reading is the correct one.
  //
  // Reading absence as `false` collapses absent with false, so consumers
  // test `=== false` explicitly and never `!sdkResumed`.
  | {
      type: 'restore-info';
      epoch: number;
      restoredMessageCount: number;
      repairedToolCallIds: string[];
      completed: boolean;
      sdkResumed?: boolean;
      failed?: false;
    }
  // Failure form (#1449): a restore attempt threw (RestoreReconstructionError
  // or any other reconstruction failure). Carries none of the success form's
  // reconstruction-shaped fields -- there is nothing to report about a
  // restore that did not happen. See the block comment above this union
  // member for the full rationale (D1/D2/Loss, #1447/#1449, forward-compat
  // with stage 4).
  //
  // `preservation` (R4, #1447 stage 4): what actually happened to the
  // pre-failure transcript, so the client's banner never claims more than
  // is true.
  //
  // - `'in-band'`: R1's PRIMARY path -- a `restore-failure-boundary` marker
  //   was appended to the SAME live stream with no reset. The old
  //   transcript is still the visible display; only the banner's wording
  //   changes (no "diagnostic copy" claim -- the copy IS the transcript).
  // - `'sidecar'`: R1's FALLBACK path, and the best-effort rename to the
  //   manifest-invisible `<workerId>.restore-failed.log` sidecar actually
  //   succeeded. The banner may claim sidecar preservation.
  // - `'lost'`: the fallback path ran AND the sidecar rename itself failed
  //   (e.g. an I/O error on the same volume that caused the restore
  //   failure in the first place). Nothing was preserved anywhere; the
  //   banner must not claim it was.
  // - **Absent**: a pre-stage-4 server. Renders today's unconditional
  //   copy unchanged -- this is a wire-compat requirement, not merely a
  //   default, so the field is optional rather than defaulted.
  | {
      type: 'restore-info';
      epoch: number;
      failed: true;
      sdkResumed?: boolean;
      preservation?: RestorePreservation;
    };

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
