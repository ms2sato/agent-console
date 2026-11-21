/**
 * Signed reply to an inbound webhook delivery (reply half).
 *
 * A session that received a delivery can answer the sender: one HTTP POST to the endpoint's
 * operator-set reply URL, signed with the endpoint's CURRENT secret under the same scheme the
 * receive half verifies. The signature, the secret and the reply URL never leave this module: they
 * appear in no returned value and no log line. A thrown fetch error is logged by name only.
 *
 * Every reply has a server-minted id that is also the `webhook-id` header. The reply row is
 * committed BEFORE the first POST, so the id survives a crash or a timeout and a resend reuses it.
 * The server never retries on its own. This module imports nothing from the action half.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../../database/schema.js';
import { signStandardWebhook } from '../../lib/inbound-webhook-secret.js';
import { createLogger } from '../../lib/logger.js';
import { outboundFetch } from '../../lib/outbound-tls.js';
import { serverConfig } from '../../lib/server-config.js';
import type { InboundWebhookEndpointRepository } from '../../repositories/webhook-endpoint-repository.js';
import { parseInboundWebhookDeliveryId } from './receive.js';
import { sanitizeMultiline, toSingleLine } from './slack-content.js';

const logger = createLogger('inbound-webhook-reply');

/** Largest `JSON.stringify(body)` accepted, in UTF-8 bytes. Exactly the cap passes. */
export const MAX_REPLY_BODY_BYTES = 262_144;
/** Attempts allowed per reply id. The attempt after this many is refused. */
export const MAX_ATTEMPTS_PER_REPLY = 10;
/** Replies allowed per (delivery, session). The reply after this many is refused. */
export const MAX_REPLIES_PER_DELIVERY_SESSION = 20;
/** Most response-body bytes kept; the reader is cancelled past it. */
export const RESPONSE_BODY_CAP_BYTES = 4096;
/** Most characters of the `retry-after` header returned. */
export const RETRY_AFTER_MAX_CHARS = 64;

/** The notification event type that records "this delivery was routed to this session". */
const ROUTED_EVENT_TYPE = 'external:message';

/** Tool error texts. One generic text per refusal class so the tool is not an oracle. */
export const REPLY_ERRORS = {
  bodyNotObject: 'body must be a JSON object',
  bodyTooLarge: 'body is too large',
  unknownDelivery: 'Unknown delivery',
  repliesNotEnabled: 'Replies are not enabled for this endpoint',
  replyLimitReached: 'Reply limit reached for this delivery',
  unknownReply: 'Unknown reply',
  bodyDiffers: 'Body differs from the recorded reply; send a new reply instead',
  attemptLimitReached: 'Attempt limit reached for this reply',
  recordFailed: 'The reply could not be recorded; nothing was sent',
} as const;

/** What `fetch` is used for here. The default is `outboundFetch`, which satisfies it. */
export type ReplyFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    redirect: 'manual';
    signal: AbortSignal;
  },
) => Promise<Response>;

export interface ReplyDeps {
  /** Only the secret-bearing lookup is used; it is read at call time, so a rotation or edit takes effect. */
  endpoints: Pick<InboundWebhookEndpointRepository, 'findWithSecretById'>;
  db: Kysely<Database>;
  /** Defaults to `outboundFetch`, so the OS CA bundle governs the connection. */
  fetch?: ReplyFetch;
  /** Defaults to the wall clock. */
  now?: () => Date;
  /** Defaults to `reply_<uuid v4>`. */
  generateId?: () => string;
  /** Defaults to `INBOUND_WEBHOOK_REPLY_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface ReplyInput {
  /** The calling session, already resolved by the caller's identity layer. */
  sessionId: string;
  deliveryId: string;
  body: unknown;
  /** Present only when resending a reply that was already attempted. */
  replyId?: string;
}

