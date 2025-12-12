import * as v from 'valibot';

/**
 * Base options for worker creation
 */
const WorkerOptionsSchema = v.object({
  name: v.optional(v.string()),
  continueConversation: v.optional(v.boolean()),
});

/**
 * Schema for creating an agent worker
 */
export const CreateAgentWorkerRequestSchema = v.object({
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
export const CreateTerminalWorkerRequestSchema = v.object({
  ...WorkerOptionsSchema.entries,
  type: v.literal('terminal'),
});

/**
 * Schema for creating any worker (union)
 */
export const CreateWorkerRequestSchema = v.union([
  CreateAgentWorkerRequestSchema,
  CreateTerminalWorkerRequestSchema,
]);

/**
 * Schema for restarting a worker
 */
export const RestartWorkerRequestSchema = v.object({
  continueConversation: v.optional(v.boolean()),
});

// Inferred types from schemas
export type CreateAgentWorkerRequest = v.InferOutput<typeof CreateAgentWorkerRequestSchema>;
export type CreateTerminalWorkerRequest = v.InferOutput<typeof CreateTerminalWorkerRequestSchema>;
export type CreateWorkerRequest = v.InferOutput<typeof CreateWorkerRequestSchema>;
export type RestartWorkerRequest = v.InferOutput<typeof RestartWorkerRequestSchema>;
