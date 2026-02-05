import * as v from 'valibot';

// ============================================================
// UUID Type for SDK Compatibility
// The SDK uses crypto.UUID which is a template literal type:
// `${string}-${string}-${string}-${string}-${string}`
// ============================================================

/**
 * UUID pattern for validation
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * UUID type compatible with crypto.UUID
 * Uses template literal type to match SDK expectations
 */
export type UUID = `${string}-${string}-${string}-${string}-${string}`;

/**
 * Schema for UUID strings
 */
export const UuidSchema = v.pipe(
  v.string(),
  v.regex(UUID_PATTERN, 'Invalid UUID format'),
  // Transform to branded type for SDK compatibility
  v.transform((val): UUID => val as UUID)
);

// ============================================================
// MessageParam Schema
// Based on @anthropic-ai/sdk/resources MessageParam type:
// { role: 'user' | 'assistant', content: string | ContentBlock[] }
// ============================================================

/**
 * Text content block in a message
 */
export const TextBlockSchema = v.object({
  type: v.literal('text'),
  text: v.string(),
});

/**
 * Image content block in a message
 */
export const ImageBlockSchema = v.object({
  type: v.literal('image'),
  source: v.object({
    type: v.literal('base64'),
    media_type: v.union([
      v.literal('image/jpeg'),
      v.literal('image/png'),
      v.literal('image/gif'),
      v.literal('image/webp'),
    ]),
    data: v.string(),
  }),
});

/**
 * Tool use content block in a message (assistant messages)
 */
export const ToolUseBlockSchema = v.object({
  type: v.literal('tool_use'),
  id: v.string(),
  name: v.string(),
  input: v.record(v.string(), v.unknown()),
});

/**
 * Tool result content block in a message (user messages)
 */
export const ToolResultBlockSchema = v.object({
  type: v.literal('tool_result'),
  tool_use_id: v.string(),
  content: v.optional(v.union([
    v.string(),
    v.array(v.union([TextBlockSchema, ImageBlockSchema])),
  ])),
  is_error: v.optional(v.boolean()),
});

/**
 * Content block union - supports text, image, tool_use, and tool_result
 */
export const ContentBlockSchema = v.union([
  TextBlockSchema,
  ImageBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
]);

/**
 * Message content - either a string or array of content blocks
 */
export const MessageContentSchema = v.union([
  v.string(),
  v.array(ContentBlockSchema),
]);

/**
 * MessageParam schema - represents a conversation message
 */
export const MessageParamSchema = v.object({
  role: v.union([v.literal('user'), v.literal('assistant')]),
  content: MessageContentSchema,
});

// ============================================================
// SDKUserMessage Schema
// Based on @anthropic-ai/claude-agent-sdk SDKUserMessage type
// ============================================================

/**
 * Schema for SDKUserMessage from Claude Code SDK.
 * Validates user messages before persisting to JSONL.
 *
 * Note: The type compatibility check with SDKUserMessage is done in
 * packages/server/src/schemas/sdk-message-typecheck.ts since the SDK
 * types are only available in the server package.
 */
export const SdkUserMessageSchema = v.object({
  type: v.literal('user'),
  message: MessageParamSchema,
  parent_tool_use_id: v.nullable(v.string()),
  isSynthetic: v.optional(v.boolean()),
  tool_use_result: v.optional(v.unknown()),
  uuid: v.optional(UuidSchema),
  session_id: v.string(),
});

/**
 * Inferred type from the schema.
 * Used for type-safe message construction.
 */
export type SdkUserMessageInput = v.InferOutput<typeof SdkUserMessageSchema>;

/**
 * Create a validated SDKUserMessage object.
 *
 * @param content - The user's message content
 * @param sessionId - The SDK session ID
 * @param options - Optional fields
 * @returns Validated SDKUserMessage object
 * @throws ValibotError if validation fails
 */
export function createSdkUserMessage(
  content: string,
  sessionId: string,
  options?: {
    uuid?: string;
    parentToolUseId?: string | null;
    isSynthetic?: boolean;
    toolUseResult?: unknown;
  }
): SdkUserMessageInput {
  const message = {
    type: 'user' as const,
    message: {
      role: 'user' as const,
      content: content,
    },
    parent_tool_use_id: options?.parentToolUseId ?? null,
    session_id: sessionId,
    ...(options?.uuid && { uuid: options.uuid }),
    ...(options?.isSynthetic && { isSynthetic: options.isSynthetic }),
    ...(options?.toolUseResult !== undefined && { tool_use_result: options.toolUseResult }),
  };

  // Validate and return
  return v.parse(SdkUserMessageSchema, message);
}