export type ReplyResult =
  | {
      replyId: string;
      attempt: number;
      outcome: 'responded';
      status: number;
      responseBody: string;
      responseBodyTruncated: boolean;
      retryAfter?: string;
    }
  | {
      replyId: string;
      attempt: number;
      outcome: 'no-response';
      reason: 'timeout' | 'connection-failed';
    };

export type ReplyOutcome = { ok: true; result: ReplyResult } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Body hashing
// ---------------------------------------------------------------------------

/** The same value with every object's keys in sorted order, recursively. Arrays keep their order. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, inner]) => [key, sortKeysDeep(inner)]),
    );
  }
  return value;
}

/** Hex SHA-256 of the body's canonical JSON, so key order does not change a reply's identity. */
function canonicalBodyHash(body: object): string {
  return createHash('sha256').update(JSON.stringify(sortKeysDeep(body))).digest('hex');
}

// ---------------------------------------------------------------------------
// Bounded exchange helpers
// ---------------------------------------------------------------------------

class ExchangeTimedOut extends Error {
  constructor() {
    super('exchange timed out');
    this.name = 'ExchangeTimedOut';
  }
}

/** Settles like `promise`, or rejects when `signal` aborts first (also for a fetch that ignores the signal). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new ExchangeTimedOut());
      return;
    }
    const onAbort = () => reject(new ExchangeTimedOut());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Drop a trailing incomplete UTF-8 sequence so the cut never splits a code point. */
function trimToCodePointBoundary(bytes: Uint8Array): Uint8Array {
  let i = bytes.length - 1;
  let continuation = 0;
  while (i >= 0 && continuation < 3 && (bytes[i]! & 0b1100_0000) === 0b1000_0000) {
    i -= 1;
    continuation += 1;
  }
  if (i < 0) return bytes.subarray(0, 0);
  const lead = bytes[i]!;
  let needed = 1;
  if ((lead & 0b1110_0000) === 0b1100_0000) needed = 2;
  else if ((lead & 0b1111_0000) === 0b1110_0000) needed = 3;
  else if ((lead & 0b1111_1000) === 0b1111_0000) needed = 4;
  // `continuation` bytes follow the lead; the sequence is whole only when they match what it announces.
  return continuation + 1 >= needed ? bytes : bytes.subarray(0, i);
}

interface BoundedBody {
  text: string;
  /** Bytes kept. */
  bytes: number;
  /** More existed than was kept, or the read did not finish. */
  truncated: boolean;
}

/** Read at most `RESPONSE_BODY_CAP_BYTES`, cancel the reader at the cap, stop when `signal` aborts. */
async function readBoundedBody(response: Response, signal: AbortSignal): Promise<BoundedBody> {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', bytes: 0, truncated: false };

  const kept: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await untilAborted(reader.read(), signal);
      if (done) break;
      if (value.length === 0) continue;
      const room = RESPONSE_BODY_CAP_BYTES - total;
      if (value.length > room) {
        if (room > 0) kept.push(value.subarray(0, room));
        total += Math.max(room, 0);
        truncated = true;
        break;
      }
      kept.push(value);
      total += value.length;
    }
  } catch {
    truncated = true;
  }
  if (truncated) reader.cancel().catch(() => undefined);

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of kept) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  const bytes = truncated ? trimToCodePointBoundary(joined) : joined;
  return { text: sanitizeMultiline(new TextDecoder().decode(bytes)), bytes: total, truncated };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/** Caller-supplied ids are logged bounded. */
