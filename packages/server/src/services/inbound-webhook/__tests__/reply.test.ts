import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../database/schema.js';
import { createDatabaseForTest } from '../../../database/connection.js';
import { rootLogger } from '../../../lib/logger.js';
import { generateInboundWebhookSecret } from '../../../lib/inbound-webhook-secret.js';
import { SqliteInboundWebhookEndpointRepository } from '../../../repositories/sqlite-inbound-webhook-endpoint-repository.js';
import { inboundWebhookDeliveryId } from '../receive.js';
import {
  MAX_ATTEMPTS_PER_REPLY,
  MAX_REPLIES_PER_DELIVERY_SESSION,
  MAX_REPLY_BODY_BYTES,
  RESPONSE_BODY_CAP_BYTES,
  RETRY_AFTER_MAX_CHARS,
  replyToInboundWebhook,
  type ReplyFetch,
  type ReplyInput,
  type ReplyOutcome,
  type ReplyResult,
} from '../reply.js';

// Markers that must never leave the server (secret, URL query) or reach a log (request and response bodies).
const SECRET_MARKER = 'SECRETMARKER-3f9a';
const URL_MARKER = 'URLMARKER-71c2';
const BODY_MARKER = 'BODYMARKER-5d10';
const RESPONSE_MARKER = 'RESPONSEMARKER-8e44';
const REPLY_HOST = 'sender.example';

const SECRET = `whsec_${Buffer.from(`${SECRET_MARKER}-key-bytes-0123456789`).toString('base64')}`;
const PREVIOUS_SECRET = `whsec_${Buffer.from('previous-key-bytes-0123456789-abcdef').toString('base64')}`;
const ROTATED_SECRET = `whsec_${Buffer.from('rotated-key-bytes-0123456789-abcdefgh').toString('base64')}`;
const REPLY_URL = `https://${REPLY_HOST}/replies?token=${URL_MARKER}`;
const OTHER_REPLY_URL = `https://other.example/replies?token=${URL_MARKER}-2`;

const ENDPOINT_ID = 'ep-1';
const WEBHOOK_ID = 'Ev1';
const DELIVERY_ID = inboundWebhookDeliveryId(ENDPOINT_ID, WEBHOOK_ID);
const NOW = new Date('2026-11-21T10:00:00.000Z');

