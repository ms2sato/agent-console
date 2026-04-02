import * as v from 'valibot';
import { AgentDefinitionSchema } from './agent.js';

// === Primitive schemas ===

const SessionStatusSchema = v.picklist(['active', 'inactive']);
const SessionActivationStateSchema = v.picklist(['running', 'hibernated']);
const AgentActivityStateSchema = v.picklist(['active', 'idle', 'asking', 'unknown']);

// === Worker schemas ===

const WorkerBaseSchema = v.object({
  id: v.string(),
  name: v.string(),
  createdAt: v.string(),
});

const AgentWorkerSchema = v.object({
  ...WorkerBaseSchema.entries,
  type: v.literal('agent'),
  agentId: v.string(),
  activated: v.boolean(),
});

const TerminalWorkerSchema = v.object({
  ...WorkerBaseSchema.entries,
  type: v.literal('terminal'),
  activated: v.boolean(),
});

const GitDiffWorkerSchema = v.object({
  ...WorkerBaseSchema.entries,
  type: v.literal('git-diff'),
  baseCommit: v.string(),
});

const WorkerSchema = v.union([AgentWorkerSchema, TerminalWorkerSchema, GitDiffWorkerSchema]);

// === Session schemas ===

const SessionBaseSchema = v.object({
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
});

const WorktreeSessionSchema = v.object({
  ...SessionBaseSchema.entries,
  type: v.literal('worktree'),
  repositoryId: v.string(),
  repositoryName: v.string(),
  worktreeId: v.string(),
  isMainWorktree: v.boolean(),
});

const QuickSessionSchema = v.object({
  ...SessionBaseSchema.entries,
  type: v.literal('quick'),
});

const SessionSchema = v.union([WorktreeSessionSchema, QuickSessionSchema]);

// === Supporting schemas ===

const WorkerActivityInfoSchema = v.object({
  sessionId: v.string(),
  workerId: v.string(),
  activityState: AgentActivityStateSchema,
});

const RepositorySchema = v.object({
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
});

