import * as v from 'valibot';
import { branchNamePattern, branchNameErrorMessage } from './session.js';

/**
 * Base options for worker creation
 */
const WorkerOptionsSchema = v.strictObject({
  name: v.optional(v.string()),
  continueConversation: v.optional(v.boolean()),
});

/**
 * Schema for creating a terminal-agent-backed worker. Reachable both from
 * the internal session-creation path and from the client via the unified
 * agent-selection picker.
 */
const CreateAgentWorkerParamsSchema = v.strictObject({
  ...WorkerOptionsSchema.entries,
  type: v.literal('agent'),
  agentId: v.pipe(
    v.string(),
    v.minLength(1, 'Agent ID is required')
  ),
  /**
   * Model override for this worker's PTY spawn (agent-surface.md Ruling 2).
   * Pass-through, no value validation beyond non-empty after trim.
   * Rejected at createWorker() time (ValidationError) unless the resolved
   * agent's commandTemplate consumes {{ model...}} -- see
   * getAgentParameterCapabilities in @agent-console/shared.
   */
  model: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'model must not be empty'))),
  /**
   * Reasoning-effort override for this worker's PTY spawn
   * (agent-surface.md Ruling 2). Populates the {{ effort...}} template variable, NOT
   * {{ reasoningEffort...}} -- see buildAgentParameterTemplateVars.
   */
  reasoningEffort: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'reasoningEffort must not be empty'))),
  /**
   * Context-window override. NOT a terminal-agent concept -- always
   * rejected at createWorker() time (agent-surface.md Ruling 4:
   * embedded-agent-only, kind-level rejection, not a capability-table row).
   * Declared here (rather than left off the schema, which would produce a
   * generic "unrecognized key" 400) so a caller who submits it alongside a
   * terminal-agent selection gets the same domain-specific ValidationError
   * as the model/reasoningEffort capability checks above, and so the
   * session/worktree-creation routes (which carry this field regardless of
   * whether the initial worker turns out to be terminal or embedded) can
   * forward it through to the single validation choke point instead of
   * silently dropping it.
   */
  contextWindowTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

/**
 * Schema for creating a terminal worker
 */
const CreateTerminalWorkerParamsSchema = v.strictObject({
  ...WorkerOptionsSchema.entries,
  type: v.literal('terminal'),
});

/**
 * Schema for creating a git diff worker (internal use only)
 */
const CreateGitDiffWorkerParamsSchema = v.strictObject({
  name: v.optional(v.string()),
  type: v.literal('git-diff'),
  // baseCommit is optional - if not provided, server calculates merge-base with default branch
  baseCommit: v.optional(v.string()),
});

/**
 * Schema for creating an embedded-agent worker
 */
const CreateEmbeddedAgentWorkerParamsSchema = v.strictObject({
  name: v.optional(v.string()),
  type: v.literal('embedded-agent'),
  embeddedAgentId: v.pipe(v.string(), v.minLength(1, 'Embedded agent ID is required')),
  /**
   * Model override for this worker (agent-surface.md Ruling 1/2).
   * Pass-through, no value validation beyond non-empty after trim. Rejected
   * at createWorker() time (ValidationError) unless the resolved
   * definition's engine capability table declares `model.capable === true`
   * -- see EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES in
   * @agent-console/shared (embedded-agent-parameter-capabilities.ts).
   */
  model: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'model must not be empty'))),
  /**
   * Reasoning-effort override for this worker (agent-surface.md Ruling
   * 1/2). Rejected at createWorker() time unless the engine's capability
   * table declares `reasoningEffort.capable === true`; when the table also
   * declares a closed `acceptedValues` list (e.g. claude-sdk's EFFORT_LEVELS),
   * a value outside that list is rejected too.
   */
  reasoningEffort: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'reasoningEffort must not be empty'))),
  /**
   * Context-window override for this worker (agent-surface.md Ruling 4).
   * Only accepted alongside a `model` override -- a declared window with no
   * model change would silently apply to a model it wasn't declared for.
   * Rejected at createWorker() time when present without `model`.
   */
  contextWindowTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

/**
 * Schema for API: clients can create terminal, embedded-agent, and agent
 * worker types. Agent workers can be added to an already-running session via
 * the unified agent-selection picker, not just at session-creation time.
 */
export const CreateWorkerRequestSchema = v.union([
  CreateTerminalWorkerParamsSchema,
  CreateEmbeddedAgentWorkerParamsSchema,
  CreateAgentWorkerParamsSchema,
]);

/**
 * Schema for updating an embedded-agent worker's own settings.
 *
 * Only `autoCompaction` today. A PATCH rather than a WebSocket command
 * because this is durable per-worker configuration, not a per-turn signal --
 * REST is where this codebase puts durable writes.
 */
export const UpdateEmbeddedAgentWorkerRequestSchema = v.strictObject({
  autoCompaction: v.boolean(),
});

/**
 * Schema for restarting a worker
 */
export const RestartWorkerRequestSchema = v.strictObject({
  continueConversation: v.optional(v.boolean()),
  agentId: v.optional(v.pipe(v.string(), v.minLength(1, 'Agent ID must not be empty'))),
  branch: v.optional(v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Branch name cannot be empty'),
    v.regex(branchNamePattern, branchNameErrorMessage)
  )),
});

// Internal types for server-side worker creation
export type CreateAgentWorkerParams = v.InferOutput<typeof CreateAgentWorkerParamsSchema>;
export type CreateTerminalWorkerParams = v.InferOutput<typeof CreateTerminalWorkerParamsSchema>;
export type CreateGitDiffWorkerParams = v.InferOutput<typeof CreateGitDiffWorkerParamsSchema>;
export type CreateEmbeddedAgentWorkerParams = v.InferOutput<typeof CreateEmbeddedAgentWorkerParamsSchema>;
export type CreateWorkerParams =
  | CreateAgentWorkerParams
  | CreateTerminalWorkerParams
  | CreateGitDiffWorkerParams
  | CreateEmbeddedAgentWorkerParams;

// API types (client can create terminal, embedded-agent, and agent workers)
export type CreateWorkerRequest = v.InferOutput<typeof CreateWorkerRequestSchema>;
export type RestartWorkerRequest = v.InferOutput<typeof RestartWorkerRequestSchema>;

export type UpdateEmbeddedAgentWorkerRequest = v.InferOutput<typeof UpdateEmbeddedAgentWorkerRequestSchema>;
