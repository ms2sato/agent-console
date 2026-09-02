import * as v from 'valibot';
import { AgentDefinitionSchema } from './agent.js';
import { EmbeddedAgentDefinitionSchema } from './embedded-agent.js';

// === Primitive schemas ===

const SessionStatusSchema = v.picklist(['active', 'inactive']);
const SessionActivationStateSchema = v.picklist(['running', 'hibernated']);
const AgentActivityStateSchema = v.picklist(['active', 'idle', 'asking', 'unknown']);

// === Worker schemas ===

const WorkerBaseSchema = v.strictObject({
  id: v.string(),
  name: v.string(),
  createdAt: v.string(),
});

const AgentWorkerSchema = v.strictObject({
  ...WorkerBaseSchema.entries,
  type: v.literal('agent'),
  agentId: v.string(),
  activated: v.boolean(),
});

const TerminalWorkerSchema = v.strictObject({
  ...WorkerBaseSchema.entries,
  type: v.literal('terminal'),
  activated: v.boolean(),
});

const GitDiffWorkerSchema = v.strictObject({
  ...WorkerBaseSchema.entries,
  type: v.literal('git-diff'),
  baseCommit: v.string(),
});

const EmbeddedAgentWorkerSchema = v.strictObject({
  ...WorkerBaseSchema.entries,
  type: v.literal('embedded-agent'),
  embeddedAgentId: v.string(),
  activated: v.boolean(),
  // Compaction's per-worker auto toggle. Mirrors EmbeddedAgentWorker in
  // types/worker.ts -- this object is strict, so the field must exist here
  // or it is stripped off the wire with no error on either side.
  autoCompaction: v.boolean(),
  // Effective context-window token denominator. Mirrors EmbeddedAgentWorker
  // in types/worker.ts -- this object is strict, so the field must exist
  // here or it is stripped off the wire with no error on either side.
  contextWindowTokens: v.optional(v.number()),
});

const WorkerSchema = v.union([
  AgentWorkerSchema,
  TerminalWorkerSchema,
  GitDiffWorkerSchema,
  EmbeddedAgentWorkerSchema,
]);

// === Session schemas ===

const SessionBaseSchema = v.strictObject({
  id: v.string(),
  locationPath: v.string(),
  status: SessionStatusSchema,
  activationState: SessionActivationStateSchema,
  createdAt: v.string(),
  workers: v.array(WorkerSchema),
  initialPrompt: v.optional(v.string()),
  initialPromptDelivered: v.optional(v.boolean()),
  title: v.optional(v.string()),
  pausedAt: v.optional(v.string()),
  parentSessionId: v.optional(v.string()),
  parentWorkerId: v.optional(v.string()),
  createdBy: v.optional(v.string()),
  createdByUsername: v.optional(v.nullable(v.string())),
  initiatedBy: v.optional(v.string()),
  isShared: v.boolean(),
  recoveryState: v.picklist(['healthy', 'orphaned']),
});

const WorktreeSessionSchema = v.strictObject({
  ...SessionBaseSchema.entries,
  type: v.literal('worktree'),
  repositoryId: v.string(),
  repositoryName: v.string(),
  worktreeId: v.string(),
  isMainWorktree: v.boolean(),
});

const QuickSessionSchema = v.strictObject({
  ...SessionBaseSchema.entries,
  type: v.literal('quick'),
});

const SessionSchema = v.union([WorktreeSessionSchema, QuickSessionSchema]);

// === Supporting schemas ===

const WorkerActivityInfoSchema = v.strictObject({
  sessionId: v.string(),
  workerId: v.string(),
  activityState: AgentActivityStateSchema,
});

const RepositorySchema = v.strictObject({
  id: v.string(),
  name: v.string(),
  path: v.string(),
  createdAt: v.string(),
  remoteUrl: v.optional(v.string()),
  setupCommand: v.optional(v.nullable(v.string())),
  cleanupCommand: v.optional(v.nullable(v.string())),
  envVars: v.optional(v.nullable(v.string())),
  description: v.optional(v.nullable(v.string())),
  defaultAgentId: v.optional(v.nullable(v.string())),
  // Required (not optional) so every broadcast carries a defined value;
  // server derives via `withRepositoryRemote` against `getSourceReposDir()`.
  clonedSourceRepoPath: v.nullable(v.string()),
});

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
  'ci:completed', 'ci:failed', 'issue:closed',
  'pr:merged', 'pr:review_comment', 'pr:changes_requested', 'pr:comment',
]);

const EventSourceSchema = v.picklist(['github', 'gitlab', 'internal']);

const SystemEventMetadataSchema = v.strictObject({
  repositoryName: v.optional(v.string()),
  branch: v.optional(v.string()),
  url: v.optional(v.string()),
  commitSha: v.optional(v.string()),
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

const WorktreeSchema = v.strictObject({
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

const WorktreeCreationCompletedSchema = v.strictObject({
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

const WorktreeCreationFailedSchema = v.strictObject({
  type: v.literal('worktree-creation-failed'),
  taskId: v.string(),
  error: v.string(),
});

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
