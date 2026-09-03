import * as v from 'valibot';
import { EFFORT_LEVELS } from '../types/embedded-agent-parameter-capabilities.js';
import { SDK_RESUME_FAILURE_REASONS } from '../types/embedded-agent.js';
import type { EmbeddedAgentToolName } from '../types/embedded-agent.js';
import { PTY_NOTIFICATION_KINDS } from '../types/system-events.js';
import type { ExitReason } from '../types/worker.js';

/**
 * Valibot schemas for embedded agent definitions and the stdio protocol.
 * The hand-written interfaces in types/embedded-agent.ts stay the canonical
 * domain types (mirroring how worker.ts types and schemas coexist); these
 * schemas provide boundary validation for REST requests and the wire protocol.
 */

// === Definition schemas ===

// Lives here (not types/) because the wire picklist below derives from it,
// and SCHEMA_VERSION hashes this directory — see generate-schema-version.mjs.
/**
 * Builtin subprocess-local tool names. This is the SINGLE WRITER of builtin
 * tool-name literals in the repo — every other usage must reference this
 * constant or the derived `EmbeddedAgentToolName` type, not a hardcoded list.
 *
 * `Bash`'s implementation ships in FF-1b (packages/embedded-agent/src/tools/bash.ts);
 * `Write`/`Edit`'s implementations ship in FF-1c
 * (packages/embedded-agent/src/tools/write.ts, edit.ts). All three stay OFF by
 * default — see DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS below.
 *
 * `TodoWrite` is a planning/task-list tool: it lets the agent
 * publish a live task list to the user rather than acting on the filesystem
 * or a shell, so it stays ON by default alongside the read-only set. On
 * `claude-sdk` it is measured absent from the resolved CLI's native tool
 * catalog (Issue #1575), so it is served by an in-process SDK MCP server
 * instead (mirroring `Compact`'s own MCP-served shape, see
 * `SDK_TODO_WRITE_TOOL_NAME` in types/embedded-agent.ts); on `openai-api` it
 * is implemented in packages/embedded-agent/src/tools/todo-write.ts.
 */
export const EMBEDDED_AGENT_TOOL_NAMES = ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit', 'TodoWrite'] as const;

/**
 * Default when a definition's `enabledTools` is absent: read-only tools ON,
 * `TodoWrite` ON (it writes no files and has no side effects outside the
 * transcript), Bash/Write/Edit OFF.
 *
 * Note that a definition that has ever been through the Add/Edit form persists
 * `enabledTools` as an explicit array (never leaves it `undefined`) — so a
 * change to this default does NOT propagate to already-edited definitions.
 * Only definitions that have never been saved through the form (still
 * `undefined` at the DB level) pick up a change here.
 */
export const DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS: readonly EmbeddedAgentToolName[] = [
  'Read',
  'Glob',
  'Grep',
  'TodoWrite',
];

/**
 * Single-tool-name wire schema element. Split out from `EnabledToolsSchema`
 * (the array wrapper below) so it can also serve as the type-level pin target
 * for `EmbeddedAgentToolName` -- see the Compile-time Type Assertions section.
 */
const EnabledToolNameSchema = v.picklist(EMBEDDED_AGENT_TOOL_NAMES);

/**
 * List of enabled builtin tool names. No nullable variant here — nullability
 * (PATCH clear-to-default semantics) is layered on only where needed
 * (`UpdateEmbeddedAgentRequestSchema`).
 */
const EnabledToolsSchema = v.pipe(
  v.array(EnabledToolNameSchema),
  v.check((arr) => new Set(arr).size === arr.length, 'duplicate tool name')
);

/**
 * List of opt-in instruction-file paths. Unlike EnabledToolsSchema, no dedup
 * check — duplicate paths are harmless (just re-read the same file twice).
 */
const InstructionsListSchema = v.array(v.pipe(v.string(), v.minLength(1)));

/**
 * Transcript Restore (#1123) wire-shape schemas, mirroring
 * `EmbeddedAgentRestoredToolCall` / `EmbeddedAgentRestoredMessage` in
 * types/embedded-agent.ts.
 */
const EmbeddedAgentRestoredToolCallSchema = v.strictObject({
  id: v.string(),
  type: v.literal('function'),
  function: v.strictObject({ name: v.string(), arguments: v.string() }),
});