const WorkerMessageSchema = v.object({
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

const SystemEventMetadataSchema = v.object({
  repositoryName: v.optional(v.string()),
  branch: v.optional(v.string()),
  url: v.optional(v.string()),
  commitSha: v.optional(v.string()),
});

const InboundEventSummarySchema = v.object({
  type: InboundEventTypeSchema,
  source: EventSourceSchema,
  summary: v.string(),
  metadata: SystemEventMetadataSchema,
});

const HookCommandResultSchema = v.object({
  success: v.boolean(),
  output: v.optional(v.string()),
  error: v.optional(v.string()),
});

const WorktreeSchema = v.object({
  path: v.string(),
  branch: v.string(),
  isMain: v.boolean(),
  repositoryId: v.string(),
  index: v.optional(v.number()),
});

const BranchNameFallbackSchema = v.object({
  usedBranch: v.string(),
  reason: v.string(),
});

// Worktree creation session - inlined to avoid circular dependency (matches worktree-creation.ts)
const WorktreeCreationSessionSchema = v.union([
  v.object({
    type: v.literal('worktree'),
    id: v.string(),
    locationPath: v.string(),
    status: v.picklist(['active', 'inactive']),
    createdAt: v.string(),
    workers: v.array(WorkerSchema),
    initialPrompt: v.optional(v.string()),
    title: v.optional(v.string()),
    repositoryId: v.string(),
    repositoryName: v.string(),
    worktreeId: v.string(),
  }),
  v.object({
    type: v.literal('quick'),
    id: v.string(),
    locationPath: v.string(),
    status: v.picklist(['active', 'inactive']),
    createdAt: v.string(),
    workers: v.array(WorkerSchema),
    initialPrompt: v.optional(v.string()),
    title: v.optional(v.string()),
  }),
]);

// === AppServerMessage variant schemas ===

const SessionsSyncSchema = v.object({
  type: v.literal('sessions-sync'),
  sessions: v.array(SessionSchema),
  activityStates: v.array(WorkerActivityInfoSchema),
});

const SessionCreatedSchema = v.object({
  type: v.literal('session-created'),
  session: SessionSchema,
});

const SessionUpdatedSchema = v.object({
  type: v.literal('session-updated'),
  session: SessionSchema,
});

const SessionDeletedSchema = v.object({
  type: v.literal('session-deleted'),
  sessionId: v.string(),
});

// State-specific session schemas to enforce invariants
const HibernatedSessionSchema = v.union([
  v.object({
    ...WorktreeSessionSchema.entries,
    activationState: v.literal('hibernated'),
    pausedAt: v.string(),
  }),
  v.object({
    ...QuickSessionSchema.entries,
    activationState: v.literal('hibernated'),
    pausedAt: v.string(),
  }),
]);

const RunningSessionSchema = v.union([
  v.object({
    ...WorktreeSessionSchema.entries,
    activationState: v.literal('running'),
  }),
  v.object({
    ...QuickSessionSchema.entries,
    activationState: v.literal('running'),
  }),
]);

const SessionPausedSchema = v.object({
  type: v.literal('session-paused'),
  session: HibernatedSessionSchema,
});

const SessionResumedSchema = v.object({
  type: v.literal('session-resumed'),
  session: RunningSessionSchema,
  activityStates: v.array(WorkerActivityInfoSchema),
});

const WorkerActivitySchema = v.object({
  type: v.literal('worker-activity'),
  sessionId: v.string(),
  workerId: v.string(),
  activityState: AgentActivityStateSchema,
});

const WorkerActivatedSchema = v.object({
  type: v.literal('worker-activated'),
  sessionId: v.string(),
  workerId: v.string(),
});

const AgentsSyncSchema = v.object({
  type: v.literal('agents-sync'),
  agents: v.array(AgentDefinitionSchema),
});

const AgentCreatedSchema = v.object({
  type: v.literal('agent-created'),
  agent: AgentDefinitionSchema,
});

const AgentUpdatedSchema = v.object({
  type: v.literal('agent-updated'),
  agent: AgentDefinitionSchema,
});

const AgentDeletedSchema = v.object({
  type: v.literal('agent-deleted'),
  agentId: v.string(),
});

const RepositoriesSyncSchema = v.object({
  type: v.literal('repositories-sync'),
  repositories: v.array(RepositorySchema),
});

const RepositoryCreatedSchema = v.object({
  type: v.literal('repository-created'),
  repository: RepositorySchema,
});

const RepositoryUpdatedSchema = v.object({
  type: v.literal('repository-updated'),
  repository: RepositorySchema,
});

const RepositoryDeletedSchema = v.object({
  type: v.literal('repository-deleted'),
  repositoryId: v.string(),
});

const WorktreeCreationCompletedSchema = v.object({
  type: v.literal('worktree-creation-completed'),
  taskId: v.string(),
  worktree: WorktreeSchema,
  session: v.nullable(WorktreeCreationSessionSchema),
  branchNameFallback: v.optional(BranchNameFallbackSchema),
  setupCommandResult: v.optional(HookCommandResultSchema),
  fetchFailed: v.optional(v.boolean()),
  fetchError: v.optional(v.string()),
});

const WorktreeCreationFailedSchema = v.object({
  type: v.literal('worktree-creation-failed'),
  taskId: v.string(),
  error: v.string(),
});

const WorktreeDeletionCompletedSchema = v.object({
  type: v.literal('worktree-deletion-completed'),
  taskId: v.string(),
  sessionId: v.string(),
  cleanupCommandResult: v.optional(HookCommandResultSchema),
  killErrors: v.optional(v.array(v.object({
    sessionId: v.string(),
    error: v.string(),
  }))),
});

const WorktreeDeletionFailedSchema = v.object({
  type: v.literal('worktree-deletion-failed'),
  taskId: v.string(),
  sessionId: v.string(),
  error: v.string(),
  gitStatus: v.optional(v.string()),
});

const WorktreePullCompletedSchema = v.object({
  type: v.literal('worktree-pull-completed'),
  taskId: v.string(),
  worktreePath: v.string(),
  branch: v.string(),
  commitsPulled: v.number(),
});

const WorktreePullFailedSchema = v.object({
  type: v.literal('worktree-pull-failed'),
  taskId: v.string(),
  worktreePath: v.string(),
  error: v.string(),
});

const WorkerMessageEventSchema = v.object({
  type: v.literal('worker-message'),
  message: WorkerMessageSchema,
});

const InboundEventSchema = v.object({
  type: v.literal('inbound-event'),
  sessionId: v.string(),
  event: InboundEventSummarySchema,
});

const WorkerRestartedSchema = v.object({
  type: v.literal('worker-restarted'),
  sessionId: v.string(),
  workerId: v.string(),
  activityState: AgentActivityStateSchema,
});

const MemoUpdatedSchema = v.object({
  type: v.literal('memo-updated'),
  sessionId: v.string(),
  content: v.string(),
});

const ReviewQueueUpdatedSchema = v.object({
  type: v.literal('review-queue-updated'),
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
]);
