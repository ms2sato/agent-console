import * as v from 'valibot';

/**
 * Initial prompt mode - how to pass the initial prompt to the agent
 */
export const InitialPromptModeSchema = v.picklist(['stdin', 'arg']);

/**
 * Agent activity patterns for detection
 */
export const AgentActivityPatternsSchema = v.object({
  askingPatterns: v.optional(v.array(v.string())),
});

/**
 * Schema for creating a new agent
 */
export const CreateAgentRequestSchema = v.object({
  name: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Name is required')
  ),
  command: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Command is required')
  ),
  description: v.optional(v.string()),
  icon: v.optional(v.string()),
  activityPatterns: v.optional(AgentActivityPatternsSchema),
  continueArgs: v.optional(v.array(v.string())),
  initialPromptMode: v.optional(InitialPromptModeSchema),
  initialPromptDelayMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

/**
 * Schema for updating an existing agent
 */
export const UpdateAgentRequestSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'Name cannot be empty'))),
  command: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'Command cannot be empty'))),
  description: v.optional(v.string()),
  icon: v.optional(v.string()),
  activityPatterns: v.optional(AgentActivityPatternsSchema),
  continueArgs: v.optional(v.array(v.string())),
  initialPromptMode: v.optional(InitialPromptModeSchema),
  initialPromptDelayMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

// Inferred types from schemas
export type CreateAgentRequest = v.InferOutput<typeof CreateAgentRequestSchema>;
export type UpdateAgentRequest = v.InferOutput<typeof UpdateAgentRequestSchema>;
export type AgentActivityPatterns = v.InferOutput<typeof AgentActivityPatternsSchema>;
export type InitialPromptMode = v.InferOutput<typeof InitialPromptModeSchema>;