/**
 * Wire-shape for one message attachment, mirroring `EmbeddedAgentAttachment`
 * in types/embedded-agent.ts.
 */
const EmbeddedAgentAttachmentSchema = v.strictObject({
  path: v.string(),
  mimeType: v.string(),
});

const EmbeddedAgentRestoredMessageSchema = v.union([
  v.strictObject({ role: v.literal('system'), content: v.string() }),
  v.strictObject({
    role: v.literal('user'),
    content: v.string(),
    attachments: v.optional(v.array(EmbeddedAgentAttachmentSchema)),
  }),
  v.strictObject({
    role: v.literal('assistant'),
    content: v.string(),
    tool_calls: v.optional(v.array(EmbeddedAgentRestoredToolCallSchema)),
  }),
  v.strictObject({ role: v.literal('tool'), tool_call_id: v.string(), content: v.string() }),
]);

export const EmbeddedAgentProviderSchema = v.strictObject({
  baseUrl: v.pipe(v.string(), v.url()),
  model: v.pipe(v.string(), v.minLength(1)),
  apiKeyRef: v.optional(v.pipe(v.string(), v.minLength(1))),
  // Per-provider capability flag: whether this provider can see image
  // content parts. Default false/absent -- see the type's doc comment.
  supportsImages: v.optional(v.boolean()),
});

/**
 * `claude-sdk` engine's provider shape (docs/design/embedded-agent-sdk-engine.md
 * §3.2): no `baseUrl`, no `apiKeyRef` -- no provider secret ever crosses the
 * server for this engine, so the schema has nothing to carry beyond the model id.
 */
export const EmbeddedAgentSdkProviderSchema = v.strictObject({
  model: v.pipe(v.string(), v.minLength(1)),
});

/**
 * Compaction config. One threshold, not the retired soft/hard pair: there is
 * a single behavior (compact) rather than a two-stage banner escalation, so
 * there is a single ratio. Unset means DEFAULT_COMPACTION_THRESHOLD -- see
 * docs/design/embedded-agent-worker.md "Compaction".
 *
 * `0` is excluded rather than merely allowed-and-odd: a threshold of zero
 * would compact after every turn including the first, which no operator
 * means by "compact when the context fills up".
 */
export const EmbeddedAgentCompactionConfigSchema = v.strictObject({
  threshold: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1), v.notValue(0))),
});

/**
 * Fields shared by both `engine` arms of {@link EmbeddedAgentDefinitionSchema}.
 * Spread into each arm rather than composed via intersection, since
 * `v.variant` requires each member to be a plain object schema exposing the
 * discriminant key directly (see the identical pattern in `app-server-message.ts`).
 */
const EmbeddedAgentDefinitionBaseFields = {
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.trim(), v.minLength(1, 'Name is required')),
  description: v.optional(v.string()),
  systemPrompt: v.optional(v.string()),
  maxToolIterations: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  enabledTools: v.optional(EnabledToolsSchema),
  instructions: v.optional(InstructionsListSchema),
  contextWindowTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  compaction: v.optional(EmbeddedAgentCompactionConfigSchema),
  isBuiltIn: v.boolean(),
  createdBy: v.string(),
  createdAt: v.string(),
  updatedAt: v.string(),
};

/**
 * Discriminated on `engine` (docs/design/embedded-agent-sdk-engine.md §3.1):
 * the wire schema enforces the per-arm `provider` shape, not just the
 * TypeScript type -- an `openai-api` definition with an SDK-shaped provider
 * (or vice versa) is rejected at the boundary.
 */
export const EmbeddedAgentDefinitionSchema = v.variant('engine', [
  v.strictObject({
    ...EmbeddedAgentDefinitionBaseFields,
    engine: v.literal('openai-api'),
    provider: EmbeddedAgentProviderSchema,
  }),
  v.strictObject({
    ...EmbeddedAgentDefinitionBaseFields,
    engine: v.literal('claude-sdk'),
    provider: EmbeddedAgentSdkProviderSchema,
  }),
]);

/**
 * Schema for creating an embedded agent definition. `createdBy` is set
 * server-side from the authenticated user, never from the request body.
 */
