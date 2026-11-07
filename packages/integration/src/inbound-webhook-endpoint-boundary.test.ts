/**
 * Server-to-client boundary test: inbound webhook endpoint management.
 *
 * Real `AppContext` (real SQLite repository, real `RepositoryManager`) + real Hono
 * `/api/inbound-webhook-endpoints` handlers -> JSON wire -> the shared strict response schemas
 * (`.claude/rules/pre-pr-completeness.md` Q10). Route tests assert raw JSON and client tests inject
 * mock objects; neither crosses the schema.
 *
 * Also pins the two new wire literals: an `inbound-event` frame carrying type `external:message`
 * and source `webhook` (with the routing / rendering metadata fields) must parse through the real
 * `AppServerMessageSchema`. Nothing emits such an event yet, so the frame is hand-built in the exact
 * shape `InboundEventSummary` has.
 *
 * Stashing `'external:message'` or `'webhook'` from the app-server-message picklists, or either new
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
  type InboundEventSummary,
} from '@agent-console/shared';

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
    return app.request(`/api/inbound-webhook-endpoints${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it('create, get, list, update, rotate and clear-previous responses all survive the strict schemas', async () => {
    const createdRes = await request('POST', '', { label: 'Slack', repositoryId, instructionText: 'Run the triage skill' });
    expect(createdRes.status).toBe(201);
    const created = v.parse(InboundWebhookEndpointWithSecretResponseSchema, await createdRes.json());
    const id = created.endpoint.id;
    expect(created.secret.startsWith('whsec_')).toBe(true);

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

  it('control: the same list body with one extra field is rejected by the strict schema', async () => {
    await request('POST', '', { label: 'Slack', repositoryId, instructionText: 'x' });
    const body = (await (await request('GET', '')).json()) as { endpoints: Array<Record<string, unknown>> };
    body.endpoints[0]!.secret = 'whsec_leak';
    expect(v.safeParse(InboundWebhookEndpointsListResponseSchema, body).success).toBe(false);
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
        instructionText: 'Run the triage skill',
      },
    };
    const frame = (event: unknown) => JSON.parse(JSON.stringify({ type: 'inbound-event', sessionId: 'session-1', event }));

    it('an external:message / webhook inbound-event frame parses and keeps its metadata', () => {
      const parsed = v.safeParse(AppServerMessageSchema, frame(summary));
      expect(parsed.success).toBe(true);
      if (!parsed.success || parsed.output.type !== 'inbound-event') throw new Error('frame did not parse as inbound-event');
      expect(parsed.output.event).toEqual(summary);
    });

    it('controls: an unknown source, an unknown type and an unknown metadata key are still rejected', () => {
      expect(v.safeParse(AppServerMessageSchema, frame({ ...summary, source: 'slack' })).success).toBe(false);
      expect(v.safeParse(AppServerMessageSchema, frame({ ...summary, type: 'external:other' })).success).toBe(false);
      expect(v.safeParse(AppServerMessageSchema, frame({ ...summary, metadata: { ...summary.metadata, extra: 'x' } })).success).toBe(false);
    });
  });
});
