import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createLogger } from '../lib/logger.js';
import { JOB_TYPES } from '../jobs/index.js';
import type { AppBindings } from '../app-context.js';

const logger = createLogger('webhooks');

const webhooks = new Hono<AppBindings>();

/**
 * Register a POST-only route: `router.post(path, ...handlers)` followed by an
 * `all` handler that answers every other method on the same path with a JSON
 * 405 and `Allow: POST`. Without it, a GET on a webhook path would fall through
 * to the production SPA fallback and answer 200 with index.html.
 *
 * Registration order is the mechanism: the POST handler must be registered
 * first so it wins for POST; the `all` handler only sees what is left.
 *
 * @internal Exported for testing.
 */
export function postOnly(
  router: Hono<AppBindings>,
  path: string,
  ...handlers: [MiddlewareHandler<AppBindings>, ...MiddlewareHandler<AppBindings>[]]
): void {
  router.on('POST', path, ...handlers);
  router.all(path, (c) => c.json({ error: 'Method Not Allowed' }, 405, { Allow: 'POST' }));
}

/**
 * GitHub webhook endpoint.
 *
 * Always returns 200 OK regardless of internal errors.
 * See docs/design/integration-inbound.md Error Handling Policy for rationale:
 * - Webhook senders retry on non-2xx, but config errors are permanent
 * - Persistent error responses may cause the sender to disable the webhook
 * - Internal failures are the receiver's responsibility to detect and resolve
 *
 * Note: Consider adding rate limiting at the infrastructure level (e.g., nginx, cloudflare)
 * to protect against webhook replay attacks.
 */
postOnly(webhooks, '/github',
  bodyLimit({
    maxSize: 1 * 1024 * 1024, // 1MB
    onError: (c) => {
      logger.warn('Webhook payload too large — dropping webhook');
      return c.json({ ok: true });
    },
  }) as MiddlewareHandler<AppBindings>,
  async (c) => {
  const appContext = c.get('appContext');
  const parser = appContext.inboundIntegration.parserRegistry.get('github');
  if (!parser) {
    logger.warn('GitHub webhook parser not registered — dropping webhook');
    return c.json({ ok: true });
  }

  const payload = await c.req.text();
  const headers = c.req.raw.headers;

  const authenticated = await parser.authenticate(payload, headers);
  if (!authenticated) {
    logger.warn('GitHub webhook authentication failed — dropping webhook');
    return c.json({ ok: true });
  }

  const jobId = crypto.randomUUID();

  try {
    await appContext.jobQueue.enqueue(
      JOB_TYPES.INBOUND_EVENT_PROCESS,
      {
        jobId,
        service: 'github',
        rawPayload: payload,
        headers: Object.fromEntries(headers),
        receivedAt: new Date().toISOString(),
      },
      { jobId }
    );
  } catch (error) {
    // Enqueue failed — event is NOT persisted anywhere.
    // Log full raw data so an operator can manually replay if needed.
    logger.error(
      {
        err: error,
        service: 'github',
        rawPayload: payload,
        headers: Object.fromEntries(headers),
      },
      'Failed to enqueue webhook job — event data preserved in log for manual recovery'
    );
    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});

// Registration order is the mechanism: this catch-all must stay LAST in this
// router. Hono matches handlers in registration order, so any webhook route
// added above it wins, and every unknown path under /webhooks/ answers a JSON
// 404 at the mount position instead of reaching the SPA fallback registered
// after the router. Scanners hit this path, so it returns directly: no throw,
// no logging.
webhooks.all('*', (c) => c.json({ error: 'Not Found' }, 404));

export { webhooks };