export const CreateEmbeddedAgentRequestSchema = v.strictObject({
  name: v.pipe(v.string(), v.trim(), v.minLength(1, 'Name is required')),
  description: v.optional(v.string()),
  provider: EmbeddedAgentProviderSchema,
  systemPrompt: v.optional(v.string()),
  maxToolIterations: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  enabledTools: v.optional(EnabledToolsSchema),
  instructions: v.optional(InstructionsListSchema),
  contextWindowTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  compaction: v.optional(EmbeddedAgentCompactionConfigSchema),
});

/**
 * Schema for updating an embedded agent definition.
 * PATCH semantics: null = clear the field, undefined = no change.
 * `provider` is a whole-object replacement (no partial provider updates);
 * `compaction` follows the same whole-object replacement convention (no
 * per-subfield PATCH merging — see docs/design/embedded-agent-worker.md
 * "Compaction" § Definition config, migration, and forms).
 */
export const UpdateEmbeddedAgentRequestSchema = v.strictObject({
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'Name cannot be empty'))),
  description: v.optional(v.nullable(v.string())),
  provider: v.optional(EmbeddedAgentProviderSchema),
  systemPrompt: v.optional(v.nullable(v.string())),
  maxToolIterations: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
  enabledTools: v.optional(v.nullable(EnabledToolsSchema)),
  instructions: v.optional(v.nullable(InstructionsListSchema)),
  contextWindowTokens: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
  compaction: v.optional(v.nullable(EmbeddedAgentCompactionConfigSchema)),
});

// === Protocol schemas ===

/**
 * Fields shared by both `engine` arms of the `init` command. Mirrors
 * {@link EmbeddedAgentDefinitionBaseFields}'s split -- see
 * docs/design/embedded-agent-sdk-engine.md §3.1.
 */
const EmbeddedAgentInitCommandBaseFields = {
  v: v.literal(1),
  type: v.literal('init'),
  mcp: v.strictObject({
    baseUrl: v.string(),
    token: v.string(),
  }),
  context: v.strictObject({
    sessionId: v.string(),
    workerId: v.string(),
    repositoryId: v.optional(v.string()),
    cwd: v.string(),
    attachmentRoots: v.optional(v.array(v.string())),
  }),
  systemPrompt: v.optional(v.string()),
  enabledTools: v.optional(EnabledToolsSchema),
  instructions: v.optional(InstructionsListSchema),
  maxToolIterations: v.number(),
  restoredConversation: v.optional(v.array(EmbeddedAgentRestoredMessageSchema)),
  compaction: v.strictObject({
    auto: v.boolean(),
    contextWindowTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    threshold: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1), v.notValue(0))),
  }),
};

/**
 * Discriminated on `engine`, same rationale as
 * {@link EmbeddedAgentDefinitionSchema}: the `claude-sdk` arm's `provider`
 * carries no `apiKey` (absent by construction, per §3.2).
 */
const EmbeddedAgentInitCommandSchema = v.variant('engine', [
  v.strictObject({
    ...EmbeddedAgentInitCommandBaseFields,
    engine: v.literal('openai-api'),
    provider: v.strictObject({
      baseUrl: v.string(),
      model: v.string(),
      apiKey: v.optional(v.string()),
      // agent-surface.md Ruling 3 (#1554): the resolved worker-override, or
      // absent when no override is set for this worker. Pass-through to the
      // provider's chat.completions request body -- no local value
      // validation at this layer, the provider is the authority. See the
      // type's doc comment (`EmbeddedAgentCommand`'s openai-api arm).
      reasoningEffort: v.optional(v.string()),
      // Pass-through of the definition's provider.supportsImages.
      supportsImages: v.optional(v.boolean()),
    }),
    // On the openai-api arm only -- `claude-sdk` carries its own context
    // state through the SDK resume, so a seed there is not representable. See the type's doc comment for what `estimated` means.
    restoredUsage: v.optional(
      v.strictObject({
        promptTokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
        estimated: v.boolean(),
      }),
    ),
    // Phase B (#1343 R4): on the openai-api arm only -- see the type's doc
    // comment (`EmbeddedAgentCommand`'s openai-api arm) for why `claude-sdk`
    // has no representable analogue.
    activatedRuleNames: v.optional(v.array(v.string())),
  }),
  v.strictObject({
    ...EmbeddedAgentInitCommandBaseFields,
    engine: v.literal('claude-sdk'),
    provider: v.strictObject({
      model: v.pipe(v.string(), v.minLength(1)),
      // agent-surface.md Ruling 3 (#1554): the resolved worker-override
      // value, or absent when no override is set. Named `effort`, NOT
      // `reasoningEffort` like the openai-api arm above -- mirrors the SDK's
      // own `Options.effort` field name. Values are a closed domain
      // (`EFFORT_LEVELS`), enforced here at the wire boundary too (defense
      // in depth alongside the worker-creation-time validation).
      effort: v.optional(v.picklist(EFFORT_LEVELS)),
    }),
    // Transcript Restore, R1. On the claude-sdk arm only -- the other
    // engine has no concept of a resume, so an `openai-api` init carrying
    // one is not representable. See the type's doc comment for where the
    // id may (and may not) come from.
    resume: v.optional(
      v.strictObject({
        sdkSessionId: v.pipe(v.string(), v.minLength(1)),
      }),
    ),
  }),
]);

