import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { createTestContext, shutdownAppContext, type AppContext, type AppBindings } from '../../app-context.js';
import { webhooks } from '../webhooks.js';

describe('Webhooks route', () => {
  let app: Hono<AppBindings>;
  let testContext: AppContext;

  beforeEach(async () => {
    testContext = await createTestContext({ skipJobQueueStart: true });

    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', testContext);
      await next();
    });
    app.route('/webhooks', webhooks);
  });

  afterEach(async () => {
    await shutdownAppContext(testContext);
  });

  describe('POST /webhooks/github body limit', () => {
    it('should accept payloads under 1MB', async () => {
      // A small payload should pass through the body limit middleware.
      // It will still return 200 OK (may fail auth, but that is expected).
      const smallPayload = JSON.stringify({ action: 'opened' });

      const res = await app.request('/webhooks/github', {
        method: 'POST',
        body: smallPayload,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    it('should return 200 OK and drop payloads exceeding 1MB', async () => {
      // Create a payload larger than 1MB
      const oversizedPayload = 'x'.repeat(1 * 1024 * 1024 + 1);

      const res = await app.request('/webhooks/github', {
        method: 'POST',
        body: oversizedPayload,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      // Should return 200 OK (not 413) to avoid sender retries
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });
  });
});

describe('Webhooks route fallthrough (method and path guards)', () => {
  let app: Hono<AppBindings>;
  let testContext: AppContext;

  beforeEach(async () => {
    testContext = await createTestContext({ skipJobQueueStart: true });

    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', testContext);
      await next();
    });
    app.route('/webhooks', webhooks);
    // Mirrors index.ts's production SPA fallback shape: `app.get('*', ...)`.
    // Anything the webhooks router does not answer itself lands here and
    // returns 200 HTML, which is what these cases must prove cannot happen.
    app.get('*', (c) => c.html('<html>SPA index.html</html>'));
  });

  afterEach(async () => {
    await shutdownAppContext(testContext);
  });

  it('GET /webhooks/github answers a JSON 405 with Allow: POST, not the SPA page', async () => {
    const res = await app.request('/webhooks/github');
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
    const text = await res.text();
    expect(text).not.toContain('<html');
    expect(JSON.parse(text)).toEqual({ error: 'Method Not Allowed' });
  });

  for (const method of ['HEAD', 'PUT', 'DELETE']) {
    it(`${method} /webhooks/github answers 405`, async () => {
      const res = await app.request('/webhooks/github', { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('POST');
    });
  }

  it('GET /webhooks/unknown answers a JSON 404, not the SPA page', async () => {
    const res = await app.request('/webhooks/unknown');
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain('<html');
    expect(JSON.parse(text)).toEqual({ error: 'Not Found' });
  });

  it('GET /webhooks/in/anything answers a JSON 404', async () => {
    const res = await app.request('/webhooks/in/anything');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not Found' });
  });

  it('POST /webhooks/unknown answers a JSON 404', async () => {
    const res = await app.request('/webhooks/unknown', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not Found' });
  });

  it('POST /webhooks/github still answers 200 { ok: true }', async () => {
    const res = await app.request('/webhooks/github', {
      method: 'POST',
      body: JSON.stringify({ action: 'opened' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
