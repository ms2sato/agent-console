import * as v from 'valibot';
import { AgentDefinitionSchema } from './agent.js';
import { EmbeddedAgentDefinitionSchema } from './embedded-agent.js';

// === Primitive schemas ===

const SessionStatusSchema = v.picklist(['active', 'inactive']);
const SessionActivationStateSchema = v.picklist(['running', 'hibernated']);
const AgentActivityStateSchema = v.picklist(['active', 'idle', 'asking', 'unknown']);

// === Worker schemas ===
//
// Each entity type below is DERIVED from its schema (`v.InferOutput`); the
// schema is the single writer. Adding or changing a field means editing the
// schema entry only. The doc comments sit on the schema entries for that
// reason -- they are the field's specification.

export const WorkerBaseSchema = v.strictObject({
  id: v.string(),
  name: v.string(),
  createdAt: v.string(),
});

export const AgentWorkerSchema = v.strictObject({
  ...WorkerBaseSchema.entries,
  type: v.literal('agent'),
  /** References AgentDefinition.id (e.g., 'claude-code-builtin') */
  agentId: v.string(),
  /** Whether the PTY is running (false when hibernated) */
  activated: v.boolean(),
});

export const TerminalWorkerSchema = v.strictObject({
  ...WorkerBaseSchema.entries,
  type: v.literal('terminal'),
  /** Whether the PTY is running (false when hibernated) */
  activated: v.boolean(),
});

export const GitDiffWorkerSchema = v.strictObject({
  ...WorkerBaseSchema.entries,
  type: v.literal('git-diff'),
  /** Comparison base commit hash (calculated at creation) */
  baseCommit: v.string(),
});

export const EmbeddedAgentWorkerSchema = v.strictObject({
  ...WorkerBaseSchema.entries,
  type: v.literal('embedded-agent'),
  /** References EmbeddedAgentDefinition.id (NOT AgentDefinition.id). */
  embeddedAgentId: v.string(),
  /** Whether the agent subprocess is running (false after server restart until reactivated). */
  activated: v.boolean(),
  /**
   * Compaction's automatic-firing toggle. Deliberately per-WORKER, not per
   * definition: two workers built from the same embedded agent can differ,
   * because the decision belongs to the conversation in front of the user.
   * Defaults ON (`workers.auto_compaction NOT NULL DEFAULT 1`), including
   * for rows that predate the column.
   */
  autoCompaction: v.boolean(),
  /**
   * Effective context-window token denominator for the compaction usage
   * gauge, resolved server-side (single writer:
   * `resolveEffectiveContextWindow` in
   * `packages/server/src/services/embedded-agent-context-window.ts`).
   * `undefined` when the underlying definition declares no window (or the
   * definition is missing) -- the gauge must render indeterminate in that
   * case, never inherit a stale or unrelated value.
   */
  contextWindowTokens: v.optional(v.number()),
  /**
   * EFFECTIVE model this worker runs on, resolved server-side (single
   * writer: `resolveEffectiveModelParams` in
   * `packages/server/src/services/embedded-agent-model-params.ts`) -- the
   * client never resolves an override against the definition registry
   * itself, exactly as with `contextWindowTokens` above.
   *
   * OPTIONAL for the SAME reason `contextWindowTokens` is: the value is
   * UNRESOLVABLE when this worker carries no `model` override AND the
   * definition cannot be looked up (a deleted definition, or the paused-
   * session converter whose definition lookup is itself optional). Absent
   * therefore means UNKNOWN, never "the definition's default" -- a control
   * that edits this value must disable itself on absence rather than
   * render a guess, the same discipline the compaction toggle already
   * follows for an unknown wire value.
   */
  model: v.optional(v.string()),
  /**
   * EFFECTIVE reasoning effort, resolved server-side by the same single
   * writer as `model` above. REQUIRED, unlike `model`: it resolves to
   * `worker.reasoningEffort ?? null` and needs no definition lookup, so it
   * is never unresolvable. `null` means no effort override is in effect.
   */
  reasoningEffort: v.nullable(v.string()),
  /**
   * Whether ANY of this worker's three override fields is set --
   * `worker.model !== null || worker.reasoningEffort !== null ||
   * worker.contextWindowTokens !== null`, computed server-side by
   * `hasEmbeddedAgentParameterOverride`
   * (`packages/server/src/services/embedded-agent-model-params.ts`).
   *
   * Exists so a surface can distinguish "override" from "definition
   * default" WITHOUT reconstructing the precedence rules: the effective
   * `model` above is the same string in both cases, so no client-side
   * comparison can recover the distinction.
   */
  hasParameterOverride: v.boolean(),
  /**
   * epic #1636 Phase 5 PR-2 (docs/design/embedded-agent-sdk-engine.md §4.5):
   * the `claude-sdk` engine's own discovery of this worker's project
   * `.mcp.json`, as last reported by the `mcp-servers-discovered` event
   * (up to 3 times per activation, last-write-wins). Absent on every
   * `openai-api` worker (no MCP-discovery concept) and on a `claude-sdk`
   * worker that has not yet reported a discovery reading (e.g. never
   * activated). `decision` here has ONE more member than the wire event's
   * own picklist -- `'denied'` -- because a server-computed decision (a user
   * explicitly denying a pending server) is never something the subprocess
   * itself emits.
   */
  mcpServers: v.optional(
    v.array(
      v.strictObject({
        name: v.string(),
        scope: v.picklist(['project', 'user', 'local', 'reserved', 'connector']),
        hash: v.optional(v.string()),
        decision: v.optional(v.picklist(['allowed', 'denied', 'pending', 'rejected-reserved', 'invalid'])),
        status: v.optional(v.string()),
      }),
    ),
  ),
});

