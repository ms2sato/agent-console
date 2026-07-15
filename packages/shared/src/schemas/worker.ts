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