export const EmbeddedAgentCommandSchema = v.union([
  EmbeddedAgentInitCommandSchema,
  v.strictObject({
    v: v.literal(1),
    type: v.literal('user-message'),
    id: v.string(),
    text: v.string(),
    // Attachment references the subprocess may resolve into real content
    // parts. Absent/empty = no attachments, unchanged today.
    attachments: v.optional(v.array(EmbeddedAgentAttachmentSchema)),
  }),
  v.strictObject({ v: v.literal(1), type: v.literal('cancel') }),
  v.strictObject({
    v: v.literal(1),
    type: v.literal('set-auto-compaction'),
    enabled: v.boolean(),
  }),
  // Slash commands, `console`-handled arm (#1572): a manual `/compact`
  // intercepted server-side rather than forwarded as prose. No payload
  // beyond the discriminant -- a pure trigger. See the type's doc comment.
  v.strictObject({ v: v.literal(1), type: v.literal('compact') }),
  v.strictObject({ v: v.literal(1), type: v.literal('shutdown') }),
]);

export const EmbeddedAgentEventSchema = v.union([
  v.strictObject({ v: v.literal(1), type: v.literal('ready') }),
  v.strictObject({
    v: v.literal(1),
    type: v.literal('state'),
    state: v.picklist(['active', 'idle']),
  }),
  v.strictObject({
    v: v.literal(1),
    type: v.literal('assistant-delta'),
    turnId: v.string(),
    text: v.string(),
  }),
  v.strictObject({
    v: v.literal(1),
    type: v.literal('assistant-thinking-delta'),
    turnId: v.string(),
    text: v.string(),
  }),
  v.strictObject({
    v: v.literal(1),
    type: v.literal('assistant-message'),
    turnId: v.string(),
    text: v.string(),
  }),
  v.strictObject({
    v: v.literal(1),
    type: v.literal('tool-call'),
    turnId: v.string(),
    callId: v.string(),
    name: v.string(),
    args: v.unknown(),
  }),
  v.strictObject({
    v: v.literal(1),
    type: v.literal('tool-result'),
    turnId: v.string(),
    callId: v.string(),
    ok: v.boolean(),
    result: v.string(),
    // Phase B (#1343 R4): the scoped-rule names ACTUALLY activated by this
    // call, structurally -- never parsed from `result`'s text. See the
    // type's doc comment (`EmbeddedAgentEvent`'s `tool-result` member).
    activatedRules: v.optional(v.array(v.string())),
  }),
  v.strictObject({
    v: v.literal(1),
    type: v.literal('turn-error'),
    turnId: v.string(),
    message: v.string(),
  }),
  v.strictObject({ v: v.literal(1), type: v.literal('fatal'), message: v.string() }),
  v.strictObject({
    v: v.literal(1),
    type: v.literal('context-usage'),
    promptTokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
    estimated: v.boolean(),
    // Window drift: OUR inference that this reading is the provider's cap
    // rather than the conversation's size. A literal `true` and not a
    // boolean -- see the type's doc comment for why there is no `false`.
    appearsClamped: v.optional(v.literal(true)),
  }),
  v.strictObject({
    v: v.literal(1),
    type: v.literal('context-compacted'),
    source: v.picklist(['auto', 'manual']),
    summary: v.optional(v.string()),
    preTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    postTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    // Window drift: THEIR number, stated in the rejection this compaction
    // was forced by. Contrast `appearsClamped` above.
    providerStatedWindowTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    // Whether the distillation input was the whole conversation or only a
    // recent suffix. Absent means UNKNOWN, never 'full' -- see the type's
    // doc comment for the full three-valued-by-absence reasoning.
    coverage: v.optional(v.picklist(['full', 'partial'])),
  }),
  /**
   * RETIRED emission, RETAINED parse (#1401). Persisted transcripts written
   * before the compaction swap carry these rows, and this union is what
   * replay parses them with -- dropping the member would break replay before
   * rendering is reached. No engine emits it any more.
   */
  v.strictObject({
    v: v.literal(1),
    type: v.literal('context-handoff'),
    distillation: v.string(),
  }),
  v.strictObject({
    v: v.literal(1),
    type: v.literal('sdk-session-id'),
    sdkSessionId: v.string(),
  }),
  // Transcript Restore, R1. The machine-readable half of a resume that did
  // not take; the `turn-error` emitted alongside a refusal is the
  // human-readable half of that one.
  //
  // `reason` reads the shared constant rather than restating the literals:
  // the server branches on this value, so a reason present in the type and
  // absent from the picklist would be rejected at the wire and the branch
  // would be dead code that typechecks.
  v.strictObject({
    v: v.literal(1),
    type: v.literal('sdk-resume-failed'),
    requestedSdkSessionId: v.pipe(v.string(), v.minLength(1)),
    reason: v.picklist(SDK_RESUME_FAILURE_REASONS),
  }),
]);