export const WorkerSchema = v.union([
  AgentWorkerSchema,
  TerminalWorkerSchema,
  GitDiffWorkerSchema,
  EmbeddedAgentWorkerSchema,
]);

export type WorkerBase = v.InferOutput<typeof WorkerBaseSchema>;
export type AgentWorker = v.InferOutput<typeof AgentWorkerSchema>;
export type TerminalWorker = v.InferOutput<typeof TerminalWorkerSchema>;
export type GitDiffWorker = v.InferOutput<typeof GitDiffWorkerSchema>;
export type EmbeddedAgentWorker = v.InferOutput<typeof EmbeddedAgentWorkerSchema>;
export type Worker = v.InferOutput<typeof WorkerSchema>;

// === Session schemas ===

export const SessionBaseSchema = v.strictObject({
  id: v.string(),
  /** Working directory (always required) */
  locationPath: v.string(),
  status: SessionStatusSchema,
  /** Whether PTY workers are running */
  activationState: SessionActivationStateSchema,
  createdAt: v.string(),
  workers: v.array(WorkerSchema),
  /** The prompt used to start the session */
  initialPrompt: v.optional(v.string()),
  /**
   * Whether `initialPrompt` has already been delivered as the session's
   * initial agent-kind worker's (embedded OR terminal-agent) first message.
   * Once true, delivery never re-fires, including across worker/server
   * restart -- this is intentional (a one-time creation-time prompt,
   * distinct from the ephemeral chat history that DOES reset on restart).
   * Undefined for sessions with no `initialPrompt` or no eligible
   * agent-kind worker.
   */
  initialPromptDelivered: v.optional(v.boolean()),
  /** Human-readable title for the session */
  title: v.optional(v.string()),
  /** ISO 8601 timestamp when this session was paused (undefined = not paused) */
  pausedAt: v.optional(v.string()),
  /** Parent session ID that delegated/created this session */
  parentSessionId: v.optional(v.string()),
  /** Parent worker ID that delegated/created this session */
  parentWorkerId: v.optional(v.string()),
  /** User UUID (from users table) of the user who created this session (nullable for backwards compatibility) */
  createdBy: v.optional(v.string()),
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
  createdByUsername: v.optional(v.nullable(v.string())),
  /**
   * User UUID of the authenticated user who actually created this session.
   * For shared sessions, this differs from `createdBy` (which is the shared
   * account). For personal sessions, this is left undefined.
   * See docs/design/shared-orchestrator-session.md §"Schema Notes".
   */
  initiatedBy: v.optional(v.string()),
  /**
   * Whether this session is owned by a configured shared account. Derived
   * server-side from `createdBy` resolving to a registered shared account
   * via SharedAccountRegistry; clients consume this boolean only and never
   * see the underlying set of shared-account user-ids. `false` when
   * `createdBy` is null/undefined (legacy sessions) or refers to a regular
   * user. See docs/design/shared-orchestrator-session.md §UI.
   */
  isShared: v.boolean(),
  /** Session recovery state, surfaced from server. 'healthy' | 'orphaned'. */
  recoveryState: v.picklist(['healthy', 'orphaned']),
});

