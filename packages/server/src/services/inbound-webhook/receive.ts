/**
 * Receive half of the generic signed inbound webhook.
 *
 * Owns everything that does not depend on who acts on a message: endpoint lookup, Standard
 * Webhooks signature and timestamp verification, id and body validation, the transactional
 * dedupe + enqueue, the process-time endpoint re-read and the delivery content. It is Hono-free
 * (the route is a thin adapter) and imports nothing from the action half, so a later endpoint
 * kind plugs a different action into the same `DeliveryContent` seam.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Kysely } from 'kysely';
import * as v from 'valibot';
import { JOB_TYPES, type InboundWebhookProcessPayload, type JobQueue } from '../../jobs/index.js';
import type { Database } from '../../database/schema.js';
import { computeStandardWebhookDigest, isPreviousSecretActive } from '../../lib/inbound-webhook-secret.js';
import { createLogger } from '../../lib/logger.js';
import type { InboundWebhookEndpointRepository } from '../../repositories/webhook-endpoint-repository.js';
import { PermanentHandlerError } from '../inbound/job-handler.js';
import { fetchAttachments, type AttachmentFetch, type AttachmentFileEntry, type AttachmentFetchLimits, type FetchedAttachment } from './attachments.js';
import { projectSlackContent, readPosterIdentity, sanitizeMultiline, toSingleLine, type PosterIdentity } from './slack-content.js';

const logger = createLogger('inbound-webhook-receive');

/** The sender caps its body at 256 KiB before dropping the source event; this leaves headroom. */
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

const DELIVERY_ID_PREFIX = 'inbound-webhook:';

/**
 * Inverse of `inboundWebhookDeliveryId`: the endpoint id runs to the NEXT `:`, the rest is the
 * webhook id (which may itself contain `:`) and must be a valid webhook id. `null` otherwise.
 */