function bounded(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}...` : value;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Send, or resend, a signed reply. Evaluates the refusals in a fixed order (body shape, body size,
 * delivery ownership, reply URL, then either the new-reply limit or the resend checks) and only
 * then makes the request. Any HTTP status is a result, not an error.
 */
export async function replyToInboundWebhook(input: ReplyInput, deps: ReplyDeps): Promise<ReplyOutcome> {
  const { sessionId, deliveryId, body } = input;
  const now = deps.now ?? (() => new Date());
  const fetchImpl: ReplyFetch = deps.fetch ?? outboundFetch;
  const generateId = deps.generateId ?? (() => `reply_${randomUUID()}`);
  const timeoutMs = deps.timeoutMs ?? serverConfig.INBOUND_WEBHOOK_REPLY_TIMEOUT_MS;

  const refuse = (error: string, reason: string, extra: Record<string, unknown> = {}): ReplyOutcome => {
    logger.warn({ deliveryId: bounded(deliveryId), sessionId, reason, ...extra }, 'Inbound webhook reply refused');
    return { ok: false, error };
  };

  // Row 2
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return refuse(REPLY_ERRORS.bodyNotObject, 'body-not-object');
  }

  // Row 3
  const requestBody = JSON.stringify(body);
  const requestBytes = Buffer.byteLength(requestBody, 'utf-8');
  if (requestBytes > MAX_REPLY_BODY_BYTES) {
    return refuse(REPLY_ERRORS.bodyTooLarge, 'body-too-large', { requestBytes });
  }

  // Row 4: the delivery exists, and it was routed to THIS session.
  const parsed = parseInboundWebhookDeliveryId(deliveryId);
  if (parsed === null) return refuse(REPLY_ERRORS.unknownDelivery, 'delivery-id-malformed');
  const { endpointId, webhookId } = parsed;

  const deliveryRow = await deps.db
    .selectFrom('inbound_webhook_deliveries')
    .select('webhook_id')
    .where('endpoint_id', '=', endpointId)
    .where('webhook_id', '=', webhookId)
    .executeTakeFirst();
  if (!deliveryRow) return refuse(REPLY_ERRORS.unknownDelivery, 'delivery-missing', { endpointId });

  const routedRow = await deps.db
    .selectFrom('inbound_event_notifications')
    .select('id')
    .where('job_id', '=', deliveryId)
    .where('session_id', '=', sessionId)
    .where('event_type', '=', ROUTED_EVENT_TYPE)
    .executeTakeFirst();
  if (!routedRow) return refuse(REPLY_ERRORS.unknownDelivery, 'not-routed-to-session', { endpointId });

  // Rows 5, 18, 19: the reply URL and secret as they are now.
  const endpoint = await deps.endpoints.findWithSecretById(endpointId);
  if (!endpoint) return refuse(REPLY_ERRORS.unknownDelivery, 'endpoint-missing', { endpointId });
  const replyUrl = endpoint.replyUrl;
  if (replyUrl === null) return refuse(REPLY_ERRORS.repliesNotEnabled, 'reply-url-not-set', { endpointId });

  const bodyHash = canonicalBodyHash(body);
  let replyId: string;

  if (input.replyId === undefined) {
    // Rows 6, 7
    const countRow = await deps.db
      .selectFrom('inbound_webhook_replies')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('endpoint_id', '=', endpointId)
      .where('webhook_id', '=', webhookId)
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    if (Number(countRow?.count ?? 0) >= MAX_REPLIES_PER_DELIVERY_SESSION) {
      return refuse(REPLY_ERRORS.replyLimitReached, 'reply-limit-reached', { endpointId });
    }

    replyId = generateId();
    try {
      await deps.db
        .insertInto('inbound_webhook_replies')
        .values({
          id: replyId,
          endpoint_id: endpointId,
          webhook_id: webhookId,
          session_id: sessionId,
          body_sha256: bodyHash,
          attempt_count: 0,
          last_status: null,
          created_at: now().toISOString(),
          last_attempt_at: null,
        })
        .execute();
    } catch (error) {
      return refuse(REPLY_ERRORS.recordFailed, 'reply-row-write-failed', { endpointId, errorName: errorName(error) });
    }
  } else {
    // Rows 8, 9
    const row = await deps.db
      .selectFrom('inbound_webhook_replies')
      .select(['id', 'body_sha256'])
      .where('id', '=', input.replyId)
      .where('endpoint_id', '=', endpointId)
      .where('webhook_id', '=', webhookId)
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    if (!row) return refuse(REPLY_ERRORS.unknownReply, 'reply-unknown', { endpointId, replyId: bounded(input.replyId) });
    if (row.body_sha256 !== bodyHash) {
      return refuse(REPLY_ERRORS.bodyDiffers, 'body-differs', { endpointId, replyId: row.id });
    }
    replyId = row.id;
  }

  // Rows 10, 11: one statement counts the attempt, and the request is made only if it counted.
  let attempt: number;
  try {
    const counted = await deps.db
      .updateTable('inbound_webhook_replies')
      .set((eb) => ({ attempt_count: eb('attempt_count', '+', 1), last_attempt_at: now().toISOString() }))
      .where('id', '=', replyId)
      .where('attempt_count', '<', MAX_ATTEMPTS_PER_REPLY)
      .returning('attempt_count')
      .executeTakeFirst();
    if (!counted) return refuse(REPLY_ERRORS.attemptLimitReached, 'attempt-limit-reached', { endpointId, replyId });
    attempt = counted.attempt_count;
  } catch (error) {
    return refuse(REPLY_ERRORS.recordFailed, 'attempt-write-failed', { endpointId, replyId, errorName: errorName(error) });
  }

  const timestamp = String(Math.floor(now().getTime() / 1000));
  const signature = signStandardWebhook({ secret: endpoint.secret, id: replyId, timestamp, body: requestBody });

  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let result: ReplyResult;
  let responseBytes = 0;
  try {
    let response: Response | null = null;
    let failure: 'timeout' | 'connection-failed' | null = null;
    let failureName = '';
    try {
      response = await untilAborted(
        fetchImpl(replyUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'webhook-id': replyId,
            'webhook-timestamp': timestamp,
            'webhook-signature': signature,
          },
          body: requestBody,
          redirect: 'manual',
          signal: controller.signal,
        }),
        controller.signal,
      );
    } catch (error) {
      failure = controller.signal.aborted ? 'timeout' : 'connection-failed';
      failureName = errorName(error);
    }

    if (response === null) {
      const reason = failure ?? 'connection-failed';
      result = { replyId, attempt, outcome: 'no-response', reason };
      logger.info(
        {
          endpointId,
          deliveryId,
          replyId,
          sessionId,
          attempt,
          outcome: 'no-response',
          reason,
          errorName: failureName,
          durationMs: Math.round(performance.now() - startedAt),
          requestBytes,
          responseBytes: 0,
        },
        'Inbound webhook reply attempted',
      );
    } else {
      const read = await readBoundedBody(response, controller.signal);
      responseBytes = read.bytes;
      const retryAfterRaw = response.headers.get('retry-after');
      const retryAfter =
        retryAfterRaw === null ? '' : Array.from(toSingleLine(retryAfterRaw)).slice(0, RETRY_AFTER_MAX_CHARS).join('');
      result = {
        replyId,
        attempt,
        outcome: 'responded',
        status: response.status,
        responseBody: read.text,
        responseBodyTruncated: read.truncated,
        ...(retryAfter !== '' ? { retryAfter } : {}),
      };
      logger.info(
        {
          endpointId,
          deliveryId,
          replyId,
          sessionId,
          attempt,
          outcome: 'responded',
          status: response.status,
          durationMs: Math.round(performance.now() - startedAt),
          requestBytes,
          responseBytes,
        },
        'Inbound webhook reply attempted',
      );
    }
  } finally {
    clearTimeout(timer);
  }

  // Row 21: the result is returned even when recording its status fails.
  try {
    await deps.db
      .updateTable('inbound_webhook_replies')
      .set({ last_status: result.outcome === 'responded' ? result.status : null })
      .where('id', '=', replyId)
      .execute();
  } catch (error) {
    logger.warn(
      { endpointId, deliveryId, replyId, sessionId, attempt, reason: 'last-status-write-failed', errorName: errorName(error) },
      'Inbound webhook reply status not recorded',
    );
  }

  return { ok: true, result };
}
