/**
 * Management routes for inbound webhook endpoints, nested under their repository
 * (`/api/repositories/:repositoryId/inbound-webhook-endpoints`).
 *
 * Mounted inside the `/api` mount AFTER `.use('*', authMiddleware)`, as a second `/repositories`
 * router like `worktrees.ts`. Authorization is the existing authenticated-caller check and nothing
 * more: any authenticated member may list, create, edit, rotate and delete any repository's
 * endpoints (flat trust model).
 *
 * Repository scoping is in the repository's queries: an endpoint of another repository is a plain
 * 404 on every id-scoped route. List and create resolve the repository first.
 *
 * A generated signing secret leaves the server in exactly two responses: create and rotate. An
 * entered secret is never echoed back. Every other response is built from
 * `InboundWebhookEndpointView`, which does not carry a secret. Nothing here logs a secret or a
 * request body.
 */
import { Hono } from 'hono';
import {
  CreateInboundWebhookEndpointRequestSchema,
  RotateInboundWebhookSecretRequestSchema,
  UpdateInboundWebhookEndpointRequestSchema,
  type InboundWebhookEndpoint,
  type InboundWebhookEndpointWithSecretResponse,
} from '@agent-console/shared';
import type { AppBindings } from '../app-context.js';
import { NotFoundError } from '../lib/errors.js';
import { generateInboundWebhookSecret, previousSecretExpiryFrom } from '../lib/inbound-webhook-secret.js';
import { createLogger } from '../lib/logger.js';
import { vOptionalJsonValidator, vValidator } from '../middleware/validation.js';
import type { InboundWebhookEndpointView } from '../repositories/webhook-endpoint-repository.js';

const logger = createLogger('api:inbound-webhook-endpoints');

const ENDPOINT_NOT_FOUND = 'Inbound webhook endpoint';
const BASE = '/:repositoryId/inbound-webhook-endpoints';

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

/**
 * The create / rotate response. `generatedSecret` is set only when the server generated the secret;
 * an entered secret is never returned.
 */
function withSecretBody(
  endpoint: InboundWebhookEndpoint,
  generatedSecret: string | undefined,
): InboundWebhookEndpointWithSecretResponse {
  return generatedSecret === undefined
    ? { endpoint, secretSource: 'entered' }
    : { endpoint, secretSource: 'generated', secret: generatedSecret };
}

const inboundWebhookEndpoints = new Hono<AppBindings>()
  .get(BASE, async (c) => {
    const repositoryId = c.req.param('repositoryId');
    const { inboundWebhookEndpointRepository, repositoryManager } = c.get('appContext');
    if (!repositoryManager.getRepository(repositoryId)) throw new NotFoundError('Repository');

    const now = new Date();
    const views = await inboundWebhookEndpointRepository.list(repositoryId);
    return c.json({ endpoints: views.map((view) => toWireEndpoint(view, now)) });
  })
  .get(`${BASE}/:id`, async (c) => {
    const { inboundWebhookEndpointRepository } = c.get('appContext');
    const view = await inboundWebhookEndpointRepository.findById(c.req.param('repositoryId'), c.req.param('id'));
    if (!view) throw new NotFoundError(ENDPOINT_NOT_FOUND);
    return c.json({ endpoint: toWireEndpoint(view, new Date()) });
  })
  .post(BASE, vValidator(CreateInboundWebhookEndpointRequestSchema), async (c) => {
    const repositoryId = c.req.param('repositoryId');
    const body = c.req.valid('json');
    const { inboundWebhookEndpointRepository, repositoryManager } = c.get('appContext');
    if (!repositoryManager.getRepository(repositoryId)) throw new NotFoundError('Repository');

    const now = new Date();
    const secret = body.secret ?? generateInboundWebhookSecret();
    const created = await inboundWebhookEndpointRepository.create({
      id: crypto.randomUUID(),
      label: body.label,
      repositoryId,
      instructionText: body.instructionText,
      secret,
      now: now.toISOString(),
    });

    logger.info({ endpointId: created.id, repositoryId }, 'Inbound webhook endpoint created');
    return c.json(withSecretBody(toWireEndpoint(created, now), body.secret === undefined ? secret : undefined), 201);
  })
  .patch(`${BASE}/:id`, vValidator(UpdateInboundWebhookEndpointRequestSchema), async (c) => {
    const body = c.req.valid('json');
    const { inboundWebhookEndpointRepository } = c.get('appContext');

    const now = new Date();
    const view = await inboundWebhookEndpointRepository.update(
      c.req.param('repositoryId'),
      c.req.param('id'),
      body,
      now.toISOString(),
    );
    if (!view) throw new NotFoundError(ENDPOINT_NOT_FOUND);
    return c.json({ endpoint: toWireEndpoint(view, now) });
  })
  .delete(`${BASE}/:id`, async (c) => {
    const id = c.req.param('id');
    const { inboundWebhookEndpointRepository } = c.get('appContext');

    const deleted = await inboundWebhookEndpointRepository.delete(c.req.param('repositoryId'), id);
    if (!deleted) throw new NotFoundError(ENDPOINT_NOT_FOUND);

    logger.info({ endpointId: id }, 'Inbound webhook endpoint deleted');
    return c.json({ success: true });
  })
  .post(`${BASE}/:id/rotate-secret`, vOptionalJsonValidator(RotateInboundWebhookSecretRequestSchema), async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const { inboundWebhookEndpointRepository } = c.get('appContext');

    const now = new Date();
    const secret = body.secret ?? generateInboundWebhookSecret();
    const rotated = await inboundWebhookEndpointRepository.rotateSecret(
      c.req.param('repositoryId'),
      id,
      secret,
      previousSecretExpiryFrom(now),
      now.toISOString(),
    );
    if (!rotated) throw new NotFoundError(ENDPOINT_NOT_FOUND);

    logger.info({ endpointId: id }, 'Inbound webhook endpoint secret rotated');
    return c.json(withSecretBody(toWireEndpoint(rotated, now), body.secret === undefined ? secret : undefined));
  })
  .post(`${BASE}/:id/clear-previous-secret`, async (c) => {
    const id = c.req.param('id');
    const { inboundWebhookEndpointRepository } = c.get('appContext');

    const now = new Date();
    const view = await inboundWebhookEndpointRepository.clearPreviousSecret(
      c.req.param('repositoryId'),
      id,
      now.toISOString(),
    );
    if (!view) throw new NotFoundError(ENDPOINT_NOT_FOUND);

    logger.info({ endpointId: id }, 'Inbound webhook endpoint previous secret cleared');
    return c.json({ endpoint: toWireEndpoint(view, now) });
  });

export { inboundWebhookEndpoints };
