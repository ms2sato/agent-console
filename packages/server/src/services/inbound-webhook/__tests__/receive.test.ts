import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { InboundWebhookProcessPayload } from '@agent-console/shared';
import type { Database } from '../../../database/schema.js';
import { createDatabaseForTest } from '../../../database/connection.js';
import { JobQueue, JOB_TYPES } from '../../../jobs/index.js';
import { SqliteInboundWebhookEndpointRepository } from '../../../repositories/sqlite-inbound-webhook-endpoint-repository.js';
import { PermanentHandlerError } from '../../inbound/job-handler.js';
import {
  inboundWebhookDeliveryId,
  isTimestampWithinTolerance,
  isValidWebhookId,
  parseInboundWebhookBody,
  prepareDelivery,
  receiveInboundWebhook,
  verifyStandardWebhookSignature,
  type ReceiveInput,
} from '../receive.js';

// Known-answer vector, computed outside this codebase (python hmac/hashlib):
// key = base64-DECODED bytes of the part after `whsec_`.
const VECTOR_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const VECTOR_ID = 'msg_2KWPBgLlAfxdpx2AI54pPJ85f4W';
const VECTOR_TS = '1700000000';
const VECTOR_BODY = '{"schema_version":1,"message":"hello","slack_channel":"C1","slack_ts":"1.2"}';
const VECTOR_SIG = 'Qq+5BnyniH/+EyUET01awGu+n4p3UudG/i/3JJ18Rcw=';
// Same message signed with the LITERAL secret string as key (the wrong derivation).
const VECTOR_SIG_LITERAL_KEY = 'rX5fmtbRkjQFHyF5bjMexTPrqCn1EYSxuo2I48IbYFE=';

const NOW = new Date('2023-11-14T22:13:20.000Z'); // unix 1700000000
const NOW_SECONDS = 1700000000;

/** True when every UTF-16 surrogate is part of a valid pair. */
function isWellFormed(value: string): boolean {
  return !/[\uD800-\uDFFF]/.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''));
}

function sign(secret: string, id: string, ts: string | number, body: string): string {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
}

