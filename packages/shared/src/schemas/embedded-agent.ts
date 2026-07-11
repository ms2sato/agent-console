import * as v from 'valibot';

/**
 * Valibot schemas for embedded agent definitions and the stdio protocol.
 * The hand-written interfaces in types/embedded-agent.ts stay the canonical
 * domain types (mirroring how worker.ts types and schemas coexist); these
 * schemas provide boundary validation for REST requests and the wire protocol.
 */

// === Definition schemas ===

export const EmbeddedAgentProviderSchema = v.strictObject({
  baseUrl: v.pipe(v.string(), v.url()),
  model: v.pipe(v.string(), v.minLength(1)),
  apiKeyRef: v.optional(v.pipe(v.string(), v.minLength(1))),
});

export const EmbeddedAgentDefinitionSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.trim(), v.minLength(1, 'Name is required')),
  description: v.optional(v.string()),
  provider: EmbeddedAgentProviderSchema,
  systemPrompt: v.optional(v.string()),
  maxToolIterations: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  createdBy: v.string(),
  createdAt: v.string(),
  updatedAt: v.string(),
});

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
});

/**
 * Schema for updating an embedded agent definition.
 * PATCH semantics: null = clear the field, undefined = no change.
 * `provider` is a whole-object replacement (no partial provider updates).
 */
export const UpdateEmbeddedAgentRequestSchema = v.strictObject({
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'Name cannot be empty'))),
  description: v.optional(v.nullable(v.string())),
  provider: v.optional(EmbeddedAgentProviderSchema),
  systemPrompt: v.optional(v.nullable(v.string())),
  maxToolIterations: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
});

// === Protocol schemas ===

export const EmbeddedAgentCommandSchema = v.union([
  v.strictObject({
    v: v.literal(1),
    type: v.literal('init'),
    mcp: v.strictObject({
      baseUrl: v.string(),
      token: v.string(),
    }),
    provider: v.strictObject({
      baseUrl: v.string(),
      model: v.string(),
      apiKey: v.optional(v.string()),
    }),
    context: v.strictObject({
      sessionId: v.string(),
      workerId: v.string(),
      repositoryId: v.optional(v.string()),
      cwd: v.string(),
    }),
    systemPrompt: v.optional(v.string()),
    maxToolIterations: v.number(),
  }),
  v.strictObject({
    v: v.literal(1),
    type: v.literal('user-message'),
    id: v.string(),
    text: v.string(),
  }),
  v.strictObject({ v: v.literal(1), type: v.literal('cancel') }),
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
  }),
  v.strictObject({
    v: v.literal(1),
    type: v.literal('turn-error'),
    turnId: v.string(),
    message: v.string(),
  }),
  v.strictObject({ v: v.literal(1), type: v.literal('fatal'), message: v.string() }),
]);

export const EmbeddedAgentServerEventSchema = v.union([
  v.strictObject({
    v: v.literal(1),
    type: v.literal('user-message'),
    id: v.string(),
    text: v.string(),
  }),
  v.strictObject({
    v: v.literal(1),
    type: v.literal('exited'),
    code: v.nullable(v.number()),
  }),
]);

export const EmbeddedAgentStreamEventSchema = v.union([
  ...EmbeddedAgentEventSchema.options,
  ...EmbeddedAgentServerEventSchema.options,
]);

// Inferred request types (canonical domain types stay in types/embedded-agent.ts)
export type CreateEmbeddedAgentRequest = v.InferOutput<typeof CreateEmbeddedAgentRequestSchema>;
export type UpdateEmbeddedAgentRequest = v.InferOutput<typeof UpdateEmbeddedAgentRequestSchema>;