export const WorktreeSessionSchema = v.strictObject({
  ...SessionBaseSchema.entries,
  type: v.literal('worktree'),
  repositoryId: v.string(),
  /** Human-readable repository name */
  repositoryName: v.string(),
  /** Worktree identifier (branch name) */
  worktreeId: v.string(),
  /** Whether this session is on the main (non-added) worktree */
  isMainWorktree: v.boolean(),
});

export const QuickSessionSchema = v.strictObject({
  ...SessionBaseSchema.entries,
  type: v.literal('quick'),
});

export const SessionSchema = v.union([WorktreeSessionSchema, QuickSessionSchema]);

export type SessionBase = v.InferOutput<typeof SessionBaseSchema>;
export type WorktreeSession = v.InferOutput<typeof WorktreeSessionSchema>;
export type QuickSession = v.InferOutput<typeof QuickSessionSchema>;
export type Session = v.InferOutput<typeof SessionSchema>;

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

// === Supporting schemas ===

export const WorkerActivityInfoSchema = v.strictObject({
  sessionId: v.string(),
  workerId: v.string(),
  activityState: AgentActivityStateSchema,
});

export type WorkerActivityInfo = v.InferOutput<typeof WorkerActivityInfoSchema>;

export const RepositorySchema = v.strictObject({
  /** UUID */
  id: v.string(),
  /** Display name (directory name) */
  name: v.string(),
  /** Absolute path */
  path: v.string(),
  /** Creation date (ISO 8601) */
  createdAt: v.string(),
  /** Git remote URL for origin (if available) */
  remoteUrl: v.optional(v.string()),
  /** Shell command to run after creating worktrees */
  setupCommand: v.optional(v.nullable(v.string())),
  /** Shell command to run before deleting worktrees */
  cleanupCommand: v.optional(v.nullable(v.string())),
  /** Environment variables in .env format (applied to workers) */
  envVars: v.optional(v.nullable(v.string())),
  /** Brief description of the repository */
  description: v.optional(v.nullable(v.string())),
  /** Default agent ID for worktree creation */
  defaultAgentId: v.optional(v.nullable(v.string())),
  /**
   * The set of sessions designated as this repository's Orchestrators (see
   * docs/design/shared-orchestrator-session.md, "Designation in multi-user");
   * sorted by designation time then id; a designation disappears with its
   * session (DB ON DELETE CASCADE). Required (not optional): zero
   * designations is `[]`, never an absent key.
   */
  orchestratorSessionIds: v.array(v.string()),
  /** Comma-separated GitHub label names (case-insensitive, trimmed) that route labeled-Issue webhooks to every live session in orchestratorSessionIds */
  issueTriggerLabels: v.optional(v.nullable(v.string())),
  /** Username of the bound shared account (Release 1: storage only, not yet consulted by session creation), or null when unbound */
  sharedAccountUsername: v.optional(v.nullable(v.string())),
  /**
   * Equal to `path` when this repository's registered path lives under the
   * shared `source-repos` directory (`getSourceReposDir()`); `null` otherwise.
   * Required (not optional) so every broadcast carries a defined value;
   * server derives via `withRepositoryRemote` against `getSourceReposDir()`.
   *
   * This is a pure path-containment check, NOT a provenance check. A
   * repository whose path falls inside the source-repos prefix is treated
   * as a cloned source repo for the purposes of the unregister UI,
   * regardless of HOW the directory was created -- whether via
   * `POST /api/repositories/clone`, an operator-side `git clone` followed
   * by registration through `POST /api/repositories`, or any other means.
   *
   * The client uses this field to gate the "also remove the cloned source
   * repo" checkbox visibility on the unregister UI. When the user checks
   * the box, `DELETE /api/repositories/:id` is sent with
   * `removeSourceRepo: true` and the server's CLEANUP_REPOSITORY job
   * removes this directory via `extraDir` in addition to the main data
   * subtree.
   */
  clonedSourceRepoPath: v.nullable(v.string()),
});

export type Repository = v.InferOutput<typeof RepositorySchema>;

const WorkerMessageSchema = v.strictObject({
  id: v.string(),
  sessionId: v.string(),
  fromWorkerId: v.string(),
  fromWorkerName: v.string(),
  toWorkerId: v.string(),
  toWorkerName: v.string(),
  content: v.string(),
  timestamp: v.string(),
});

