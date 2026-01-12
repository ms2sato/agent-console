import { Hono } from 'hono';
import { createLogger } from '../lib/logger.js';
import { serverConfig } from '../lib/server-config.js';
import { JOB_TYPES } from '../jobs/index.js';
import type { AppBindings } from '../app-context.js';

const logger = createLogger('webhooks');

const webhooks = new Hono<AppBindings>();

/**
 * GitHub webhook endpoint.
 *
 * Authentication:
 * - Returns 403 if webhook secret is not configured
 * - Returns 401 if signature verification fails (allows GitHub to retry with backoff)
 *
 * Processing:
 * - Returns 500 if job enqueue fails (allows GitHub to retry)
 * - Returns 200 on successful enqueue
 *
 * Note: Consider adding rate limiting at the infrastructure level (e.g., nginx, cloudflare)
 * to protect against webhook replay attacks.
 */
webhooks.post('/github', async (c) => {
  if (!serverConfig.GITHUB_WEBHOOK_SECRET) {
    logger.warn('GitHub webhook secret not configured');
    return c.json({ ok: false }, 403);
  }

  const appContext = c.get('appContext');
  const parser = appContext.inboundIntegration.parserRegistry.get('github');
  if (!parser) {
    logger.warn('GitHub webhook parser not registered');
    return c.json({ error: 'Service unavailable' }, 503);
  }

  const payload = await c.req.text();
  const headers = c.req.raw.headers;

  const authenticated = await parser.authenticate(payload, headers);
  if (!authenticated) {
    // Return 401 Unauthorized so GitHub knows to retry with proper credentials
    // or investigate the signature mismatch. Returning 200 would silently drop
    // legitimate webhooks with signature issues.
    logger.warn('GitHub webhook authentication failed');
    return c.json({ error: 'Unauthorized' }, 401);
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
    // Return 500 so GitHub will retry the webhook delivery.
    // Silent success on enqueue failure would cause data loss.
    logger.error({ err: error }, 'Failed to enqueue inbound webhook job');
    return c.json({ error: 'Internal server error' }, 500);
  }

  return c.json({ ok: true });
});

export { webhooks };
