import { Hono } from 'hono';
import { createLogger } from '../lib/logger.js';
import { getJobQueue, JOB_TYPES } from '../jobs/index.js';
import { getServiceParser } from '../services/inbound/parser-registry.js';

const logger = createLogger('webhooks');

const webhooks = new Hono();

webhooks.post('/github', async (c) => {
  const parser = getServiceParser('github');
  if (!parser) {
    logger.warn('GitHub webhook parser not registered');
    return c.json({ ok: true });
  }

  const payload = await c.req.text();
  const headers = c.req.raw.headers;

  const authenticated = await parser.authenticate(payload, headers);
  if (!authenticated) {
    logger.warn('GitHub webhook authentication failed');
    return c.json({ ok: true });
  }

  const jobQueue = getJobQueue();
  const jobId = crypto.randomUUID();

  try {
    await jobQueue.enqueue(
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
    logger.warn({ err: error }, 'Failed to enqueue inbound webhook job');
  }

  return c.json({ ok: true });
});

export { webhooks };
