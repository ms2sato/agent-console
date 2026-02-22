import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createLogger } from '../lib/logger.js';
import { serverConfig } from '../lib/server-config.js';
import { JOB_TYPES } from '../jobs/index.js';
import type { AppBindings } from '../app-context.js';

const logger = createLogger('webhooks');

const webhooks = new Hono<AppBindings>();

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
webhooks.post('/github',
  bodyLimit({
    maxSize: 1 * 1024 * 1024, // 1MB
    onError: (c) => {
      logger.warn('Webhook payload too large — dropping webhook');
      return c.json({ ok: true });
    },
  }) as MiddlewareHandler<AppBindings>,
  async (c) => {
  if (!serverConfig.GITHUB_WEBHOOK_SECRET) {
    logger.warn('GitHub webhook secret not configured — dropping webhook');
    return c.json({ ok: true });
  }

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

export { webhooks };