/** Sender-side signature, written from the Standard Webhooks specification (not production code). */
function specSignature(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

/** True when `signatureHeader` is the valid signature of this message under `secret`. */
function senderAccepts(secret: string, headers: Record<string, string>, body: string): boolean {
  return headers['webhook-signature'] === specSignature(secret, headers['webhook-id']!, headers['webhook-timestamp']!, body);
}

interface FetchCall {
  url: string;
  init: Parameters<ReplyFetch>[1];
}

describe('replyToInboundWebhook', () => {
  let db: Kysely<Database>;
  let endpoints: SqliteInboundWebhookEndpointRepository;
  let clock: Date;
  let calls: FetchCall[];
  let respond: (call: FetchCall) => Promise<Response>;
  let logSpies: Array<ReturnType<typeof spyOn>>;
  type LogCall = unknown[];

  const okResponse = () => new Response('ok', { status: 200 });

  const fakeFetch: ReplyFetch = (url, init) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };

  const deps = (over: Partial<Parameters<typeof replyToInboundWebhook>[1]> = {}) => ({
    endpoints,
    db,
    fetch: fakeFetch,
    now: () => clock,
    timeoutMs: 2000,
    ...over,
  });

  const reply = (over: Partial<ReplyInput> = {}, depsOver: Parameters<typeof deps>[0] = {}): Promise<ReplyOutcome> =>
    replyToInboundWebhook(
      { sessionId: 's1', deliveryId: DELIVERY_ID, body: { text: 'hello' }, ...over },
      deps(depsOver),
    );

  const okResult = (outcome: ReplyOutcome): ReplyResult => {
    if (!outcome.ok) throw new Error(`expected a result, got error: ${outcome.error}`);
    return outcome.result;
  };

  const errorOf = (outcome: ReplyOutcome): string => {
    if (outcome.ok) throw new Error('expected an error, got a result');
    return outcome.error;
  };

  const replyRows = () => db.selectFrom('inbound_webhook_replies').selectAll().execute();

  const seedSession = async (id: string) => {
    await db
      .insertInto('sessions')
      .values({
        id,
        type: 'worktree',
        location_path: '/test/path',
        created_at: '2024-01-01T00:00:00Z',
        server_pid: null,
        initial_prompt: null,
        title: null,
        repository_id: null,
        worktree_id: null,
      })
      .execute();
  };

  const seedDelivery = async (endpointId: string, webhookId: string) => {
    await db
      .insertInto('inbound_webhook_deliveries')
      .values({ endpoint_id: endpointId, webhook_id: webhookId, received_at: NOW.toISOString() })
      .execute();
  };

  const seedRouting = async (
    sessionId: string,
    over: { jobId?: string; status?: 'pending' | 'delivered' | 'failed'; eventType?: string; handlerId?: string } = {},
  ) => {
    await db
      .insertInto('inbound_event_notifications')
      .values({
        id: crypto.randomUUID(),
        job_id: over.jobId ?? DELIVERY_ID,
        session_id: sessionId,
        worker_id: 'w1',
        handler_id: over.handlerId ?? 'h1',
        event_type: over.eventType ?? 'external:message',
        event_summary: 'summary',
        status: over.status ?? 'delivered',
        created_at: NOW.toISOString(),
        notified_at: null,
      })
      .execute();
  };

  const logged = (): string => JSON.stringify(logSpies.flatMap((spy) => spy.mock.calls));

  beforeEach(async () => {
    clock = NOW;
    calls = [];
    respond = async () => okResponse();
    db = await createDatabaseForTest();
    await db.insertInto('repositories').values({ id: 'repo-1', name: 'r', path: '/tmp/r' }).execute();
    endpoints = new SqliteInboundWebhookEndpointRepository(db);
    await endpoints.create({
      id: ENDPOINT_ID,
      label: 'Sender',
      repositoryId: 'repo-1',
      instructionText: 'x',
      secret: SECRET,
      replyUrl: REPLY_URL,
      now: '2026-11-07T00:00:00.000Z',
    });
    await seedSession('s1');
    await seedSession('s2');
    await seedDelivery(ENDPOINT_ID, WEBHOOK_ID);
    await seedRouting('s1');
    logSpies = [spyOn(rootLogger, 'info'), spyOn(rootLogger, 'warn'), spyOn(rootLogger, 'error')];
  });

  afterEach(async () => {
    for (const spy of logSpies) spy.mockRestore();
    await db.destroy();
  });

  // -------------------------------------------------------------------------
  // Table 2b, rows 2-21
  // -------------------------------------------------------------------------

  it('row 2: a body that is not a JSON object is refused (array, string, number, boolean, null, missing) and nothing is sent', async () => {
    for (const body of [[1], 'text', 5, true, null, undefined]) {
      expect(errorOf(await reply({ body }))).toBe('body must be a JSON object');
    }
    expect(calls).toHaveLength(0);
    expect(await replyRows()).toHaveLength(0);
  });

  it('row 3: a serialized body over 262,144 bytes is refused; exactly the cap passes', async () => {
    const overhead = Buffer.byteLength(JSON.stringify({ a: '' }), 'utf-8');
    const atCap = { a: 'x'.repeat(MAX_REPLY_BODY_BYTES - overhead) };
    expect(Buffer.byteLength(JSON.stringify(atCap), 'utf-8')).toBe(MAX_REPLY_BODY_BYTES);
    const over = { a: 'x'.repeat(MAX_REPLY_BODY_BYTES - overhead + 1) };

    expect(errorOf(await reply({ body: over }))).toBe('body is too large');
    expect(calls).toHaveLength(0);

    expect(okResult(await reply({ body: atCap })).outcome).toBe('responded');
    expect(calls).toHaveLength(1);
  });

  it('row 3: the cap is in UTF-8 bytes, not characters', async () => {
    const overhead = Buffer.byteLength(JSON.stringify({ a: '' }), 'utf-8');
    // 3-byte characters: character count is under the cap, byte length is over it.
    const body = { a: '€'.repeat(Math.ceil((MAX_REPLY_BODY_BYTES - overhead) / 3) + 1) };
    expect(JSON.stringify(body).length).toBeLessThan(MAX_REPLY_BODY_BYTES);
    expect(errorOf(await reply({ body }))).toBe('body is too large');
  });

  it('row 4: a malformed delivery id, a missing delivery row, a deleted endpoint and a delivery routed elsewhere are all "Unknown delivery"', async () => {
    const malformed = await reply({ deliveryId: 'not-a-delivery-id' });
    const noRow = await reply({ deliveryId: inboundWebhookDeliveryId(ENDPOINT_ID, 'Missing') });
    const otherSession = await reply({ sessionId: 's2' });
    expect(errorOf(malformed)).toBe('Unknown delivery');
    expect(errorOf(noRow)).toBe('Unknown delivery');
    expect(errorOf(otherSession)).toBe('Unknown delivery');

    await endpoints.delete('repo-1', ENDPOINT_ID);
    expect(errorOf(await reply())).toBe('Unknown delivery');
    expect(calls).toHaveLength(0);
    expect(await replyRows()).toHaveLength(0);
  });

  it('row 5: an endpoint with no reply URL refuses replies and sends nothing', async () => {
    await endpoints.update('repo-1', ENDPOINT_ID, { replyUrl: null }, NOW.toISOString());
    expect(errorOf(await reply())).toBe('Replies are not enabled for this endpoint');
    expect(calls).toHaveLength(0);
    expect(await replyRows()).toHaveLength(0);
  });

  it('row 6: with no replyId and 20 replies already, the 21st is refused (the 20th passes)', async () => {
    for (let i = 0; i < MAX_REPLIES_PER_DELIVERY_SESSION; i += 1) {
      okResult(await reply());
    }
    expect(await replyRows()).toHaveLength(MAX_REPLIES_PER_DELIVERY_SESSION);
    const sent = calls.length;
    expect(errorOf(await reply())).toBe('Reply limit reached for this delivery');
    expect(calls).toHaveLength(sent);
    expect(await replyRows()).toHaveLength(MAX_REPLIES_PER_DELIVERY_SESSION);
  });

  it('row 6: the limit is counted per (delivery, session): another session routed the same delivery still has its own 20', async () => {
    await seedRouting('s2', { handlerId: 'h2' });
    for (let i = 0; i < MAX_REPLIES_PER_DELIVERY_SESSION; i += 1) okResult(await reply());
    expect(errorOf(await reply())).toBe('Reply limit reached for this delivery');
    expect(okResult(await reply({ sessionId: 's2' })).attempt).toBe(1);
  });

  it('row 7: with no replyId and under the limit a reply id is minted, the row inserted, and attempt 1 made', async () => {
    const result = okResult(await reply());
    expect(result.replyId).toMatch(/^reply_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(result.attempt).toBe(1);
    const rows = await replyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.replyId,
      endpoint_id: ENDPOINT_ID,
      webhook_id: WEBHOOK_ID,
      session_id: 's1',
      attempt_count: 1,
      last_status: 200,
      created_at: NOW.toISOString(),
      last_attempt_at: NOW.toISOString(),
    });
    expect(rows[0]!.body_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('row 8: a replyId that is unknown, of another delivery, or of another session is "Unknown reply"', async () => {
    const first = okResult(await reply());
    expect(errorOf(await reply({ replyId: 'reply_nope' }))).toBe('Unknown reply');

    await seedDelivery(ENDPOINT_ID, 'Ev2');
    await seedRouting('s1', { jobId: inboundWebhookDeliveryId(ENDPOINT_ID, 'Ev2') });
    expect(
      errorOf(await reply({ deliveryId: inboundWebhookDeliveryId(ENDPOINT_ID, 'Ev2'), replyId: first.replyId })),
    ).toBe('Unknown reply');

    await seedRouting('s2', { handlerId: 'h2' });
    expect(errorOf(await reply({ sessionId: 's2', replyId: first.replyId }))).toBe('Unknown reply');
    expect(calls).toHaveLength(1);
  });

  it('row 9: a known replyId with a different body is refused and nothing is sent', async () => {
    const first = okResult(await reply({ body: { a: 1 } }));
    const message = 'Body differs from the recorded reply; send a new reply instead';
    expect(errorOf(await reply({ replyId: first.replyId, body: { a: 2 } }))).toBe(message);
    expect(calls).toHaveLength(1);
    expect((await replyRows())[0]!.attempt_count).toBe(1);
  });

  it('row 10: the 10th attempt of one reply passes and the 11th is refused without a request', async () => {
    const first = okResult(await reply());
    let last = first;
    for (let i = 2; i <= MAX_ATTEMPTS_PER_REPLY; i += 1) {
      last = okResult(await reply({ replyId: first.replyId }));
    }
    expect(last.attempt).toBe(MAX_ATTEMPTS_PER_REPLY);
    expect(calls).toHaveLength(MAX_ATTEMPTS_PER_REPLY);

    expect(errorOf(await reply({ replyId: first.replyId }))).toBe('Attempt limit reached for this reply');
    expect(calls).toHaveLength(MAX_ATTEMPTS_PER_REPLY);
    expect((await replyRows())[0]!.attempt_count).toBe(MAX_ATTEMPTS_PER_REPLY);
  });

  it('row 11: a resend with the same body reuses the id, with a new timestamp and a new signature', async () => {
    const first = okResult(await reply());
    clock = new Date(NOW.getTime() + 7000);
    const second = okResult(await reply({ replyId: first.replyId }));
    expect(second.replyId).toBe(first.replyId);
    expect(second.attempt).toBe(2);
    const [a, b] = calls.map((call) => call.init.headers);
    expect(b!['webhook-id']).toBe(a!['webhook-id']);
    expect(b!['webhook-timestamp']).not.toBe(a!['webhook-timestamp']);
    expect(b!['webhook-signature']).not.toBe(a!['webhook-signature']);
    expect(await replyRows()).toHaveLength(1);
  });

  it('row 12: any status the sender answers is a result, and a 3xx is returned as its status without being followed', async () => {
    for (const status of [200, 204, 302, 409, 429, 500]) {
      calls = [];
      respond = async () => new Response(status === 204 ? null : 'x', { status, headers: { location: 'https://elsewhere.example/' } });
      const result = okResult(await reply());
      expect(result).toMatchObject({ outcome: 'responded', status });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.init.redirect).toBe('manual');
    }
    const rows = await replyRows();
    expect(rows.map((row) => row.last_status).sort()).toEqual([200, 204, 302, 409, 429, 500]);
  });

  it('row 13: a response body over 4,096 bytes is cut to its first 4,096 bytes and flagged', async () => {
    respond = async () => new Response('a'.repeat(RESPONSE_BODY_CAP_BYTES + 100), { status: 200 });
    const result = okResult(await reply());
    expect(result).toMatchObject({ outcome: 'responded', responseBodyTruncated: true });
    expect((result as { responseBody: string }).responseBody).toBe('a'.repeat(RESPONSE_BODY_CAP_BYTES));
  });

  it('row 13: exactly 4,096 bytes is not truncated and 4,097 is', async () => {
    respond = async () => new Response('b'.repeat(RESPONSE_BODY_CAP_BYTES), { status: 200 });
    expect(okResult(await reply())).toMatchObject({ responseBody: 'b'.repeat(RESPONSE_BODY_CAP_BYTES), responseBodyTruncated: false });
    respond = async () => new Response('b'.repeat(RESPONSE_BODY_CAP_BYTES + 1), { status: 200 });
    expect(okResult(await reply())).toMatchObject({ responseBody: 'b'.repeat(RESPONSE_BODY_CAP_BYTES), responseBodyTruncated: true });
  });

  it('row 13: a multi-byte character straddling the cap is cut before it, never split', async () => {
    for (const [char, bytes] of [['é', 2], ['€', 3], ['😀', 4]] as const) {
      // The character starts one byte before the cap, so only its first byte(s) fit.
      const padding = RESPONSE_BODY_CAP_BYTES - 1;
      respond = async () => new Response('a'.repeat(padding) + char, { status: 200 });
      const result = okResult(await reply()) as Extract<ReplyResult, { outcome: 'responded' }>;
      expect(bytes).toBeGreaterThan(1);
      expect(result.responseBodyTruncated).toBe(true);
      expect(result.responseBody).toBe('a'.repeat(padding));
      expect(result.responseBody).not.toContain('�');
    }
  });

  it('row 13: a multi-byte character that fits whole before the cap is kept', async () => {
    respond = async () => new Response('a'.repeat(RESPONSE_BODY_CAP_BYTES - 2) + 'é' + 'zzz', { status: 200 });
    const result = okResult(await reply()) as Extract<ReplyResult, { outcome: 'responded' }>;
    expect(result.responseBodyTruncated).toBe(true);
    expect(result.responseBody).toBe('a'.repeat(RESPONSE_BODY_CAP_BYTES - 2) + 'é');
  });

  it('row 13: a body arriving in several chunks is capped across chunks', async () => {
    const encoder = new TextEncoder();
    respond = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < 6; i += 1) controller.enqueue(encoder.encode('c'.repeat(1000)));
            controller.close();
          },
        }),
        { status: 200 },
      );
    const result = okResult(await reply()) as Extract<ReplyResult, { outcome: 'responded' }>;
    expect(result.responseBody).toBe('c'.repeat(RESPONSE_BODY_CAP_BYTES));
    expect(result.responseBodyTruncated).toBe(true);
  });

  it('row 13: control characters in the response text are removed (newline and tab kept)', async () => {
    respond = async () => new Response('a\u0007b\u001b[31mc\nd\te\r\u0000f\u000bg', { status: 200 });
    const result = okResult(await reply()) as Extract<ReplyResult, { outcome: 'responded' }>;
    expect(result.responseBody).toBe('ab[31mc\nd\tefg');
  });

  it('row 13: a reader whose cancel never settles delays the result by no more than the timeout', async () => {
    respond = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('y'.repeat(RESPONSE_BODY_CAP_BYTES + 10)));
          },
          cancel: () => new Promise<void>(() => undefined),
        }),
        { status: 200 },
      );
    const startedAt = performance.now();
    const result = okResult(await reply({}, { timeoutMs: 60 })) as Extract<ReplyResult, { outcome: 'responded' }>;
    expect(result.responseBodyTruncated).toBe(true);
    expect(result.responseBody).toHaveLength(RESPONSE_BODY_CAP_BYTES);
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  it('row 14: an empty response body is "" and not truncated', async () => {
    respond = async () => new Response(null, { status: 202 });
    expect(okResult(await reply())).toEqual({
      replyId: expect.any(String),
      attempt: 1,
      outcome: 'responded',
      status: 202,
      responseBody: '',
      responseBodyTruncated: false,
    });
  });

  it('row 12: retry-after is returned through toSingleLine and capped at 64 characters; no other header is returned', async () => {
    respond = async () =>
      new Response('x', {
        status: 429,
        headers: { 'retry-after': 'x'.repeat(100), 'set-cookie': 'session=SECRET', 'x-extra': 'leak', location: 'https://e.example/' },
      });
    const long = okResult(await reply()) as Extract<ReplyResult, { outcome: 'responded' }>;
    expect(long.retryAfter).toBe('x'.repeat(RETRY_AFTER_MAX_CHARS));
    expect(Object.keys(long).sort()).toEqual(
      ['attempt', 'outcome', 'replyId', 'responseBody', 'responseBodyTruncated', 'retryAfter', 'status'],
    );

    respond = async () => new Response('x', { status: 429, headers: { 'retry-after': 'x'.repeat(64) } });
    expect((okResult(await reply()) as { retryAfter?: string }).retryAfter).toBe('x'.repeat(64));

    respond = async () => new Response('x', { status: 429, headers: { 'retry-after': '  12 \t 3  ' } });
    expect((okResult(await reply()) as { retryAfter?: string }).retryAfter).toBe('12 3');

    respond = async () => new Response('x', { status: 200 });
    expect('retryAfter' in (okResult(await reply()) as object)).toBe(false);
  });

  it('row 15: a timeout before headers is no-response / timeout, and the attempt is recorded with a NULL status', async () => {
    respond = ({ init }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const result = okResult(await reply({}, { timeoutMs: 40 }));
    expect(result).toEqual({ replyId: expect.any(String), attempt: 1, outcome: 'no-response', reason: 'timeout' });
    const rows = await replyRows();
    expect(rows[0]).toMatchObject({ attempt_count: 1, last_status: null });
  });

  it('row 15: a fetch that ignores the abort signal still times out', async () => {
    respond = () => new Promise<Response>(() => undefined);
    const result = okResult(await reply({}, { timeoutMs: 40 }));
    expect(result).toMatchObject({ outcome: 'no-response', reason: 'timeout' });
  });

  it('row 16: a connection or TLS failure is no-response / connection-failed', async () => {
    respond = async () => {
      throw new TypeError('unable to connect');
    };
    const result = okResult(await reply());
    expect(result).toEqual({ replyId: expect.any(String), attempt: 1, outcome: 'no-response', reason: 'connection-failed' });
    expect((await replyRows())[0]).toMatchObject({ attempt_count: 1, last_status: null });
  });

  it('row 17: headers received but the body read timing out is responded with the partial body, flagged truncated', async () => {
    respond = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'));
          },
        }),
        { status: 200 },
      );
    const result = okResult(await reply({}, { timeoutMs: 40 }));
    expect(result).toMatchObject({
      outcome: 'responded',
      status: 200,
      responseBody: 'partial',
      responseBodyTruncated: true,
    });
    expect((await replyRows())[0]!.last_status).toBe(200);
  });

  it('row 18: a secret rotation and a reply URL edit between attempts take effect on the next attempt', async () => {
    const first = okResult(await reply());
    expect(calls[0]!.url).toBe(REPLY_URL);
    expect(senderAccepts(SECRET, calls[0]!.init.headers, calls[0]!.init.body)).toBe(true);

    await endpoints.rotateSecret('repo-1', ENDPOINT_ID, ROTATED_SECRET, '2026-12-01T00:00:00.000Z', NOW.toISOString());
    await endpoints.update('repo-1', ENDPOINT_ID, { replyUrl: OTHER_REPLY_URL }, NOW.toISOString());
    clock = new Date(NOW.getTime() + 3000);
    okResult(await reply({ replyId: first.replyId }));

    expect(calls[1]!.url).toBe(OTHER_REPLY_URL);
    expect(senderAccepts(ROTATED_SECRET, calls[1]!.init.headers, calls[1]!.init.body)).toBe(true);
    expect(senderAccepts(SECRET, calls[1]!.init.headers, calls[1]!.init.body)).toBe(false);
  });

  it('row 19: a reply URL cleared since the first attempt makes a resend row 5', async () => {
    const first = okResult(await reply());
    await endpoints.update('repo-1', ENDPOINT_ID, { replyUrl: null }, NOW.toISOString());
    expect(errorOf(await reply({ replyId: first.replyId }))).toBe('Replies are not enabled for this endpoint');
    expect(calls).toHaveLength(1);
    expect((await replyRows())[0]!.attempt_count).toBe(1);
  });

  it('row 20: when the reply row cannot be written the tool errors and nothing is sent', async () => {
    await sql`CREATE TRIGGER fail_reply_insert BEFORE INSERT ON inbound_webhook_replies BEGIN SELECT RAISE(ABORT, 'boom'); END`.execute(db);
    expect(errorOf(await reply())).toBe('The reply could not be recorded; nothing was sent');
    expect(calls).toHaveLength(0);
    expect(await replyRows()).toHaveLength(0);
  });

  it('row 21: when recording last_status fails after the POST the result is still returned and a warning is logged', async () => {
    await sql`CREATE TRIGGER fail_status_update BEFORE UPDATE OF last_status ON inbound_webhook_replies BEGIN SELECT RAISE(ABORT, 'boom'); END`.execute(db);
    const result = okResult(await reply());
    expect(result).toMatchObject({ outcome: 'responded', status: 200, attempt: 1 });
    expect((await replyRows())[0]).toMatchObject({ attempt_count: 1, last_status: null });
    expect(logged()).toContain('last-status-write-failed');
  });

  it('row 23: a database error during the ownership check is a thrown tool error, not "Unknown delivery"; nothing is sent, no reply row, and the error text carries no marker', async () => {
    await sql`DROP TABLE inbound_event_notifications`.execute(db);
    let thrown: unknown;
    try {
      await reply({ body: { note: BODY_MARKER } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const text = `${(thrown as Error).name} ${(thrown as Error).message}`;
    expect(text).not.toBe('Unknown delivery');
    for (const marker of [URL_MARKER, REPLY_HOST, SECRET_MARKER, SECRET, BODY_MARKER]) {
      expect(text).not.toContain(marker);
    }
    expect(calls).toHaveLength(0);
    expect(await replyRows()).toHaveLength(0);
  });

  it('row 25: retry-after empty or whitespace-only after cleanup has no retryAfter key; "120" is returned as "120"', async () => {
    for (const [header, expected] of [['', undefined], ['   ', undefined], ['\t\n ', undefined], ['120', '120']] as const) {
      respond = async () => new Response('x', { status: 429, headers: { 'retry-after': header } });
      const result = okResult(await reply()) as Extract<ReplyResult, { outcome: 'responded' }>;
      if (expected === undefined) expect('retryAfter' in result).toBe(false);
      else expect(result.retryAfter).toBe(expected);
    }
  });

  it('row 26: when the pre-POST attempt write throws on a resend the tool errors with row 20\'s text, nothing is sent and attempt_count is unchanged', async () => {
    const first = okResult(await reply());
    await sql`CREATE TRIGGER fail_attempt_update BEFORE UPDATE OF attempt_count ON inbound_webhook_replies BEGIN SELECT RAISE(ABORT, 'boom'); END`.execute(db);
    const sent = calls.length;
    expect(errorOf(await reply({ replyId: first.replyId }))).toBe('The reply could not be recorded; nothing was sent');
    expect(calls).toHaveLength(sent);
    expect((await replyRows())[0]!.attempt_count).toBe(1);
  });

  it('row 26: the attempt is already counted when the fetch runs', async () => {
    // Read inside the fetch but asserted outside it: a throw inside the fake fetch would be swallowed
    // as a connection failure and the test would pass vacuously.
    const seen: { count: number | null } = { count: null };
    respond = async (call) => {
      const row = await db
        .selectFrom('inbound_webhook_replies')
        .select('attempt_count')
        .where('id', '=', call.init.headers['webhook-id']!)
        .executeTakeFirstOrThrow();
      seen.count = row.attempt_count;
      return okResponse();
    };
    okResult(await reply());
    expect(seen.count).toBe(1);
  });

  it('row 21: only the latest attempt records its status (an earlier attempt whose fetch resolves last does not overwrite it)', async () => {
    const first = okResult(await reply());
    let releaseEarlier: (response: Response) => void = () => undefined;
    const outcomes: Array<Promise<ReplyOutcome>> = [];
    respond = () => {
      if (calls.length === 2) {
        return new Promise<Response>((resolve) => {
          releaseEarlier = resolve;
        });
      }
      return Promise.resolve(new Response('later', { status: 201 }));
    };
    outcomes.push(reply({ replyId: first.replyId }));
    while (calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 2));
    const later = okResult(await reply({ replyId: first.replyId }));
    expect(later).toMatchObject({ attempt: 3, status: 201 });
    releaseEarlier(new Response('earlier', { status: 500 }));
    const earlier = okResult(await outcomes[0]!);
    expect(earlier).toMatchObject({ attempt: 2, status: 500 });
    expect((await replyRows())[0]).toMatchObject({ attempt_count: 3, last_status: 201 });
  });

  describe('row 27: both caps are atomic', () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const slowOk = async () => {
      await tick();
      return okResponse();
    };

    it('25 concurrent new replies for one (delivery, session): exactly 20 attempts, 5 reply-limit refusals, 20 rows, 20 fetch calls', async () => {
      respond = slowOk;
      const outcomes = await Promise.all(Array.from({ length: 25 }, () => reply()));
      expect(outcomes.filter((o) => o.ok)).toHaveLength(MAX_REPLIES_PER_DELIVERY_SESSION);
      expect(outcomes.filter((o) => !o.ok && o.error === 'Reply limit reached for this delivery')).toHaveLength(5);
      expect(await replyRows()).toHaveLength(MAX_REPLIES_PER_DELIVERY_SESSION);
      expect(calls).toHaveLength(MAX_REPLIES_PER_DELIVERY_SESSION);
    });

    it('19 existing replies and 5 concurrent new ones: exactly 1 attempt, 4 reply-limit refusals, 20 rows, 1 fetch call', async () => {
      respond = slowOk;
      const bodySha = createHash('sha256').update(JSON.stringify({ text: 'seed' })).digest('hex');
      for (let i = 0; i < MAX_REPLIES_PER_DELIVERY_SESSION - 1; i += 1) {
        await db
          .insertInto('inbound_webhook_replies')
          .values({
            id: `reply_seed_${i}`,
            endpoint_id: ENDPOINT_ID,
            webhook_id: WEBHOOK_ID,
            session_id: 's1',
            body_sha256: bodySha,
            attempt_count: 1,
            created_at: NOW.toISOString(),
          })
          .execute();
      }
      const outcomes = await Promise.all(Array.from({ length: 5 }, () => reply()));
      expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
      expect(outcomes.filter((o) => !o.ok && o.error === 'Reply limit reached for this delivery')).toHaveLength(4);
      const rows = await replyRows();
      expect(rows.filter((row) => row.session_id === 's1' && row.webhook_id === WEBHOOK_ID)).toHaveLength(MAX_REPLIES_PER_DELIVERY_SESSION);
      expect(calls).toHaveLength(1);
    });

    it('15 concurrent resends of a reply with no attempt yet: exactly 10 attempts, 5 attempt-limit refusals, attempt_count 10, 10 fetch calls', async () => {
      respond = slowOk;
      // A reply row with attempt_count 0, seeded directly (a new reply is inserted already counted).
      await db
        .insertInto('inbound_webhook_replies')
        .values({
          id: 'reply_fresh',
          endpoint_id: ENDPOINT_ID,
          webhook_id: WEBHOOK_ID,
          session_id: 's1',
          body_sha256: createHash('sha256').update(JSON.stringify({ text: 'hello' })).digest('hex'),
          created_at: NOW.toISOString(),
        })
        .execute();
      const outcomes = await Promise.all(Array.from({ length: 15 }, () => reply({ replyId: 'reply_fresh' })));
      expect(outcomes.filter((o) => o.ok)).toHaveLength(MAX_ATTEMPTS_PER_REPLY);
      expect(outcomes.filter((o) => !o.ok && o.error === 'Attempt limit reached for this reply')).toHaveLength(5);
      expect((await replyRows())[0]!.attempt_count).toBe(MAX_ATTEMPTS_PER_REPLY);
      expect(calls).toHaveLength(MAX_ATTEMPTS_PER_REPLY);
    });

    it('15 concurrent resends after a first attempt: 9 more attempts fit, 6 are refused, attempt_count 10, 9 more fetch calls', async () => {
      respond = slowOk;
      const first = okResult(await reply());
      calls = [];
      const outcomes = await Promise.all(Array.from({ length: 15 }, () => reply({ replyId: first.replyId })));
      expect(outcomes.filter((o) => o.ok)).toHaveLength(MAX_ATTEMPTS_PER_REPLY - 1);
      expect(outcomes.filter((o) => !o.ok && o.error === 'Attempt limit reached for this reply')).toHaveLength(6);
      expect((await replyRows())[0]!.attempt_count).toBe(MAX_ATTEMPTS_PER_REPLY);
      expect(calls).toHaveLength(MAX_ATTEMPTS_PER_REPLY - 1);
    });
  });

  describe('row 13: values the sender echoes back are redacted', () => {
    type Responded = Extract<ReplyResult, { outcome: 'responded' }>;
    const bodyOf = async (): Promise<string> => (okResult(await reply()) as Responded).responseBody;

    it('a body echoing the signature header value, or its base64 part alone, does not contain either', async () => {
      let signature = '';
      respond = async ({ init }) => {
        signature = init.headers['webhook-signature']!;
        return new Response(`bad signature ${signature} / ${signature.slice(3)}`, { status: 401 });
      };
      const text = await bodyOf();
      expect(signature.startsWith('v1,')).toBe(true);
      expect(text).not.toContain(signature.slice(3));
      expect(text).toBe('bad signature [redacted] / [redacted]');
    });

    it('a body echoing the path and query keeps its other text and loses the token', async () => {
      respond = async () => new Response(`Not Found: /replies?token=${URL_MARKER}`, { status: 404 });
      const text = await bodyOf();
      expect(text).not.toContain(URL_MARKER);
      expect(text).toBe('Not Found: [redacted]');
    });

    it('a body echoing the full reply URL, or only the query value, loses both', async () => {
      respond = async () => new Response(`posted to ${REPLY_URL}; token ${URL_MARKER} rejected`, { status: 400 });
      expect(await bodyOf()).toBe('posted to [redacted]; token [redacted] rejected');
    });

    it('a percent-encoded query value is redacted raw and decoded', async () => {
      await endpoints.update('repo-1', ENDPOINT_ID, { replyUrl: `https://${REPLY_HOST}/r?k=a%20b%20c%20d%20e` }, NOW.toISOString());
      respond = async () => new Response('raw a%20b%20c%20d%20e decoded a b c d e', { status: 400 });
      expect(await bodyOf()).toBe('raw [redacted] decoded [redacted]');
    });

    it('a retry-after echoing the token does not carry it', async () => {
      respond = async () => new Response('x', { status: 429, headers: { 'retry-after': URL_MARKER } });
      const result = okResult(await reply()) as Responded;
      expect(JSON.stringify(result)).not.toContain(URL_MARKER);
      expect(result.retryAfter).toBe('[redacted]');
    });

    it('a query value shorter than 8 characters is not redacted: a body containing it is unchanged', async () => {
      await endpoints.update('repo-1', ENDPOINT_ID, { replyUrl: `https://${REPLY_HOST}/r?n=1` }, NOW.toISOString());
      respond = async () => new Response('total 1 of 1', { status: 200 });
      expect(await bodyOf()).toBe('total 1 of 1');
    });

    it('a reply URL with no query leaves the body unchanged except for a full-URL echo', async () => {
      await endpoints.update('repo-1', ENDPOINT_ID, { replyUrl: `https://${REPLY_HOST}/replies` }, NOW.toISOString());
      respond = async () => new Response(`see /replies on ${REPLY_HOST}`, { status: 404 });
      expect(await bodyOf()).toBe(`see /replies on ${REPLY_HOST}`);
      respond = async () => new Response(`posted to https://${REPLY_HOST}/replies`, { status: 404 });
      expect(await bodyOf()).toBe('posted to [redacted]');
    });
  });

  // -------------------------------------------------------------------------
  // Ownership (R3)
  // -------------------------------------------------------------------------

  describe('ownership', () => {
    it('a delivery routed to the caller is allowed', async () => {
      expect(okResult(await reply()).outcome).toBe('responded');
    });

    it('a delivery routed only to another session is "Unknown delivery" for the caller', async () => {
      await db.deleteFrom('inbound_event_notifications').execute();
      await seedRouting('s2');
      expect(errorOf(await reply({ sessionId: 's1' }))).toBe('Unknown delivery');
      expect(okResult(await reply({ sessionId: 's2' })).outcome).toBe('responded');
    });

    it('a ledger row with status pending or failed is allowed', async () => {
      for (const status of ['pending', 'failed'] as const) {
        await db.deleteFrom('inbound_event_notifications').execute();
        await seedRouting('s1', { status });
        expect(okResult(await reply()).outcome).toBe('responded');
      }
    });

    it('a missing delivery row is "Unknown delivery" even when a notification row exists', async () => {
      await db.deleteFrom('inbound_webhook_deliveries').execute();
      expect(errorOf(await reply())).toBe('Unknown delivery');
    });

    it('a deleted endpoint is "Unknown delivery" even when the notification row survives', async () => {
      await endpoints.delete('repo-1', ENDPOINT_ID);
      const survivors = await db.selectFrom('inbound_event_notifications').selectAll().execute();
      expect(survivors).toHaveLength(1);
      expect(errorOf(await reply())).toBe('Unknown delivery');
    });

    it('a delivery row that outlives its endpoint (dangling, no cascade) is "Unknown delivery" and nothing is sent', async () => {
      await sql`PRAGMA foreign_keys = OFF`.execute(db);
      await sql`DELETE FROM inbound_webhook_endpoints WHERE id = ${ENDPOINT_ID}`.execute(db);
      await sql`PRAGMA foreign_keys = ON`.execute(db);
      expect(await db.selectFrom('inbound_webhook_deliveries').selectAll().execute()).toHaveLength(1);
      expect(errorOf(await reply())).toBe('Unknown delivery');
      expect(calls).toHaveLength(0);
      expect(await replyRows()).toHaveLength(0);
    });

    it('a ledger row for the same job id with another event_type is "Unknown delivery"', async () => {
      await db.deleteFrom('inbound_event_notifications').execute();
      await seedRouting('s1', { eventType: 'ci:completed' });
      expect(errorOf(await reply())).toBe('Unknown delivery');
    });

    it('a webhook id containing a colon round-trips through ownership', async () => {
      const colonId = 'a:b:c';
      const deliveryId = inboundWebhookDeliveryId(ENDPOINT_ID, colonId);
      await seedDelivery(ENDPOINT_ID, colonId);
      await seedRouting('s1', { jobId: deliveryId });
      expect(okResult(await reply({ deliveryId })).outcome).toBe('responded');
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency (R4)
  // -------------------------------------------------------------------------

  describe('idempotency', () => {
    it('the reply row is committed before the fetch is called', async () => {
      let seen: Array<{ id: string; attempt_count: number }> = [];
      respond = async (call) => {
        seen = await db.selectFrom('inbound_webhook_replies').select(['id', 'attempt_count']).execute();
        expect(seen.map((row) => row.id)).toContain(call.init.headers['webhook-id']!);
        return okResponse();
      };
      const result = okResult(await reply());
      expect(seen).toEqual([{ id: result.replyId, attempt_count: 1 }]);
    });

    it('the row survives a failed first attempt so the id can be resent', async () => {
      respond = async () => {
        throw new TypeError('down');
      };
      const first = okResult(await reply());
      expect(first.outcome).toBe('no-response');
      respond = async () => okResponse();
      clock = new Date(NOW.getTime() + 1000);
      const second = okResult(await reply({ replyId: first.replyId }));
      expect(second).toMatchObject({ replyId: first.replyId, attempt: 2, outcome: 'responded' });
    });

    it('a resend carries the identical webhook-id and a signature that verifies for its own timestamp', async () => {
      const first = okResult(await reply());
      clock = new Date(NOW.getTime() + 61_000);
      okResult(await reply({ replyId: first.replyId }));
      const [a, b] = calls;
      expect(b!.init.headers['webhook-id']).toBe(a!.init.headers['webhook-id']);
      expect(a!.init.headers['webhook-timestamp']).toBe(String(Math.floor(NOW.getTime() / 1000)));
      expect(b!.init.headers['webhook-timestamp']).toBe(String(Math.floor((NOW.getTime() + 61_000) / 1000)));
      expect(senderAccepts(SECRET, a!.init.headers, a!.init.body)).toBe(true);
      expect(senderAccepts(SECRET, b!.init.headers, b!.init.body)).toBe(true);
      // The old signature is for the old timestamp: it does not verify against the new one.
      expect(
        senderAccepts(SECRET, { ...b!.init.headers, 'webhook-signature': a!.init.headers['webhook-signature']! }, b!.init.body),
      ).toBe(false);
    });

    it('the same body with its keys reordered is accepted as a resend', async () => {
      const first = okResult(await reply({ body: { a: 1, b: { c: 2, d: [3, { e: 4, f: 5 }] } } }));
      const second = await reply({ replyId: first.replyId, body: { b: { d: [3, { f: 5, e: 4 }], c: 2 }, a: 1 } });
      expect(okResult(second)).toMatchObject({ replyId: first.replyId, attempt: 2 });
    });

    it('a changed value, or a reordered array, is a different body', async () => {
      const first = okResult(await reply({ body: { a: [1, 2] } }));
      expect(errorOf(await reply({ replyId: first.replyId, body: { a: [2, 1] } }))).toBe(
        'Body differs from the recorded reply; send a new reply instead',
      );
      expect(errorOf(await reply({ replyId: first.replyId, body: { a: [1, 3] } }))).toBe(
        'Body differs from the recorded reply; send a new reply instead',
      );
    });

    it('two concurrent resends of one reply are counted once each', async () => {
      const first = okResult(await reply());
      const [x, y] = await Promise.all([reply({ replyId: first.replyId }), reply({ replyId: first.replyId })]);
      expect([okResult(x).attempt, okResult(y).attempt].sort()).toEqual([2, 3]);
      expect((await replyRows())[0]!.attempt_count).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Request shape (R5)
  // -------------------------------------------------------------------------

  describe('request shape', () => {
    it('sends exactly four headers, redirect manual, the exact JSON bytes, and a signature that verifies with the CURRENT secret only', async () => {
      await endpoints.rotateSecret('repo-1', ENDPOINT_ID, ROTATED_SECRET, '2026-12-01T00:00:00.000Z', NOW.toISOString());
      const stored = await endpoints.findWithSecretById(ENDPOINT_ID);
      expect(stored!.previousSecret).toBe(SECRET);

      const body = { text: 'héllo €', nested: { b: 1, a: [1, 2] } };
      const result = okResult(await reply({ body }));

      expect(calls).toHaveLength(1);
      const { url, init } = calls[0]!;
      expect(url).toBe(REPLY_URL);
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('manual');
      expect(init.body).toBe(JSON.stringify(body));
      expect(Object.keys(init.headers).sort()).toEqual(['content-type', 'webhook-id', 'webhook-signature', 'webhook-timestamp']);
      expect(init.headers['content-type']).toBe('application/json');
      expect(init.headers['webhook-id']).toBe(result.replyId);
      expect(init.headers['webhook-timestamp']).toBe(String(Math.floor(NOW.getTime() / 1000)));
      expect(senderAccepts(ROTATED_SECRET, init.headers, init.body)).toBe(true);
      expect(senderAccepts(SECRET, init.headers, init.body)).toBe(false);
      expect(senderAccepts(PREVIOUS_SECRET, init.headers, init.body)).toBe(false);
    });

    it('a 302 answer is returned as status 302 and the fetch is called once', async () => {
      respond = async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/x' } });
      const result = okResult(await reply());
      expect(result).toMatchObject({ outcome: 'responded', status: 302 });
      expect(calls).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain('elsewhere.example');
    });
  });

  // -------------------------------------------------------------------------
  // Nothing secret leaves (R6, R8)
  // -------------------------------------------------------------------------

  describe('nothing secret leaves', () => {
    it('the result carries no secret, URL marker, host or signature, and the logs carry none of the four markers', async () => {
      respond = async () => new Response(`sender says ${RESPONSE_MARKER}`, { status: 200 });
      const outcome = await reply({ body: { note: BODY_MARKER } });
      const result = okResult(outcome);
      const { init } = calls[0]!;
      const signature = init.headers['webhook-signature']!;
      const secretKeyPart = SECRET.slice('whsec_'.length);

      const resultText = JSON.stringify(outcome);
      for (const forbidden of [SECRET, secretKeyPart, SECRET_MARKER, URL_MARKER, REPLY_HOST, signature, signature.slice(3)]) {
        expect(resultText).not.toContain(forbidden);
      }

      const logText = logged();
      expect(logText).toContain(result.replyId); // control: the logs are not empty and name the reply
      for (const forbidden of [SECRET, secretKeyPart, SECRET_MARKER, URL_MARKER, REPLY_HOST, BODY_MARKER, RESPONSE_MARKER, signature, signature.slice(3)]) {
        expect(logText).not.toContain(forbidden);
      }
    });

    it('refusals are logged with ids and a reason code only', async () => {
      await reply({ replyId: 'reply_nope', body: { note: BODY_MARKER } });
      const logText = logged();
      expect(logText).toContain('reply-unknown');
      expect(logText).not.toContain(BODY_MARKER);
      expect(logText).not.toContain(URL_MARKER);
    });

    it('a fetch error carrying the URL in its message puts that text in neither the log nor the result', async () => {
      const message = `connect to ${REPLY_URL} failed`;
      respond = async () => {
        throw new Error(message);
      };
      const outcome = await reply();
      expect(okResult(outcome)).toMatchObject({ outcome: 'no-response', reason: 'connection-failed' });
      const logText = logged();
      expect(logText).toContain('connection-failed'); // control: the attempt is logged
      expect(logText).toContain('"errorName":"Error"');
      for (const text of [logText, JSON.stringify(outcome)]) {
        expect(text).not.toContain(message);
        expect(text).not.toContain(URL_MARKER);
        expect(text).not.toContain(REPLY_HOST);
      }
    });

    it('one info record per attempt carries the ids, outcome, status, duration and byte counts', async () => {
      respond = async () => new Response('four', { status: 201 });
      const result = okResult(await reply({ body: { a: 1 } }));
      const infoCalls = (logSpies[0]!.mock.calls as LogCall[]).filter((call) => JSON.stringify(call).includes(result.replyId));
      expect(infoCalls).toHaveLength(1);
      expect(infoCalls[0]![0]).toMatchObject({
        endpointId: ENDPOINT_ID,
        deliveryId: DELIVERY_ID,
        replyId: result.replyId,
        sessionId: 's1',
        attempt: 1,
        outcome: 'responded',
        status: 201,
        requestBytes: Buffer.byteLength(JSON.stringify({ a: 1 }), 'utf-8'),
        responseBytes: 4,
      });
      expect(typeof (infoCalls[0]![0] as { durationMs: number }).durationMs).toBe('number');
    });
  });

  // -------------------------------------------------------------------------
  // Recorded proxy: the sender side is the injected fetch; everything else is real.
  // -------------------------------------------------------------------------

  it('proxy success path (injected fetch): the sender verifies the signature over the exact bytes, the id is the reply id, a resend verifies for its new timestamp, and the result carries neither secret nor signature', async () => {
    // Real repository create: the secret is captured from the create result, as an operator would see it once.
    const created = await endpoints.create({
      id: 'ep-proxy',
      label: 'Proxy',
      repositoryId: 'repo-1',
      instructionText: 'x',
      secret: generateInboundWebhookSecret(),
      replyUrl: 'https://sender.example/proxy?token=PROXYTOKEN',
      now: '2026-11-07T00:00:00.000Z',
    });
    const deliveryId = inboundWebhookDeliveryId('ep-proxy', 'ProxyEv');
    await seedDelivery('ep-proxy', 'ProxyEv');
    await seedRouting('s1', { jobId: deliveryId });

    const seenBySender: Array<{ id: string; timestamp: string; verified: boolean; bytes: string }> = [];
    const sender: ReplyFetch = async (_url, init) => {
      seenBySender.push({
        id: init.headers['webhook-id']!,
        timestamp: init.headers['webhook-timestamp']!,
        verified: senderAccepts(created.secret, init.headers, init.body),
        bytes: init.body,
      });
      return new Response('accepted by the sender', { status: 200 });
    };

    // Default id generator and default clock handling are the real ones here (only fetch and the clock for the timestamp are injected).
    const body = { type: 'message', text: 'the answer', n: 1 };
    const outcome = await replyToInboundWebhook({ sessionId: 's1', deliveryId, body }, deps({ fetch: sender }));
    const result = okResult(outcome);

    expect(result).toEqual({
      replyId: expect.stringMatching(/^reply_[0-9a-f-]{36}$/),
      attempt: 1,
      outcome: 'responded',
      status: 200,
      responseBody: 'accepted by the sender',
      responseBodyTruncated: false,
    });
    expect(seenBySender[0]).toMatchObject({ verified: true, bytes: JSON.stringify(body), id: result.replyId });

    clock = new Date(NOW.getTime() + 11_000);
    const again = okResult(
      await replyToInboundWebhook({ sessionId: 's1', deliveryId, body, replyId: result.replyId }, deps({ fetch: sender })),
    );
    expect(again).toMatchObject({ replyId: result.replyId, attempt: 2, outcome: 'responded', status: 200 });
    expect(seenBySender[1]).toMatchObject({ id: result.replyId, verified: true });
    expect(seenBySender[1]!.timestamp).not.toBe(seenBySender[0]!.timestamp);

    const signatures = seenBySender.map((seen) => specSignature(created.secret, seen.id, seen.timestamp, seen.bytes));
    const resultText = JSON.stringify([outcome, again]);
    expect(resultText).not.toContain(created.secret);
    expect(resultText).not.toContain(created.secret.slice('whsec_'.length));
    for (const signature of signatures) {
      expect(resultText).not.toContain(signature);
      expect(resultText).not.toContain(signature.slice(3));
    }
    expect(resultText).not.toContain('PROXYTOKEN');
  });
});
