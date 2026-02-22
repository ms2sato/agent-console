import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { createTestContext, shutdownAppContext, type AppContext } from '../../app-context.js';
import { webhooks } from '../webhooks.js';

// Mock server config to set GITHUB_WEBHOOK_SECRET for tests
mock.module('../../lib/server-config.js', () => ({
  serverConfig: {
    GITHUB_WEBHOOK_SECRET: 'test-secret',
  },
}));

describe('Webhooks route', () => {
  let app: Hono;
  let testContext: AppContext;

  beforeEach(async () => {
    testContext = await createTestContext({ skipJobQueueStart: true });

    // Type assertion needed: the root Hono app uses BlankEnv, while sub-routes
    // that consume appContext declare AppBindings on their own Hono instances.
    // This mirrors the pattern in index.ts.
    app = new Hono();
    app.use('*', async (c, next) => {
      (c as any).set('appContext', testContext);
      await next();
    });
    app.route('/webhooks', webhooks);
  });

  afterEach(async () => {
    await shutdownAppContext(testContext, { resetSingletons: true });
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
