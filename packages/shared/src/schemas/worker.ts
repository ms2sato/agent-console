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
 * A PATCH rather than a WebSocket command because this is durable per-worker
 * configuration, not a per-turn signal -- REST is where this codebase puts
 * durable writes. The compaction toggle was the first field; the mid-run
 * model / reasoning-effort / context-window override (agent-surface.md Phase
 * 3) reuses the SAME write path rather than adding a second one.
 *
 * Every key is OPTIONAL, and `v.optional(v.nullable(...))` is deliberate on
 * the three override fields: ABSENT and `null` are different instructions.
 * Absent = leave this override exactly as it is. `null` = CLEAR the
 * override, so the worker goes back to live-reading the definition's own
 * default (agent-surface.md Ruling 3). Collapsing the two -- e.g. by using
 * `v.optional(v.string())` -- would make "clear the model" unexpressible.
 *
 * No `v.trim()` here, unlike the creation schemas above: value normalisation
 * and validation for these three fields is the shared
 * `validateEmbeddedAgentParameterOverride` writer's job (one writer, three
 * callers: worker creation, this PATCH, and the MCP tool). Trimming at the
 * wire would make that writer's own trim unmeasurable.
 */
export const UpdateEmbeddedAgentWorkerRequestSchema = v.pipe(
  v.strictObject({
    autoCompaction: v.optional(v.boolean()),
    model: v.optional(v.nullable(v.string())),
    reasoningEffort: v.optional(v.nullable(v.string())),
    /**
     * A non-null window must be a positive integer, matching the declared
     * window on the creation schemas above and on the `init` command's
     * `compaction.contextWindowTokens`.
     */
    contextWindowTokens: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
  }),
  /**
   * An empty body is a caller bug, not "no change": this route exists to set
   * something, and returning 200 for a request that changed nothing would
   * hide it.
   */
  v.check(
    (body) => Object.keys(body).length > 0,
    'at least one of autoCompaction, model, reasoningEffort, contextWindowTokens is required',
  ),
  /**
   * agent-surface.md Ruling 4 at the wire: `contextWindowTokens` is a
   * property OF a model override, never an independent setting.
   *
   * The whole of Ruling 4 collapses to one equivalence --
   * `contextWindowTokens` present IFF (`model` present AND non-null) -- and
   * the three sentences the ruling states are exactly its three failing
   * cases, which a reader can check rather than re-derive:
   *
   *   1. `model` present and non-null, `contextWindowTokens` absent
   *      -> right side true, left side false -> REJECT. Setting a model must
   *      declare a window, or declare `null` for "no window, compaction
   *      inert".
   *   2. `model` present and null, `contextWindowTokens` present
   *      -> right side false, left side true -> REJECT. Clearing the model
   *      clears the window by construction, so a window alongside it is a
   *      contradiction.
   *   3. `contextWindowTokens` present, `model` absent entirely
   *      -> right side false, left side true -> REJECT. Same coupling: a
   *      window declared for a model this request does not set would apply
   *      to whatever model happens to be in effect.
   *
   * Three distinct messages rather than one, because the three are different
   * caller mistakes.
   */
  v.rawCheck(({ dataset, addIssue }) => {
    if (!dataset.typed) return;
    const body = dataset.value;
    const modelPresent = 'model' in body;
    const windowPresent = 'contextWindowTokens' in body;

    if (modelPresent && body.model !== null && !windowPresent) {
      addIssue({
        message:
          'setting a model requires contextWindowTokens; pass null to declare no window',
      });
      return;
    }
    if (modelPresent && body.model === null && windowPresent) {
      addIssue({
        message: 'clearing the model clears the window; omit contextWindowTokens',
      });
      return;
    }
    if (!modelPresent && windowPresent) {
      addIssue({
        message:
          'contextWindowTokens is a property of a model override; send it together with model',
      });
    }
  }),
);

/**
 * Schema for restarting a PTY agent worker as another PTY agent worker
 * (today's only restart shape, unchanged). `agentId` absent keeps the
 * worker's current agent; `continueConversation` controls whether the
 * conversation resumes or starts fresh.
 */
const TerminalRestartSchema = v.strictObject({
  continueConversation: v.optional(v.boolean()),
  agentId: v.optional(v.pipe(v.string(), v.minLength(1, 'Agent ID must not be empty'))),
  branch: v.optional(v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Branch name cannot be empty'),
    v.regex(branchNamePattern, branchNameErrorMessage)
  )),
});

/**
 * Schema for restarting a PTY `agent` worker AS an embedded-agent worker
 * (cross-type restart, agent-surface.md-style conversion). `continueConversation`
 * and `agentId` are deliberately ABSENT from this member -- `strictObject`
 * rejects them at the wire, which IS the "reject continueConversation across
 * kinds" mechanism (no separate runtime check). No `model`/`reasoningEffort`/
 * `contextWindowTokens` at restart time either: a converted worker always
 * starts with no override (mirrors agent-surface.md Ruling 3's restart-time
 * deferral).
 */
const EmbeddedRestartSchema = v.strictObject({
  embeddedAgentId: v.pipe(v.string(), v.minLength(1, 'Embedded agent ID is required')),
  branch: v.optional(v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Branch name cannot be empty'),
    v.regex(branchNamePattern, branchNameErrorMessage)
  )),
});

/**
 * Schema for restarting a worker. A union rather than a flat object with
 * optional fields: `strictObject` on each member rejects any key that
 * belongs to the other member (e.g. `embeddedAgentId` + `continueConversation`
 * together, or `embeddedAgentId` + `agentId` together) at the wire, before
 * any application code runs.
 */
export const RestartWorkerRequestSchema = v.union([
  TerminalRestartSchema,
  EmbeddedRestartSchema,
]);

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
