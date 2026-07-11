import { Hono } from 'hono';
import {
  CreateEmbeddedAgentRequestSchema,
  UpdateEmbeddedAgentRequestSchema,
} from '@agent-console/shared';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import { vValidator } from '../middleware/validation.js';
import { createLogger } from '../lib/logger.js';
import type { AppBindings } from '../app-context.js';

const logger = createLogger('embedded-agents-route');

const embeddedAgents = new Hono<AppBindings>()
  // List all embedded-agent definitions (shared resource, any authenticated user)
  .get('/', async (c) => {
    const { embeddedAgentManager } = c.get('appContext');
    const embeddedAgentList = embeddedAgentManager.getAllEmbeddedAgents();
    return c.json({ embeddedAgents: embeddedAgentList });
  })
  // Create a new embedded-agent definition
  .post('/', vValidator(CreateEmbeddedAgentRequestSchema), async (c) => {
    const body = c.req.valid('json');
    const { embeddedAgentManager } = c.get('appContext');
    const authUser = c.get('authUser');

    // createdBy is set server-side from the authenticated user, never from body.
    const embeddedAgent = await embeddedAgentManager.createEmbeddedAgent(body, authUser.id);

    return c.json({ embeddedAgent }, 201);
  })
  // Update an embedded-agent definition (creator only)
  .patch('/:id', vValidator(UpdateEmbeddedAgentRequestSchema), async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const { embeddedAgentManager } = c.get('appContext');
    const authUser = c.get('authUser');

    const existing = embeddedAgentManager.getEmbeddedAgent(id);
    if (!existing) {
      throw new NotFoundError('Embedded agent');
    }

    // Ownership: only the creator may modify. In single-user mode there is only
    // one user id, so the check is trivially satisfied.
    if (existing.createdBy !== authUser.id) {
      throw new ForbiddenError('Only the creator can modify this embedded agent');
    }

    const embeddedAgent = await embeddedAgentManager.updateEmbeddedAgent(id, body);

    if (!embeddedAgent) {
      throw new NotFoundError('Embedded agent');
    }

    return c.json({ embeddedAgent });
  })
  // Delete an embedded-agent definition (creator only)
  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    const { embeddedAgentManager, sessionManager } = c.get('appContext');
    const authUser = c.get('authUser');

    const existing = embeddedAgentManager.getEmbeddedAgent(id);
    if (!existing) {
      throw new NotFoundError('Embedded agent');
    }

    // Ownership: only the creator may delete. Trivially satisfied in single-user mode.
    if (existing.createdBy !== authUser.id) {
      throw new ForbiddenError('Only the creator can delete this embedded agent');
    }

    // Unlike terminal agents (which block deletion when in use), embedded-agent
    // deletion WARNS but proceeds. Activation of any worker referencing this
    // dangling id will fail with a clear error at activation time.
    const activeSessions = sessionManager.getAllSessions();
    const referencingActive = activeSessions.filter((s) =>
      s.workers.some((w) => w.type === 'embedded-agent' && w.embeddedAgentId === id)
    );

    const persistedSessions = await sessionManager.getAllPersistedSessions();
    const activeIds = new Set(activeSessions.map((s) => s.id));
    const referencingPersisted = persistedSessions.filter(
      (ps) =>
        !activeIds.has(ps.id) &&
        ps.workers.some((w) => w.type === 'embedded-agent' && w.embeddedAgentId === id)
    );

    const referencingCount = referencingActive.length + referencingPersisted.length;
    if (referencingCount > 0) {
      logger.warn(
        {
          embeddedAgentId: id,
          activeSessionCount: referencingActive.length,
          persistedSessionCount: referencingPersisted.length,
        },
        'Deleting embedded-agent definition with live worker references; activation of those workers will fail with a dangling id'
      );
    }

    const success = await embeddedAgentManager.deleteEmbeddedAgent(id);

    if (!success) {
      // Deleted between the existence check and delete (race). Return 404 for
      // idempotent behavior.
      throw new NotFoundError('Embedded agent');
    }

    return c.json({ success: true });
  });

export { embeddedAgents };