/**
 * Wire schema for {@link EmbeddedAgentServerNotification}. `kind` is
 * validated against the shared PTY-notification-kind enum;
 * `summary` is only present for kinds whose `fields` shape carries one
 * (internal-message, inbound-event) -- see extractNotificationSummary in
 * packages/server/src/lib/pty-notification.ts.
 */
const EmbeddedAgentServerNotificationSchema = v.strictObject({
  kind: v.picklist(PTY_NOTIFICATION_KINDS),
  summary: v.optional(v.string()),
});

/**
 * Wire half of the hand-written `ExitReason` union in types/worker.ts.
 *
 * The two are pinned to each other below rather than one deriving from the
 * other, following how the rest of this file lets the hand-written domain
 * types and the boundary schemas coexist.
 */
export const ExitReasonSchema = v.picklist(['managed', 'unexpected', 'evicted']);

// === Compile-time Type Assertions ===

/**
 * Bidirectional pin between {@link ExitReasonSchema} and the hand-written
 * `ExitReason`. Remove these and the two can drift silently: a value added to
 * one side only would either be rejected at the wire boundary while type-
 * checking fine (schema too narrow), or accepted at the boundary and then
 * handled by no consumer (schema too wide). Both failures are invisible to
 * every test that does not happen to use the new value.
 */
/**
 * The constraint is what makes the pin fire. An earlier form resolved to
 * `never` on drift and declared a `const` of that type -- which compiles
 * cleanly, because `declare` introduces no assignment and so `never` has
 * nothing to reject. Measured against this repo's own compiler: drifting the
 * schema produced zero diagnostics. Both halves of the change are required --
 * `never` becomes `false`, AND `false` must violate a `extends true`
 * constraint; either alone leaves the pin inert.
 */
type Assert<T extends true> = T;
type _AssertExitReasonSchemaWidensToType = Assert<
  v.InferOutput<typeof ExitReasonSchema> extends ExitReason ? true : false
>;
type _AssertExitReasonTypeWidensToSchema = Assert<
  ExitReason extends v.InferOutput<typeof ExitReasonSchema> ? true : false
>;
export type { _AssertExitReasonSchemaWidensToType, _AssertExitReasonTypeWidensToSchema };

