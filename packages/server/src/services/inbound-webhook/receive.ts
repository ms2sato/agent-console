/**
 * Receive half of the generic signed inbound webhook.
 *
 * Owns everything that does not depend on who acts on a message: endpoint lookup, Standard
 * Webhooks signature and timestamp verification, id and body validation, the transactional
 * dedupe + enqueue, the process-time endpoint re-read and the delivery content. It is Hono-free
 * (the route is a thin adapter) and imports nothing from the action half, so a later endpoint
 * kind plugs a different action into the same `DeliveryContent` seam.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Kysely } from 'kysely';
import * as v from 'valibot';
import { JOB_TYPES, type InboundWebhookProcessPayload, type JobQueue } from '../../jobs/index.js';
import type { Database } from '../../database/schema.js';
import { INBOUND_WEBHOOK_SECRET_PREFIX, isPreviousSecretActive } from '../../lib/inbound-webhook-secret.js';
import { stripControlChars } from '../../lib/pty-notification.js';
import { createLogger } from '../../lib/logger.js';
import type { InboundWebhookEndpointRepository } from '../../repositories/webhook-endpoint-repository.js';
import { PermanentHandlerError } from '../inbound/job-handler.js';
import { fetchAttachments, type AttachmentFetch, type AttachmentFetchLimits, type FetchedAttachment } from './attachments.js';

const logger = createLogger('inbound-webhook-receive');

/** The sender caps its body at 256 KiB before dropping `slack_message`; this leaves headroom. */
export const INBOUND_WEBHOOK_MAX_BODY_BYTES = 512 * 1024;

/** Replay window, applied to both directions (past and future). */
export const INBOUND_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

/**
 * `webhook-id` becomes part of a per-target directory name and of the job id, and it is
 * sender-controlled: a leading alphanumeric (no `.`/`..`, no leading dash), then a short run of
 * filename-safe characters. No `/`, whitespace, NUL or non-ASCII can pass.
 */
const WEBHOOK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Longest summary, counted in code points so a surrogate pair is never cut. */
const SUMMARY_MAX_CODE_POINTS = 160;

const SUMMARY_FALLBACK = 'Inbound webhook message';

const SIGNATURE_VERSION_PREFIX = 'v1,';
const HMAC_SHA256_BYTES = 32;

/** The deterministic id of one delivery: the job id and the per-target directory name. */
export function inboundWebhookDeliveryId(endpointId: string, webhookId: string): string {
  return `inbound-webhook:${endpointId}:${webhookId}`;
}

