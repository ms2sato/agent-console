import * as v from 'valibot';
import { branchNamePattern, branchNameErrorMessage } from './session.js';

/**
 * Base options for worker creation
 */
const WorkerOptionsSchema = v.object({
  name: v.optional(v.string()),
  continueConversation: v.optional(v.boolean()),
});

/**
 * Schema for creating an agent worker (internal use only)
 */
const CreateAgentWorkerParamsSchema = v.object({
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
const CreateTerminalWorkerParamsSchema = v.object({
  ...WorkerOptionsSchema.entries,
  type: v.literal('terminal'),
});

/**
 * Schema for creating a git diff worker (internal use only)
 */
const CreateGitDiffWorkerParamsSchema = v.object({
  name: v.optional(v.string()),
  type: v.literal('git-diff'),
  // baseCommit is optional - if not provided, server calculates merge-base with default branch
  baseCommit: v.optional(v.string()),
});

/**
 * Schema for API: only terminal workers can be created by client
 */
export const CreateWorkerRequestSchema = CreateTerminalWorkerParamsSchema;

/**
 * Schema for restarting a worker
 */
export const RestartWorkerRequestSchema = v.object({
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
export type CreateWorkerParams = CreateAgentWorkerParams | CreateTerminalWorkerParams | CreateGitDiffWorkerParams;

// API types (client can only create terminal workers)
export type CreateWorkerRequest = v.InferOutput<typeof CreateWorkerRequestSchema>;
export type RestartWorkerRequest = v.InferOutput<typeof RestartWorkerRequestSchema>;
