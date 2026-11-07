/**
 * Management routes for inbound webhook endpoints.
 *
 * Mounted inside the `/api` mount AFTER `.use('*', authMiddleware)`. Authorization is the existing
 * authenticated-caller check and nothing more: any authenticated member may list, create, edit,
 * rotate and delete any endpoint (flat trust model).
 *
 * The signing secret leaves the server in exactly two responses: create and rotate. Every other
 * response is built from `InboundWebhookEndpointView`, which does not carry it. Nothing here logs a
 * secret or a request body.
 */
import { Hono } from 'hono';
import {
  CreateInboundWebhookEndpointRequestSchema,
  UpdateInboundWebhookEndpointRequestSchema,
  type InboundWebhookEndpoint,
} from '@agent-console/shared';
import type { AppBindings } from '../app-context.js';
import { NotFoundError } from '../lib/errors.js';
import { generateInboundWebhookSecret, previousSecretExpiryFrom } from '../lib/inbound-webhook-secret.js';
import { createLogger } from '../lib/logger.js';
import { vValidator } from '../middleware/validation.js';
import type { InboundWebhookEndpointView } from '../repositories/webhook-endpoint-repository.js';

const logger = createLogger('api:inbound-webhook-endpoints');

const ENDPOINT_NOT_FOUND = 'Inbound webhook endpoint';

/**
 * The wire shape of a stored endpoint. A previous secret counts only while its expiry is in the
 * future; an expired one reads as absent (`hasPreviousSecret` false, expiry null).
 */
function toWireEndpoint(view: InboundWebhookEndpointView, now: Date): InboundWebhookEndpoint {
  const hasPreviousSecret =
    view.previousSecretExpiresAt !== null && Date.parse(view.previousSecretExpiresAt) > now.getTime();
  return {
    id: view.id,
    label: view.label,
    repositoryId: view.repositoryId,
    instructionText: view.instructionText,
    hasPreviousSecret,
    previousSecretExpiresAt: hasPreviousSecret ? view.previousSecretExpiresAt : null,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

const inboundWebhookEndpoints = new Hono<AppBindings>()
  .get('/', async (c) => {
    const { inboundWebhookEndpointRepository } = c.get('appContext');
    const now = new Date();
    const views = await inboundWebhookEndpointRepository.list();
    return c.json({ endpoints: views.map((view) => toWireEndpoint(view, now)) });
  })
  .get('/:id', async (c) => {
    const { inboundWebhookEndpointRepository } = c.get('appContext');
    const view = await inboundWebhookEndpointRepository.findById(c.req.param('id'));
    if (!view) throw new NotFoundError(ENDPOINT_NOT_FOUND);
    return c.json({ endpoint: toWireEndpoint(view, new Date()) });
  })
  .post('/', vValidator(CreateInboundWebhookEndpointRequestSchema), async (c) => {
    const body = c.req.valid('json');
    const { inboundWebhookEndpointRepository, repositoryManager } = c.get('appContext');

    if (!repositoryManager.getRepository(body.repositoryId)) {
      throw new NotFoundError('Repository');
    }

    const now = new Date();
    const created = await inboundWebhookEndpointRepository.create({
      id: crypto.randomUUID(),
      label: body.label,
      repositoryId: body.repositoryId,
      instructionText: body.instructionText,
      secret: generateInboundWebhookSecret(),
      now: now.toISOString(),
    });

    logger.info({ endpointId: created.id, repositoryId: created.repositoryId }, 'Inbound webhook endpoint created');
    return c.json({ endpoint: toWireEndpoint(created, now), secret: created.secret }, 201);
  })
  .patch('/:id', vValidator(UpdateInboundWebhookEndpointRequestSchema), async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const { inboundWebhookEndpointRepository } = c.get('appContext');

    const now = new Date();
    const view = await inboundWebhookEndpointRepository.update(id, body, now.toISOString());
    if (!view) throw new NotFoundError(ENDPOINT_NOT_FOUND);
    return c.json({ endpoint: toWireEndpoint(view, now) });
  })
  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    const { inboundWebhookEndpointRepository } = c.get('appContext');

    const deleted = await inboundWebhookEndpointRepository.delete(id);
    if (!deleted) throw new NotFoundError(ENDPOINT_NOT_FOUND);

    logger.info({ endpointId: id }, 'Inbound webhook endpoint deleted');
    return c.json({ success: true });
  })
  .post('/:id/rotate-secret', async (c) => {
    const id = c.req.param('id');
    const { inboundWebhookEndpointRepository } = c.get('appContext');

    const now = new Date();
    const rotated = await inboundWebhookEndpointRepository.rotateSecret(
      id,
      generateInboundWebhookSecret(),
      previousSecretExpiryFrom(now),
      now.toISOString(),
    );
    if (!rotated) throw new NotFoundError(ENDPOINT_NOT_FOUND);

    logger.info({ endpointId: id }, 'Inbound webhook endpoint secret rotated');
    return c.json({ endpoint: toWireEndpoint(rotated, now), secret: rotated.secret });
  })
  .post('/:id/clear-previous-secret', async (c) => {
    const id = c.req.param('id');
    const { inboundWebhookEndpointRepository } = c.get('appContext');

    const now = new Date();
    const view = await inboundWebhookEndpointRepository.clearPreviousSecret(id, now.toISOString());
    if (!view) throw new NotFoundError(ENDPOINT_NOT_FOUND);

    logger.info({ endpointId: id }, 'Inbound webhook endpoint previous secret cleared');
    return c.json({ endpoint: toWireEndpoint(view, now) });
  });

export { inboundWebhookEndpoints };