export function isValidWebhookId(value: string): boolean {
  return WEBHOOK_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Signature and timestamp
// ---------------------------------------------------------------------------

export interface SignatureCheckInput {
  /** Stored `whsec_<base64>` secret. */
  secret: string;
  webhookId: string;
  /** `webhook-timestamp` header, verbatim. */
  timestamp: string;
  /** Raw request text, exactly as received. */
  rawBody: string;
  /** `webhook-signature` header: space-separated `v1,<base64>` entries. */
  signatureHeader: string;
}

/**
 * Standard Webhooks verification: HMAC-SHA256 over `{id}.{timestamp}.{body}`, keyed by the
 * base64-DECODED bytes of the part after `whsec_`. Accepts if any space-separated `v1,` entry
 * matches. A malformed entry or a length mismatch is a plain refusal.
 */
export function verifyStandardWebhookSignature(input: SignatureCheckInput): boolean {
  if (!input.secret.startsWith(INBOUND_WEBHOOK_SECRET_PREFIX)) return false;
  const key = Buffer.from(input.secret.slice(INBOUND_WEBHOOK_SECRET_PREFIX.length), 'base64');
  const expected = createHmac('sha256', key)
    .update(`${input.webhookId}.${input.timestamp}.${input.rawBody}`)
    .digest();

  let matched = false;
  for (const entry of input.signatureHeader.split(' ')) {
    if (!entry.startsWith(SIGNATURE_VERSION_PREFIX)) continue;
    const candidate = Buffer.from(entry.slice(SIGNATURE_VERSION_PREFIX.length), 'base64');
    if (candidate.length !== HMAC_SHA256_BYTES) continue;
    if (timingSafeEqual(candidate, expected)) matched = true;
  }
  return matched;
}

/**
 * Whether `timestamp` (unix seconds, plain decimal digits) is within the tolerance of `now`.
 * Exactly the tolerance is accepted on both sides. Missing, non-numeric or non-integer is false.
 */
export function isTimestampWithinTolerance(timestamp: string | undefined, now: Date): boolean {
  if (timestamp === undefined || !/^[0-9]{1,15}$/.test(timestamp)) return false;
  const skewMs = Math.abs(now.getTime() - Number(timestamp) * 1000);
  return skewMs <= INBOUND_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS * 1000;
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

const SlackFileSchema = v.object({
  name: v.optional(v.string()),
  mimetype: v.optional(v.string()),
  size: v.optional(v.number()),
  url: v.optional(v.string()),
});

/**
 * The sender's body (schema_version 1). Non-strict: unknown keys are ignored and missing keys are
 * absent. Beyond the types, the one requirement is that the message carries something to read:
 * `message` or `slack_message`.
 */
const InboundWebhookBodySchema = v.pipe(
  v.object({
    schema_version: v.optional(v.number()),
    event_id: v.optional(v.string()),
    team_id: v.optional(v.string()),
    matched_triggers: v.optional(v.array(v.string())),
    message: v.optional(v.string()),
    slack_channel: v.optional(v.string()),
    slack_ts: v.optional(v.string()),
    slack_thread_ts: v.optional(v.string()),
    slack_permalink: v.optional(v.string()),
    slack_files: v.optional(v.array(SlackFileSchema)),
    slack_message: v.optional(v.record(v.string(), v.unknown())),
    slack_message_truncated: v.optional(v.boolean()),
  }),
  v.check(
    (body) => body.message !== undefined || body.slack_message !== undefined,
    'Body carries neither message nor slack_message',
  ),
);

export type InboundWebhookBody = v.InferOutput<typeof InboundWebhookBodySchema>;

/** Parse the raw body text. `null` for invalid JSON, a non-object, a wrong type or no message. */
export function parseInboundWebhookBody(rawBody: string): InboundWebhookBody | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const result = v.safeParse(InboundWebhookBodySchema, json);
  return result.success ? result.output : null;
}

// ---------------------------------------------------------------------------
// Receive flow
// ---------------------------------------------------------------------------

export interface ReceiveInput {
  endpointId: string;
  /** Raw request text, read once and never re-serialized. */
  rawBody: string;
  webhookId: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

export interface ReceiveDeps {
  endpoints: Pick<InboundWebhookEndpointRepository, 'findWithSecretById'>;
  db: Kysely<Database>;
  jobQueue: Pick<JobQueue, 'enqueue' | 'wake'>;
  now: () => Date;
}

/** What the route should answer. A throw out of `receiveInboundWebhook` is the unhandled case. */
export type ReceiveResult =
  | { kind: 'not_found' }
  | { kind: 'unauthorized' }
  | { kind: 'invalid_request' }
  | { kind: 'duplicate' }
  | { kind: 'accepted' }
  | { kind: 'unavailable' };

/**
 * Verify one delivery and persist it: endpoint lookup, signature, timestamp, id and body
 * validation, then ONE transaction holding the dedupe row and the job row. Validation completes
 * before anything is written. The processor is woken after COMMIT, on a duplicate too, so a job
 * committed by an earlier attempt whose wake was lost is still picked up.
 */
export async function receiveInboundWebhook(input: ReceiveInput, deps: ReceiveDeps): Promise<ReceiveResult> {
  const { endpointId } = input;
  const endpoint = await deps.endpoints.findWithSecretById(endpointId);
  if (!endpoint) return { kind: 'not_found' };

  const now = deps.now();
  if (input.webhookId === undefined || input.timestamp === undefined || input.signature === undefined) {
    logger.warn({ endpointId, reason: 'missing-header' }, 'Inbound webhook refused');
    return { kind: 'unauthorized' };
  }
  const signed = (secret: string): boolean =>
    verifyStandardWebhookSignature({
      secret,
      webhookId: input.webhookId as string,
      timestamp: input.timestamp as string,
      rawBody: input.rawBody,
      signatureHeader: input.signature as string,
    });
  const verified =
    signed(endpoint.secret) ||
    (endpoint.previousSecret !== null &&
      isPreviousSecretActive(endpoint.previousSecretExpiresAt, now) &&
      signed(endpoint.previousSecret));
  if (!verified) {
    logger.warn({ endpointId, reason: 'bad-signature' }, 'Inbound webhook refused');
    return { kind: 'unauthorized' };
  }
  if (!isTimestampWithinTolerance(input.timestamp, now)) {
    logger.warn({ endpointId, reason: 'timestamp' }, 'Inbound webhook refused');
    return { kind: 'unauthorized' };
  }

  const { webhookId } = input;
  if (!isValidWebhookId(webhookId) || parseInboundWebhookBody(input.rawBody) === null) {
    logger.warn({ endpointId, reason: 'invalid-request' }, 'Inbound webhook refused');
    return { kind: 'invalid_request' };
  }

  const deliveryId = inboundWebhookDeliveryId(endpointId, webhookId);
  const receivedAt = now.toISOString();
  const payload: InboundWebhookProcessPayload = {
    jobId: deliveryId,
    endpointId,
    rawPayload: input.rawBody,
    receivedAt,
  };

  let outcome: 'duplicate' | 'accepted';
  try {
    outcome = await deps.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('inbound_webhook_deliveries')
        .values({ endpoint_id: endpointId, webhook_id: webhookId, received_at: receivedAt })
        .onConflict((oc) => oc.columns(['endpoint_id', 'webhook_id']).doNothing())
        .returning('webhook_id')
        .executeTakeFirst();
      if (!inserted) return 'duplicate';
      await deps.jobQueue.enqueue(JOB_TYPES.INBOUND_WEBHOOK_PROCESS, payload, {
        jobId: deliveryId,
        executor: trx,
      });
      return 'accepted';
    });
  } catch (error) {
    // Never the payload: only the ids and the error.
    logger.error({ err: error, endpointId, webhookId }, 'Failed to persist inbound webhook delivery');
    return { kind: 'unavailable' };
  }

  deps.jobQueue.wake();
  return { kind: outcome };
}

