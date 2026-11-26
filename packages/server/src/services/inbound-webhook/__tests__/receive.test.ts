import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { InboundWebhookProcessPayload } from '@agent-console/shared';
import type { Database } from '../../../database/schema.js';
import { createDatabaseForTest } from '../../../database/connection.js';
import { JobQueue, JOB_TYPES } from '../../../jobs/index.js';
import { SqliteInboundWebhookEndpointRepository } from '../../../repositories/sqlite-inbound-webhook-endpoint-repository.js';
import { PermanentHandlerError } from '../../inbound/job-handler.js';
import { rootLogger } from '../../../lib/logger.js';
import { signStandardWebhook } from '../../../lib/inbound-webhook-secret.js';
import { v2Body } from '../../../__tests__/utils/inbound-webhook-body.js';
// Fictional values from a public repository's sender fixture.
import golden from './fixtures/slack-blocks-golden.json';
import {
  inboundWebhookDeliveryId,
  isTimestampWithinTolerance,
  isValidWebhookId,
  parseInboundWebhookBody,
  parseInboundWebhookDeliveryId,
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
// Signed by the known-answer vectors but never parsed, so its body shape does not matter.
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
  const refused: Array<[string, string]> = [
    ['invalid JSON', '{not json'],
    ['empty text', ''],
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"x"'],
    ['a string schema_version', '{"message":"x","schema_version":"1"}'],
  ];
  for (const [name, text] of refused) {
    it(`refuses ${name}`, () => expect(parseInboundWebhookBody(text).ok).toBe(false));
  }
});

describe('signStandardWebhook with verifyStandardWebhookSignature', () => {
  it('a signature produced by the signer verifies', () => {
    const signature = signStandardWebhook({ secret: VECTOR_SECRET, id: VECTOR_ID, timestamp: VECTOR_TS, body: VECTOR_BODY });
    expect(signature).toBe(`v1,${VECTOR_SIG}`);
    expect(
      verifyStandardWebhookSignature({
        secret: VECTOR_SECRET,
        webhookId: VECTOR_ID,
        timestamp: VECTOR_TS,
        rawBody: VECTOR_BODY,
        signatureHeader: signature,
      }),
    ).toBe(true);
  });
});

describe('parseInboundWebhookDeliveryId', () => {
  const longest = 'A'.repeat(128);
  for (const [name, webhookId] of [
    ['a plain webhook id', 'Ev1'],
    ['a webhook id containing a colon', 'a:b:c'],
    ['the 128-character maximum', longest],
  ] as const) {
    it(`round-trips ${name}`, () => {
      expect(parseInboundWebhookDeliveryId(inboundWebhookDeliveryId('ep-1', webhookId))).toEqual({
        endpointId: 'ep-1',
        webhookId,
      });
    });
  }

  it('returns null for a wrong prefix', () => {
    expect(parseInboundWebhookDeliveryId('other:ep-1:Ev1')).toBeNull();
    expect(parseInboundWebhookDeliveryId('ep-1:Ev1')).toBeNull();
  });

  it('returns null for an empty endpoint id', () => {
    expect(parseInboundWebhookDeliveryId('inbound-webhook::Ev1')).toBeNull();
  });

  it('returns null for an empty webhook id and for a missing separator', () => {
    expect(parseInboundWebhookDeliveryId('inbound-webhook:ep-1:')).toBeNull();
    expect(parseInboundWebhookDeliveryId('inbound-webhook:ep-1')).toBeNull();
  });

  it('returns null for a webhook id that fails isValidWebhookId', () => {
    expect(parseInboundWebhookDeliveryId('inbound-webhook:ep-1:../x')).toBeNull();
    expect(parseInboundWebhookDeliveryId(`inbound-webhook:ep-1:${'A'.repeat(129)}`)).toBeNull();
  });
});