const InboundEventTypeSchema = v.picklist([
  'ci:completed', 'ci:failed', 'issue:closed', 'issue:labeled',
  'pr:merged', 'pr:review_comment', 'pr:changes_requested', 'pr:comment',
]);

const EventSourceSchema = v.picklist(['github', 'gitlab', 'internal']);

const SystemEventMetadataSchema = v.strictObject({
  repositoryName: v.optional(v.string()),
  branch: v.optional(v.string()),
  url: v.optional(v.string()),
  commitSha: v.optional(v.string()),
  labels: v.optional(v.array(v.string())),
});

const InboundEventSummarySchema = v.strictObject({
  type: InboundEventTypeSchema,
  source: EventSourceSchema,
  summary: v.string(),
  metadata: SystemEventMetadataSchema,
});

const HookCommandResultSchema = v.strictObject({
  success: v.boolean(),
  output: v.optional(v.string()),
  error: v.optional(v.string()),
});

export const WorktreeSchema = v.strictObject({
  path: v.string(),
  branch: v.string(),
  isMain: v.boolean(),
  repositoryId: v.string(),
  index: v.optional(v.number()),
});

const BranchNameFallbackSchema = v.strictObject({
  usedBranch: v.string(),
  reason: v.string(),
});

// === AppServerMessage variant schemas ===

const SessionsSyncSchema = v.strictObject({
  type: v.literal('sessions-sync'),
  sessions: v.array(SessionSchema),
  activityStates: v.array(WorkerActivityInfoSchema),
});

const SessionCreatedSchema = v.strictObject({
  type: v.literal('session-created'),
  session: SessionSchema,
});

const SessionUpdatedSchema = v.strictObject({
  type: v.literal('session-updated'),
  session: SessionSchema,
});

const SessionDeletedSchema = v.strictObject({
  type: v.literal('session-deleted'),
  sessionId: v.string(),
});

// State-specific session schemas to enforce invariants
const HibernatedSessionSchema = v.union([
  v.strictObject({
    ...WorktreeSessionSchema.entries,
    activationState: v.literal('hibernated'),
    pausedAt: v.string(),
  }),
  v.strictObject({
    ...QuickSessionSchema.entries,
    activationState: v.literal('hibernated'),
    pausedAt: v.string(),
  }),
]);

const RunningSessionSchema = v.union([
  v.strictObject({
    ...WorktreeSessionSchema.entries,
    activationState: v.literal('running'),
  }),
  v.strictObject({
    ...QuickSessionSchema.entries,
    activationState: v.literal('running'),
  }),
]);

const SessionPausedSchema = v.strictObject({
  type: v.literal('session-paused'),
  session: HibernatedSessionSchema,
});

const SessionResumedSchema = v.strictObject({
  type: v.literal('session-resumed'),
  session: RunningSessionSchema,
  activityStates: v.array(WorkerActivityInfoSchema),
});

const WorkerActivitySchema = v.strictObject({
  type: v.literal('worker-activity'),
  sessionId: v.string(),
  workerId: v.string(),
  activityState: AgentActivityStateSchema,
});

const WorkerActivatedSchema = v.strictObject({
  type: v.literal('worker-activated'),
  sessionId: v.string(),
  workerId: v.string(),
});

const AgentsSyncSchema = v.strictObject({
  type: v.literal('agents-sync'),
  agents: v.array(AgentDefinitionSchema),
});

const AgentCreatedSchema = v.strictObject({
  type: v.literal('agent-created'),
  agent: AgentDefinitionSchema,
});

const AgentUpdatedSchema = v.strictObject({
  type: v.literal('agent-updated'),
  agent: AgentDefinitionSchema,
});

const AgentDeletedSchema = v.strictObject({
  type: v.literal('agent-deleted'),
  agentId: v.string(),
});

const EmbeddedAgentCreatedSchema = v.strictObject({
  type: v.literal('embedded-agent-created'),
  embeddedAgent: EmbeddedAgentDefinitionSchema,
});

const EmbeddedAgentUpdatedSchema = v.strictObject({
  type: v.literal('embedded-agent-updated'),
  embeddedAgent: EmbeddedAgentDefinitionSchema,
});

const EmbeddedAgentDeletedSchema = v.strictObject({
  type: v.literal('embedded-agent-deleted'),
  embeddedAgentId: v.string(),
});

const RepositoriesSyncSchema = v.strictObject({
  type: v.literal('repositories-sync'),
  repositories: v.array(RepositorySchema),
});