// ---------------------------------------------------------------------------
// Job front: delivery content
// ---------------------------------------------------------------------------

/** The endpoint as the action half sees it: no secrets. */
export interface DeliveryEndpoint {
  id: string;
  repositoryId: string;
  label: string;
}

/** What the receive half hands to an action. Content, not files. */
export interface DeliveryContent {
  /** Sanitized projection of the untrusted sender message. */
  bodyMarkdown: string;
  /** The operator's `instruction_text` as stored at the process-time re-read, byte for byte. */
  instructionMarkdown: string;
  /** Sender text on one line, at most ~160 characters. */
  summary: string;
  /** The Slack permalink, or null. */
  url: string | null;
  deliveryId: string;
  endpoint: DeliveryEndpoint;
  /** Fetched attachments, fetched once; the action copies them per target. Sanitized unique names. */
  attachments: FetchedAttachment[];
  /** Equal to `attachments.length`. 0 when the message carried no files. */
  attachmentsFetched: number;
  /** Files listed by the sender that were not fetched, for any reason. 0 when it carried no files. */
  attachmentsSkipped: number;
  /** Whether the message listed any files at all (the counts are only reported when true). */
  hasAttachments: boolean;
}

export interface PrepareDeliveryDeps {
  endpoints: Pick<InboundWebhookEndpointRepository, 'findWithSecretById'>;
  /** The fetch used for attachments. Defaults to `outboundFetch` (the OS-CA-aware helper); an injected function overrides it. */
  attachmentFetch?: AttachmentFetch;
  /** Attachment limits. Default to the server config. */
  attachmentLimits?: AttachmentFetchLimits;
}