export function parseInboundWebhookDeliveryId(deliveryId: string): { endpointId: string; webhookId: string } | null {
  if (!deliveryId.startsWith(DELIVERY_ID_PREFIX)) return null;
  const rest = deliveryId.slice(DELIVERY_ID_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) return null;
  const endpointId = rest.slice(0, separator);
  const webhookId = rest.slice(separator + 1);
  if (!isValidWebhookId(webhookId)) return null;
  return { endpointId, webhookId };
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
  const expected = computeStandardWebhookDigest(input.secret, input.webhookId, input.timestamp, input.rawBody);
  if (expected === null) return false;

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
 * The body as every consumer below this parser sees it. The reader maps into this shape; nothing
 * downstream reads a body key.
 */
export interface InboundMessage {
  schemaVersion: 2;
  /** Sender text. Empty when the body carried none. */
  message: string;
  permalink: string | null;
  channel: string | null;
  ts: string | null;
  files: AttachmentFileEntry[];
  /** The raw source event whose blocks / attachments are projected, or null when there is none. */
  sourceEvent: Record<string, unknown> | null;
  /** The sender dropped (part of) the source event to fit its own size limit. */
  sourceEventTruncated: boolean;
}

export type InboundWebhookRefusalReason = 'invalid-request' | 'unsupported-schema-version';

export type ParseInboundWebhookBodyResult =
  | { ok: true; message: InboundMessage }
  | {
      ok: false;
      reason: InboundWebhookRefusalReason;
      /** The received `schema_version`, only when it is a finite number (never any other value). */
      schemaVersion?: number;
    };

const refuse = (reason: InboundWebhookRefusalReason, schemaVersion?: number): ParseInboundWebhookBodyResult =>
  schemaVersion === undefined ? { ok: false, reason } : { ok: false, reason, schemaVersion };

// The body reader. Non-strict at every level: the sender may add keys within a version. The
// reply address the sender carries (`hikyac.reply`) is deliberately not declared, so it is not read.
const BodyV2Schema = v.object({
  message: v.string(),
  hikyac: v.object({
    permalink: v.nullable(v.string()),
    files: v.array(SlackFileSchema),
  }),
  source: v.object({ type: v.string() }),
});

// Read only when `source.type` is `slack`; any other source type is never looked into.
const SlackSourceV2Schema = v.object({
  ids: v.object({ channel: v.string(), ts: v.string() }),
  event: v.nullable(v.record(v.string(), v.unknown())),
  truncated: v.boolean(),
});

const HIKYAC_VERSION = 1;
const SLACK_SOURCE_TYPE = 'slack';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBodyV2(json: Record<string, unknown>): ParseInboundWebhookBodyResult {
  // The envelope version inside `hikyac` is checked first: a body whose envelope this reader does
  // not know is refused as unsupported whatever else is wrong with it.
  if (isPlainObject(json.hikyac) && json.hikyac.v !== HIKYAC_VERSION) {
    return refuse('unsupported-schema-version', 2);
  }
  const result = v.safeParse(BodyV2Schema, json);
  if (!result.success) return refuse('invalid-request');
  const body = result.output;
  const base = {
    schemaVersion: 2 as const,
    message: body.message,
    permalink: body.hikyac.permalink,
    files: body.hikyac.files,
  };
  if (body.source.type !== SLACK_SOURCE_TYPE) {
    return { ok: true, message: { ...base, channel: null, ts: null, sourceEvent: null, sourceEventTruncated: false } };
  }
  const source = v.safeParse(SlackSourceV2Schema, (json as { source: unknown }).source);
  if (!source.success) return refuse('invalid-request');
  return {
    ok: true,
    message: {
      ...base,
      channel: source.output.ids.channel,
      ts: source.output.ids.ts,
      sourceEvent: source.output.event,
      sourceEventTruncated: source.output.truncated,
    },
  };
}

/**
 * Parse the raw body text into the normalised message. Only `schema_version` 2 is read; an absent
 * key or any other value is refused as an unsupported version. A body the reader fails on is refused.
 */
export function parseInboundWebhookBody(rawBody: string): ParseInboundWebhookBodyResult {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return refuse('invalid-request');
  }
  if (!isPlainObject(json)) return refuse('invalid-request');
  if (!Object.hasOwn(json, 'schema_version')) return refuse('unsupported-schema-version');
  const version = json.schema_version;
  if (version === 2) return readBodyV2(json);
  return refuse('unsupported-schema-version', typeof version === 'number' && Number.isFinite(version) ? version : undefined);
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
  if (!isValidWebhookId(webhookId)) {
    logger.warn({ endpointId, reason: 'invalid-request' }, 'Inbound webhook refused');
    return { kind: 'invalid_request' };
  }

  // A recorded reply id is a message this server signed itself; if the sender echoes it back it
  // must not be delivered to a session as a new inbound message. The lookup runs after signature
  // verification (an unsigned request cannot probe reply ids) and before body-schema validation,
  // so the answer to a reflected reply does not depend on the shape of its body.
  const reflected = await deps.db
    .selectFrom('inbound_webhook_replies')
    .select('id')
    .where('id', '=', webhookId)
    .where('endpoint_id', '=', endpointId)
    .executeTakeFirst();
  if (reflected) {
    logger.warn({ endpointId, webhookId, reason: 'reply-id-reflected' }, 'Inbound webhook ignored');
    return { kind: 'duplicate' };
  }

  const parsedBody = parseInboundWebhookBody(input.rawBody);
  if (!parsedBody.ok) {
    logger.warn(
      {
        endpointId,
        reason: parsedBody.reason,
        ...(parsedBody.schemaVersion === undefined ? {} : { schemaVersion: parsedBody.schemaVersion }),
      },
      'Inbound webhook refused',
    );
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
  /**
   * Sanitized projection of the untrusted sender message: its text, the Slack content projection
   * (blocks and attachments, text only), permalink, channel, timestamp, the poster's `app_id` /
   * `bot_id` when they match the id shape, and fetched attachment names.
   */
  bodyMarkdown: string;
  /** The operator's `instruction_text` as stored at the process-time re-read, byte for byte. */
  instructionMarkdown: string;
  /** Sender text on one line, at most ~160 characters: `message`, or the first projected content line when `message` is empty. */
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

/** Single line, cut at SUMMARY_MAX_CODE_POINTS with `...` appended, never inside a surrogate pair. */
function toSummary(message: string | undefined): string {
  const line = toSingleLine(message ?? '');
  if (line === '') return SUMMARY_FALLBACK;
  const codePoints = Array.from(line);
  if (codePoints.length <= SUMMARY_MAX_CODE_POINTS) return line;
  return `${codePoints.slice(0, SUMMARY_MAX_CODE_POINTS).join('')}...`;
}

/**
 * Projection of the normalised message: its text, permalink, channel and timestamp, a text-only
 * projection of the source event's `blocks` / `attachments` (the `## Content` section, between
 * `## Message` and `## Details`; see `slack-content.ts`), plus the LOCAL names of the fetched
 * attachments, and the poster's `app_id` / `bot_id` when each matches the id shape (the only keys
 * of the source event read besides `blocks` and `attachments`). The source event itself, every
 * other key of it, and the file entries never enter it: the first is the raw event, the second
 * carries short-lived download-token URLs, and a listed attachment is only ever a file name under
 * `attachments/` (the sanitized name, not the declared name, mimetype or size). With no section,
 * the output is identical to a message without a source event.
 */
function buildBodyMarkdown(
  message: InboundMessage,
  section: string[] | null,
  poster: PosterIdentity,
  attachments: { names: string[]; skipped: number },
): string {
  const lines = ['# Inbound webhook message', '', '## Message', '', sanitizeMultiline(message.message)];
  if (section !== null) lines.push('', ...section);
  const details: string[] = [];
  if (message.permalink !== null) details.push(`- Permalink: ${toSingleLine(message.permalink)}`);
  if (message.channel !== null) details.push(`- Channel: ${toSingleLine(message.channel)}`);
  if (message.ts !== null) details.push(`- Timestamp: ${toSingleLine(message.ts)}`);
  if (poster.appId.kind === 'shown') details.push(`- App ID: ${poster.appId.value}`);
  if (poster.botId.kind === 'shown') details.push(`- Bot ID: ${poster.botId.value}`);
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
  const parsed = parseInboundWebhookBody(payload.rawPayload);
  if (!parsed.ok) {
    throw new PermanentHandlerError('Stored inbound webhook payload does not match the body schema');
  }
  const message = parsed.message;
  const files = message.files;
  const { fetched, skipped } = files.length === 0
    ? { fetched: [], skipped: 0 }
    : await fetchAttachments(files, { fetch: deps.attachmentFetch, limits: deps.attachmentLimits });
  const sourceEvent = message.sourceEvent ?? undefined;
  const projection = projectSlackContent(sourceEvent, message.sourceEventTruncated);
  const poster = readPosterIdentity(sourceEvent);
  // Counts and kinds only, never a payload string.
  logger.info(
    {
      deliveryId: payload.jobId,
      endpointId: endpoint.id,
      schemaVersion: message.schemaVersion,
      ...projection.counts,
      appId: poster.appId.kind,
      botId: poster.botId.kind,
      senderTruncated: message.sourceEventTruncated,
    },
    'Slack content projected',
  );
  const summary = toSingleLine(message.message) !== ''
    ? toSummary(message.message)
    : toSummary(projection.firstLine ?? undefined);
  return {
    bodyMarkdown: buildBodyMarkdown(message, projection.section, poster, { names: fetched.map((file) => file.name), skipped }),
    instructionMarkdown: endpoint.instructionText,
    summary,
    url: message.permalink,
    deliveryId: payload.jobId,
    endpoint: { id: endpoint.id, repositoryId: endpoint.repositoryId, label: endpoint.label },
    attachments: fetched,
    attachmentsFetched: fetched.length,
    attachmentsSkipped: skipped,
    hasAttachments: files.length > 0,
  };
}