const RepositoryCreatedSchema = v.strictObject({
  type: v.literal('repository-created'),
  repository: RepositorySchema,
});

const RepositoryUpdatedSchema = v.strictObject({
  type: v.literal('repository-updated'),
  repository: RepositorySchema,
});

const RepositoryDeletedSchema = v.strictObject({
  type: v.literal('repository-deleted'),
  repositoryId: v.string(),
});

export const WorktreeCreationCompletedSchema = v.strictObject({
  type: v.literal('worktree-creation-completed'),
  taskId: v.string(),
  worktree: WorktreeSchema,
  // The server broadcasts the full public Session here; the wire schema uses
  // the same `SessionSchema` as sessions-sync so strict parsing accepts every
  // field the server actually sends (the previous reduced inline schema only
  // survived because loose parsing silently stripped the extra keys).
  session: v.nullable(SessionSchema),
  branchNameFallback: v.optional(BranchNameFallbackSchema),
  setupCommandResult: v.optional(HookCommandResultSchema),
  fetchFailed: v.optional(v.boolean()),
  fetchError: v.optional(v.string()),
});

export const WorktreeCreationFailedSchema = v.strictObject({
  type: v.literal('worktree-creation-failed'),
  taskId: v.string(),
  error: v.string(),
});

/** Payload for the worktree-creation-completed WebSocket message (the message minus its `type` discriminant). */
export type WorktreeCreationCompletedPayload = Omit<v.InferOutput<typeof WorktreeCreationCompletedSchema>, 'type'>;

/** Payload for the worktree-creation-failed WebSocket message (the message minus its `type` discriminant). */
export type WorktreeCreationFailedPayload = Omit<v.InferOutput<typeof WorktreeCreationFailedSchema>, 'type'>;

const WorktreeDeletionCompletedSchema = v.strictObject({
  type: v.literal('worktree-deletion-completed'),
  taskId: v.string(),
  sessionIds: v.array(v.string()),
  cleanupCommandResult: v.optional(HookCommandResultSchema),
  killErrors: v.optional(v.array(v.strictObject({
    sessionId: v.string(),
    error: v.string(),
  }))),
});

const WorktreeDeletionFailedSchema = v.strictObject({
  type: v.literal('worktree-deletion-failed'),
  taskId: v.string(),
  sessionIds: v.array(v.string()),
  error: v.string(),
  gitStatus: v.optional(v.string()),
});

const WorktreePullCompletedSchema = v.strictObject({
  type: v.literal('worktree-pull-completed'),
  taskId: v.string(),
  worktreePath: v.string(),
  branch: v.string(),
  commitsPulled: v.number(),
});

const WorktreePullFailedSchema = v.strictObject({
  type: v.literal('worktree-pull-failed'),
  taskId: v.string(),
  worktreePath: v.string(),
  error: v.string(),
});

const WorkerMessageEventSchema = v.strictObject({
  type: v.literal('worker-message'),
  message: WorkerMessageSchema,
});

const InboundEventSchema = v.strictObject({
  type: v.literal('inbound-event'),
  sessionId: v.string(),
  event: InboundEventSummarySchema,
});

const WorkerRestartedSchema = v.strictObject({
  type: v.literal('worker-restarted'),
  sessionId: v.string(),
  workerId: v.string(),
  activityState: AgentActivityStateSchema,
});

const MemoUpdatedSchema = v.strictObject({
  type: v.literal('memo-updated'),
  sessionId: v.string(),
  content: v.string(),
});

const ReviewQueueUpdatedSchema = v.strictObject({
  type: v.literal('review-queue-updated'),
});

// Realtime refresh triggers. These carry at most an id -- never
// title/url/content/etc. -- per N1 ("a broadcast is never a source of
// list content"): the client re-fetches the authoritative REST endpoint on
// receipt and never renders anything from the broadcast payload itself. See
// `notification-service.ts`'s `NotificationServiceDeps` doc comment.
const ArtifactCreatedSchema = v.strictObject({
  type: v.literal('artifact-created'),
  sessionId: v.string(),
  artifactId: v.string(),
});

const ArtifactDeletedSchema = v.strictObject({
  type: v.literal('artifact-deleted'),
  sessionId: v.string(),
  artifactId: v.string(),
});

const BookmarkCreatedSchema = v.strictObject({
  type: v.literal('bookmark-created'),
  sessionId: v.string(),
  bookmarkId: v.string(),
});

