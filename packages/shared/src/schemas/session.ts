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
 * `sdkResumed`'s shared doc: Transcript Restore, R1: did the `claude-sdk`
 * engine's SDK session actually resume? Set ONLY by that engine;
 * `openai-api` omits the field entirely, because it has no such concept.
 * Applies IDENTICALLY to both branches of `RestoreInfoMessageSchema` below.
 *
 * Three-valued, and the third value is not a loading race: `absent` means
 * "this engine does not have the concept", `false` means "this
 * incarnation's SDK session did not resume" -- defined by the OUTCOME,
 * never by an attempt, since three of its four routes never send a
 * `resume`. The route list lives with the wire type in
 * `types/session.ts`'s `restore-info` member; this comment does not
 * restate it.
 *
 * Reading absence as `false` collapses those two and would show a
 * divergence notice on every `openai-api` worker, so the client tests
 * `=== false` explicitly and never `!sdkResumed`.
 */
const sdkResumedSchema = v.optional(v.boolean());

/**
 * Standalone schema for the `restore-info` WorkerServerMessage variant
 * (Transcript Restore, #1123 success form / #1449 failure form).
 * `WorkerServerMessage` as a whole has no existing valibot union to extend
 * (server sends raw typed literals; the client does an unchecked
 * `as WorkerServerMessage` cast) -- building a full 8-variant union schema
 * is out of scope here. This schema exists so an integration test can catch
 * server/client field-shape drift for this specific field per
 * pre-pr-completeness.md Q10, without retrofitting runtime validation onto
 * the unrelated existing variants.
 *
 * Two branches, discriminated on `failed`, mirroring the `WorkerServerMessage`
 * `restore-info` union member in `types/session.ts` exactly -- see that
 * member's doc comment for the D1/D2/Loss rationale (#1447, #1449), not
 * restated here. `v.union` tries branches in order; each branch is a
 * `v.strictObject`, so a required-field mismatch (e.g. `failed: true` plus
 * `completed`) naturally falls through rather than silently stripping
 * fields.
 */
const RestoreInfoSuccessSchema = v.strictObject({
  type: v.literal('restore-info'),
  epoch: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * Entries restored from the persisted transcript, by criterion: an entry
   * counts if and only if its content originates from a line of that
   * transcript. Replayed messages and a compaction summary do. The
   * freshly-assembled system prompt and Tier C repair markers do not -- both
   * are invented by the reconstruction so the provider accepts the array, and
   * originate in no row.
   * `0` is a real, reachable value (a worker activated but never spoken to)
   * and the client's restore notice is gated on it being non-zero.
   */
  restoredMessageCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  repairedToolCallIds: v.array(v.string()),
  completed: v.boolean(),
  sdkResumed: sdkResumedSchema,
  failed: v.optional(v.literal(false)),
});

const RestoreInfoFailureSchema = v.strictObject({
  type: v.literal('restore-info'),
  epoch: v.pipe(v.number(), v.integer(), v.minValue(0)),
  failed: v.literal(true),
  sdkResumed: sdkResumedSchema,
});

export const RestoreInfoMessageSchema = v.union([
  RestoreInfoSuccessSchema,
  RestoreInfoFailureSchema,
]);

// Inferred types from schemas
export type CreateWorktreeSessionRequest = v.InferOutput<typeof CreateWorktreeSessionRequestSchema>;
export type CreateQuickSessionRequest = v.InferOutput<typeof CreateQuickSessionRequestSchema>;
export type CreateSessionRequest = v.InferOutput<typeof CreateSessionRequestSchema>;
export type UpdateSessionRequest = v.InferOutput<typeof UpdateSessionRequestSchema>;
export type DeleteSessionRequest = v.InferOutput<typeof DeleteSessionRequestSchema>;
