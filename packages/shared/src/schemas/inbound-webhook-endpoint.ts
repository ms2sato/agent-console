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
 * The instruction is multi-line operator text stored as-is: it is not trimmed and line breaks are
 * kept. Only the length cap and a blank check apply.
 */
const InstructionTextSchema = v.pipe(
  v.string(),
  v.maxLength(
    INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH,
    `Instruction text must be at most ${INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH} characters`,
  ),
  v.check((value) => value.trim().length > 0, 'Instruction text is required'),
);

const SECRET_PATTERN = /^whsec_[A-Za-z0-9+/]+={0,2}$/;
const SECRET_PREFIX_LENGTH = 'whsec_'.length;
const SECRET_MIN_BYTES = 24;
const SECRET_MAX_BYTES = 64;

/**
 * Decode the base64 part of a `whsec_` secret to its raw bytes as a binary string, or null when the
 * value does not match the shape or is not canonical base64 (the re-encoded form must equal the
 * input, which rejects lax decoding such as a missing pad or non-zero trailing bits). Uses
 * `atob`/`btoa` so the schema also runs in a browser.
 */
function decodeCanonicalSecret(value: string): string | null {
  if (!SECRET_PATTERN.test(value)) return null;
  const base64 = value.slice(SECRET_PREFIX_LENGTH);
  try {
    const decoded = atob(base64);
    return btoa(decoded) === base64 ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * A secret entered by an admin: `whsec_` followed by canonical base64 whose decoded length is 24 to
 * 64 bytes (what the sending side accepts, nothing stricter).
 *
 * Every step carries a custom message that names only the rule. valibot's default messages embed
 * the received value, the validation middleware forwards the first message into an error that the
 * API error handler logs, so a default message would log an entered secret.
 */
export const InboundWebhookSecretSchema = v.pipe(
  v.string('Secret must be a string'),
  v.regex(SECRET_PATTERN, 'Secret must be "whsec_" followed by base64'),
  v.check((value) => decodeCanonicalSecret(value) !== null, 'Secret must be canonical base64'),
  v.check((value) => {
    const decoded = decodeCanonicalSecret(value);
    return decoded !== null && decoded.length >= SECRET_MIN_BYTES && decoded.length <= SECRET_MAX_BYTES;
  }, `Secret must decode to ${SECRET_MIN_BYTES} to ${SECRET_MAX_BYTES} bytes`),
);

export const CreateInboundWebhookEndpointRequestSchema = v.strictObject({
  label: LabelSchema,
  instructionText: InstructionTextSchema,
  secret: v.optional(InboundWebhookSecretSchema),
});

export type CreateInboundWebhookEndpointRequest = v.InferOutput<typeof CreateInboundWebhookEndpointRequestSchema>;

/** Body of `POST /:id/rotate-secret`. The body itself is optional: none, `{}` and `{ secret }` are all valid. */
export const RotateInboundWebhookSecretRequestSchema = v.strictObject({
  secret: v.optional(InboundWebhookSecretSchema),
});

export type RotateInboundWebhookSecretRequest = v.InferOutput<typeof RotateInboundWebhookSecretRequestSchema>;

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

/** Schema for the list response of `GET /api/repositories/:repositoryId/inbound-webhook-endpoints`. */
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
 * Schema for the responses of `POST /` (create) and `POST /:id/rotate-secret`. A generated secret
 * is returned once; an entered secret is never echoed back.
 */
export const InboundWebhookEndpointWithSecretResponseSchema = v.variant('secretSource', [
  v.strictObject({
    endpoint: InboundWebhookEndpointSchema,
    secretSource: v.literal('generated'),
    secret: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({
    endpoint: InboundWebhookEndpointSchema,
    secretSource: v.literal('entered'),
  }),
]);

export type InboundWebhookEndpointWithSecretResponse = v.InferOutput<typeof InboundWebhookEndpointWithSecretResponseSchema>;