describe('verifyStandardWebhookSignature', () => {
  const check = (signatureHeader: string, over: Partial<Parameters<typeof verifyStandardWebhookSignature>[0]> = {}) =>
    verifyStandardWebhookSignature({
      secret: VECTOR_SECRET,
      webhookId: VECTOR_ID,
      timestamp: VECTOR_TS,
      rawBody: VECTOR_BODY,
      signatureHeader,
      ...over,
    });

  it('accepts the independently computed known-answer signature', () => {
    expect(check(`v1,${VECTOR_SIG}`)).toBe(true);
  });

  it('refuses the signature made with the literal secret string as key', () => {
    expect(check(`v1,${VECTOR_SIG_LITERAL_KEY}`)).toBe(false);
  });

  it('accepts when any of several space-separated entries matches', () => {
    expect(check(`v1,${VECTOR_SIG_LITERAL_KEY} v1,${VECTOR_SIG}`)).toBe(true);
    expect(check(`v1,${VECTOR_SIG} v1,${VECTOR_SIG_LITERAL_KEY}`)).toBe(true);
    expect(check(`v1,${VECTOR_SIG_LITERAL_KEY} v1,${VECTOR_SIG_LITERAL_KEY}`)).toBe(false);
  });

  it('refuses a changed id, timestamp, body or secret', () => {
    expect(check(`v1,${VECTOR_SIG}`, { webhookId: `${VECTOR_ID}x` })).toBe(false);
    expect(check(`v1,${VECTOR_SIG}`, { timestamp: '1700000001' })).toBe(false);
    expect(check(`v1,${VECTOR_SIG}`, { rawBody: `${VECTOR_BODY} ` })).toBe(false);
    expect(check(`v1,${VECTOR_SIG}`, { secret: 'whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).toBe(false);
  });

  it('refuses malformed headers without throwing', () => {
    expect(check('')).toBe(false);
    expect(check(VECTOR_SIG)).toBe(false); // no v1, prefix
    expect(check(`v2,${VECTOR_SIG}`)).toBe(false);
    expect(check('v1,')).toBe(false);
    expect(check('v1,AAAA')).toBe(false); // wrong length
    expect(check(`v1,${VECTOR_SIG.slice(0, -1)}AAAA`)).toBe(false); // longer than a digest
  });

  it('refuses a secret without the whsec_ prefix', () => {
    expect(check(`v1,${VECTOR_SIG}`, { secret: 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw' })).toBe(false);
  });
});

describe('isTimestampWithinTolerance', () => {
  const at = (offsetSeconds: number) => String(NOW_SECONDS + offsetSeconds);

  it('accepts exactly 300 s in the past and in the future', () => {
    expect(isTimestampWithinTolerance(at(-300), NOW)).toBe(true);
    expect(isTimestampWithinTolerance(at(300), NOW)).toBe(true);
    expect(isTimestampWithinTolerance(at(0), NOW)).toBe(true);
  });

  it('refuses 301 s in the past and in the future', () => {
    expect(isTimestampWithinTolerance(at(-301), NOW)).toBe(false);
    expect(isTimestampWithinTolerance(at(301), NOW)).toBe(false);
  });

  for (const bad of [undefined, '', 'abc', '1700000000.5', '1e9', '-5', ' 1700000000', '1700000000 ', '0x10', '1'.repeat(16)]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      expect(isTimestampWithinTolerance(bad, NOW)).toBe(false);
    });
  }
});

describe('isValidWebhookId', () => {
  const accepted = ['Ev0123ABC', 'msg_2KWPBgLlAfxdpx2AI54pPJ85f4W', 'a', 'a.b-c_d:e', '1', 'A'.repeat(128)];
  const refused: Array<[string, string]> = [
    ['empty', ''],
    ['parent directory', '..'],
    ['relative traversal', '../x'],
    ['slash', 'a/b'],
    ['backslash', 'a\\b'],
    ['129 chars', 'A'.repeat(129)],
    ['space', 'a b'],
    ['NUL', 'a\u0000b'],
    ['newline', 'a\nb'],
    ['unicode', 'événement'],
    ['leading dot', '.hidden'],
    ['leading dash', '-x'],
  ];
  for (const id of accepted) {
    it(`accepts ${id.length > 20 ? `${id.length} chars` : id}`, () => expect(isValidWebhookId(id)).toBe(true));
  }
  for (const [name, id] of refused) {
    it(`refuses ${name}`, () => expect(isValidWebhookId(id)).toBe(false));
  }
});

describe('parseInboundWebhookBody', () => {
  it('accepts the sender shape and ignores unknown keys', () => {
    const parsed = parseInboundWebhookBody(
      JSON.stringify({ schema_version: 1, message: 'hi', matched_triggers: ['mention'], future_key: { a: 1 } }),
    );
    expect(parsed?.message).toBe('hi');
    expect(parsed).not.toHaveProperty('future_key');
  });

  it('accepts an empty message and a body with only slack_message', () => {
    expect(parseInboundWebhookBody('{"message":""}')).not.toBeNull();
    expect(parseInboundWebhookBody('{"slack_message":{"text":"x"},"slack_message_truncated":true}')).not.toBeNull();
  });

  const refused: Array<[string, string]> = [
    ['invalid JSON', '{not json'],
    ['empty text', ''],
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"x"'],
    ['an empty object (no message at all)', '{}'],
    ['a number message', '{"message":5}'],
    ['a null message', '{"message":null}'],
    ['a string schema_version', '{"message":"x","schema_version":"1"}'],
    ['a non-array slack_files', '{"message":"x","slack_files":"u"}'],
    ['a string slack_message', '{"slack_message":"x"}'],
    ['a string matched_triggers', '{"message":"x","matched_triggers":"mention"}'],
  ];
  for (const [name, text] of refused) {
    it(`refuses ${name}`, () => expect(parseInboundWebhookBody(text)).toBeNull());
  }
});

describe('receiveInboundWebhook', () => {
  let db: Kysely<Database>;
  let endpoints: SqliteInboundWebhookEndpointRepository;
  let jobQueue: JobQueue;
  let wakeSpy: ReturnType<typeof spyOn>;
  const ENDPOINT_ID = 'ep-1';
  const SECRET = VECTOR_SECRET;
  const BODY = JSON.stringify({ schema_version: 1, message: 'hello', slack_channel: 'C1', slack_ts: '1.2' });
  let clock: Date;

  const deps = () => ({ endpoints, db, jobQueue, now: () => clock });
  const input = (over: Partial<ReceiveInput> = {}, secret = SECRET): ReceiveInput => {
    const webhookId = over.webhookId ?? 'Ev1';
    const rawBody = over.rawBody ?? BODY;
    const timestamp = over.timestamp ?? String(NOW_SECONDS);
    return {
      endpointId: ENDPOINT_ID,
      rawBody,
      webhookId,
      timestamp,
      signature: sign(secret, webhookId ?? '', timestamp, rawBody),
      ...over,
    };
  };
  const rows = async () => ({
    deliveries: await db.selectFrom('inbound_webhook_deliveries').selectAll().execute(),
    jobs: await db.selectFrom('jobs').selectAll().execute(),
  });

  beforeEach(async () => {
    clock = NOW;
    db = await createDatabaseForTest();
    await db.insertInto('repositories').values({ id: 'repo-1', name: 'r', path: '/tmp/r' }).execute();
    endpoints = new SqliteInboundWebhookEndpointRepository(db);
    await endpoints.create({
      id: ENDPOINT_ID,
      label: 'Slack',
      repositoryId: 'repo-1',
      instructionText: 'Do the thing',
      secret: SECRET,
      now: '2026-11-07T00:00:00.000Z',
    });
    jobQueue = new JobQueue(db, { concurrency: 1 });
    wakeSpy = spyOn(jobQueue, 'wake');
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('accepts a valid delivery: one deduplication row, one job carrying the deterministic id, then a wake', async () => {
    const result = await receiveInboundWebhook(input(), deps());
    expect(result).toEqual({ kind: 'accepted' });
    const { deliveries, jobs } = await rows();
    expect(deliveries).toEqual([
      { endpoint_id: ENDPOINT_ID, webhook_id: 'Ev1', received_at: NOW.toISOString() },
    ]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe('inbound-webhook:ep-1:Ev1');
    expect(jobs[0]?.id).toBe(inboundWebhookDeliveryId(ENDPOINT_ID, 'Ev1'));
    expect(jobs[0]?.type).toBe(JOB_TYPES.INBOUND_WEBHOOK_PROCESS);
    const payload = JSON.parse(jobs[0]?.payload ?? '{}') as InboundWebhookProcessPayload;
    expect(payload).toEqual({
      jobId: 'inbound-webhook:ep-1:Ev1',
      endpointId: ENDPOINT_ID,
      rawPayload: BODY,
      receivedAt: NOW.toISOString(),
    });
    expect(wakeSpy).toHaveBeenCalledTimes(1);
  });

  it('answers a duplicate without a second job, and still wakes', async () => {
    await receiveInboundWebhook(input(), deps());
    wakeSpy.mockClear();
    const again = await receiveInboundWebhook(input({ timestamp: String(NOW_SECONDS + 5) }), deps());
    expect(again).toEqual({ kind: 'duplicate' });
    const { deliveries, jobs } = await rows();
    expect(deliveries).toHaveLength(1);
    expect(jobs).toHaveLength(1);
    expect(wakeSpy).toHaveBeenCalledTimes(1);
  });

  it('the same webhook-id on another endpoint is not a duplicate', async () => {
    await endpoints.create({
      id: 'ep-2',
      label: 'Other',
      repositoryId: 'repo-1',
      instructionText: 'x',
      secret: SECRET,
      now: '2026-11-07T00:00:00.000Z',
    });
    await receiveInboundWebhook(input(), deps());
    const other = await receiveInboundWebhook(input({ endpointId: 'ep-2' }), deps());
    expect(other).toEqual({ kind: 'accepted' });
    expect((await rows()).jobs).toHaveLength(2);
  });

  it('answers not_found for an unknown endpoint and writes nothing', async () => {
    expect(await receiveInboundWebhook(input({ endpointId: 'nope' }), deps())).toEqual({ kind: 'not_found' });
    const { deliveries, jobs } = await rows();
    expect(deliveries).toHaveLength(0);
    expect(jobs).toHaveLength(0);
  });

  describe('401', () => {
    const refuse = async (over: Partial<ReceiveInput>) => {
      const result = await receiveInboundWebhook(input(over), deps());
      expect(result).toEqual({ kind: 'unauthorized' });
      const { deliveries, jobs } = await rows();
      expect(deliveries).toHaveLength(0);
      expect(jobs).toHaveLength(0);
    };

    it('a signature made with another secret', async () => {
      await refuse({ signature: sign('whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'Ev1', NOW_SECONDS, BODY) });
    });
    it('a missing signature, timestamp or webhook-id header', async () => {
      await refuse({ signature: undefined });
      await refuse({ timestamp: undefined, signature: sign(SECRET, 'Ev1', NOW_SECONDS, BODY) });
      await refuse({ webhookId: undefined, signature: sign(SECRET, 'Ev1', NOW_SECONDS, BODY) });
    });
    it('a body altered after signing', async () => {
      await refuse({ rawBody: `${BODY} `, signature: sign(SECRET, 'Ev1', NOW_SECONDS, BODY) });
    });
    it('a validly signed but stale timestamp, and a non-integer timestamp', async () => {
      await refuse({ timestamp: String(NOW_SECONDS - 301) });
      await refuse({ timestamp: String(NOW_SECONDS + 301) });
      await refuse({ timestamp: '1700000000.5' });
    });
    it('accepts exactly 300 s on both edges', async () => {
      expect(await receiveInboundWebhook(input({ timestamp: String(NOW_SECONDS - 300), webhookId: 'Past' }), deps())).toEqual({ kind: 'accepted' });
      expect(await receiveInboundWebhook(input({ timestamp: String(NOW_SECONDS + 300), webhookId: 'Future' }), deps())).toEqual({ kind: 'accepted' });
    });
  });

  describe('previous secret', () => {
    const PREVIOUS = 'whsec_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const EXPIRY = '2026-11-08T00:00:00.000Z';
    const rotate = async () => {
      await endpoints.rotateSecret('repo-1', ENDPOINT_ID, PREVIOUS, EXPIRY, '2026-11-07T00:00:00.000Z');
      // PREVIOUS is now current and the old SECRET is the previous one; sign with the OLD secret.
    };

    it('honours the previous secret while its expiry is strictly in the future', async () => {
      await rotate();
      clock = new Date(Date.parse(EXPIRY) - 1);
      const ts = String(Math.floor(clock.getTime() / 1000));
      expect(await receiveInboundWebhook(input({ timestamp: ts }, SECRET), deps())).toEqual({ kind: 'accepted' });
      expect(await receiveInboundWebhook(input({ timestamp: ts, webhookId: 'Ev2' }, PREVIOUS), deps())).toEqual({ kind: 'accepted' });
    });

    it('refuses the previous secret at exactly its expiry and after', async () => {
      await rotate();
      for (const offsetMs of [0, 1, 3600_000]) {
        clock = new Date(Date.parse(EXPIRY) + offsetMs);
        const ts = String(Math.floor(clock.getTime() / 1000));
        const result = await receiveInboundWebhook(input({ timestamp: ts }, SECRET), deps());
        expect(result, `offset ${offsetMs}`).toEqual({ kind: 'unauthorized' });
      }
      expect((await rows()).jobs).toHaveLength(0);
    });

    it('refuses the previous secret once it was cleared', async () => {
      await rotate();
      await endpoints.clearPreviousSecret('repo-1', ENDPOINT_ID, '2026-11-07T00:00:00.000Z');
      expect(await receiveInboundWebhook(input({}, SECRET), deps())).toEqual({ kind: 'unauthorized' });
    });
  });

  describe('400 leaves no row', () => {
    const invalidIds = ['../x', 'a/b', 'A'.repeat(129), '', 'événement', '..', 'a b', 'a\u0000b'];
    for (const webhookId of invalidIds) {
      it(`invalid webhook-id ${JSON.stringify(webhookId.length > 20 ? `${webhookId.length} chars` : webhookId)}`, async () => {
        const result = await receiveInboundWebhook(input({ webhookId }), deps());
        // An empty id is a header that is present but unusable: it still reaches validation, never the table.
        expect(result.kind === 'invalid_request' || result.kind === 'unauthorized').toBe(true);
        if (webhookId !== '') expect(result).toEqual({ kind: 'invalid_request' });
        const { deliveries, jobs } = await rows();
        expect(deliveries).toHaveLength(0);
        expect(jobs).toHaveLength(0);
      });
    }

    const invalidBodies: Array<[string, string]> = [
      ['invalid JSON', '{nope'],
      ['an array', '[]'],
      ['wrong types', '{"message":5}'],
      ['no message', '{"schema_version":1}'],
    ];
    for (const [name, rawBody] of invalidBodies) {
      it(`${name}, correctly signed`, async () => {
        const result = await receiveInboundWebhook(input({ rawBody }), deps());
        expect(result).toEqual({ kind: 'invalid_request' });
        const { deliveries, jobs } = await rows();
        expect(deliveries).toHaveLength(0);
        expect(jobs).toHaveLength(0);
        expect(wakeSpy).not.toHaveBeenCalled();
      });
    }
  });

  describe('transaction failure', () => {
    it('a failure after the dedupe insert leaves NEITHER row, answers unavailable, and a retry is accepted', async () => {
      const enqueue = spyOn(jobQueue, 'enqueue').mockRejectedValueOnce(new Error('disk full'));
      const failed = await receiveInboundWebhook(input(), deps());
      expect(failed).toEqual({ kind: 'unavailable' });
      expect(enqueue).toHaveBeenCalledTimes(1);
      let state = await rows();
      expect(state.deliveries).toHaveLength(0);
      expect(state.jobs).toHaveLength(0);
      expect(wakeSpy).not.toHaveBeenCalled();

      const retry = await receiveInboundWebhook(input(), deps());
      expect(retry).toEqual({ kind: 'accepted' });
      state = await rows();
      expect(state.deliveries).toHaveLength(1);
      expect(state.jobs).toHaveLength(1);
    });

    it('a failure AFTER a real enqueue also rolls the job row back (the enqueue is inside the transaction)', async () => {
      const original = jobQueue.enqueue.bind(jobQueue);
      spyOn(jobQueue, 'enqueue').mockImplementationOnce(async (type, payload, options) => {
        await original(type, payload, options);
        throw new Error('late failure');
      });
      expect(await receiveInboundWebhook(input(), deps())).toEqual({ kind: 'unavailable' });
      const state = await rows();
      expect(state.jobs).toHaveLength(0);
      expect(state.deliveries).toHaveLength(0);
    });

    it('hands the transaction to enqueue as its executor', async () => {
      const enqueue = spyOn(jobQueue, 'enqueue');
      await receiveInboundWebhook(input(), deps());
      const options = enqueue.mock.calls[0]?.[2];
      expect(options?.jobId).toBe('inbound-webhook:ep-1:Ev1');
      expect(options?.executor).toBeDefined();
      expect(options?.executor).not.toBe(db);
    });
  });
});

describe('prepareDelivery', () => {
  let db: Kysely<Database>;
  let endpoints: SqliteInboundWebhookEndpointRepository;
  const payloadOf = (body: unknown, over: Partial<InboundWebhookProcessPayload> = {}): InboundWebhookProcessPayload => ({
    jobId: 'inbound-webhook:ep-1:Ev1',
    endpointId: 'ep-1',
    rawPayload: typeof body === 'string' ? body : JSON.stringify(body),
    receivedAt: NOW.toISOString(),
    ...over,
  });

  beforeEach(async () => {
    db = await createDatabaseForTest();
    await db.insertInto('repositories').values({ id: 'repo-1', name: 'r', path: '/tmp/r' }).execute();
    endpoints = new SqliteInboundWebhookEndpointRepository(db);
    await endpoints.create({
      id: 'ep-1',
      label: 'Slack',
      repositoryId: 'repo-1',
      instructionText: 'line one\nline two\r\n',
      secret: VECTOR_SECRET,
      now: '2026-11-07T00:00:00.000Z',
    });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('builds content without any action attached', async () => {
    const content = await prepareDelivery(
      payloadOf({ message: 'hello\nworld', slack_permalink: 'https://x.slack.com/archives/C1/p1', slack_channel: 'C1', slack_ts: '1.2' }),
      { endpoints },
    );
    expect(content.deliveryId).toBe('inbound-webhook:ep-1:Ev1');
    expect(content.endpoint).toEqual({ id: 'ep-1', repositoryId: 'repo-1', label: 'Slack' });
    expect(content.endpoint).not.toHaveProperty('secret');
    expect(content.instructionMarkdown).toBe('line one\nline two\r\n');
    expect(content.summary).toBe('hello world');
    expect(content.url).toBe('https://x.slack.com/archives/C1/p1');
    expect(content.bodyMarkdown).toContain('hello\nworld');
    expect(content.bodyMarkdown).toContain('- Permalink: https://x.slack.com/archives/C1/p1');
    expect(content.bodyMarkdown).toContain('- Channel: C1');
    expect(content.bodyMarkdown).toContain('- Timestamp: 1.2');
  });

  it('has url null and no details section when the sender omitted them', async () => {
    const content = await prepareDelivery(payloadOf({ message: 'x' }), { endpoints });
    expect(content.url).toBeNull();
    expect(content.bodyMarkdown).not.toContain('Details');
  });

  it('never projects slack_message or slack_files, even when the payload carries them', async () => {
    const token = 'TOKEN-SENTINEL-123';
    const content = await prepareDelivery(
      payloadOf({
        message: 'plain',
        slack_message: { text: 'RAW-EVENT-SENTINEL', blocks: [] },
        slack_files: [{ name: 'a.png', mimetype: 'image/png', size: 5, url: `https://firebasestorage.googleapis.com/v0/b/x/o/a?alt=media&token=${token}` }],
      }),
      { endpoints },
    );
    const everything = JSON.stringify(content);
    for (const forbidden of ['RAW-EVENT-SENTINEL', token, 'firebasestorage', 'slack_message', 'slack_files', 'a.png']) {
      expect(everything).not.toContain(forbidden);
    }
  });

  it('strips control characters but keeps newline and tab in the body projection', async () => {
    const content = await prepareDelivery(
      payloadOf({ message: 'a\u001b[31mb\u0000c\u009bd\re\nf\tg' }),
      { endpoints },
    );
    expect(content.bodyMarkdown).toContain('a[31mbcde\nf\tg');
    expect(content.bodyMarkdown).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  it('uses a fixed summary when the sender text is empty', async () => {
    expect((await prepareDelivery(payloadOf({ message: '' }), { endpoints })).summary).toBe('Inbound webhook message');
    expect((await prepareDelivery(payloadOf({ slack_message: { text: 'x' } }), { endpoints })).summary).toBe('Inbound webhook message');
  });

  it('carries the instruction text as of the re-read, not as of receipt', async () => {
    await endpoints.update('repo-1', 'ep-1', { instructionText: 'NEW\ntext' }, '2026-11-07T01:00:00.000Z');
    const content = await prepareDelivery(payloadOf({ message: 'x' }), { endpoints });
    expect(content.instructionMarkdown).toBe('NEW\ntext');
  });

  it('a deleted endpoint is a PermanentHandlerError', async () => {
    await endpoints.delete('repo-1', 'ep-1');
    await expect(prepareDelivery(payloadOf({ message: 'x' }), { endpoints })).rejects.toBeInstanceOf(PermanentHandlerError);
  });

  it('a cascade-deleted endpoint (its repository deleted) is a PermanentHandlerError', async () => {
    await db.deleteFrom('repositories').where('id', '=', 'repo-1').execute();
    expect(await endpoints.findWithSecretById('ep-1')).toBeNull();
    await expect(prepareDelivery(payloadOf({ message: 'x' }), { endpoints })).rejects.toBeInstanceOf(PermanentHandlerError);
  });

  it('a stored payload that no longer parses is a PermanentHandlerError', async () => {
    await expect(prepareDelivery(payloadOf('{broken'), { endpoints })).rejects.toBeInstanceOf(PermanentHandlerError);
  });

  describe('summary truncation', () => {
    const summaryOf = async (message: string) => (await prepareDelivery(payloadOf({ message }), { endpoints })).summary;

    it('keeps 159 and 160 characters whole', async () => {
      expect(await summaryOf('a'.repeat(159))).toBe('a'.repeat(159));
      expect(await summaryOf('a'.repeat(160))).toBe('a'.repeat(160));
    });

    it('cuts 161 characters to 160 plus an ellipsis marker', async () => {
      expect(await summaryOf('a'.repeat(161))).toBe(`${'a'.repeat(160)}...`);
    });

    it('does not split a surrogate pair at the cut', async () => {
      const kept = await summaryOf(`${'a'.repeat(159)}\u{1F600}b`);
      expect(kept).toBe(`${'a'.repeat(159)}\u{1F600}...`);
      expect(isWellFormed(kept)).toBe(true);
      // 159 + a pair that starts at the boundary: 160 code points, not truncated.
      expect(await summaryOf(`${'a'.repeat(159)}\u{1F600}`)).toBe(`${'a'.repeat(159)}\u{1F600}`);
      expect(isWellFormed(await summaryOf(`${'a'.repeat(160)}\u{1F600}`))).toBe(true);
    });

    it('collapses whitespace before measuring', async () => {
      expect(await summaryOf(`  ${'a '.repeat(10)}\n\n\tb `)).toBe(`${'a '.repeat(10)}b`);
    });
  });
});

describe('module boundary', () => {
  it('receive.ts imports nothing from the actions directory', async () => {
    const source = await Bun.file(new URL('../receive.ts', import.meta.url)).text();
    expect(source).not.toMatch(/from\s+['"][^'"]*\/actions\//);
  });
});
