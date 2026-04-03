import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Hono } from 'hono';
import type { AppBindings } from '../../app-context.js';
import { setupTestEnvironment, cleanupTestEnvironment, createTestApp } from '../../__tests__/test-utils.js';

// ---------------------------------------------------------------------------
// Mock services
// ---------------------------------------------------------------------------

const agentManager = {
  getAgent: mock(() => undefined as any),
  getAllAgents: mock(() => []),
  registerAgent: mock(() => Promise.resolve({} as any)),
  updateAgent: mock(() => Promise.resolve(undefined as any)),
  unregisterAgent: mock(() => Promise.resolve(true)),
};

const sessionManager = {
  getSessionsUsingAgent: mock(() => [] as any[]),
  getAllPersistedSessions: mock(() => Promise.resolve([] as any[])),
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Agents API', () => {
  let app: Hono<AppBindings>;

  beforeEach(async () => {
    await setupTestEnvironment();
    app = await createTestApp({ agentManager: agentManager as any, sessionManager: sessionManager as any });

    // Reset all mocks
    agentManager.getAgent.mockReset();
    agentManager.getAllAgents.mockReset();
    agentManager.registerAgent.mockReset();
    agentManager.updateAgent.mockReset();
    agentManager.unregisterAgent.mockReset();
    sessionManager.getSessionsUsingAgent.mockReset();
    sessionManager.getAllPersistedSessions.mockReset();
  });

  afterEach(async () => {
    await cleanupTestEnvironment();
  });

  // =========================================================================
  // DELETE /api/agents/:id
  // =========================================================================

  describe('DELETE /api/agents/:id', () => {
    it('should return 400 for built-in agent', async () => {
      agentManager.getAgent.mockReturnValue({ id: 'test', isBuiltIn: true });

      const res = await app.request('/api/agents/test', { method: 'DELETE' });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Built-in agents cannot be deleted');
    });

    it('should return 409 when agent has active sessions', async () => {
      agentManager.getAgent.mockReturnValue({ id: 'test', isBuiltIn: false });
      sessionManager.getSessionsUsingAgent.mockReturnValue([{ id: 's1', title: 'Session 1' }]);
      sessionManager.getAllPersistedSessions.mockReturnValue(Promise.resolve([]));

      const res = await app.request('/api/agents/test', { method: 'DELETE' });
      expect(res.status).toBe(409);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Agent is in use by 1 session(s) (active)');
    });

    it('should return 409 when agent has persisted (inactive) sessions', async () => {
      agentManager.getAgent.mockReturnValue({ id: 'test', isBuiltIn: false });
      sessionManager.getSessionsUsingAgent.mockReturnValue([]);
      sessionManager.getAllPersistedSessions.mockReturnValue(
        Promise.resolve([{ id: 's2', title: 'Paused Session', workers: [{ type: 'agent', agentId: 'test' }] }])
      );

      const res = await app.request('/api/agents/test', { method: 'DELETE' });
      expect(res.status).toBe(409);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Agent is in use by 1 session(s) (inactive)');
    });

    it('should successfully delete an unused agent', async () => {
      agentManager.getAgent.mockReturnValue({ id: 'test', isBuiltIn: false });
      sessionManager.getSessionsUsingAgent.mockReturnValue([]);
      sessionManager.getAllPersistedSessions.mockReturnValue(Promise.resolve([]));
      agentManager.unregisterAgent.mockReturnValue(Promise.resolve(true));

      const res = await app.request('/api/agents/test', { method: 'DELETE' });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);
    });
  });

  // =========================================================================
  // PATCH /api/agents/:id
  // =========================================================================

  describe('PATCH /api/agents/:id', () => {
    it('should return 400 for invalid body', async () => {
      const res = await app.request('/api/agents/test', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 123 }),
      });

      expect(res.status).toBe(400);
    });

    it('should successfully update an agent with valid body', async () => {
      const updatedAgent = { id: 'test', name: 'Updated Agent', commandTemplate: 'cmd {{prompt}}' };
      agentManager.updateAgent.mockReturnValue(Promise.resolve(updatedAgent));

      const res = await app.request('/api/agents/test', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated Agent' }),
      });

      expect(res.status).toBe(200);

      const body = (await res.json()) as { agent: { id: string; name: string } };
      expect(body.agent.name).toBe('Updated Agent');
    });

    it('should return 404 when agent does not exist', async () => {
      agentManager.updateAgent.mockReturnValue(Promise.resolve(undefined));

      const res = await app.request('/api/agents/nonexistent', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      });

      expect(res.status).toBe(404);
    });
  });
});
