import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Hono } from 'hono';
import type { AppBindings } from '../../app-context.js';
import { setupTestEnvironment, cleanupTestEnvironment, createTestApp } from '../../__tests__/test-utils.js';
import { rootLogger } from '../../lib/logger.js';
import { CROSS_SITE_REFUSED_ERROR } from '../same-origin-guard.js';
import { webhooks } from '../../routes/webhooks.js';
import { Hono as HonoApp } from 'hono';
import { createTestContext, shutdownAppContext } from '../../app-context.js';

const FOREIGN_ORIGIN = 'https://evil.example';
const HOST = 'console.test';
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function stateChangingRoutes(): Promise<Array<{ method: string; path: string }>> {
  const { api } = await import('../../routes/api.js');
  return api.routes
    .filter((r) => STATE_CHANGING.has(r.method))
    .map((r) => ({
      method: r.method,
      // Fill path parameters (":id" and ":id{regex}") with a placeholder id.
      path: '/api' + r.path.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?\??/g, 'placeholder-id'),
    }));
}

function send(app: Hono<AppBindings>, route: { method: string; path: string }, headers: Record<string, string>) {
  return app.request(route.path, { method: route.method, headers: { Host: HOST, ...headers } });
}

describe('sameOriginGuard', () => {
  let app: Hono<AppBindings>;
  let routes: Array<{ method: string; path: string }>;

  beforeEach(async () => {
    await setupTestEnvironment();
    app = await createTestApp();
    routes = await stateChangingRoutes();
  });

  afterEach(async () => {
    await cleanupTestEnvironment();
  });

  describe('route table (every state-changing /api route)', () => {
    it('enumerates a non-empty route table (positive control)', () => {
      console.log(`state-changing /api routes enumerated: ${routes.length}`);
      expect(routes.length).toBeGreaterThan(0);
    });

    it('refuses a foreign Origin for every non-GET route', async () => {
      for (const route of routes) {
        const res = await send(app, route, { Origin: FOREIGN_ORIGIN });
        expect(`${route.method} ${route.path} ${res.status}`).toBe(`${route.method} ${route.path} 403`);
        expect(await res.json()).toEqual({ error: CROSS_SITE_REFUSED_ERROR });
      }
    });

    it('refuses Sec-Fetch-Site cross-site for every non-GET route', async () => {
      for (const route of routes) {
        const res = await send(app, route, { 'Sec-Fetch-Site': 'cross-site' });
        expect(`${route.method} ${route.path} ${res.status}`).toBe(`${route.method} ${route.path} 403`);
        expect(await res.json()).toEqual({ error: CROSS_SITE_REFUSED_ERROR });
      }
    });

    it('refuses Sec-Fetch-Site same-site', async () => {
      const res = await send(app, routes[0], { 'Sec-Fetch-Site': 'same-site' });
      expect(res.status).toBe(403);
    });

    it('lets Sec-Fetch-Site same-origin and none through to the route', async () => {
      for (const route of routes) {
        for (const site of ['same-origin', 'none']) {
          const res = await send(app, route, { 'Sec-Fetch-Site': site });
          expect(`${route.method} ${route.path} ${res.status}`).not.toBe(`${route.method} ${route.path} 403`);
        }
      }
    });

    it('lets requests with neither Origin nor Sec-Fetch-Site through', async () => {
      for (const route of routes) {
        const res = await send(app, route, {});
        expect(`${route.method} ${route.path} ${res.status}`).not.toBe(`${route.method} ${route.path} 403`);
      }
    });

    it('lets an Origin whose host equals Host through', async () => {
      for (const route of routes) {
        const res = await send(app, route, { Origin: `https://${HOST}` });
        expect(`${route.method} ${route.path} ${res.status}`).not.toBe(`${route.method} ${route.path} 403`);
      }
    });

    it('refuses an Origin that differs from Host only by port, and an opaque Origin', async () => {
      expect((await send(app, routes[0], { Origin: `https://${HOST}:8443` })).status).toBe(403);
      expect((await send(app, routes[0], { Origin: 'null' })).status).toBe(403);
    });

    it('refuses an Origin when the request carries no Host header', async () => {
      const route = routes[0];
      const origin = `https://${HOST}`;
      // Control: the same Origin with a matching Host is not refused.
      expect((await send(app, route, { Origin: origin })).status).not.toBe(403);
      // Sent without Host (not through send(), which adds the default one).
      const res = await app.request(route.path, { method: route.method, headers: { Origin: origin } });
      expect(res.status).toBe(403);
    });

    it('prefers Sec-Fetch-Site over Origin when both are present', async () => {
      const res = await send(app, routes[0], { 'Sec-Fetch-Site': 'same-origin', Origin: FOREIGN_ORIGIN });
      expect(res.status).not.toBe(403);
    });

    it('passes GET, HEAD and OPTIONS through untouched', async () => {
      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        const res = await app.request('/api/config', {
          method,
          headers: { Host: HOST, Origin: FOREIGN_ORIGIN, 'Sec-Fetch-Site': 'cross-site' },
        });
        expect(res.status).not.toBe(403);
      }
    });

    it('refuses a foreign Origin on /api/auth routes', async () => {
      const authRoute = routes.find((r) => r.path.startsWith('/api/auth/'));
      expect(authRoute).toBeDefined();
      const res = await send(app, authRoute!, { Origin: FOREIGN_ORIGIN });
      expect(res.status).toBe(403);
    });
  });

  describe('handler is never reached on refusal', () => {
    // Two routes, each with its own spy and its own positive control: a
    // bodyless POST and a POST with a required JSON body. Reaching a handler
    // is observed through the repository it calls first.
    const refusalHeaders = [{ Origin: FOREIGN_ORIGIN }, { 'Sec-Fetch-Site': 'cross-site' }] as Array<Record<string, string>>;

    it('does not reach a bodyless POST handler on refusal, and does without the headers', async () => {
      const lookups: string[] = [];
      const todoRepository = { findById: async (id: string) => { lookups.push(id); return null; } };
      const spied = await createTestApp({ todoRepository: todoRepository as never });
      const route = { method: 'POST', path: '/api/todos/placeholder-id/dismiss' };

      for (const headers of refusalHeaders) {
        expect((await send(spied, route, headers)).status).toBe(403);
      }
      expect(lookups).toEqual([]);

      // Control: without the headers the handler runs (its own 404 for an unknown id).
      const control = await send(spied, route, {});
      expect(control.status).toBe(404);
      expect(lookups).toEqual(['placeholder-id']);
    });

    it('does not reach a JSON-body POST handler on refusal, and creates exactly once without the headers', async () => {
      let created = 0;
      const messageTemplateRepository = {
        findAll: async () => [],
        create: async () => {
          created++;
          return { id: 'x', title: 't', content: 'c', sortOrder: 0, createdAt: 'now', updatedAt: 'now' };
        },
      };
      const spied = await createTestApp({ messageTemplateRepository: messageTemplateRepository as never });
      const post = (headers: Record<string, string>) =>
        spied.request('/api/message-templates', {
          method: 'POST',
          headers: { Host: HOST, 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ title: 't', content: 'c' }),
        });

      for (const headers of refusalHeaders) {
        expect((await post(headers)).status).toBe(403);
      }
      expect(created).toBe(0);

      // Control: without the headers the handler runs and creates once.
      expect((await post({})).status).toBe(201);
      expect(created).toBe(1);
    });
  });

  describe('per request body type', () => {
    const form = new FormData();
    form.append('title', 't');
    const bodies: Array<{ name: string; contentType?: string; body?: string | FormData; controlStatus: number }> = [
      { name: 'application/json', contentType: 'application/json', body: JSON.stringify({ title: 't', content: 'c' }), controlStatus: 201 },
      { name: 'multipart/form-data', body: form, controlStatus: 400 },
      { name: 'application/x-www-form-urlencoded', contentType: 'application/x-www-form-urlencoded', body: 'title=t&content=c', controlStatus: 400 },
      { name: 'text/plain', contentType: 'text/plain', body: 'title=t', controlStatus: 400 },
      { name: 'empty body', controlStatus: 400 },
    ];

    for (const b of bodies) {
      it(`${b.name}: foreign Origin is refused with no side effect; without Origin the route answers itself`, async () => {
        let created = 0;
        const repo = {
          create: async () => { created++; return { id: 'x', title: 't', content: 'c' }; },
          findAll: async () => [],
        };
        const spied = await createTestApp({ messageTemplateRepository: repo as never });
        const headers: Record<string, string> = { Host: HOST };
        if (b.contentType) headers['Content-Type'] = b.contentType;

        const refused = await spied.request('/api/message-templates', {
          method: 'POST',
          headers: { ...headers, Origin: FOREIGN_ORIGIN },
          body: b.body,
        });
        expect(refused.status).toBe(403);
        expect(created).toBe(0);

        const control = await spied.request('/api/message-templates', { method: 'POST', headers, body: b.body });
        // The headerless request reaches the route: JSON is created; the other
        // body types get the route's own validation answer (400), never the guard's 403.
        expect(control.status).toBe(b.controlStatus);
        expect(created).toBe(b.controlStatus === 201 ? 1 : 0);
      });
    }
  });

  describe('exemptions', () => {
    it('does not put /webhooks/* behind the guard', async () => {
      const testContext = await createTestContext({ skipJobQueueStart: true });
      const webhookApp = new HonoApp<AppBindings>();
      webhookApp.use('*', async (c, next) => {
        c.set('appContext', testContext);
        await next();
      });
      webhookApp.route('/webhooks', webhooks);
      const res = await webhookApp.request('/webhooks/github', {
        method: 'POST',
        headers: { Host: HOST, Origin: FOREIGN_ORIGIN, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'opened' }),
      });
      try {
        // Its own existing answer: always 200, never the guard's 403.
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      } finally {
        await shutdownAppContext(testContext);
      }
    });
  });

  describe('logging', () => {
    it('logs a refusal at debug exactly once and never at warn', async () => {
      const warn = spyOn(rootLogger, 'warn').mockImplementation(() => undefined);
      const debug = spyOn(rootLogger, 'debug').mockImplementation(() => undefined);
      try {
        const res = await send(app, routes[0], { Origin: FOREIGN_ORIGIN });
        expect(res.status).toBe(403);
        expect(warn).toHaveBeenCalledTimes(0);
        expect(debug).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
        debug.mockRestore();
      }
    });
  });
});
