import * as v from 'valibot';
import {
  INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH,
  INBOUND_WEBHOOK_LABEL_MAX_LENGTH,
  INBOUND_WEBHOOK_REPLY_URL_IN_REPLY_TO_PLACEHOLDER as IN_REPLY_TO_PLACEHOLDER,
  INBOUND_WEBHOOK_REPLY_URL_MAX_LENGTH,
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

function parseUrl(value: string): URL | null {
  return URL.canParse(value) ? new URL(value) : null;
}

/** True when the placeholder is absent, or occurs once as a whole path segment (not in the host or the query). */
function placeholderPlacementIsValid(value: string): boolean {
  if (!value.includes(IN_REPLY_TO_PLACEHOLDER)) return true;
  if (value.split(IN_REPLY_TO_PLACEHOLDER).length !== 2) return false;
  const match = /^https:\/\/([^/?#]*)([^?#]*)/i.exec(value);
  // A value that does not start like an https URL is reported by the checks above.
  if (match === null) return true;
  return match[2]!.split('/').includes(IN_REPLY_TO_PLACEHOLDER);
}

/**
 * The address a signed reply is posted to, set by an operator: 1 to 2048 characters, no
 * leading or trailing whitespace (the value is never trimmed), no control character, an `https:` URL
 * with no credentials and no fragment. Query strings, ports and any hostname are accepted. The path may
 * carry `{{in_reply_to}}` once as a whole segment; every other `{{` or `}}` is refused.
 *
 * Every step carries a custom message that names only the rule: the reply URL may carry a token in
 * its query, valibot's default messages embed the received value, and the API error handler logs
 * the first message.
 */
export const InboundWebhookReplyUrlSchema = v.pipe(
  v.string('Reply URL must be a string'),
  v.minLength(1, 'Reply URL must not be empty'),
  v.maxLength(
    INBOUND_WEBHOOK_REPLY_URL_MAX_LENGTH,
    `Reply URL must be at most ${INBOUND_WEBHOOK_REPLY_URL_MAX_LENGTH} characters`,
  ),
  v.check((value) => value === value.trim(), 'Reply URL must not have leading or trailing whitespace'),
  // `\p{Cc}` is every control character, C0, DEL and C1.
  v.check((value) => !/\p{Cc}/u.test(value), 'Reply URL must not contain control characters'),
  v.check((value) => URL.canParse(value), 'Reply URL must be a valid URL'),
  // valibot runs every check even after one failed, so the checks below tolerate a value that is not a
  // URL (the check above already reports it).
  v.check((value) => {
    const url = parseUrl(value);
    return url === null || url.protocol === 'https:';
  }, 'Reply URL must use https'),
  // The stored text must show the host that is called: `new URL` also reads `https:///x`, `https:x`, `https:/x`
  // and `https:\\host\p` as an https URL with a host, so the input text itself is required to start with
  // the scheme, two slashes and a host character.
  v.check((value) => /^https:\/\/[^/\\?#]/i.test(value), 'Reply URL must start with https:// followed by a host'),
  v.check((value) => {
    const url = parseUrl(value);
    return url === null || (url.username === '' && url.password === '');
  }, 'Reply URL must not contain credentials'),
  // A raw `#` is the fragment delimiter, including an empty one that `URL#hash` reads as ''.
  v.check((value) => !value.includes('#'), 'Reply URL must not contain a fragment'),
  // The allowed placeholder is replaced by a space so that removing it can never join two brace characters.
  v.check(
    (value) => {
      const rest = value.split(IN_REPLY_TO_PLACEHOLDER).join(' ');
      return !rest.includes('{{') && !rest.includes('}}');
    },
    'Reply URL contains an unknown placeholder',
  ),
  v.check(
    placeholderPlacementIsValid,
    `Reply URL may contain ${IN_REPLY_TO_PLACEHOLDER} only once, as a whole path segment`,
  ),
);

export const CreateInboundWebhookEndpointRequestSchema = v.strictObject({
  label: LabelSchema,
  instructionText: InstructionTextSchema,
  secret: v.optional(InboundWebhookSecretSchema),
  replyUrl: v.optional(InboundWebhookReplyUrlSchema),
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
    /** `null` clears the reply URL; an omitted key leaves it unchanged. */
    replyUrl: v.optional(v.nullable(InboundWebhookReplyUrlSchema)),
  }),
  v.check(
    (val) => val.label !== undefined || val.instructionText !== undefined || val.replyUrl !== undefined,
    'At least one of label, instructionText or replyUrl is required',
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
  replyUrl: v.nullable(v.string()),
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
