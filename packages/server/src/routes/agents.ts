import { Hono } from 'hono';
import {
  CreateAgentRequestSchema,
  UpdateAgentRequestSchema,
} from '@agent-console/shared';
import { getSessionManager } from '../services/session-manager.js';
import { getAgentManager } from '../services/agent-manager.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { vValidator } from '../middleware/validation.js';
import type { AppBindings } from '../app-context.js';

const agents = new Hono<AppBindings>()
  // Get all agents
  .get('/', async (c) => {
    const agentManager = await getAgentManager();
    const agentList = agentManager.getAllAgents();
    return c.json({ agents: agentList });
  })
  // Get a single agent
  .get('/:id', async (c) => {
    const agentId = c.req.param('id');
    const agentManager = await getAgentManager();
    const agent = agentManager.getAgent(agentId);

    if (!agent) {
      throw new NotFoundError('Agent');
    }

    return c.json({ agent });
  })
  // Register a new agent
  .post('/', vValidator(CreateAgentRequestSchema), async (c) => {
    const body = c.req.valid('json');
    const agentManager = await getAgentManager();

    const agent = await agentManager.registerAgent(body);

    return c.json({ agent }, 201);
  })
  // Update an agent
  .patch('/:id', vValidator(UpdateAgentRequestSchema), async (c) => {
    const agentId = c.req.param('id');
    const body = c.req.valid('json');
    const agentManager = await getAgentManager();

    const agent = await agentManager.updateAgent(agentId, body);

    if (!agent) {
      throw new NotFoundError('Agent');
    }

    return c.json({ agent });
  })
  // Delete an agent
  .delete('/:id', async (c) => {
    const agentId = c.req.param('id');
    const agentManager = await getAgentManager();

    // Check if agent exists
    const agent = agentManager.getAgent(agentId);
    if (!agent) {
      throw new NotFoundError('Agent');
    }

    // Built-in agents cannot be deleted
    if (agent.isBuiltIn) {
      throw new ValidationError('Built-in agents cannot be deleted');
    }

    // Check if agent is in use by any active sessions
    const sessionManager = getSessionManager();
    const activeSessions = sessionManager.getSessionsUsingAgent(agentId);
    const activeSessionIds = new Set(activeSessions.map(s => s.id));

    // Also check persisted (inactive) sessions
    const persistedSessions = await sessionManager.getAllPersistedSessions();
    const inactiveSessions = persistedSessions.filter(ps =>
      !activeSessionIds.has(ps.id) &&
      ps.workers.some(w => w.type === 'agent' && w.agentId === agentId)
    );

    const totalCount = activeSessions.length + inactiveSessions.length;
    if (totalCount > 0) {
      const activeNames = activeSessions.map(s => s.title || s.id);
      const inactiveNames = inactiveSessions.map(s => s.title || s.id);
      const allNames = [...activeNames, ...inactiveNames].join(', ');

      const details = activeSessions.length > 0 && inactiveSessions.length > 0
        ? ` (${activeSessions.length} active, ${inactiveSessions.length} inactive)`
        : activeSessions.length > 0 ? ' (active)' : ' (inactive)';

      throw new ConflictError(
        `Agent is in use by ${totalCount} session(s)${details}: ${allNames}`
      );
    }

    const success = await agentManager.unregisterAgent(agentId);

    if (!success) {
      // Agent was likely deleted between the check and unregister (race condition)
      // Return 404 for idempotent behavior
      throw new NotFoundError('Agent');
    }

    return c.json({ success: true });
  });

export { agents };
