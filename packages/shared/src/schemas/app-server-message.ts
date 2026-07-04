import * as v from 'valibot';
import { AgentDefinitionSchema } from './agent.js';

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

const WorkerSchema = v.union([AgentWorkerSchema, TerminalWorkerSchema, GitDiffWorkerSchema]);

// === Session schemas ===

const SessionBaseSchema = v.strictObject({
  id: v.string(),
  locationPath: v.string(),
  status: SessionStatusSchema,
  activationState: SessionActivationStateSchema,
  createdAt: v.string(),
  workers: v.array(WorkerSchema),
  initialPrompt: v.optional(v.string()),
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
  SchemaVersionMessageSchema,
]);
