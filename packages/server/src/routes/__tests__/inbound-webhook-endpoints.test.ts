/**
 * Sibling test for the inbound webhook endpoint management routes: real in-memory sqlite DB,
 * production layering (appContext -> authMiddleware -> route).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, type Mock } from 'bun:test';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import * as v from 'valibot';
import {
  InboundWebhookEndpointResponseSchema,
  InboundWebhookEndpointWithSecretResponseSchema,
  InboundWebhookEndpointsListResponseSchema,
  type AuthUser,
} from '@agent-console/shared';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteInboundWebhookEndpointRepository } from '../../repositories/sqlite-inbound-webhook-endpoint-repository.js';
import type { InboundWebhookEndpointRepository } from '../../repositories/webhook-endpoint-repository.js';
import { inboundWebhookEndpoints } from '../inbound-webhook-endpoints.js';
import { authMiddleware } from '../../middleware/auth.js';
import { onApiError } from '../../lib/error-handler.js';
import { rootLogger } from '../../lib/logger.js';
import type { AppBindings, AppContext } from '../../app-context.js';
import type { UserMode, PtySpawnRequest } from '../../services/user-mode.js';
import type { PtyInstance } from '../../lib/pty-provider.js';
import type { RepositoryManager } from '../../services/repository-manager.js';

const ALICE: AuthUser = { id: 'alice-1', username: 'alice', homeDir: '/home/alice' };
const REPO_ID = 'repo-1';
const OTHER_REPO_ID = 'repo-2';
const DAY_MS = 24 * 60 * 60 * 1000;

const KNOWN_REPOSITORIES = new Set([REPO_ID, OTHER_REPO_ID]);
const stubRepositoryManager = {
  getRepository: (id: string) => (KNOWN_REPOSITORIES.has(id) ? { id } : undefined),
} as Pick<RepositoryManager, 'getRepository'> as RepositoryManager;

function mockUserMode(user: AuthUser | null): UserMode {
  return {
    authenticate: () => user,
    login: async () => null,
    spawnPty: (_request: PtySpawnRequest): PtyInstance => {
      throw new Error('spawnPty not implemented in mock');
    },
  };
}

function buildApp(repository: InboundWebhookEndpointRepository, user: AuthUser | null): Hono<AppBindings> {
  const partialContext: Partial<AppContext> = {
    inboundWebhookEndpointRepository: repository,
    repositoryManager: stubRepositoryManager,
    userMode: mockUserMode(user),
  };
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('appContext', partialContext as AppContext);
    await next();
  });
  app.use('*', authMiddleware);
  app.onError(onApiError);
  app.route('/api/inbound-webhook-endpoints', inboundWebhookEndpoints);
  return app;
}

function json(method: string, body?: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) };
}

const VALID_CREATE = { label: 'Slack', repositoryId: REPO_ID, instructionText: 'Run the triage skill' };

type WithSecret = v.InferOutput<typeof InboundWebhookEndpointWithSecretResponseSchema>;

describe('Inbound webhook endpoint routes', () => {
  let db: Kysely<Database>;
  let repository: SqliteInboundWebhookEndpointRepository;
  let app: Hono<AppBindings>;

  beforeEach(async () => {
    db = await createDatabaseForTest();
    for (const id of KNOWN_REPOSITORIES) {
      await db.insertInto('repositories').values({ id, name: id, path: `/tmp/${id}` }).execute();
    }
    repository = new SqliteInboundWebhookEndpointRepository(db);
    app = buildApp(repository, ALICE);
  });

  afterEach(async () => {
    await db.destroy();
  });

  const base = '/api/inbound-webhook-endpoints';

  async function create(body: Record<string, unknown> = VALID_CREATE): Promise<WithSecret> {
    const res = await app.request(base, json('POST', body));
    expect(res.status).toBe(201);
    return v.parse(InboundWebhookEndpointWithSecretResponseSchema, await res.json());
  }

  async function storedRow(id: string) {
    return db.selectFrom('inbound_webhook_endpoints').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  }

  describe('authentication', () => {
    it('rejects an unauthenticated request on every route', async () => {
      const unauthenticated = buildApp(repository, null);
      expect((await unauthenticated.request(base)).status).toBe(401);
      expect((await unauthenticated.request(`${base}/x`)).status).toBe(401);
      expect((await unauthenticated.request(base, json('POST', VALID_CREATE))).status).toBe(401);
      expect((await unauthenticated.request(`${base}/x`, json('PATCH', { label: 'y' }))).status).toBe(401);
      expect((await unauthenticated.request(`${base}/x`, json('DELETE'))).status).toBe(401);
      expect((await unauthenticated.request(`${base}/x/rotate-secret`, json('POST'))).status).toBe(401);
      expect((await unauthenticated.request(`${base}/x/clear-previous-secret`, json('POST'))).status).toBe(401);
      expect(await repository.list()).toEqual([]);
    });
  });

  describe('POST / (create)', () => {
    it('returns 201 with the endpoint and a whsec_ secret that decodes to 32 bytes', async () => {
      const { endpoint, secret } = await create();

      expect(endpoint).toMatchObject({
        label: 'Slack',
        repositoryId: REPO_ID,
        instructionText: 'Run the triage skill',
        hasPreviousSecret: false,
        previousSecretExpiresAt: null,
      });
      expect(endpoint.id.length).toBeGreaterThan(0);
      expect(secret.startsWith('whsec_')).toBe(true);
      expect(Buffer.from(secret.slice('whsec_'.length), 'base64').length).toBe(32);
      expect((await storedRow(endpoint.id)).secret).toBe(secret);
    });

    it('response keys carry the secret only at the top level, never inside the endpoint', async () => {
      const res = await app.request(base, json('POST', VALID_CREATE));
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['endpoint', 'secret']);
      expect(Object.keys(body.endpoint as object)).not.toContain('secret');
      expect(Object.keys(body.endpoint as object)).not.toContain('previousSecret');
    });

    it('trims the label', async () => {
      const { endpoint } = await create({ ...VALID_CREATE, label: '  Slack  ' });
      expect(endpoint.label).toBe('Slack');
    });

    it('refuses a missing repositoryId with 400 and writes nothing', async () => {
      const res = await app.request(base, json('POST', { label: 'Slack', instructionText: 'x' }));
      expect(res.status).toBe(400);
      expect(await repository.list()).toEqual([]);
    });

    it('refuses an unknown repositoryId with 404 and writes nothing', async () => {
      const res = await app.request(base, json('POST', { ...VALID_CREATE, repositoryId: 'no-such-repo' }));
      expect(res.status).toBe(404);
      expect(await repository.list()).toEqual([]);
    });

    it('refuses an empty or blank label, an over-long label, and unknown keys', async () => {
      for (const body of [
        { ...VALID_CREATE, label: '' },
        { ...VALID_CREATE, label: '   ' },
        { ...VALID_CREATE, label: 'x'.repeat(101) },
        { ...VALID_CREATE, secret: 'whsec_mine' },
      ]) {
        expect((await app.request(base, json('POST', body))).status).toBe(400);
      }
      expect(await repository.list()).toEqual([]);
    });

    it('accepts a 100-char label', async () => {
      const { endpoint } = await create({ ...VALID_CREATE, label: 'x'.repeat(100) });
      expect(endpoint.label).toHaveLength(100);
    });
  });

  describe('instructionText validation (the database CHECK is never reached)', () => {
    let createSpy: Mock<InboundWebhookEndpointRepository['create']>;
    let updateSpy: Mock<InboundWebhookEndpointRepository['update']>;

    beforeEach(() => {
      createSpy = spyOn(repository, 'create');
      updateSpy = spyOn(repository, 'update');
    });

    const REFUSED: Array<[string, string]> = [
      ['an LF', 'two\nlines'],
      ['a CR', 'two\rlines'],
      ['a trailing LF', 'one line\n'],
      ['a CRLF', 'a\r\nb'],
      ['301 characters', 'x'.repeat(301)],
      ['an empty string', ''],
      ['only whitespace', '   '],
    ];

    for (const [name, instructionText] of REFUSED) {
      it(`create refuses ${name} with 400 before the repository is called`, async () => {
        const res = await app.request(base, json('POST', { ...VALID_CREATE, instructionText }));
        expect(res.status).toBe(400);
        expect(createSpy).not.toHaveBeenCalled();
        expect(await repository.list()).toEqual([]);
      });

      it(`update refuses ${name} with 400 before the repository is called`, async () => {
        const { endpoint } = await create();
        const res = await app.request(`${base}/${endpoint.id}`, json('PATCH', { instructionText }));
        expect(res.status).toBe(400);
        expect(updateSpy).not.toHaveBeenCalled();
        expect((await storedRow(endpoint.id)).instruction_text).toBe(VALID_CREATE.instructionText);
      });
    }

    it('accepts exactly 300 characters, and keeps interior whitespace and tabs as written', async () => {
      const { endpoint } = await create({ ...VALID_CREATE, instructionText: 'x'.repeat(300) });
      expect(endpoint.instructionText).toHaveLength(300);
      const tabbed = await create({ ...VALID_CREATE, instructionText: 'use\tthe  skill' });
      expect(tabbed.endpoint.instructionText).toBe('use\tthe  skill');
    });
  });

  describe('GET / and GET /:id never expose a secret', () => {
    it('list and get bodies contain neither the field names nor the secret values (raw text)', async () => {
      const created = await create();
      const rotated = await app.request(`${base}/${created.endpoint.id}/rotate-secret`, json('POST'));
      const { secret: currentSecret } = v.parse(InboundWebhookEndpointWithSecretResponseSchema, await rotated.json());
      const previousSecret = created.secret;

      const listText = await (await app.request(base)).text();
      const getText = await (await app.request(`${base}/${created.endpoint.id}`)).text();

      for (const text of [listText, getText]) {
        expect(text).not.toContain('secret');
        expect(text).not.toContain('previous_secret');
        expect(text).not.toContain(currentSecret);
        expect(text).not.toContain(previousSecret);
        expect(text).not.toContain('whsec_');
      }
      // the only previous-secret signal is the derived boolean
      expect(v.parse(InboundWebhookEndpointsListResponseSchema, JSON.parse(listText)).endpoints[0]!.hasPreviousSecret).toBe(true);
    });

    it('update, clear-previous responses carry no secret either', async () => {
      const created = await create();
      await app.request(`${base}/${created.endpoint.id}/rotate-secret`, json('POST'));
      const patchText = await (await app.request(`${base}/${created.endpoint.id}`, json('PATCH', { label: 'renamed' }))).text();
      const clearText = await (await app.request(`${base}/${created.endpoint.id}/clear-previous-secret`, json('POST'))).text();
      for (const text of [patchText, clearText]) {
        expect(text).not.toContain('secret');
        expect(text).not.toContain('whsec_');
      }
    });

    it('list is empty on a fresh database and lists every endpoint otherwise', async () => {
      const empty = v.parse(InboundWebhookEndpointsListResponseSchema, await (await app.request(base)).json());
      expect(empty.endpoints).toEqual([]);
      const a = await create();
      const b = await create({ ...VALID_CREATE, repositoryId: OTHER_REPO_ID });
      const listed = v.parse(InboundWebhookEndpointsListResponseSchema, await (await app.request(base)).json());
      expect(listed.endpoints.map((e) => e.id).sort()).toEqual([a.endpoint.id, b.endpoint.id].sort());
    });

    it('get returns the endpoint', async () => {
      const created = await create();
      const res = await app.request(`${base}/${created.endpoint.id}`);
      expect(res.status).toBe(200);
      expect(v.parse(InboundWebhookEndpointResponseSchema, await res.json()).endpoint).toEqual(created.endpoint);
    });
  });

  describe('PATCH /:id', () => {
    it('changes label and instruction text, touches updated_at, and cannot change the secret or repository', async () => {
      const created = await create();
      const before = await storedRow(created.endpoint.id);

      const res = await app.request(
        `${base}/${created.endpoint.id}`,
        json('PATCH', { label: 'Renamed', instructionText: 'New instruction' }),
      );
      expect(res.status).toBe(200);
      const { endpoint } = v.parse(InboundWebhookEndpointResponseSchema, await res.json());
      expect(endpoint).toMatchObject({ label: 'Renamed', instructionText: 'New instruction', repositoryId: REPO_ID });

      const after = await storedRow(created.endpoint.id);
      expect(after.secret).toBe(before.secret);
      expect(after.previous_secret).toBe(before.previous_secret);
      expect(after.repository_id).toBe(REPO_ID);
      expect(after.created_at).toBe(before.created_at);
      expect(after.updated_at >= before.updated_at).toBe(true);
    });

    it('refuses secret, previousSecret and repositoryId in the body with 400 and changes nothing', async () => {
      const created = await create();
      for (const body of [
        { label: 'x', secret: 'whsec_mine' },
        { label: 'x', previousSecret: 'whsec_mine' },
        { label: 'x', repositoryId: OTHER_REPO_ID },
      ]) {
        expect((await app.request(`${base}/${created.endpoint.id}`, json('PATCH', body))).status).toBe(400);
      }
      const row = await storedRow(created.endpoint.id);
      expect(row).toMatchObject({ label: 'Slack', secret: created.secret, repository_id: REPO_ID });
    });

    it('refuses an empty body and a blank label with 400', async () => {
      const created = await create();
      expect((await app.request(`${base}/${created.endpoint.id}`, json('PATCH', {}))).status).toBe(400);
      expect((await app.request(`${base}/${created.endpoint.id}`, json('PATCH', { label: '  ' }))).status).toBe(400);
    });
  });

  describe('POST /:id/rotate-secret', () => {
    it('moves current to previous with a 24h expiry and returns the new secret', async () => {
      const created = await create();
      const beforeMs = Date.now();
      const res = await app.request(`${base}/${created.endpoint.id}/rotate-secret`, json('POST'));
      const afterMs = Date.now();
      expect(res.status).toBe(200);
      const rotated = v.parse(InboundWebhookEndpointWithSecretResponseSchema, await res.json());

      expect(rotated.secret).not.toBe(created.secret);
      expect(rotated.secret.startsWith('whsec_')).toBe(true);
      expect(Buffer.from(rotated.secret.slice('whsec_'.length), 'base64').length).toBe(32);

      const row = await storedRow(created.endpoint.id);
      expect(row.secret).toBe(rotated.secret);
      expect(row.previous_secret).toBe(created.secret);
      const expiresMs = Date.parse(row.previous_secret_expires_at!);
      expect(expiresMs).toBeGreaterThanOrEqual(beforeMs + DAY_MS);
      expect(expiresMs).toBeLessThanOrEqual(afterMs + DAY_MS);

      expect(rotated.endpoint).toMatchObject({ hasPreviousSecret: true, previousSecretExpiresAt: row.previous_secret_expires_at });
      expect(Date.parse(row.updated_at)).toBeGreaterThanOrEqual(beforeMs);
    });

    it('rotating twice replaces the previous secret with the then-current one', async () => {
      const created = await create();
      const first = v.parse(
        InboundWebhookEndpointWithSecretResponseSchema,
        await (await app.request(`${base}/${created.endpoint.id}/rotate-secret`, json('POST'))).json(),
      );
      const second = v.parse(
        InboundWebhookEndpointWithSecretResponseSchema,
        await (await app.request(`${base}/${created.endpoint.id}/rotate-secret`, json('POST'))).json(),
      );

      const row = await storedRow(created.endpoint.id);
      expect(row.secret).toBe(second.secret);
      expect(row.previous_secret).toBe(first.secret);
      expect(new Set([created.secret, first.secret, second.secret]).size).toBe(3);
    });

    it('an expired previous secret reads as absent', async () => {
      const created = await create();
      await app.request(`${base}/${created.endpoint.id}/rotate-secret`, json('POST'));
      await db
        .updateTable('inbound_webhook_endpoints')
        .set({ previous_secret_expires_at: new Date(Date.now() - 1000).toISOString() })
        .where('id', '=', created.endpoint.id)
        .execute();

      const { endpoint } = v.parse(
        InboundWebhookEndpointResponseSchema,
        await (await app.request(`${base}/${created.endpoint.id}`)).json(),
      );
      expect(endpoint).toMatchObject({ hasPreviousSecret: false, previousSecretExpiresAt: null });
    });
  });

  describe('POST /:id/clear-previous-secret', () => {
    it('nulls both previous columns and keeps the current secret', async () => {
      const created = await create();
      const rotated = v.parse(
        InboundWebhookEndpointWithSecretResponseSchema,
        await (await app.request(`${base}/${created.endpoint.id}/rotate-secret`, json('POST'))).json(),
      );

      const res = await app.request(`${base}/${created.endpoint.id}/clear-previous-secret`, json('POST'));
      expect(res.status).toBe(200);
      expect(v.parse(InboundWebhookEndpointResponseSchema, await res.json()).endpoint).toMatchObject({
        hasPreviousSecret: false,
        previousSecretExpiresAt: null,
      });

      const row = await storedRow(created.endpoint.id);
      expect(row.previous_secret).toBeNull();
      expect(row.previous_secret_expires_at).toBeNull();
      expect(row.secret).toBe(rotated.secret);
    });
  });

  describe('DELETE /:id', () => {
    it('removes the row and cascades its deliveries, leaving other endpoints', async () => {
      const doomed = await create();
      const kept = await create();
      await db
        .insertInto('inbound_webhook_deliveries')
        .values([
          { endpoint_id: doomed.endpoint.id, webhook_id: 'w1', received_at: '2026-11-07T00:00:00.000Z' },
          { endpoint_id: kept.endpoint.id, webhook_id: 'w1', received_at: '2026-11-07T00:00:00.000Z' },
        ])
        .execute();

      const res = await app.request(`${base}/${doomed.endpoint.id}`, json('DELETE'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });

      expect(await repository.findById(doomed.endpoint.id)).toBeNull();
      expect((await db.selectFrom('inbound_webhook_deliveries').select('endpoint_id').execute()).map((r) => r.endpoint_id)).toEqual([
        kept.endpoint.id,
      ]);
    });
  });

  describe('unknown id is 404', () => {
    it('get, update, delete, rotate and clear-previous', async () => {
      const responses = await Promise.all([
        app.request(`${base}/ghost`),
        app.request(`${base}/ghost`, json('PATCH', { label: 'x' })),
        app.request(`${base}/ghost`, json('DELETE')),
        app.request(`${base}/ghost/rotate-secret`, json('POST')),
        app.request(`${base}/ghost/clear-previous-secret`, json('POST')),
      ]);
      expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
    });
  });

  describe('repository deletion', () => {
    it('deleting the repository removes its endpoint', async () => {
      const created = await create();
      await db.deleteFrom('repositories').where('id', '=', REPO_ID).execute();
      expect((await app.request(`${base}/${created.endpoint.id}`)).status).toBe(404);
    });
  });

  describe('logging', () => {
    it('no log call during create, rotate, update, clear or delete carries a secret', async () => {
      const spies = (['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const).map((level) => spyOn(rootLogger, level));
      try {
        const created = await create();
        const rotated = v.parse(
          InboundWebhookEndpointWithSecretResponseSchema,
          await (await app.request(`${base}/${created.endpoint.id}/rotate-secret`, json('POST'))).json(),
        );
        await app.request(`${base}/${created.endpoint.id}`, json('PATCH', { label: 'renamed' }));
        await app.request(`${base}/${created.endpoint.id}/clear-previous-secret`, json('POST'));
        await app.request(`${base}/${created.endpoint.id}`, json('DELETE'));

        const calls = spies.flatMap((spy) => spy.mock.calls);
        // Positive control: the routes and the repository do log, so an empty list would be a blind spy.
        expect(calls.length).toBeGreaterThan(0);
        const logged = JSON.stringify(calls);
        expect(logged).not.toContain(created.secret);
        expect(logged).not.toContain(rotated.secret);
        expect(logged).not.toContain('whsec_');
        expect(logged).toContain(created.endpoint.id);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  });
});
