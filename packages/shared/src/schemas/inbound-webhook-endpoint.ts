import * as v from 'valibot';
import {
  INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH,
  INBOUND_WEBHOOK_LABEL_MAX_LENGTH,
} from '../types/inbound-webhook-endpoint.js';

const LabelSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, 'Label is required'),
  v.maxLength(INBOUND_WEBHOOK_LABEL_MAX_LENGTH, `Label must be at most ${INBOUND_WEBHOOK_LABEL_MAX_LENGTH} characters`),
);

/**
 * The instruction is delivered as one line of a notification, so a line break
 * is refused here (400) before the database CHECK can fire. The value is not
 * trimmed: trimming first would let a trailing line break through.
 */
const InstructionTextSchema = v.pipe(
  v.string(),
  v.maxLength(
    INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH,
    `Instruction text must be at most ${INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH} characters`,
  ),
  v.regex(/^[^\r\n]*$/, 'Instruction text must be a single line'),
  v.check((value) => value.trim().length > 0, 'Instruction text is required'),
);

export const CreateInboundWebhookEndpointRequestSchema = v.strictObject({
  label: LabelSchema,
  repositoryId: v.pipe(v.string(), v.minLength(1, 'Repository is required')),
  instructionText: InstructionTextSchema,
});

export type CreateInboundWebhookEndpointRequest = v.InferOutput<typeof CreateInboundWebhookEndpointRequestSchema>;

/** The repository an endpoint is bound to is not changed after creation, and the secret only by rotation. */
export const UpdateInboundWebhookEndpointRequestSchema = v.pipe(
  v.strictObject({
    label: v.optional(LabelSchema),
    instructionText: v.optional(InstructionTextSchema),
  }),
  v.check(
    (val) => val.label !== undefined || val.instructionText !== undefined,
    'At least one of label or instructionText is required',
  ),
);

export type UpdateInboundWebhookEndpointRequest = v.InferOutput<typeof UpdateInboundWebhookEndpointRequestSchema>;

/**
 * An endpoint as every read returns it. Never carries `secret` or
 * `previous_secret`. `hasPreviousSecret` is derived at read time (a previous
 * secret exists and has not expired); `previousSecretExpiresAt` is non-null
 * exactly when it is true.
 */
export const InboundWebhookEndpointSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  label: v.string(),
  repositoryId: v.string(),
  instructionText: v.string(),
  hasPreviousSecret: v.boolean(),
  previousSecretExpiresAt: v.nullable(v.string()),
  createdAt: v.string(),
  updatedAt: v.string(),
});

export type InboundWebhookEndpoint = v.InferOutput<typeof InboundWebhookEndpointSchema>;

/** Schema for `GET /api/inbound-webhook-endpoints`'s response. */
export const InboundWebhookEndpointsListResponseSchema = v.strictObject({
  endpoints: v.array(InboundWebhookEndpointSchema),
});

export type InboundWebhookEndpointsListResponse = v.InferOutput<typeof InboundWebhookEndpointsListResponseSchema>;

/** Schema for the single-endpoint response of `GET /:id` and `PATCH /:id`. */
export const InboundWebhookEndpointResponseSchema = v.strictObject({
  endpoint: InboundWebhookEndpointSchema,
});

export type InboundWebhookEndpointResponse = v.InferOutput<typeof InboundWebhookEndpointResponseSchema>;

/**
 * Schema for the responses of `POST /` (create) and `POST /:id/rotate-secret`:
 * the only responses that carry the signing secret, shown once.
 */
export const InboundWebhookEndpointWithSecretResponseSchema = v.strictObject({
  endpoint: InboundWebhookEndpointSchema,
  secret: v.pipe(v.string(), v.minLength(1)),
});

export type InboundWebhookEndpointWithSecretResponse = v.InferOutput<typeof InboundWebhookEndpointWithSecretResponseSchema>;
