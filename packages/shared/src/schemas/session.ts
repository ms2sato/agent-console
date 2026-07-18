import * as v from 'valibot';

/**
 * Schema for creating a worktree session
 */
export const CreateWorktreeSessionRequestSchema = v.pipe(
  v.strictObject({
    type: v.literal('worktree'),
    repositoryId: v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1, 'Repository ID is required')
    ),
    worktreeId: v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1, 'Worktree ID is required')
    ),
    locationPath: v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1, 'Location path is required')
    ),
    agentId: v.optional(v.string()),
    /**
     * Embedded-agent selection for the initial worker. Mutually exclusive
     * with `agentId`.
     */
    embeddedAgentId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'Embedded agent ID cannot be empty'))),
    continueConversation: v.optional(v.boolean()),
    initialPrompt: v.optional(v.string()),
    title: v.optional(v.string()),
    parentSessionId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
    parentWorkerId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
    /**
     * When true, create a shared session (PTY runs as the configured shared
     * account). Requires AGENT_CONSOLE_SHARED_USERNAME to be set on the server.
     * See docs/design/shared-orchestrator-session.md.
     */
    shared: v.optional(v.boolean()),
    templateVars: v.optional(
      v.record(
        v.pipe(
          v.string(),
          v.regex(/^\w+$/, 'Template variable keys must be alphanumeric/underscore only'),
          v.check(
            (key) => key !== 'prompt' && key !== 'cwd',
            'Cannot override reserved template variables: prompt, cwd'
          )
        ),
        v.string()
      )
    ),
  }),
  v.check(
    (val) => !(val.agentId && val.embeddedAgentId),
    'Cannot specify both agentId and embeddedAgentId',
  ),
);

/**
 * Schema for creating a quick session
 */
export const CreateQuickSessionRequestSchema = v.pipe(
  v.strictObject({
    type: v.literal('quick'),
    locationPath: v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1, 'Location path is required')
    ),
    agentId: v.optional(v.string()),
    /**
     * Embedded-agent selection for the initial worker. Mutually exclusive
     * with `agentId`.
     */
    embeddedAgentId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'Embedded agent ID cannot be empty'))),
    continueConversation: v.optional(v.boolean()),
    initialPrompt: v.optional(v.string()),
    title: v.optional(v.string()),
    parentSessionId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
    parentWorkerId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
    /**
     * When true, create a shared session (PTY runs as the configured shared
     * account). Requires AGENT_CONSOLE_SHARED_USERNAME to be set on the server.
     * See docs/design/shared-orchestrator-session.md.
     */
    shared: v.optional(v.boolean()),
    templateVars: v.optional(
      v.record(
        v.pipe(
          v.string(),
          v.regex(/^\w+$/, 'Template variable keys must be alphanumeric/underscore only'),
          v.check(
            (key) => key !== 'prompt' && key !== 'cwd',
            'Cannot override reserved template variables: prompt, cwd'
          )
        ),
        v.string()
      )
    ),
  }),
  v.check(
    (val) => !(val.agentId && val.embeddedAgentId),
    'Cannot specify both agentId and embeddedAgentId',
  ),
);

/**
 * Schema for creating any session (union)
 */
export const CreateSessionRequestSchema = v.union([
  CreateWorktreeSessionRequestSchema,
  CreateQuickSessionRequestSchema,
]);

/**
 * Branch name validation regex pattern
 * Valid: alphanumeric, dots, underscores, slashes, hyphens
 */
export const branchNamePattern = /^[a-zA-Z0-9._/-]+$/;

/**
 * Branch name validation error message
 */
export const branchNameErrorMessage = 'Invalid branch name. Use alphanumeric, dots, underscores, slashes, or hyphens.';

/**
 * Schema for updating a session (title only)
 * Branch renaming is now handled via the restart worker endpoint.
 */
export const UpdateSessionRequestSchema = v.strictObject({
  title: v.optional(v.pipe(v.string(), v.trim())),
});

/**
 * Schema for deleting a session.
 * Quick sessions are deleted synchronously without task management.
 * For worktree sessions with async deletion, use the worktree deletion endpoint instead.
 */
export const DeleteSessionRequestSchema = v.strictObject({});

/**
 * Standalone schema for the `restore-info` WorkerServerMessage variant
 * (Transcript Restore, #1123). `WorkerServerMessage` as a whole has no
 * existing valibot union to extend (server sends raw typed literals; the
 * client does an unchecked `as WorkerServerMessage` cast) -- building a
 * full 8-variant union schema is out of scope here. This schema exists
 * so an integration test can catch server/client field-shape drift for
 * this specific new field per pre-pr-completeness.md Q10, without
 * retrofitting runtime validation onto the unrelated existing variants.
 */
export const RestoreInfoMessageSchema = v.strictObject({
  type: v.literal('restore-info'),
  epoch: v.pipe(v.number(), v.integer(), v.minValue(0)),
  messageCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  repairedToolCallIds: v.array(v.string()),
});

// Inferred types from schemas
export type CreateWorktreeSessionRequest = v.InferOutput<typeof CreateWorktreeSessionRequestSchema>;
export type CreateQuickSessionRequest = v.InferOutput<typeof CreateQuickSessionRequestSchema>;
export type CreateSessionRequest = v.InferOutput<typeof CreateSessionRequestSchema>;
export type UpdateSessionRequest = v.InferOutput<typeof UpdateSessionRequestSchema>;
export type DeleteSessionRequest = v.InferOutput<typeof DeleteSessionRequestSchema>;
