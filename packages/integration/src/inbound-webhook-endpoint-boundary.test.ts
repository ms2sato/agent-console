/**
 * Server-to-client boundary test: inbound webhook endpoint management.
 *
 * Real `AppContext` (real SQLite repository, real `RepositoryManager`) + real Hono
 * `/api/repositories/:repositoryId/inbound-webhook-endpoints` handlers -> JSON wire -> the shared strict response schemas
 * (`.claude/rules/pre-pr-completeness.md` Q10). Route tests assert raw JSON and client tests inject
 * mock objects; neither crosses the schema.
 *
 * Also pins the two new wire literals: an `inbound-event` frame carrying type `external:message`
 * and source `webhook` (with the routing / rendering metadata keys and the two attachment counts) must parse through the
 * real `AppServerMessageSchema`, and one carrying `instructionText` must not. Nothing emits such an
 * event yet, so the frame is hand-built in the exact shape `InboundEventSummary` has.
 *
 * The health response is parsed with its new `internetOrigin` field.
 *
 * Stashing `'external:message'` or `'webhook'` from the app-server-message picklists, or any new
 * metadata key from its metadata object, fails this file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as v from 'valibot';
import type { Hono } from 'hono';

import {
  createTestApp,
  setupTestEnvironment,
  cleanupTestEnvironment,
  getTestConfigDir,
} from '@agent-console/server/src/__tests__/test-utils';
import { setupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppBindings, AppContext } from '@agent-console/server/src/app-context';
import { createMockPtyProvider } from '@agent-console/server/src/__tests__/utils/mock-pty';

import {
  AppServerMessageSchema,
  InboundWebhookEndpointResponseSchema,
  InboundWebhookEndpointWithSecretResponseSchema,
  InboundWebhookEndpointsListResponseSchema,
  SystemHealthResponseSchema,
  type InboundEventSummary,
} from '@agent-console/shared';
import { serverConfig } from '@agent-console/server/src/lib/server-config';

const TEST_REPO_PATH = '/test/repo-a';

describe('Client-Server Boundary: inbound webhook endpoints', () => {
  let ctx: AppContext;
  let app: Hono<AppBindings>;
  let repositoryId: string;

  beforeEach(async () => {
    await setupTestEnvironment();
    ctx = await createTestContext({ ptyProvider: createMockPtyProvider() });
    setupMemfs({
      [`${getTestConfigDir()}/.keep`]: '',
      [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
    });
    repositoryId = (await ctx.repositoryManager.registerRepository(TEST_REPO_PATH)).id;
    app = await createTestApp(ctx);
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  function request(method: string, path: string, body?: unknown) {
    return app.request(`/api/repositories/${repositoryId}/inbound-webhook-endpoints${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** A canonical `whsec_` secret of `bytes` raw bytes. */
  const enteredSecret = (bytes: number) => `whsec_${Buffer.alloc(bytes, 7).toString('base64')}`;

  it('create, get, list, update, rotate and clear-previous responses all survive the strict schemas', async () => {
    const createdRes = await request('POST', '', { label: 'Slack', instructionText: 'Run the triage skill\nthen report' });
    expect(createdRes.status).toBe(201);
    const created = v.parse(InboundWebhookEndpointWithSecretResponseSchema, await createdRes.json());
    if (created.secretSource !== 'generated') throw new Error('expected a generated secret');
    const id = created.endpoint.id;
    expect(created.secret.startsWith('whsec_')).toBe(true);
    expect(created.endpoint.repositoryId).toBe(repositoryId);
    expect(created.endpoint.instructionText).toBe('Run the triage skill\nthen report');

    const got = v.parse(InboundWebhookEndpointResponseSchema, await (await request('GET', `/${id}`)).json());
    expect(got.endpoint).toEqual(created.endpoint);

    const listed = v.parse(InboundWebhookEndpointsListResponseSchema, await (await request('GET', '')).json());
    expect(listed.endpoints).toEqual([created.endpoint]);

    const updated = v.parse(
      InboundWebhookEndpointResponseSchema,
      await (await request('PATCH', `/${id}`, { label: 'Renamed' })).json(),
    );
    expect(updated.endpoint.label).toBe('Renamed');

    const rotated = v.parse(InboundWebhookEndpointWithSecretResponseSchema, await (await request('POST', `/${id}/rotate-secret`)).json());
    if (rotated.secretSource !== 'generated') throw new Error('expected a generated secret');
    expect(rotated.endpoint.hasPreviousSecret).toBe(true);
    expect(rotated.endpoint.previousSecretExpiresAt).not.toBeNull();
    expect(rotated.secret).not.toBe(created.secret);

    const cleared = v.parse(
      InboundWebhookEndpointResponseSchema,
      await (await request('POST', `/${id}/clear-previous-secret`)).json(),
    );
    expect(cleared.endpoint).toMatchObject({ hasPreviousSecret: false, previousSecretExpiresAt: null });

    // the secret never rides on a read, even though the schemas above would reject only an unknown key
    const readText = await (await request('GET', `/${id}`)).text();
    expect(readText).not.toContain(rotated.secret);
    expect(readText).not.toContain('secret');
  });

  it('an entered secret parses as the entered variant on create and on rotate, and is never echoed', async () => {
    const onCreate = enteredSecret(32);
    const createdText = await (await request('POST', '', { label: 'Slack', instructionText: 'x', secret: onCreate })).text();
    const created = v.parse(InboundWebhookEndpointWithSecretResponseSchema, JSON.parse(createdText));
    expect(created.secretSource).toBe('entered');
    expect(createdText).not.toContain(onCreate);

    const onRotate = enteredSecret(48);
    const rotatedText = await (await request('POST', `/${created.endpoint.id}/rotate-secret`, { secret: onRotate })).text();
    expect(v.parse(InboundWebhookEndpointWithSecretResponseSchema, JSON.parse(rotatedText)).secretSource).toBe('entered');
    expect(rotatedText).not.toContain(onRotate);
  });

  it('control: the entered variant must not carry a secret, and the generated variant must', async () => {
    const generated = await (await request('POST', '', { label: 'Slack', instructionText: 'x' })).json();
    expect(v.safeParse(InboundWebhookEndpointWithSecretResponseSchema, generated).success).toBe(true);
    const { secret: _omitted, ...withoutSecret } = generated as Record<string, unknown>;
    expect(v.safeParse(InboundWebhookEndpointWithSecretResponseSchema, withoutSecret).success).toBe(false);
    expect(v.safeParse(InboundWebhookEndpointWithSecretResponseSchema, { ...withoutSecret, secretSource: 'entered' }).success).toBe(true);
    expect(v.safeParse(InboundWebhookEndpointWithSecretResponseSchema, { ...(generated as object), secretSource: 'entered' }).success).toBe(false);
  });

  it('control: the same list body with one extra field is rejected by the strict schema', async () => {
    await request('POST', '', { label: 'Slack', instructionText: 'x' });
    const body = (await (await request('GET', '')).json()) as { endpoints: Array<Record<string, unknown>> };
    body.endpoints[0]!.secret = 'whsec_leak';
    expect(v.safeParse(InboundWebhookEndpointsListResponseSchema, body).success).toBe(false);
  });

  it('the former global URL is not served', async () => {
    expect((await app.request('/api/inbound-webhook-endpoints')).status).toBe(404);
  });

  it('the health response parses with internetOrigin, set and unset', async () => {
    // `serverConfig` is a readonly constant; the route reads it on every request.
    const config = serverConfig as { AGENT_CONSOLE_INTERNET_ORIGIN: string | undefined };
    const original = config.AGENT_CONSOLE_INTERNET_ORIGIN;
    try {
      for (const origin of ['https://hooks.example.com', undefined]) {
        config.AGENT_CONSOLE_INTERNET_ORIGIN = origin;
        const body = await (await app.request('/api/system/health')).json();
        const parsed = v.parse(SystemHealthResponseSchema, body);
        expect(parsed.internetOrigin).toBe(origin ?? null);
        expect(v.safeParse(SystemHealthResponseSchema, { ...(body as object), extra: 1 }).success).toBe(false);
      }
    } finally {
      config.AGENT_CONSOLE_INTERNET_ORIGIN = original;
    }
  });

  describe('app-server-message wire literals', () => {
    const summary: InboundEventSummary = {
      type: 'external:message',
      source: 'webhook',
      summary: 'A message arrived',
      metadata: {
        repositoryName: 'org/repo',
        url: 'https://example.com/permalink',
        targetRepositoryId: 'repo-1',
        deliveryId: 'inbound-webhook:ep-1:webhook-1',
        instructionExcerpt: 'Run the triage skill',
        attachmentsFetched: 2,
        attachmentsSkipped: 1,
      },
    };
    const frame = (event: unknown) => JSON.parse(JSON.stringify({ type: 'inbound-event', sessionId: 'session-1', event }));

    it('an external:message / webhook inbound-event frame parses and keeps its metadata', () => {
      const parsed = v.safeParse(AppServerMessageSchema, frame(summary));
      expect(parsed.success).toBe(true);
      if (!parsed.success || parsed.output.type !== 'inbound-event') throw new Error('frame did not parse as inbound-event');
      expect(parsed.output.event).toEqual(summary);
    });

    it('an external:message frame carrying instructionText in its metadata is rejected (the full text travels as a file)', () => {
      const withText = { ...summary, metadata: { ...summary.metadata, instructionText: 'Run the triage skill' } };
      expect(v.safeParse(AppServerMessageSchema, frame(withText)).success).toBe(false);
    });

    it('the attachment counts parse as non-negative integers, zero included, and are optional', () => {
      for (const counts of [{ attachmentsFetched: 0, attachmentsSkipped: 0 }, { attachmentsFetched: 10, attachmentsSkipped: 0 }]) {
        const parsed = v.safeParse(AppServerMessageSchema, frame({ ...summary, metadata: { ...summary.metadata, ...counts } }));
        expect(parsed.success).toBe(true);
      }
      const { attachmentsFetched: _f, attachmentsSkipped: _s, ...without } = summary.metadata;
      expect(v.safeParse(AppServerMessageSchema, frame({ ...summary, metadata: without })).success).toBe(true);
    });

    it('a negative, fractional or non-numeric attachment count is rejected, on either key', () => {
      for (const key of ['attachmentsFetched', 'attachmentsSkipped'] as const) {
        for (const bad of [-1, 1.5, '2', null, Number.NaN]) {
          const result = v.safeParse(AppServerMessageSchema, frame({ ...summary, metadata: { ...summary.metadata, [key]: bad } }));
          expect(result.success).toBe(false);
        }
      }
    });

    it('controls: an unknown source, an unknown type and an unknown metadata key are still rejected', () => {
      expect(v.safeParse(AppServerMessageSchema, frame({ ...summary, source: 'slack' })).success).toBe(false);
      expect(v.safeParse(AppServerMessageSchema, frame({ ...summary, type: 'external:other' })).success).toBe(false);
      expect(v.safeParse(AppServerMessageSchema, frame({ ...summary, metadata: { ...summary.metadata, extra: 'x' } })).success).toBe(false);
    });
  });
});