/**
 * Bidirectional pin between {@link EnabledToolNameSchema} (a single tool
 * name) and the hand-written `EmbeddedAgentToolName` in types/embedded-agent.ts.
 * `EMBEDDED_AGENT_TOOL_NAMES` above is the SINGLE WRITER of the tool-name
 * literals for the wire (and for SCHEMA_VERSION's hash, which is the whole
 * reason it lives in this directory); `EmbeddedAgentToolName` cannot import
 * it back (types/ -> schemas/ is a forbidden depcruise edge — see
 * `EmbeddedAgentToolName`'s own doc comment in types/embedded-agent.ts), so
 * the two lists are pinned here instead of one deriving from the other. Same
 * failure mode as the `ExitReasonSchema`/`ExitReason` pin above if removed.
 *
 * Mutation measurement (workflow.md "Testing Requirements" -- reach is
 * measured, not predicted, not assumed): adding `'Foo'` to
 * `EmbeddedAgentToolName` only (types/embedded-agent.ts) produced
 * `error TS2344: Type 'false' does not satisfy the constraint 'true'.` on
 * `_AssertToolNameTypeWidensToSchema`. Reverting that and instead adding
 * `'Foo'` to `EMBEDDED_AGENT_TOOL_NAMES` only (this file) produced the same
 * `TS2344` on `_AssertToolNameSchemaWidensToType`. Both mutations were
 * reverted; `tsc --noEmit` is clean on the unmodified pair.
 */
type _AssertToolNameTypeWidensToSchema = Assert<
  EmbeddedAgentToolName extends v.InferOutput<typeof EnabledToolNameSchema> ? true : false
>;
type _AssertToolNameSchemaWidensToType = Assert<
  v.InferOutput<typeof EnabledToolNameSchema> extends EmbeddedAgentToolName ? true : false
>;
export type { _AssertToolNameTypeWidensToSchema, _AssertToolNameSchemaWidensToType };

export const EmbeddedAgentServerEventSchema = v.union([
  v.strictObject({
    v: v.literal(1),
    type: v.literal('user-message'),
    id: v.string(),
    text: v.string(),
    clientMessageId: v.optional(v.string()),
    notification: v.optional(EmbeddedAgentServerNotificationSchema),
    // Mirrors the originating EmbeddedAgentCommand's `attachments`. See the
    // type's doc comment.
    attachments: v.optional(v.array(EmbeddedAgentAttachmentSchema)),
  }),
  // Transcript Restore, R1 (the local half of #1273). Server-authored --
  // never a synthesized `turn-error`. See the type's doc comment.
  v.strictObject({
    v: v.literal(1),
    type: v.literal('turn-interrupted'),
    turnId: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({
    v: v.literal(1),
    type: v.literal('exited'),
    code: v.nullable(v.number()),
    // Optional, and that is a contract rather than laxness: a persisted row
    // written by a server older than idle eviction carries no `reason`, and
    // must keep parsing. See the type's doc comment for why consumers test
    // `reason === 'evicted'` instead of truthiness.
    reason: v.optional(ExitReasonSchema),
    // Optional, present only for an unexpected exit with non-empty stderr;
    // absent means absent, never ''. See the type's doc comment.
    stderrTail: v.optional(v.string()),
  }),
  // Transcript Restore, R2 (#1447 stage 4). A reconstruction boundary, the
  // same class as `context-compacted` -- deliberately no `summary` field.
  // See the type's doc comment.
  v.strictObject({
    v: v.literal(1),
    type: v.literal('restore-failure-boundary'),
  }),
  // Transcript Restore, R6 (#1447 stage 4). Restore-TRANSPARENT, the
  // opposite of the boundary member above. See the type's doc comment.
  v.strictObject({
    v: v.literal(1),
    type: v.literal('restore-failure-declaration'),
  }),
]);

export const EmbeddedAgentStreamEventSchema = v.union([
  ...EmbeddedAgentEventSchema.options,
  ...EmbeddedAgentServerEventSchema.options,
]);

// Inferred request types (canonical domain types stay in types/embedded-agent.ts)
export type CreateEmbeddedAgentRequest = v.InferOutput<typeof CreateEmbeddedAgentRequestSchema>;
export type UpdateEmbeddedAgentRequest = v.InferOutput<typeof UpdateEmbeddedAgentRequestSchema>;