describe('receiveInboundWebhook', () => {
  let db: Kysely<Database>;
  let endpoints: SqliteInboundWebhookEndpointRepository;
  let jobQueue: JobQueue;
  let wakeSpy: ReturnType<typeof spyOn>;
  const ENDPOINT_ID = 'ep-1';
  const SECRET = VECTOR_SECRET;
  const BODY = JSON.stringify(v2Body());
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

  describe('reflected reply ids', () => {
    const recordReply = async (endpointId: string, replyId: string) => {
      await db
        .insertInto('inbound_webhook_deliveries')
        .values({ endpoint_id: endpointId, webhook_id: 'Orig1', received_at: NOW.toISOString() })
        .execute();
      await db
        .insertInto('inbound_webhook_replies')
        .values({
          id: replyId,
          endpoint_id: endpointId,
          webhook_id: 'Orig1',
          session_id: 'session-1',
          body_sha256: 'a'.repeat(64),
          created_at: NOW.toISOString(),
        })
        .execute();
    };

    it('a signed delivery whose webhook-id is a recorded reply id for this endpoint is a duplicate with no new row, job or wake (control: an unrecorded id is accepted)', async () => {
      await recordReply(ENDPOINT_ID, 'reply_abc');
      const before = await rows();
      wakeSpy.mockClear();
      const warn = spyOn(rootLogger, 'warn');
      try {
        const reflected = await receiveInboundWebhook(input({ webhookId: 'reply_abc' }), deps());
        expect(reflected).toEqual({ kind: 'duplicate' });
        expect(await rows()).toEqual(before);
        expect(wakeSpy).not.toHaveBeenCalled();
        const logged = warn.mock.calls.map((call) => JSON.stringify(call));
        expect(logged.some((line) => line.includes('reply-id-reflected') && line.includes('reply_abc') && line.includes(ENDPOINT_ID))).toBe(true);
      } finally {
        warn.mockRestore();
      }

      const control = await receiveInboundWebhook(input({ webhookId: 'reply_other' }), deps());
      expect(control).toEqual({ kind: 'accepted' });
      const after = await rows();
      expect(after.deliveries.map((d) => d.webhook_id).sort()).toEqual(['Orig1', 'reply_other']);
      expect(after.jobs).toHaveLength(1);
    });

    it('a reflected reply id is a duplicate even when the body fails the inbound schema (control: the same body with an unrecorded id is invalid_request)', async () => {
      await recordReply(ENDPOINT_ID, 'reply_abc');
      const before = await rows();
      wakeSpy.mockClear();
      const badBody = '{"unexpected":"echo"}';

      expect(await receiveInboundWebhook(input({ webhookId: 'reply_abc', rawBody: badBody }), deps())).toEqual({ kind: 'duplicate' });
      expect(await rows()).toEqual(before);
      expect(wakeSpy).not.toHaveBeenCalled();

      expect(await receiveInboundWebhook(input({ webhookId: 'reply_unrecorded', rawBody: badBody }), deps())).toEqual({
        kind: 'invalid_request',
      });
      expect(await rows()).toEqual(before);
    });

    it('a reply id recorded for another endpoint does not block this one', async () => {
      await endpoints.create({
        id: 'ep-2',
        label: 'Other',
        repositoryId: 'repo-1',
        instructionText: 'x',
        secret: SECRET,
        now: '2026-11-07T00:00:00.000Z',
      });
      await recordReply('ep-2', 'reply_abc');
      const result = await receiveInboundWebhook(input({ webhookId: 'reply_abc' }), deps());
      expect(result).toEqual({ kind: 'accepted' });
      expect((await rows()).jobs).toHaveLength(1);
    });
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

    describe('a version 1 body', () => {
      const V1_BODY = JSON.stringify({ schema_version: 1, message: 'm', slack_channel: 'C1' });
      const refusedRecords = async (rawBody: string) => {
        const warn = spyOn(rootLogger, 'warn');
        try {
          expect(await receiveInboundWebhook(input({ rawBody }), deps())).toEqual({ kind: 'invalid_request' });
          return warn.mock.calls.filter((call) => call.includes('Inbound webhook refused')).map((call) => call[0]);
        } finally {
          warn.mockRestore();
        }
      };

      it('(T3) correctly signed: 400, no row, no job, one refusal record reporting schemaVersion 1', async () => {
        const records = await refusedRecords(V1_BODY);
        expect(records).toEqual([{ endpointId: ENDPOINT_ID, reason: 'unsupported-schema-version', schemaVersion: 1 }]);
        expect(await rows()).toEqual({ deliveries: [], jobs: [] });
        expect(wakeSpy).not.toHaveBeenCalled();
      });

      it('(T3) correctly signed without the schema_version key: the same, with no schemaVersion on the record', async () => {
        const records = await refusedRecords('{"message":"m"}');
        expect(records).toEqual([{ endpointId: ENDPOINT_ID, reason: 'unsupported-schema-version' }]);
        expect(await rows()).toEqual({ deliveries: [], jobs: [] });
        expect(wakeSpy).not.toHaveBeenCalled();
      });

      it('(T3) with a wrong signature it is still 401: the signature is checked before the body', async () => {
        const signature = sign('whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'Ev1', NOW_SECONDS, V1_BODY);
        expect(await receiveInboundWebhook(input({ rawBody: V1_BODY, signature }), deps())).toEqual({ kind: 'unauthorized' });
        expect(await rows()).toEqual({ deliveries: [], jobs: [] });
      });
    });

    const invalidBodies: Array<[string, string]> = [
      ['invalid JSON', '{nope'],
      ['an array', '[]'],
      ['wrong types', JSON.stringify(v2With(['message'], 5))],
      ['no message', JSON.stringify(v2With(['message']))],
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
      payloadOf(v2Body({ message: 'hello\nworld' }, { permalink: 'https://x.slack.com/archives/C1/p1' }, { ids: IDS })),
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
    const content = await prepareDelivery(payloadOf(v2Body({ message: 'x' }, { permalink: null }, { type: 'other' })), { endpoints });
    expect(content.url).toBeNull();
    expect(content.bodyMarkdown).not.toContain('Details');
  });

  it('never projects source.event.text, non-content keys of source.event (the poster app_id / bot_id are the only exception), or hikyac.files, even when the payload carries them', async () => {
    const token = 'TOKEN-SENTINEL-123';
    const content = await prepareDelivery(
      payloadOf(
        v2Body(
          { message: 'plain' },
          { files: [{ name: 'a.png', mimetype: 'image/png', size: 5, url: `https://firebasestorage.googleapis.com/v0/b/x/o/a?alt=media&token=${token}` }] },
          // bot_id fails the id shape here, so it is not shown either; bot_profile.app_id is never read.
          { event: { text: 'RAW-EVENT-SENTINEL', user: 'USER-SENTINEL', username: 'USERNAME-SENTINEL', bot_profile: { app_id: 'APROFILE1' }, bot_id: 'BOT-SENTINEL', blocks: [{ type: 'rich_text', block_id: 'BLOCK-ID-SENTINEL' }] } },
        ),
      ),
      // The file is not fetchable here, so no local name is listed either.
      { endpoints, attachmentFetch: async () => new Response('', { status: 404 }) },
    );
    const everything = JSON.stringify(content);
    for (const forbidden of ['RAW-EVENT-SENTINEL', 'USER-SENTINEL', 'USERNAME-SENTINEL', 'APROFILE1', 'BOT-SENTINEL', 'BLOCK-ID-SENTINEL', token, 'firebasestorage', 'slack_message', 'slack_files', 'hikyac', 'source.event', 'a.png']) {
      expect(everything).not.toContain(forbidden);
    }
  });

  describe('slack content projection', () => {
    it('leaves the body byte-identical when there is nothing to project', async () => {
      const bodyOf = (event: Record<string, unknown> | null) => payloadOf(v2Body({ message: 'hi' }, {}, { ids: IDS, event }));
      const plain = await prepareDelivery(bodyOf(null), { endpoints });
      expect(plain.bodyMarkdown).toBe('# Inbound webhook message\n\n## Message\n\nhi\n\n## Details\n\n- Channel: C1\n- Timestamp: 1.2\n');
      const withEvent = await prepareDelivery(bodyOf({ text: 'x', user: 'U1' }), { endpoints });
      expect(withEvent.bodyMarkdown).toBe(plain.bodyMarkdown);
    });

    it('places ## Content between ## Message and ## Details, and keeps the message as the summary', async () => {
      const content = await prepareDelivery(
        payloadOf(v2Body({ message: golden.message }, {}, { ids: IDS, event: golden.slack_message })),
        { endpoints },
      );
      const body = content.bodyMarkdown;
      const message = body.indexOf('## Message');
      const projected = body.indexOf('## Content');
      const details = body.indexOf('## Details');
      expect(message).toBeGreaterThanOrEqual(0);
      expect(projected).toBeGreaterThan(message);
      expect(details).toBeGreaterThan(projected);
      expect(body).toContain('\n\n## Content\n\n');
      expect(body).toContain('### 🚨 arata daily — acme');
      expect(content.summary).toBe(golden.message);
    });

    it('takes the summary from the first projected line when the message is empty or blank', async () => {
      for (const message of ['', '   ']) {
        const content = await prepareDelivery(payloadOf(v2Body({ message }, {}, { event: golden.slack_message })), { endpoints });
        expect(content.summary).toBe('<!channel>');
      }
      const headerFirst = await prepareDelivery(
        payloadOf(v2Body({ message: '' }, {}, { event: { blocks: [{ type: 'divider' }, { type: 'header', text: { text: 'Head' } }] } })),
        { endpoints },
      );
      expect(headerFirst.summary).toBe('Head');
    });

    it('falls back to the fixed summary when nothing is projected', async () => {
      expect((await prepareDelivery(payloadOf(v2Body({ message: '' }, {}, { event: {} })), { endpoints })).summary).toBe('Inbound webhook message');
      expect((await prepareDelivery(payloadOf(v2Body({ message: '' }, {}, { event: { blocks: [{ type: 'divider' }] } })), { endpoints })).summary).toBe('Inbound webhook message');
    });

    it('does not fail the delivery on malformed blocks and shows the count line', async () => {
      const content = await prepareDelivery(
        payloadOf(v2Body({ message: '' }, {}, { event: { blocks: [null, { type: 'section' }] } })),
        { endpoints },
      );
      expect(content.bodyMarkdown).toContain('(2 blocks without projectable text not shown.)');
      expect(content.summary).toBe('Inbound webhook message');
    });

    it('renders the section when the sender shortened the message, even with no source event', async () => {
      const content = await prepareDelivery(payloadOf(v2Body({ message: 'hi' }, {}, { event: null, truncated: true })), { endpoints });
      expect(content.bodyMarkdown).toContain('## Content');
      expect(content.bodyMarkdown).toContain('The sender shortened the Slack message');
    });

    it('logs counts only, once per delivery, with or without a source event', async () => {
      const sentinel = 'LOG-SENTINEL-XYZ';
      const infoSpy = spyOn(rootLogger, 'info');
      try {
        await prepareDelivery(
          payloadOf(v2Body({ message: sentinel }, {}, { event: { text: sentinel, blocks: [{ type: 'section', text: { text: sentinel } }, { type: 'image', title: sentinel }] } })),
          { endpoints },
        );
        const projected = infoSpy.mock.calls.filter((call) => call.includes('Slack content projected'));
        expect(projected).toHaveLength(1);
        expect(projected[0]![0]).toEqual({
          deliveryId: 'inbound-webhook:ep-1:Ev1',
          endpointId: 'ep-1',
          schemaVersion: 2,
          blocksSeen: 2,
          attachmentsSeen: 0,
          chunks: 1,
          notShown: 1,
          cut: false,
          appId: 'absent',
          botId: 'absent',
          senderTruncated: false,
        });
        expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(sentinel);

        infoSpy.mockClear();
        await prepareDelivery(payloadOf(v2Body({ message: 'no event' })), { endpoints });
        const withoutEvent = infoSpy.mock.calls.filter((call) => call.includes('Slack content projected'));
        expect(withoutEvent).toHaveLength(1);
        expect(withoutEvent[0]![0]).toMatchObject({ schemaVersion: 2, blocksSeen: 0, appId: 'absent', botId: 'absent' });
      } finally {
        infoSpy.mockRestore();
      }
    });
  });

  describe('poster identity', () => {
    /** `message` "hi" from channel C1 at 1.2, with `event` as the source event. */
    const posted = (event: Record<string, unknown> | null, hikyac: Record<string, unknown> = {}) =>
      payloadOf(v2Body({ message: 'hi' }, hikyac, { ids: IDS, event }));

    it('(T6) renders the five Details lines in order', async () => {
      const content = await prepareDelivery(
        posted({ app_id: 'A0123ABCD', bot_id: 'B0123ABCD' }, { permalink: 'https://x.slack.com/archives/C1/p1' }),
        { endpoints },
      );
      expect(content.bodyMarkdown).toBe(
        [
          '# Inbound webhook message',
          '',
          '## Message',
          '',
          'hi',
          '',
          '## Details',
          '',
          '- Permalink: https://x.slack.com/archives/C1/p1',
          '- Channel: C1',
          '- Timestamp: 1.2',
          '- App ID: A0123ABCD',
          '- Bot ID: B0123ABCD',
          '',
        ].join('\n'),
      );
    });

    it('(T7) renders the two id lines after Timestamp', async () => {
      const content = await prepareDelivery(
        posted({ app_id: 'A0123ABCD', bot_id: 'B0123ABCD' }),
        { endpoints },
      );
      expect(content.bodyMarkdown).toBe('# Inbound webhook message\n\n## Message\n\nhi\n\n## Details\n\n- Channel: C1\n- Timestamp: 1.2\n- App ID: A0123ABCD\n- Bot ID: B0123ABCD\n');
    });

    it('(A2/A3) renders one id alone when the other is malformed', async () => {
      const content = await prepareDelivery(
        posted({ app_id: 'A0123ABCD', bot_id: 'b-1' }),
        { endpoints },
      );
      expect(content.bodyMarkdown).toBe('# Inbound webhook message\n\n## Message\n\nhi\n\n## Details\n\n- Channel: C1\n- Timestamp: 1.2\n- App ID: A0123ABCD\n');
      expect(content.bodyMarkdown).not.toContain('Bot ID');
    });

    it('(T8) writes nothing of an id that carries a newline and a heading', async () => {
      const content = await prepareDelivery(
        posted({ app_id: 'A1\n## Injected' }),
        { endpoints },
      );
      expect(content.bodyMarkdown).not.toContain('Injected');
      expect(content.bodyMarkdown).not.toContain('App ID');
    });

    it('(T9) leaves the body byte-identical when the only ids are malformed and nothing is projected', async () => {
      const plain = await prepareDelivery(posted(null), { endpoints });
      const withBad = await prepareDelivery(posted({ app_id: 'bad id', text: 'x' }), { endpoints });
      expect(withBad.bodyMarkdown).toBe(plain.bodyMarkdown);
    });

    it('(T11/A5) keeps summary, url and the rest of the content equal to the same body without ids', async () => {
      const bodyOf = (event: Record<string, unknown>) =>
        payloadOf(v2Body({ message: 'hello' }, { permalink: 'https://x.slack.com/archives/C1/p1' }, { event }));
      const without = await prepareDelivery(bodyOf({ text: 'x' }), { endpoints });
      const withIds = await prepareDelivery(bodyOf({ text: 'x', app_id: 'A0123ABCD', bot_id: 'B0123ABCD' }), { endpoints });
      expect(withIds.summary).toBe(without.summary);
      expect(withIds.url).toBe(without.url);
      expect(withIds.instructionMarkdown).toBe(without.instructionMarkdown);
      expect(withIds.deliveryId).toBe(without.deliveryId);
      expect(withIds.endpoint).toEqual(without.endpoint);
      const everythingButBody = JSON.stringify({ ...withIds, bodyMarkdown: '' });
      expect(everythingButBody).not.toContain('A0123ABCD');
      expect(everythingButBody).not.toContain('B0123ABCD');
    });

    it('(A6) logs the kinds of both ids and never a value', async () => {
      const infoSpy = spyOn(rootLogger, 'info');
      try {
        await prepareDelivery(posted({ app_id: 'A0123ABCD', bot_id: 'b-1' }), { endpoints });
        const projected = infoSpy.mock.calls.filter((call) => call.includes('Slack content projected'));
        expect(projected).toHaveLength(1);
        expect(projected[0]![0]).toMatchObject({ appId: 'shown', botId: 'rejected' });
        const logged = JSON.stringify(infoSpy.mock.calls);
        expect(logged).not.toContain('A0123ABCD');
        expect(logged).not.toContain('b-1');
      } finally {
        infoSpy.mockRestore();
      }
    });
  });

  describe('attachments', () => {
    const TOKEN = 'tok-NEUTRAL-0002';
    const fileUrl = (n: number) => `https://firebasestorage.googleapis.com/v0/b/bucket-NEUTRAL/o/f${n}?alt=media&token=${TOKEN}-${n}`;
    const calls: string[] = [];
    const stubFetch = async (url: string) => {
      calls.push(url);
      return url.includes('/f2?') ? new Response('', { status: 404 }) : new Response(new Uint8Array([9, 8, 7]), { status: 200 });
    };

    beforeEach(() => {
      calls.length = 0;
    });

    it('a message with no files has no attachments, 0/0 counts, hasAttachments false and no section', async () => {
      const content = await prepareDelivery(payloadOf(v2Body({ message: 'x' })), { endpoints, attachmentFetch: stubFetch });
      expect(content).toMatchObject({ attachments: [], attachmentsFetched: 0, attachmentsSkipped: 0, hasAttachments: false });
      expect(content.bodyMarkdown).not.toContain('Attachments');
      expect(calls).toEqual([]);
    });

    it('an empty hikyac.files array counts as no attachments', async () => {
      const content = await prepareDelivery(payloadOf(v2Body({ message: 'x' }, { files: [] })), { endpoints, attachmentFetch: stubFetch });
      expect(content).toMatchObject({ attachmentsFetched: 0, attachmentsSkipped: 0, hasAttachments: false });
    });

    it('fetches each file once, lists the LOCAL names under attachments/, counts the failure, and carries no URL or token anywhere', async () => {
      const content = await prepareDelivery(
        payloadOf(
          v2Body(
            { message: 'with files' },
            {
              files: [
                { name: 'one.png', mimetype: 'image/png', size: 3, url: fileUrl(1) },
                { name: '../../two.png', url: fileUrl(2) },
                { name: 'three.txt', url: fileUrl(3) },
                { name: 'four.txt', url: 'https://evil.test/four' },
              ],
            },
          ),
        ),
        { endpoints, attachmentFetch: stubFetch },
      );
      expect(calls).toHaveLength(3);
      expect(content.hasAttachments).toBe(true);
      expect(content.attachments.map((a) => a.name)).toEqual(['one.png', 'three.txt']);
      expect(Array.from(content.attachments[0]!.bytes)).toEqual([9, 8, 7]);
      expect(content.attachmentsFetched).toBe(2);
      expect(content.attachmentsSkipped).toBe(2);
      expect(content.bodyMarkdown).toContain('## Attachments\n\n- attachments/one.png\n- attachments/three.txt\n- Not fetched: 2\n');
      const everything = JSON.stringify({ ...content, attachments: content.attachments.map((a) => a.name) });
      for (const forbidden of [TOKEN, 'firebasestorage', 'bucket-NEUTRAL', 'evil.test', 'image/png', 'two.png']) {
        expect(everything).not.toContain(forbidden);
      }
    });

    it('a failing fetch never fails the delivery: the body is built and everything is counted skipped', async () => {
      const content = await prepareDelivery(
        payloadOf(v2Body({ message: 'still delivered' }, { files: [{ name: 'a.png', url: fileUrl(1) }] })),
        { endpoints, attachmentFetch: async () => { throw new Error('network down'); } },
      );
      expect(content.bodyMarkdown).toContain('still delivered');
      expect(content).toMatchObject({ attachments: [], attachmentsFetched: 0, attachmentsSkipped: 1, hasAttachments: true });
    });

    it('applies injected limits: the count cap leaves the rest skipped', async () => {
      const content = await prepareDelivery(
        payloadOf(v2Body({ message: 'x' }, { files: [1, 3, 4].map((n) => ({ name: `f${n}`, url: fileUrl(n) })) })),
        { endpoints, attachmentFetch: stubFetch, attachmentLimits: { timeoutMs: 1000, maxBytes: 100, maxCount: 2 } },
      );
      expect(calls).toHaveLength(2);
      expect(content).toMatchObject({ attachmentsFetched: 2, attachmentsSkipped: 1 });
    });
  });

  it('strips control characters but keeps newline and tab in the body projection', async () => {
    const content = await prepareDelivery(
      payloadOf(v2Body({ message: 'a\u001b[31mb\u0000c\u009bd\re\u000bv\u000cw\nf\tg' })),
      { endpoints },
    );
    expect(content.bodyMarkdown).toContain('a[31mbcdevw\nf\tg');
    expect(content.bodyMarkdown).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  it('renders the exact VT, FF and CR input as abcd, newline, e, tab, f in both ## Message and ## Content', async () => {
    const raw = 'a\u000bb\u000cc\rd\ne\tf';
    const content = await prepareDelivery(
      payloadOf(v2Body({ message: raw }, {}, { event: { blocks: [{ type: 'section', text: { type: 'mrkdwn', text: raw } }] } })),
      { endpoints },
    );
    const body = content.bodyMarkdown;
    expect(body).toContain('## Message\n\nabcd\ne\tf\n');
    const projected = body.slice(body.indexOf('## Content'));
    expect(projected).toContain('\n\nabcd\ne\tf\n');
  });

  it('uses a fixed summary when the sender text is empty', async () => {
    expect((await prepareDelivery(payloadOf(v2Body({ message: '' })), { endpoints })).summary).toBe('Inbound webhook message');
    expect((await prepareDelivery(payloadOf(v2Body({ message: '' }, {}, { event: { text: 'x' } })), { endpoints })).summary).toBe('Inbound webhook message');
  });

  it('carries the instruction text as of the re-read, not as of receipt', async () => {
    await endpoints.update('repo-1', 'ep-1', { instructionText: 'NEW\ntext' }, '2026-11-07T01:00:00.000Z');
    const content = await prepareDelivery(payloadOf(v2Body()), { endpoints });
    expect(content.instructionMarkdown).toBe('NEW\ntext');
  });

  it('a deleted endpoint is a PermanentHandlerError', async () => {
    await endpoints.delete('repo-1', 'ep-1');
    await expect(prepareDelivery(payloadOf(v2Body()), { endpoints })).rejects.toBeInstanceOf(PermanentHandlerError);
  });

  it('a cascade-deleted endpoint (its repository deleted) is a PermanentHandlerError', async () => {
    await db.deleteFrom('repositories').where('id', '=', 'repo-1').execute();
    expect(await endpoints.findWithSecretById('ep-1')).toBeNull();
    await expect(prepareDelivery(payloadOf(v2Body()), { endpoints })).rejects.toBeInstanceOf(PermanentHandlerError);
  });

  it('a stored payload that no longer parses is a PermanentHandlerError', async () => {
    await expect(prepareDelivery(payloadOf('{broken'), { endpoints })).rejects.toBeInstanceOf(PermanentHandlerError);
  });

  it('(T4) a stored version 1 body is a PermanentHandlerError: no attachment fetch, no projection record', async () => {
    const calls: string[] = [];
    const infoSpy = spyOn(rootLogger, 'info');
    try {
      const stored = {
        schema_version: 1,
        message: 'm',
        slack_files: [{ name: 'a.png', url: 'https://firebasestorage.googleapis.com/v0/b/bucket-NEUTRAL/o/f1?alt=media' }],
      };
      await expect(
        prepareDelivery(payloadOf(stored), {
          endpoints,
          attachmentFetch: async (url) => {
            calls.push(url);
            return new Response('', { status: 200 });
          },
        }),
      ).rejects.toBeInstanceOf(PermanentHandlerError);
      expect(calls).toEqual([]);
      expect(infoSpy.mock.calls.filter((call) => call.includes('Slack content projected'))).toEqual([]);
    } finally {
      infoSpy.mockRestore();
    }
  });

  describe('summary truncation', () => {
    const summaryOf = async (message: string) => (await prepareDelivery(payloadOf(v2Body({ message })), { endpoints })).summary;

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

describe('the reply URL stays off every agent-visible surface', () => {
  const MARK = 'REPLYURLMARK';
  const REPLY_URL = `https://sender.example.com/replies?token=${MARK}`;

  it('prepareDelivery for an endpoint that has a reply URL puts it in no content field (control: the endpoint really carries it)', async () => {
    const db = await createDatabaseForTest();
    try {
      await db.insertInto('repositories').values({ id: 'repo-1', name: 'r', path: '/tmp/r' }).execute();
      const endpoints = new SqliteInboundWebhookEndpointRepository(db);
      await endpoints.create({
        id: 'ep-1',
        label: 'Slack',
        repositoryId: 'repo-1',
        instructionText: 'Do it',
        secret: VECTOR_SECRET,
        replyUrl: REPLY_URL,
        now: '2026-11-20T00:00:00.000Z',
      });
      expect((await endpoints.findWithSecretById('ep-1'))?.replyUrl).toBe(REPLY_URL);

      const content = await prepareDelivery(
        { jobId: 'inbound-webhook:ep-1:Ev1', endpointId: 'ep-1', rawPayload: JSON.stringify(v2Body()), receivedAt: NOW.toISOString() },
        { endpoints },
      );
      const serialized = JSON.stringify(content);
      expect(serialized).toContain('Do it');
      expect(serialized).not.toContain(MARK);
      expect(serialized).not.toContain('sender.example.com');
    } finally {
      await db.destroy();
    }
  });

  it('no MCP source file or notification renderer names the reply URL or reads the endpoint repository', async () => {
    const roots = ['../../../mcp', '../../inbound', '../../../lib/pty-notification.ts'];
    const files: string[] = [];
    for (const root of roots) {
      const path = new URL(`${root}`, import.meta.url).pathname;
      const glob = new Bun.Glob(root.endsWith('.ts') ? path.split('/').pop()! : '**/*.ts');
      const base = root.endsWith('.ts') ? path.split('/').slice(0, -1).join('/') : path;
      for await (const file of glob.scan({ cwd: base, absolute: true })) {
        if (!file.includes('__tests__')) files.push(file);
      }
    }
    // Presence control: the scan actually reached the MCP server and the inbound handlers.
    expect(files.some((f) => f.endsWith('/mcp/mcp-server.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('/inbound/handlers.ts'))).toBe(true);
    for (const file of files) {
      const text = await Bun.file(file).text();
      expect(text, file).not.toMatch(/reply_url|replyUrl|inboundWebhookEndpointRepository/);
    }
  });
});

// ---------------------------------------------------------------------------
// schema_version dispatch and the body reader
// ---------------------------------------------------------------------------

const FILE_URL = 'https://firebasestorage.googleapis.com/v0/b/bucket-NEUTRAL/o/f1?alt=media&token=tok-NEUTRAL-V2';
const SECTION_EVENT = { app_id: 'A0123ABCD', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'BLOCK-MARKER' } }] };
const PERMALINK = 'https://example.slack.com/archives/C1/p1';
const IDS = { channel: 'C1', ts: '1.2' };

/** A deep copy of `v2Body()` with the value at `path` removed, or replaced when `value` is given. */
function v2With(path: string[], value?: unknown): unknown {
  const body = JSON.parse(JSON.stringify(v2Body())) as Record<string, unknown>;
  let node: Record<string, unknown> = body;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
  const last = path[path.length - 1] as string;
  if (arguments.length === 2) node[last] = value;
  else delete node[last];
  return body;
}

describe('parseInboundWebhookBody: schema_version dispatch', () => {
  const v1Text = (versionText?: string) =>
    `{${versionText === undefined ? '' : `"schema_version":${versionText},`}"message":"m","slack_channel":"C1"}`;
  const v2Text = (versionText: string) => JSON.stringify(v2Body()).replace('"schema_version":2', `"schema_version":${versionText}`);

  // (T1) one case per row of the decision table
  for (const [name, text] of [['2', v2Text('2')], ['2.0', v2Text('2.0')]] as const) {
    it(`(T1) schema_version ${name} is read`, () => {
      const parsed = parseInboundWebhookBody(text);
      expect(parsed.ok && parsed.message.schemaVersion).toBe(2);
    });
  }

  // The refused bodies below are complete version 1 bodies, so a reader for that shape coming back fails these.
  it('(T1) a body without the schema_version key is refused as unsupported, with no schemaVersion', () => {
    const parsed = parseInboundWebhookBody('{"message":"m"}');
    expect(parsed).toEqual({ ok: false, reason: 'unsupported-schema-version' });
    expect('schemaVersion' in parsed).toBe(false);
  });

  for (const versionText of ['1', '1.0']) {
    it(`(T1) schema_version ${versionText} is refused as unsupported, reporting 1`, () => {
      expect(parseInboundWebhookBody(v1Text(versionText))).toEqual({
        ok: false,
        reason: 'unsupported-schema-version',
        schemaVersion: 1,
      });
    });
  }

  it('(T2) an empty object is refused as unsupported, with no schemaVersion', () => {
    const parsed = parseInboundWebhookBody('{}');
    expect(parsed).toEqual({ ok: false, reason: 'unsupported-schema-version' });
    expect('schemaVersion' in parsed).toBe(false);
  });

  it('(T2) schema_version 2 alone reaches the reader and fails it', () => {
    expect(parseInboundWebhookBody('{"schema_version":2}')).toEqual({ ok: false, reason: 'invalid-request' });
  });

  it('(T2) a body carrying both key sets is read from the version 2 keys', () => {
    const parsed = parseInboundWebhookBody(
      JSON.stringify({
        ...v2Body({}, { permalink: PERMALINK }, { ids: IDS }),
        slack_channel: 'C-OLD',
        slack_ts: '9.9',
        slack_permalink: 'https://example.slack.com/archives/C-OLD/p9',
      }),
    );
    expect(parsed.ok && parsed.message).toMatchObject({ channel: 'C1', permalink: PERMALINK });
  });

  const unsupported: Array<[string, string, number | undefined]> = [
    ['0', v1Text('0'), 0],
    ['3', v1Text('3'), 3],
    ['1.5', v1Text('1.5'), 1.5],
    ['-1', v1Text('-1'), -1],
    ['"2" (a string)', v1Text('"2"'), undefined],
    ['null', v1Text('null'), undefined],
    ['true', v1Text('true'), undefined],
    ['an object', v1Text('{"a":1}'), undefined],
    ['a number too large for a double', v1Text('1e999'), undefined],
  ];
  for (const [name, text, schemaVersion] of unsupported) {
    it(`(T1) schema_version ${name} is refused as unsupported, reporting the number only when it is finite`, () => {
      const parsed = parseInboundWebhookBody(text);
      expect(parsed).toEqual(schemaVersion === undefined ? { ok: false, reason: 'unsupported-schema-version' } : { ok: false, reason: 'unsupported-schema-version', schemaVersion });
    });
  }

  for (const [name, text] of [['a non-JSON text', '{nope'], ['an array', '[]'], ['a string', '"x"'], ['a number', '2'], ['null', 'null']] as const) {
    it(`(T1) ${name} is refused as an invalid request`, () => {
      expect(parseInboundWebhookBody(text)).toEqual({ ok: false, reason: 'invalid-request' });
    });
  }

  it('(T1) version 1 keys claiming version 2 fail the reader, and a version 2 body without the key is refused', () => {
    // A complete version 1 body that claims version 2: the reader refuses it.
    expect(parseInboundWebhookBody('{"schema_version":2,"message":"m","slack_channel":"C1"}')).toEqual({ ok: false, reason: 'invalid-request' });
    // A complete version 2 body with the version key removed is not read at all.
    const { schema_version: _dropped, ...withoutVersion } = v2Body();
    const parsed = parseInboundWebhookBody(JSON.stringify(withoutVersion));
    expect(parsed).toEqual({ ok: false, reason: 'unsupported-schema-version' });
    expect('schemaVersion' in parsed).toBe(false);
  });
});

describe('parseInboundWebhookBody: version 2 reader', () => {
  const read = (body: unknown) => parseInboundWebhookBody(JSON.stringify(body));

  it('maps a full slack body into the normalised shape', () => {
    const parsed = read(
      v2Body({ message: 'hello' }, { permalink: PERMALINK, files: [{ name: 'a.png', url: FILE_URL }] }, { ids: IDS, event: { a: 1 }, truncated: true }),
    );
    expect(parsed).toEqual({
      ok: true,
      message: {
        schemaVersion: 2,
        message: 'hello',
        permalink: PERMALINK,
        channel: 'C1',
        ts: '1.2',
        files: [{ name: 'a.png', url: FILE_URL }],
        sourceEvent: { a: 1 },
        sourceEventTruncated: true,
      },
    });
  });

  // (T2) every required key missing, and each with a wrong type
  const invalid: Array<[string, unknown]> = [
    ['message missing', v2With(['message'])],
    ['message a number', v2With(['message'], 5)],
    ['message null', v2With(['message'], null)],
    ['hikyac missing', v2With(['hikyac'])],
    ['hikyac a string', v2With(['hikyac'], 'x')],
    ['hikyac an array', v2With(['hikyac'], [])],
    ['hikyac.permalink missing', v2With(['hikyac', 'permalink'])],
    ['hikyac.permalink a number', v2With(['hikyac', 'permalink'], 5)],
    ['hikyac.files missing', v2With(['hikyac', 'files'])],
    ['hikyac.files null', v2With(['hikyac', 'files'], null)],
    ['hikyac.files a string', v2With(['hikyac', 'files'], 'u')],
    ['a hikyac.files element with a wrong typed name', v2With(['hikyac', 'files'], [{ name: 5 }])],
    ['source missing', v2With(['source'])],
    ['source a string', v2With(['source'], 'slack')],
    ['source.type missing', v2With(['source', 'type'])],
    ['source.type a number', v2With(['source', 'type'], 5)],
    ['source.ids missing', v2With(['source', 'ids'])],
    ['source.ids a string', v2With(['source', 'ids'], 'x')],
    ['source.ids.channel missing', v2With(['source', 'ids', 'channel'])],
    ['source.ids.channel a number', v2With(['source', 'ids', 'channel'], 5)],
    ['source.ids.channel null', v2With(['source', 'ids', 'channel'], null)],
    ['source.ids.ts missing', v2With(['source', 'ids', 'ts'])],
    ['source.ids.ts a number', v2With(['source', 'ids', 'ts'], 1.2)],
    ['source.event missing', v2With(['source', 'event'])],
    ['source.event a string', v2With(['source', 'event'], 'x')],
    ['source.truncated missing', v2With(['source', 'truncated'])],
    ['source.truncated a string', v2With(['source', 'truncated'], 'false')],
  ];
  for (const [name, body] of invalid) {
    it(`(T2) refuses: ${name}`, () => expect(read(body)).toEqual({ ok: false, reason: 'invalid-request' }));
  }

  // hikyac.v is the envelope version: anything but the number 1 (including absent) is an unsupported version.
  const badEnvelope: Array<[string, unknown]> = [
    ['hikyac.v 2', v2With(['hikyac', 'v'], 2)],
    ['hikyac.v 0', v2With(['hikyac', 'v'], 0)],
    ['hikyac.v "1"', v2With(['hikyac', 'v'], '1')],
    ['hikyac.v missing', v2With(['hikyac', 'v'])],
  ];
  for (const [name, body] of badEnvelope) {
    it(`(T2) ${name} is refused as an unsupported version`, () => {
      expect(read(body)).toEqual({ ok: false, reason: 'unsupported-schema-version', schemaVersion: 2 });
    });
  }

  it('accepts unknown extra keys at the top level, in hikyac, in source and in source.ids', () => {
    const body = v2Body({ extra: 1 }, { extra: [1] }, { extra: { a: 1 }, ids: { channel: 'C1', ts: '1.2', extra: true } });
    const parsed = read(body);
    expect(parsed.ok && parsed.message).toMatchObject({ schemaVersion: 2, channel: 'C1', ts: '1.2' });
  });

  it('a non-slack source is not looked into: its ids, event and truncated may be absent or ill-typed', () => {
    for (const source of [{ type: 'other' }, { type: 'other', ids: 5, event: 'x', truncated: 'no' }]) {
      const parsed = read({ ...v2Body(), source });
      expect(parsed.ok && parsed.message).toMatchObject({ channel: null, ts: null, sourceEvent: null, sourceEventTruncated: false });
    }
  });
});

describe('inbound body schema_version 2', () => {
  let db: Kysely<Database>;
  let endpoints: SqliteInboundWebhookEndpointRepository;
  let jobQueue: JobQueue;
  const stubFetch = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  const payloadOf = (body: unknown): InboundWebhookProcessPayload => ({
    jobId: 'inbound-webhook:ep-1:Ev1',
    endpointId: 'ep-1',
    rawPayload: JSON.stringify(body),
    receivedAt: NOW.toISOString(),
  });
  const deliver = (body: unknown) => prepareDelivery(payloadOf(body), { endpoints, attachmentFetch: stubFetch });

  beforeEach(async () => {
    db = await createDatabaseForTest();
    await db.insertInto('repositories').values({ id: 'repo-1', name: 'r', path: '/tmp/r' }).execute();
    endpoints = new SqliteInboundWebhookEndpointRepository(db);
    await endpoints.create({
      id: 'ep-1',
      label: 'Slack',
      repositoryId: 'repo-1',
      instructionText: 'Do the thing',
      secret: VECTOR_SECRET,
      now: '2026-11-07T00:00:00.000Z',
    });
    jobQueue = new JobQueue(db, { concurrency: 1 });
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('boundary values (T3)', () => {
    it('an empty message with a projectable block takes its summary from the first projected line', async () => {
      const content = await deliver(v2Body({ message: '' }, {}, { event: SECTION_EVENT }));
      expect(content.summary).toBe('BLOCK-MARKER');
      expect(content.bodyMarkdown).toContain('## Content');
    });

    it('hikyac.files [] means no attachments and no section', async () => {
      const content = await deliver(v2Body());
      expect(content).toMatchObject({ hasAttachments: false, attachmentsFetched: 0, attachmentsSkipped: 0 });
      expect(content.bodyMarkdown).not.toContain('Attachments');
    });

    it('hikyac.permalink null means url null and no Permalink line (the Channel and Timestamp lines remain)', async () => {
      const content = await deliver(v2Body({}, { permalink: null }, { ids: IDS }));
      expect(content.url).toBeNull();
      expect(content.bodyMarkdown).not.toContain('Permalink');
      expect(content.bodyMarkdown).toContain('- Channel: C1');
      expect(content.bodyMarkdown).toContain('- Timestamp: 1.2');
    });

    it('a non-slack source with a null permalink and no files has no ## Details at all', async () => {
      const content = await deliver(v2Body({ message: 'hi' }, { permalink: null, files: [] }, { type: 'other' }));
      expect(content.bodyMarkdown).toBe('# Inbound webhook message\n\n## Message\n\nhi\n');
    });

    it('source.event null with truncated false has no ## Content', async () => {
      const content = await deliver(v2Body());
      expect(content.bodyMarkdown).not.toContain('## Content');
    });

    it('source.event null with truncated true renders the section with the sender-shortened notice', async () => {
      const content = await deliver(v2Body({}, {}, { truncated: true }));
      expect(content.bodyMarkdown).toContain('## Content');
      expect(content.bodyMarkdown).toContain('The sender shortened the Slack message');
    });

    it('hikyac.reply null is accepted', async () => {
      const content = await deliver(v2Body({ message: 'hello' }, { reply: null }));
      expect(content.summary).toBe('hello');
    });

    it('unknown extra keys at every level are accepted and reach nothing', async () => {
      const content = await deliver(v2Body({ extra_top: 'EXTRA-TOP' }, { extra_h: 'EXTRA-H', thread_key: 'th_1' }, { extra_s: 'EXTRA-S', ids: { channel: 'C1', ts: '1.2', extra_i: 'EXTRA-I' } }));
      for (const marker of ['EXTRA-TOP', 'EXTRA-H', 'EXTRA-S', 'EXTRA-I', 'th_1']) expect(JSON.stringify(content)).not.toContain(marker);
    });
  });

  it('(T4) a source of another type delivers the message, permalink and files only', async () => {
    const body = v2Body(
      { message: 'hello' },
      { permalink: PERMALINK, files: [{ name: 'one.png', mimetype: 'image/png', size: 3, url: FILE_URL }] },
      { type: 'other', ids: { channel: 'C-IGNORED', ts: '9.9' }, event: SECTION_EVENT, truncated: true },
    );
    const content = await deliver(body);
    expect(content.bodyMarkdown).toContain('hello');
    expect(content.bodyMarkdown).toContain(`- Permalink: ${PERMALINK}`);
    expect(content.bodyMarkdown).toContain('- attachments/one.png');
    for (const absent of ['Channel', 'Timestamp', 'App ID', 'Bot ID', '## Content', 'BLOCK-MARKER', 'C-IGNORED', 'sender shortened']) {
      expect(content.bodyMarkdown).not.toContain(absent);
    }
    const bare = await deliver({ ...v2Body({}, { permalink: PERMALINK }), source: { type: 'other' } });
    expect(bare.bodyMarkdown).toContain(`- Permalink: ${PERMALINK}`);
    expect(bare.bodyMarkdown).not.toContain('Channel');
  });

  it('(T8) a human-mention-shaped body is byte-identical to the body without a source event', async () => {
    const bodyOf = (event: Record<string, unknown> | null) => v2Body({ message: 'hello' }, { permalink: PERMALINK }, { ids: IDS, event });
    const plain = await deliver(bodyOf(null));
    const v2 = await deliver(bodyOf({ blocks: [{ type: 'rich_text', elements: [] }] }));
    expect(v2.bodyMarkdown).toBe(plain.bodyMarkdown);
    expect(v2.bodyMarkdown).toContain('## Details');
    expect(v2.bodyMarkdown).not.toContain('## Content');
  });

  describe('the reply address and refusals at receiveInboundWebhook', () => {
    const MARK = 'REPLY-MARKER-7f3a';
    const SECRET = VECTOR_SECRET;
    const signedInput = (body: unknown, webhookId: string): ReceiveInput => {
      const rawBody = JSON.stringify(body);
      const timestamp = String(NOW_SECONDS);
      return { endpointId: 'ep-1', rawBody, webhookId, timestamp, signature: sign(SECRET, webhookId, timestamp, rawBody) };
    };
    const deps = () => ({ endpoints, db, jobQueue, now: () => NOW });
    const rows = async () => ({
      deliveries: await db.selectFrom('inbound_webhook_deliveries').selectAll().execute(),
      jobs: await db.selectFrom('jobs').selectAll().execute(),
    });

    it('(T6) the reply address in a version 2 body reaches no content field and no log call', async () => {
      const body = v2Body({}, { reply: { url: `https://sender.example.com/webhook/reply/${MARK}` } }, { event: SECTION_EVENT });
      const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) => spyOn(rootLogger, level));
      try {
        expect(await receiveInboundWebhook(signedInput(body, 'Ev1'), deps())).toEqual({ kind: 'accepted' });
        const stored = (await rows()).jobs[0]?.payload ?? '';
        // Controls: the body really carries the marker, and the spies really saw the projection record.
        expect(stored).toContain(MARK);
        const content = await prepareDelivery(payloadOf(body), { endpoints, attachmentFetch: stubFetch });
        expect(spies.some((spy) => spy.mock.calls.some((call) => call.includes('Slack content projected')))).toBe(true);

        for (const field of [content.bodyMarkdown, content.summary, content.url ?? '']) expect(field).not.toContain(MARK);
        const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
        expect(logged).not.toContain(MARK);
        expect(logged).not.toContain('sender.example.com');
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });

    it('(T7) a signed schema_version 3 body is refused with no row and no job, against a version 2 positive control', async () => {
      const warn = spyOn(rootLogger, 'warn');
      try {
        const refused = await receiveInboundWebhook(signedInput({ ...v2Body(), schema_version: 3 }, 'Ev3'), deps());
        expect(refused).toEqual({ kind: 'invalid_request' });
        expect(await rows()).toEqual({ deliveries: [], jobs: [] });
        const record = warn.mock.calls.find((call) => call.includes('Inbound webhook refused'));
        expect(record?.[0]).toEqual({ endpointId: 'ep-1', reason: 'unsupported-schema-version', schemaVersion: 3 });

        const accepted = await receiveInboundWebhook(signedInput(v2Body(), 'Ev2'), deps());
        expect(accepted).toEqual({ kind: 'accepted' });
        const after = await rows();
        expect(after.deliveries.map((d) => d.webhook_id)).toEqual(['Ev2']);
        expect(after.jobs).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('a non-number schema_version is refused as unsupported and the value is never logged', async () => {
      const warn = spyOn(rootLogger, 'warn');
      try {
        const refused = await receiveInboundWebhook(signedInput({ ...v2Body(), schema_version: 'SECRET-VERSION-TEXT' }, 'EvS'), deps());
        expect(refused).toEqual({ kind: 'invalid_request' });
        const record = warn.mock.calls.find((call) => call.includes('Inbound webhook refused'));
        expect(record?.[0]).toEqual({ endpointId: 'ep-1', reason: 'unsupported-schema-version' });
        expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET-VERSION-TEXT');
      } finally {
        warn.mockRestore();
      }
    });

    it('a malformed version 2 body is refused as an invalid request', async () => {
      const warn = spyOn(rootLogger, 'warn');
      try {
        const refused = await receiveInboundWebhook(signedInput(v2With(['hikyac']), 'EvM'), deps());
        expect(refused).toEqual({ kind: 'invalid_request' });
        const record = warn.mock.calls.find((call) => call.includes('Inbound webhook refused'));
        expect(record?.[0]).toEqual({ endpointId: 'ep-1', reason: 'invalid-request' });
        expect(await rows()).toEqual({ deliveries: [], jobs: [] });
      } finally {
        warn.mockRestore();
      }
    });

    it('prepareDelivery throws PermanentHandlerError when the stored payload does not parse', async () => {
      await expect(prepareDelivery(payloadOf({ ...v2Body(), schema_version: 3 }), { endpoints })).rejects.toBeInstanceOf(PermanentHandlerError);
    });
  });
});