function toSingleLine(value: string): string {
  return stripControlChars(value).replace(/\s+/g, ' ').trim();
}

/** Single line, cut at SUMMARY_MAX_CODE_POINTS with `...` appended, never inside a surrogate pair. */
function toSummary(message: string | undefined): string {
  const line = toSingleLine(message ?? '');
  if (line === '') return SUMMARY_FALLBACK;
  const codePoints = Array.from(line);
  if (codePoints.length <= SUMMARY_MAX_CODE_POINTS) return line;
  return `${codePoints.slice(0, SUMMARY_MAX_CODE_POINTS).join('')}...`;
}

/** Keep \n and \t; drop every other control character. */
function sanitizeMultiline(value: string): string {
  return stripControlChars(value).replace(/\r/g, '');
}

/**
 * Projection of `message`, `slack_permalink`, `slack_channel` and `slack_ts`, plus the LOCAL names
 * of the fetched attachments. `slack_message` and the `slack_files` entries never enter it: the
 * first is the raw event, the second carries short-lived download-token URLs, and a listed
 * attachment is only ever a file name under `attachments/` (the sanitized name, not the declared
 * name, mimetype or size).
 */
function buildBodyMarkdown(body: InboundWebhookBody, attachments: { names: string[]; skipped: number }): string {
  const lines = ['# Inbound webhook message', '', '## Message', '', sanitizeMultiline(body.message ?? '')];
  const details: string[] = [];
  if (body.slack_permalink !== undefined) details.push(`- Permalink: ${toSingleLine(body.slack_permalink)}`);
  if (body.slack_channel !== undefined) details.push(`- Channel: ${toSingleLine(body.slack_channel)}`);
  if (body.slack_ts !== undefined) details.push(`- Timestamp: ${toSingleLine(body.slack_ts)}`);
  if (details.length > 0) lines.push('', '## Details', '', ...details);
  if (attachments.names.length > 0 || attachments.skipped > 0) {
    lines.push('', '## Attachments', '');
    for (const name of attachments.names) lines.push(`- attachments/${name}`);
    if (attachments.skipped > 0) lines.push(`- Not fetched: ${attachments.skipped}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Re-read the endpoint and build the delivery content. A missing endpoint (deleted, or
 * cascade-deleted with its repository) can never succeed on retry: `PermanentHandlerError`.
 * The secret fields of the row are not read.
 */
export async function prepareDelivery(
  payload: InboundWebhookProcessPayload,
  deps: PrepareDeliveryDeps,
): Promise<DeliveryContent> {
  const endpoint = await deps.endpoints.findWithSecretById(payload.endpointId);
  if (!endpoint) {
    throw new PermanentHandlerError(`Inbound webhook endpoint no longer exists: ${payload.endpointId}`);
  }
  const body = parseInboundWebhookBody(payload.rawPayload);
  if (body === null) {
    throw new PermanentHandlerError('Stored inbound webhook payload does not match the body schema');
  }
  const files = body.slack_files ?? [];
  const { fetched, skipped } = files.length === 0
    ? { fetched: [], skipped: 0 }
    : await fetchAttachments(files, { fetch: deps.attachmentFetch, limits: deps.attachmentLimits });
  return {
    bodyMarkdown: buildBodyMarkdown(body, { names: fetched.map((file) => file.name), skipped }),
    instructionMarkdown: endpoint.instructionText,
    summary: toSummary(body.message),
    url: body.slack_permalink ?? null,
    deliveryId: payload.jobId,
    endpoint: { id: endpoint.id, repositoryId: endpoint.repositoryId, label: endpoint.label },
    attachments: fetched,
    attachmentsFetched: fetched.length,
    attachmentsSkipped: skipped,
    hasAttachments: files.length > 0,
  };
}