const BookmarkDeletedSchema = v.strictObject({
  type: v.literal('bookmark-deleted'),
  sessionId: v.string(),
  bookmarkId: v.string(),
});

const OrchestratorDesignationChangedSchema = v.strictObject({
  type: v.literal('orchestrator-designation-changed'),
  repositoryId: v.string(),
  // The full re-read set after the change, so a client never needs to
  // reconcile an add/remove delta locally (see docs/design/shared-orchestrator-session.md, "Designation in multi-user").
  orchestratorSessionIds: v.array(v.string()),
  // The single session whose add/remove caused this broadcast.
  changedSessionId: v.string(),
  action: v.picklist(['added', 'removed']),
});

/**
 * Standalone schema for the schema-version frame sent as the first message on
 * `/ws/app`. Exported separately (not only as part of the envelope) so the
 * client can parse this single frame independently: drift in any other variant
 * must never prevent version detection.
 */
export const SchemaVersionMessageSchema = v.strictObject({
  type: v.literal('schema-version'),
  version: v.string(),
});

// === Discriminated union ===

/**
 * Valibot schema for all AppServerMessage variants.
 * Uses v.variant() for discriminated union on 'type' field.
 */
export const AppServerMessageSchema = v.variant('type', [
  SessionsSyncSchema,
  SessionCreatedSchema,
  SessionUpdatedSchema,
  SessionDeletedSchema,
  SessionPausedSchema,
  SessionResumedSchema,
  WorkerActivitySchema,
  WorkerActivatedSchema,
  AgentsSyncSchema,
  AgentCreatedSchema,
  AgentUpdatedSchema,
  AgentDeletedSchema,
  EmbeddedAgentCreatedSchema,
  EmbeddedAgentUpdatedSchema,
  EmbeddedAgentDeletedSchema,
  RepositoriesSyncSchema,
  RepositoryCreatedSchema,
  RepositoryUpdatedSchema,
  RepositoryDeletedSchema,
  WorktreeCreationCompletedSchema,
  WorktreeCreationFailedSchema,
  WorktreeDeletionCompletedSchema,
  WorktreeDeletionFailedSchema,
  WorktreePullCompletedSchema,
  WorktreePullFailedSchema,
  WorkerMessageEventSchema,
  InboundEventSchema,
  WorkerRestartedSchema,
  MemoUpdatedSchema,
  ReviewQueueUpdatedSchema,
  ArtifactCreatedSchema,
  ArtifactDeletedSchema,
  BookmarkCreatedSchema,
  BookmarkDeletedSchema,
  OrchestratorDesignationChangedSchema,
  SchemaVersionMessageSchema,
]);

// AppServerMessage lives beside its schema, not in types/session.ts, for
// two independent, still-current reasons.
//
// First: `.dependency-cruiser.cjs`'s `shared-no-types-import-schemas` rule
// forbids any import from packages/shared/src/types into
// packages/shared/src/schemas, unconditionally -- deriving this type in
// types/session.ts would need a type-only import of AppServerMessageSchema
// from this file, which that rule rejects outright regardless of whether a
// cycle exists.
//
// Second: this placement is a deliberate anti-recurrence guard against a
// cycle shape that has occurred before -- a type-only import added into
// types/session.ts from elsewhere in types/ that, combined with a
// types/session.ts -> schemas/app-server-message.ts edge, would close a
// ring through schemas/app-server-message.ts -> schemas/embedded-agent.ts
// -> types/embedded-agent.ts and back. No such closing edge exists in the
// graph today, so this guard is forward-looking, not a currently live
// cycle. The circularity linter in place when this guard was written could
// not distinguish that type-only ring from a value one, so it would have
// rejected it outright with no allowlist mechanism. That linter has since
// been retired, and dependency-cruiser's `no-circular` rule would
// today permit an all-type-only ring like that one (its `viaOnly` clause,
// see `.dependency-cruiser.cjs`) -- but the layering rule above blocks
// moving this type regardless of that policy, so the guard's conclusion
// (keep the type here) still holds even though the retired linter's blind
// spot is no longer the operative reason. See `worker-types.ts`'s
// `RestoreInfo` doc comment for the sibling case, where cycle-avoidance
// (not a layering rule) was the retired linter's actual blind spot.
export type AppServerMessage = v.InferOutput<typeof AppServerMessageSchema>;
