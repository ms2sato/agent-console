/**
 * POST /webhooks/in/:endpointId: one case per row of the response-code table, the log-content
 * guarantees and the body limit. Real in-memory database and real job queue (not started).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { JobQueue } from '../../jobs/index.js';
import { rootLogger } from '../../lib/logger.js';
import { SqliteInboundWebhookEndpointRepository } from '../../repositories/sqlite-inbound-webhook-endpoint-repository.js';
import { INBOUND_WEBHOOK_MAX_BODY_BYTES } from '../../services/inbound-webhook/receive.js';
import type { AppBindings, AppContext } from '../../app-context.js';
import { webhooks } from '../webhooks.js';

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const NOW = new Date('2023-11-14T22:13:20.000Z');
const NOW_SECONDS = 1700000000;
const BODY_SENTINEL = 'BODY-SENTINEL-7f3a';
const BODY = JSON.stringify({ schema_version: 1, message: `hello ${BODY_SENTINEL}` });

function signature(id: string, ts: string | number, body: string, secret = SECRET): string {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
}

/** JSON.stringify drops an Error's fields; keep them so assertions see what pino would serialize. */
function serialize(calls: unknown[]): string {
  return JSON.stringify(calls, (_key, value: unknown) =>
    value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value,
  );
}

describe('POST /webhooks/in/:endpointId', () => {
  let db: Kysely<Database>;
  let jobQueue: JobQueue;
  let endpoints: SqliteInboundWebhookEndpointRepository;
  let app: Hono<AppBindings>;

  const post = (
    endpointId: string,
    over: { id?: string | null; ts?: string | null; sig?: string | null; body?: string } = {},
  ) => {
    const body = over.body ?? BODY;
    const id = over.id === undefined ? 'Ev1' : over.id;
    const ts = over.ts === undefined ? String(NOW_SECONDS) : over.ts;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (id !== null) headers['webhook-id'] = id;
    if (ts !== null) headers['webhook-timestamp'] = ts;
    const sig = over.sig === undefined ? signature(id ?? '', ts ?? '', body) : over.sig;
    if (sig !== null) headers['webhook-signature'] = sig;
    return app.request(`/webhooks/in/${endpointId}`, { method: 'POST', body, headers });
  };
  const counts = async () => ({
    deliveries: (await db.selectFrom('inbound_webhook_deliveries').selectAll().execute()).length,
    jobs: (await db.selectFrom('jobs').selectAll().execute()).length,
  });

  beforeEach(async () => {
    db = await createDatabaseForTest();
    await db.insertInto('repositories').values({ id: 'repo-1', name: 'r', path: '/tmp/r' }).execute();
    endpoints = new SqliteInboundWebhookEndpointRepository(db);
    await endpoints.create({
      id: 'ep-1',
      label: 'Slack',
      repositoryId: 'repo-1',
      instructionText: 'x',
      secret: SECRET,
      now: '2026-11-07T00:00:00.000Z',
    });
    jobQueue = new JobQueue(db, { concurrency: 1 });
    const context: Partial<AppContext> = {
      db,
      jobQueue,
      inboundWebhookEndpointRepository: endpoints,
      now: () => NOW,
    };
    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', context as AppContext);
      await next();
    });
    app.route('/webhooks', webhooks);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('200 accepted: enqueues one job', async () => {
    const res = await post('ep-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await counts()).toEqual({ deliveries: 1, jobs: 1 });
  });

  it('200 duplicate: no second job', async () => {
    await post('ep-1');
    const res = await post('ep-1', { ts: String(NOW_SECONDS + 1) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    expect(await counts()).toEqual({ deliveries: 1, jobs: 1 });
  });

  it('404 unknown endpoint: JSON, nothing else', async () => {
    const res = await post('does-not-exist');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not Found' });
    expect(await counts()).toEqual({ deliveries: 0, jobs: 0 });
  });

  it('401 bad signature', async () => {
    const res = await post('ep-1', { sig: signature('Ev1', NOW_SECONDS, BODY, 'whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA') });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(await counts()).toEqual({ deliveries: 0, jobs: 0 });
  });

  it('401 missing signature header', async () => {
    expect((await post('ep-1', { sig: null })).status).toBe(401);
  });

  it('401 stale timestamp (301 s) but 200 at exactly 300 s', async () => {
    expect((await post('ep-1', { ts: String(NOW_SECONDS - 301) })).status).toBe(401);
    expect((await post('ep-1', { ts: String(NOW_SECONDS - 300) })).status).toBe(200);
  });

  it('400 invalid webhook-id and 400 malformed body, both leave no row', async () => {
    expect((await post('ep-1', { id: '../x' })).status).toBe(400);
    expect((await post('ep-1', { body: '{"message":5}' })).status).toBe(400);
    expect((await post('ep-1', { body: 'not json' })).status).toBe(400);
    expect(await counts()).toEqual({ deliveries: 0, jobs: 0 });
  });

  it('503 when the transaction fails, then the same webhook-id is accepted', async () => {
    spyOn(jobQueue, 'enqueue').mockRejectedValueOnce(new Error('disk full'));
    const failed = await post('ep-1');
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'Service Unavailable' });
    expect(await counts()).toEqual({ deliveries: 0, jobs: 0 });
    expect((await post('ep-1')).status).toBe(200);
  });

  it('500 JSON for an unhandled exception, not 200', async () => {
    spyOn(endpoints, 'findWithSecretById').mockRejectedValueOnce(new Error('db exploded'));
    const res = await post('ep-1');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal Server Error' });
  });

  it('413 above the body limit, with a JSON error and no row; a body just under it passes the limit', async () => {
    const filler = 'x'.repeat(INBOUND_WEBHOOK_MAX_BODY_BYTES + 1);
    const res = await app.request('/webhooks/in/ep-1', { method: 'POST', body: filler });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Payload Too Large' });
    expect(await counts()).toEqual({ deliveries: 0, jobs: 0 });

    const withLength = await app.request('/webhooks/in/ep-1', {
      method: 'POST',
      body: filler,
      headers: { 'Content-Length': String(filler.length) },
    });
    expect(withLength.status).toBe(413);
    expect(await counts()).toEqual({ deliveries: 0, jobs: 0 });

    const underBody = JSON.stringify({ message: 'x'.repeat(INBOUND_WEBHOOK_MAX_BODY_BYTES - 100) });
    expect((await post('ep-1', { body: underBody })).status).toBe(200);
  });

  it('answers 405 with Allow: POST to a GET', async () => {
    const res = await app.request('/webhooks/in/ep-1');
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
  });

  describe('logging', () => {
    const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

    const assertClean = (logged: string, extraForbidden: string[] = []) => {
      expect(logged).not.toContain('rawPayload');
      expect(logged).not.toContain(BODY_SENTINEL);
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain(SECRET.slice('whsec_'.length));
      for (const forbidden of extraForbidden) expect(logged).not.toContain(forbidden);
    };

    it('a forced enqueue failure logs endpointId, webhookId and the error, never the body', async () => {
      const spies = LEVELS.map((level) => spyOn(rootLogger, level));
      try {
        spyOn(jobQueue, 'enqueue').mockRejectedValueOnce(new Error('disk full'));
        const sig = signature('Ev-log', NOW_SECONDS, BODY);
        const res = await post('ep-1', { id: 'Ev-log', sig });
        expect(res.status).toBe(503);
        const calls = spies.flatMap((spy) => spy.mock.calls);
        const logged = serialize(calls);
        expect(calls.length).toBeGreaterThan(0); // positive control: the spies saw the failure
        expect(logged).toContain('ep-1');
        expect(logged).toContain('Ev-log');
        expect(logged).toContain('disk full');
        assertClean(logged, [sig]);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });

    it('a forced 500 logs endpointId, webhookId and the error, never the body', async () => {
      const spies = LEVELS.map((level) => spyOn(rootLogger, level));
      try {
        spyOn(endpoints, 'findWithSecretById').mockRejectedValueOnce(new Error('db exploded'));
        const sig = signature('Ev-500', NOW_SECONDS, BODY);
        const res = await post('ep-1', { id: 'Ev-500', sig });
        expect(res.status).toBe(500);
        const calls = spies.flatMap((spy) => spy.mock.calls);
        const logged = serialize(calls);
        expect(calls.length).toBeGreaterThan(0);
        expect(logged).toContain('ep-1');
        expect(logged).toContain('Ev-500');
        expect(logged).toContain('db exploded');
        assertClean(logged, [sig]);
        expect(await res.text()).not.toContain('db exploded');
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });

    it('refusals (401, 400) and a success log neither the secret, the signature header nor the body', async () => {
      const spies = LEVELS.map((level) => spyOn(rootLogger, level));
      try {
        const goodSig = signature('Ev1', NOW_SECONDS, BODY);
        const badSig = signature('Ev1', NOW_SECONDS, BODY, 'whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
        await post('ep-1', { sig: badSig });
        await post('ep-1', { id: '../x' });
        await post('ep-1', { body: `{"message":5,"k":"${BODY_SENTINEL}"}` });
        await post('ep-1');
        const calls = spies.flatMap((spy) => spy.mock.calls);
        const logged = serialize(calls);
        expect(logged).toContain('Inbound webhook refused'); // positive control
        assertClean(logged, [goodSig, badSig]);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  });
});
