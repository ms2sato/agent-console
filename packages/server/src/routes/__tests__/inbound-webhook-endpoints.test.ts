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
  app.route('/api/repositories', inboundWebhookEndpoints);
  return app;
}

function json(method: string, body?: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) };
}

const VALID_CREATE = { label: 'Slack', instructionText: 'Run the triage skill' };

type WithSecret = v.InferOutput<typeof InboundWebhookEndpointWithSecretResponseSchema>;
type Generated = Extract<WithSecret, { secretSource: 'generated' }>;
type Entered = Extract<WithSecret, { secretSource: 'entered' }>;

/** `whsec_` plus base64 of `bytes` filler bytes (canonical by construction). */
function secretOfBytes(bytes: number, fill = 9): string {
  return `whsec_${Buffer.alloc(bytes, fill).toString('base64')}`;
}

/**
 * A secret that lax base64 decoders accept but that is not canonical: the last data character
 * carries non-zero trailing bits, so decoding and re-encoding gives a different string.
 */
function nonCanonicalSecret(): string {
  const canonical = secretOfBytes(32);
  const lastData = canonical.length - 2; // 32 bytes encode with a single trailing '='
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bumped = alphabet[alphabet.indexOf(canonical[lastData]!) + 1]!;
  return canonical.slice(0, lastData) + bumped + canonical.slice(lastData + 1);
}

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

  const baseOf = (repositoryId: string) => `/api/repositories/${repositoryId}/inbound-webhook-endpoints`;
  const base = baseOf(REPO_ID);

  async function create(body: Record<string, unknown> = VALID_CREATE, repositoryId = REPO_ID): Promise<Generated> {
    const res = await app.request(baseOf(repositoryId), json('POST', body));
    expect(res.status).toBe(201);
    const parsed = v.parse(InboundWebhookEndpointWithSecretResponseSchema, await res.json());
    if (parsed.secretSource !== 'generated') throw new Error('expected a generated secret');
    return parsed;
  }

  async function rotate(id: string, body?: Record<string, unknown>, repositoryId = REPO_ID): Promise<Generated> {
    const res = await app.request(`${baseOf(repositoryId)}/${id}/rotate-secret`, json('POST', body));
    expect(res.status).toBe(200);
    const parsed = v.parse(InboundWebhookEndpointWithSecretResponseSchema, await res.json());
    if (parsed.secretSource !== 'generated') throw new Error('expected a generated secret');
    return parsed;
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
      expect(await repository.list(REPO_ID)).toEqual([]);
    });
  });

  describe('the old global mount is gone', () => {
    it('/api/inbound-webhook-endpoints is not served', async () => {
      expect((await app.request('/api/inbound-webhook-endpoints')).status).toBe(404);
    });
  });

  describe('unknown repository', () => {
    it('list and create answer 404 and write nothing', async () => {
      const createSpy = spyOn(repository, 'create');
      const listSpy = spyOn(repository, 'list');
      const unknown = baseOf('no-such-repo');

      const listRes = await app.request(unknown);
      expect(listRes.status).toBe(404);
      expect(((await listRes.json()) as { error: string }).error).toContain('Repository');
      expect(listSpy).not.toHaveBeenCalled();

      const createRes = await app.request(unknown, json('POST', VALID_CREATE));
      expect(createRes.status).toBe(404);
      expect(createSpy).not.toHaveBeenCalled();
      expect(await db.selectFrom('inbound_webhook_endpoints').selectAll().execute()).toEqual([]);
    });
  });

  describe('POST / (create)', () => {
    it('returns 201 with the endpoint and a generated whsec_ secret that decodes to 32 bytes', async () => {
      const { endpoint, secret, secretSource } = await create();

      expect(secretSource).toBe('generated');
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

    it('a generated-secret response has exactly the keys endpoint, secretSource and secret', async () => {
      const res = await app.request(base, json('POST', VALID_CREATE));
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['endpoint', 'secret', 'secretSource']);
      expect(Object.keys(body.endpoint as object)).not.toContain('secret');
      expect(Object.keys(body.endpoint as object)).not.toContain('previousSecret');
    });

    it('binds the endpoint to the repository in the path', async () => {
      const { endpoint } = await create(VALID_CREATE, OTHER_REPO_ID);
      expect(endpoint.repositoryId).toBe(OTHER_REPO_ID);
      expect((await storedRow(endpoint.id)).repository_id).toBe(OTHER_REPO_ID);
    });

    it('trims the label', async () => {
      const { endpoint } = await create({ ...VALID_CREATE, label: '  Slack  ' });
      expect(endpoint.label).toBe('Slack');
    });

    it('refuses repositoryId in the body with 400 and writes nothing', async () => {
      const res = await app.request(base, json('POST', { ...VALID_CREATE, repositoryId: OTHER_REPO_ID }));
      expect(res.status).toBe(400);
      expect(await repository.list(REPO_ID)).toEqual([]);
      expect(await repository.list(OTHER_REPO_ID)).toEqual([]);
    });

    it('refuses an empty or blank label, an over-long label, and unknown keys', async () => {
      for (const body of [
        { ...VALID_CREATE, label: '' },
        { ...VALID_CREATE, label: '   ' },
        { ...VALID_CREATE, label: 'x'.repeat(101) },
        { ...VALID_CREATE, previousSecret: 'whsec_mine' },
      ]) {
        expect((await app.request(base, json('POST', body))).status).toBe(400);
      }
      expect(await repository.list(REPO_ID)).toEqual([]);
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
      ['4001 characters', 'x'.repeat(4001)],
      ['an empty string', ''],
      ['only spaces', '   '],
      ['only line breaks', '\n\r\n\t '],
    ];

    for (const [name, instructionText] of REFUSED) {
      it(`create refuses ${name} with 400 before the repository is called`, async () => {
        const res = await app.request(base, json('POST', { ...VALID_CREATE, instructionText }));
        expect(res.status).toBe(400);
        expect(createSpy).not.toHaveBeenCalled();
        expect(await repository.list(REPO_ID)).toEqual([]);
      });

      it(`update refuses ${name} with 400 before the repository is called`, async () => {
        const { endpoint } = await create();
        updateSpy.mockClear();
        const res = await app.request(`${base}/${endpoint.id}`, json('PATCH', { instructionText }));
        expect(res.status).toBe(400);
        expect(updateSpy).not.toHaveBeenCalled();
        expect((await storedRow(endpoint.id)).instruction_text).toBe(VALID_CREATE.instructionText);
      });
    }

    it('accepts exactly 4000 characters', async () => {
      const { endpoint } = await create({ ...VALID_CREATE, instructionText: 'x'.repeat(4000) });
      expect(endpoint.instructionText).toHaveLength(4000);
      expect((await storedRow(endpoint.id)).instruction_text).toHaveLength(4000);
    });

    it('stores a multi-line instruction byte for byte (LF, CR, CRLF, edge line breaks, tabs, no trimming)', async () => {
      const text = '\n  line1\nline2\r\nline3\rline4\tend  \n';
      const { endpoint } = await create({ ...VALID_CREATE, instructionText: text });
      expect(endpoint.instructionText).toBe(text);
      expect((await storedRow(endpoint.id)).instruction_text).toBe(text);

      const patched = 'a\r\nb\rc\nd';
      const res = await app.request(`${base}/${endpoint.id}`, json('PATCH', { instructionText: patched }));
      expect(res.status).toBe(200);
      expect((await storedRow(endpoint.id)).instruction_text).toBe(patched);
    });
  });

  describe('entered secret', () => {
    it('create stores the entered secret as-is and answers secretSource entered with no secret in the response text', async () => {
      const entered = secretOfBytes(32, 5);
      const res = await app.request(base, json('POST', { ...VALID_CREATE, secret: entered }));
      expect(res.status).toBe(201);
      const text = await res.text();

      expect(text).not.toContain(entered);
      expect(text).not.toContain(entered.slice('whsec_'.length));
      const parsed = v.parse(InboundWebhookEndpointWithSecretResponseSchema, JSON.parse(text)) as Entered;
      expect(parsed.secretSource).toBe('entered');
      expect(Object.keys(JSON.parse(text)).sort()).toEqual(['endpoint', 'secretSource']);
      expect((await storedRow(parsed.endpoint.id)).secret).toBe(entered);
      expect((await repository.findWithSecretById(parsed.endpoint.id))?.secret).toBe(entered);
    });

    it('rotate stores the entered secret as-is, moves the old one to previous, and echoes nothing', async () => {
      const created = await create();
      const entered = secretOfBytes(40, 6);
      const res = await app.request(`${base}/${created.endpoint.id}/rotate-secret`, json('POST', { secret: entered }));
      expect(res.status).toBe(200);
      const text = await res.text();

      expect(text).not.toContain(entered);
      expect(text).not.toContain(created.secret);
      expect(Object.keys(JSON.parse(text)).sort()).toEqual(['endpoint', 'secretSource']);
      expect(v.parse(InboundWebhookEndpointWithSecretResponseSchema, JSON.parse(text)).secretSource).toBe('entered');

      const row = await storedRow(created.endpoint.id);
      expect(row.secret).toBe(entered);
      expect(row.previous_secret).toBe(created.secret);
      expect(row.previous_secret_expires_at).not.toBeNull();
    });

    it('the non-canonical test value really is lax-decodable (presence control)', () => {
      const lax = nonCanonicalSecret();
      const base64 = lax.slice('whsec_'.length);
      expect(Buffer.from(base64, 'base64').length).toBe(32);
      expect(Buffer.from(base64, 'base64').toString('base64')).not.toBe(base64);
    });

    const ACCEPTED: Array<[string, string]> = [
      ['24 bytes', secretOfBytes(24)],
      ['64 bytes', secretOfBytes(64)],
    ];
    const REJECTED: Array<[string, string]> = [
      ['a missing prefix', Buffer.alloc(32, 9).toString('base64')],
      ['non-base64 characters', 'whsec_ENTERED!!not*base64@@value##'],
      ['whitespace inside', `${secretOfBytes(32).slice(0, 20)} ${secretOfBytes(32).slice(20)}`],
      ['23 bytes', secretOfBytes(23)],
      ['65 bytes', secretOfBytes(65)],
      ['a lax-decodable but non-canonical string', nonCanonicalSecret()],
    ];

    for (const [name, secret] of ACCEPTED) {
      it(`create accepts ${name}`, async () => {
        const res = await app.request(base, json('POST', { ...VALID_CREATE, secret }));
        expect(res.status).toBe(201);
        expect(await res.text()).not.toContain(secret);
      });

      it(`rotate accepts ${name}`, async () => {
        const created = await create();
        const res = await app.request(`${base}/${created.endpoint.id}/rotate-secret`, json('POST', { secret }));
        expect(res.status).toBe(200);
        expect(await res.text()).not.toContain(secret);
        expect((await storedRow(created.endpoint.id)).secret).toBe(secret);
      });
    }

    for (const [name, secret] of REJECTED) {
      it(`create rejects ${name} with 400 that does not echo the value, and writes nothing`, async () => {
        const res = await app.request(base, json('POST', { ...VALID_CREATE, secret }));
        expect(res.status).toBe(400);
        expect(await res.text()).not.toContain(secret);
        expect(await repository.list(REPO_ID)).toEqual([]);
      });

      it(`rotate rejects ${name} with 400 that does not echo the value, and changes nothing`, async () => {
        const created = await create();
        const res = await app.request(`${base}/${created.endpoint.id}/rotate-secret`, json('POST', { secret }));
        expect(res.status).toBe(400);
        expect(await res.text()).not.toContain(secret);
        const row = await storedRow(created.endpoint.id);
        expect(row.secret).toBe(created.secret);
        expect(row.previous_secret).toBeNull();
      });
    }

    it('a rejected secret is in neither the 400 body nor any log call (every level spied)', async () => {
      const entered = 'whsec_ENTERED-SENTINEL not*base64';
      const spies = (['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const).map((level) => spyOn(rootLogger, level));
      try {
        const created = await create();
        const createRes = await app.request(base, json('POST', { ...VALID_CREATE, secret: entered }));
        const rotateRes = await app.request(`${base}/${created.endpoint.id}/rotate-secret`, json('POST', { secret: entered }));
        expect(createRes.status).toBe(400);
        expect(rotateRes.status).toBe(400);
        expect(await createRes.text()).not.toContain('ENTERED-SENTINEL');
        expect(await rotateRes.text()).not.toContain('ENTERED-SENTINEL');

        const calls = spies.flatMap((spy) => spy.mock.calls);
        const logged = JSON.stringify(calls);
        // Positive control: the 400 path did log (onApiError warns with the validation message).
        expect(logged).toContain('API error');
        expect(logged).toContain('Secret must');
        expect(logged).not.toContain('ENTERED-SENTINEL');
        expect(logged).not.toContain(entered);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  });

  describe('GET / and GET /:id never expose a secret', () => {
    it('list and get bodies contain neither the field names nor the secret values (raw text)', async () => {
      const created = await create();
      const { secret: currentSecret } = await rotate(created.endpoint.id);
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
      await rotate(created.endpoint.id);
      const patchText = await (await app.request(`${base}/${created.endpoint.id}`, json('PATCH', { label: 'renamed' }))).text();
      const clearText = await (await app.request(`${base}/${created.endpoint.id}/clear-previous-secret`, json('POST'))).text();
      for (const text of [patchText, clearText]) {
        expect(text).not.toContain('secret');
        expect(text).not.toContain('whsec_');
      }
    });

    it('list is empty on a fresh database and lists only the path repository\'s endpoints', async () => {
      const empty = v.parse(InboundWebhookEndpointsListResponseSchema, await (await app.request(base)).json());
      expect(empty.endpoints).toEqual([]);
      const a = await create();
      await create(VALID_CREATE, OTHER_REPO_ID);
      const listed = v.parse(InboundWebhookEndpointsListResponseSchema, await (await app.request(base)).json());
      expect(listed.endpoints.map((e) => e.id)).toEqual([a.endpoint.id]);
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
    it('moves current to previous with a 24h expiry and returns the new generated secret', async () => {
      const created = await create();
      const beforeMs = Date.now();
      const rotated = await rotate(created.endpoint.id);
      const afterMs = Date.now();

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

    it('accepts an empty body, a blank body, {} and { secret } when the content type is JSON', async () => {
      const created = await create();
      const url = `${base}/${created.endpoint.id}/rotate-secret`;
      const requests: Array<[string, RequestInit]> = [
        ['empty body, JSON content type', { method: 'POST', headers: { 'Content-Type': 'application/json' } }],
        ['blank body, JSON content type', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '' }],
        ['empty object', json('POST', {})],
        ['charset parameter', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: '{}' }],
        ['+json media type', { method: 'POST', headers: { 'Content-Type': 'application/vnd.api+json' }, body: '{}' }],
        ['entered secret', json('POST', { secret: secretOfBytes(32, 3) })],
      ];
      for (const [name, init] of requests) {
        const res = await app.request(url, init);
        expect(res.status, name).toBe(200);
        const parsed = v.parse(InboundWebhookEndpointWithSecretResponseSchema, await res.json());
        expect(parsed.secretSource, name).toBe(name === 'entered secret' ? 'entered' : 'generated');
      }
    });

    it('refuses a missing or non-JSON content type with 400, changes nothing, and echoes and logs nothing sent', async () => {
      const created = await create();
      const url = `${base}/${created.endpoint.id}/rotate-secret`;
      const attacker = secretOfBytes(32, 13);
      const body = JSON.stringify({ secret: attacker });
      const attempts: Array<[string, RequestInit]> = [
        ['text/plain with a JSON-shaped body', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body }],
        ['form-urlencoded', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `secret=${attacker}` }],
        ['no content type, JSON-shaped body', { method: 'POST', body }],
        ['no content type, no body', { method: 'POST' }],
        ['text/plain, blank body (forced generated rotation)', { method: 'POST', headers: { 'Content-Type': 'text/plain' } }],
      ];
      const spies = (['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const).map((level) => spyOn(rootLogger, level));
      try {
        for (const [name, init] of attempts) {
          const res = await app.request(url, init);
          expect(res.status, name).toBe(400);
          const text = await res.text();
          expect(text, name).not.toContain(attacker);
          expect(text, name).toContain('Content-Type must be application/json');
        }
        const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
        expect(logged).toContain('Content-Type must be application/json'); // positive control: the refusal was logged
        expect(logged).not.toContain(attacker);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      const row = await storedRow(created.endpoint.id);
      expect(row.secret).toBe(created.secret);
      expect(row.previous_secret).toBeNull();
      expect(row.previous_secret_expires_at).toBeNull();
    });

    it('rejects malformed JSON and an unknown key with 400', async () => {
      const created = await create();
      const url = `${base}/${created.endpoint.id}/rotate-secret`;
      expect((await app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' })).status).toBe(400);
      expect((await app.request(url, json('POST', { repositoryId: OTHER_REPO_ID }))).status).toBe(400);
      expect((await storedRow(created.endpoint.id)).secret).toBe(created.secret);
    });

    it('rotating twice replaces the previous secret with the then-current one', async () => {
      const created = await create();
      const first = await rotate(created.endpoint.id);
      const second = await rotate(created.endpoint.id);

      const row = await storedRow(created.endpoint.id);
      expect(row.secret).toBe(second.secret);
      expect(row.previous_secret).toBe(first.secret);
      expect(new Set([created.secret, first.secret, second.secret]).size).toBe(3);
    });

    it('an expired previous secret reads as absent', async () => {
      const created = await create();
      await rotate(created.endpoint.id);
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
      const rotated = await rotate(created.endpoint.id);

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

      expect(await repository.findById(REPO_ID, doomed.endpoint.id)).toBeNull();
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

  describe("another repository's endpoint is 404 and stays unchanged", () => {
    let foreignId: string;
    let foreignBefore: Awaited<ReturnType<typeof storedRow>>;

    beforeEach(async () => {
      // The endpoint lives under OTHER_REPO_ID; every request below addresses it under REPO_ID.
      const foreign = await create(VALID_CREATE, OTHER_REPO_ID);
      foreignId = foreign.endpoint.id;
      await rotate(foreignId, undefined, OTHER_REPO_ID);
      foreignBefore = await storedRow(foreignId);
    });

    async function expectForeignUntouched() {
      expect(await storedRow(foreignId)).toEqual(foreignBefore);
    }

    it('get', async () => {
      const res = await app.request(`${base}/${foreignId}`);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toContain('Inbound webhook endpoint');
      await expectForeignUntouched();
    });

    it('patch', async () => {
      const res = await app.request(`${base}/${foreignId}`, json('PATCH', { label: 'hijack', instructionText: 'hijack' }));
      expect(res.status).toBe(404);
      await expectForeignUntouched();
    });

    it('delete', async () => {
      const res = await app.request(`${base}/${foreignId}`, json('DELETE'));
      expect(res.status).toBe(404);
      await expectForeignUntouched();
    });

    it('rotate-secret (generated and entered)', async () => {
      const generated = await app.request(`${base}/${foreignId}/rotate-secret`, json('POST'));
      expect(generated.status).toBe(404);
      const entered = await app.request(`${base}/${foreignId}/rotate-secret`, json('POST', { secret: secretOfBytes(32, 4) }));
      expect(entered.status).toBe(404);
      await expectForeignUntouched();
    });

    it('clear-previous-secret', async () => {
      const res = await app.request(`${base}/${foreignId}/clear-previous-secret`, json('POST'));
      expect(res.status).toBe(404);
      await expectForeignUntouched();
    });

    it('the owning repository still reaches it (control)', async () => {
      expect((await app.request(`${baseOf(OTHER_REPO_ID)}/${foreignId}`)).status).toBe(200);
    });
  });

  describe('repository deletion', () => {
    it('deleting the repository removes its endpoint', async () => {
      const created = await create();
      await db.deleteFrom('repositories').where('id', '=', REPO_ID).execute();
      expect(await db.selectFrom('inbound_webhook_endpoints').select('id').where('id', '=', created.endpoint.id).execute()).toEqual([]);
    });
  });

  describe('logging', () => {
    it('no log call during create, rotate, update, clear or delete carries a secret, generated or entered', async () => {
      const spies = (['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const).map((level) => spyOn(rootLogger, level));
      try {
        const enteredOnCreate = secretOfBytes(32, 11);
        const enteredOnRotate = secretOfBytes(32, 12);

        const created = await create();
        const rotated = await rotate(created.endpoint.id);
        await app.request(`${base}/${created.endpoint.id}`, json('PATCH', { label: 'renamed' }));
        await app.request(`${base}/${created.endpoint.id}/clear-previous-secret`, json('POST'));
        const enteredCreate = await app.request(base, json('POST', { ...VALID_CREATE, secret: enteredOnCreate }));
        expect(enteredCreate.status).toBe(201);
        const rotatedEntered = await app.request(`${base}/${created.endpoint.id}/rotate-secret`, json('POST', { secret: enteredOnRotate }));
        expect(rotatedEntered.status).toBe(200);
        await app.request(`${base}/${created.endpoint.id}`, json('DELETE'));

        const calls = spies.flatMap((spy) => spy.mock.calls);
        // Positive control: the routes and the repository do log, so an empty list would be a blind spy.
        expect(calls.length).toBeGreaterThan(0);
        const logged = JSON.stringify(calls);
        expect(logged).not.toContain(created.secret);
        expect(logged).not.toContain(rotated.secret);
        expect(logged).not.toContain(enteredOnCreate);
        expect(logged).not.toContain(enteredOnRotate);
        expect(logged).not.toContain('whsec_');
        expect(logged).toContain(created.endpoint.id);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  });
});
