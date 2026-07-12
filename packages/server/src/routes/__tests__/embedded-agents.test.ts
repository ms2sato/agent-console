import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Hono } from 'hono';
import type { AppBindings } from '../../app-context.js';
import {
  setupTestEnvironment,
  cleanupTestEnvironment,
  createTestApp,
  TEST_AUTH_USER,
} from '../../__tests__/test-utils.js';

// ---------------------------------------------------------------------------
// Mock services
// ---------------------------------------------------------------------------

const embeddedAgentManager = {
  getAllEmbeddedAgents: mock(() => [] as any[]),
  getEmbeddedAgent: mock(() => undefined as any),
  createEmbeddedAgent: mock(() => Promise.resolve({} as any)),
  updateEmbeddedAgent: mock(() => Promise.resolve(undefined as any)),
  deleteEmbeddedAgent: mock(() => Promise.resolve(true)),
};

const sessionManager = {
  getAllSessions: mock(() => [] as any[]),
  getAllPersistedSessions: mock(() => Promise.resolve([] as any[])),
};

const VALID_PROVIDER = {
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen3:32b',
};

/** A definition created by the harness's authenticated user (the owner). */
function ownedDefinition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'def-1',
    name: 'Ollama',
    provider: VALID_PROVIDER,
    createdBy: TEST_AUTH_USER.id,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('Embedded Agents API', () => {
  let app: Hono<AppBindings>;

  beforeEach(async () => {
    await setupTestEnvironment();
    app = await createTestApp({
      embeddedAgentManager: embeddedAgentManager as any,
      sessionManager: sessionManager as any,
    });

    embeddedAgentManager.getAllEmbeddedAgents.mockReset();
    embeddedAgentManager.getEmbeddedAgent.mockReset();
    embeddedAgentManager.createEmbeddedAgent.mockReset();
    embeddedAgentManager.updateEmbeddedAgent.mockReset();
    embeddedAgentManager.deleteEmbeddedAgent.mockReset();
    sessionManager.getAllSessions.mockReset();
    sessionManager.getAllPersistedSessions.mockReset();
  });

  afterEach(async () => {
    await cleanupTestEnvironment();
  });

  // =========================================================================
  // GET /api/embedded-agents
  // =========================================================================

  describe('GET /api/embedded-agents', () => {
    it('returns an empty list', async () => {
      embeddedAgentManager.getAllEmbeddedAgents.mockReturnValue([]);

      const res = await app.request('/api/embedded-agents');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { embeddedAgents: unknown[] };
      expect(body.embeddedAgents).toEqual([]);
    });
  });

  // =========================================================================
  // POST /api/embedded-agents
  // =========================================================================

  describe('POST /api/embedded-agents', () => {
    it('creates a definition with createdBy from the authenticated user (201)', async () => {
      const created = ownedDefinition();
      embeddedAgentManager.createEmbeddedAgent.mockReturnValue(Promise.resolve(created));

      const res = await app.request('/api/embedded-agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Ollama', provider: VALID_PROVIDER }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { embeddedAgent: { id: string } };
      expect(body.embeddedAgent.id).toBe('def-1');

      // createdBy is threaded from the authenticated user, not from the body.
      expect(embeddedAgentManager.createEmbeddedAgent).toHaveBeenCalledWith(
        { name: 'Ollama', provider: VALID_PROVIDER },
        TEST_AUTH_USER.id
      );
    });

    it('rejects a body carrying an extra createdBy key (400, strict schema)', async () => {
      const res = await app.request('/api/embedded-agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Ollama',
          provider: VALID_PROVIDER,
          createdBy: 'attacker',
        }),
      });

      expect(res.status).toBe(400);
      expect(embeddedAgentManager.createEmbeddedAgent).not.toHaveBeenCalled();
    });

    it('rejects an invalid provider baseUrl (400)', async () => {
      const res = await app.request('/api/embedded-agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'X', provider: { baseUrl: 'not-a-url', model: 'm' } }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects a body with a duplicate tool name in enabledTools (400)', async () => {
      const res = await app.request('/api/embedded-agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'X',
          provider: VALID_PROVIDER,
          enabledTools: ['Read', 'Read'],
        }),
      });

      expect(res.status).toBe(400);
      expect(embeddedAgentManager.createEmbeddedAgent).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // PATCH /api/embedded-agents/:id
  // =========================================================================

  describe('PATCH /api/embedded-agents/:id', () => {
    it('updates when the requester is the creator', async () => {
      embeddedAgentManager.getEmbeddedAgent.mockReturnValue(ownedDefinition());
      embeddedAgentManager.updateEmbeddedAgent.mockReturnValue(
        Promise.resolve(ownedDefinition({ name: 'Renamed' }))
      );

      const res = await app.request('/api/embedded-agents/def-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { embeddedAgent: { name: string } };
      expect(body.embeddedAgent.name).toBe('Renamed');
    });

    it('returns 403 when the requester is not the creator', async () => {
      embeddedAgentManager.getEmbeddedAgent.mockReturnValue(
        ownedDefinition({ createdBy: 'someone-else' })
      );

      const res = await app.request('/api/embedded-agents/def-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });

      expect(res.status).toBe(403);
      expect(embeddedAgentManager.updateEmbeddedAgent).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown id', async () => {
      embeddedAgentManager.getEmbeddedAgent.mockReturnValue(undefined);

      const res = await app.request('/api/embedded-agents/nope', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });

      expect(res.status).toBe(404);
    });

    it('returns 400 for an invalid body', async () => {
      const res = await app.request('/api/embedded-agents/def-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 123 }),
      });

      expect(res.status).toBe(400);
    });

    it('accepts enabledTools: null (clear to default)', async () => {
      embeddedAgentManager.getEmbeddedAgent.mockReturnValue(ownedDefinition({ enabledTools: ['Read'] }));
      embeddedAgentManager.updateEmbeddedAgent.mockReturnValue(
        Promise.resolve(ownedDefinition({ enabledTools: undefined }))
      );

      const res = await app.request('/api/embedded-agents/def-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledTools: null }),
      });

      expect(res.status).toBe(200);
      expect(embeddedAgentManager.updateEmbeddedAgent).toHaveBeenCalledWith('def-1', {
        enabledTools: null,
      });
    });

    it('rejects a body with a duplicate tool name in enabledTools (400)', async () => {
      embeddedAgentManager.getEmbeddedAgent.mockReturnValue(ownedDefinition());

      const res = await app.request('/api/embedded-agents/def-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledTools: ['Grep', 'Grep'] }),
      });

      expect(res.status).toBe(400);
      expect(embeddedAgentManager.updateEmbeddedAgent).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // enabledTools — POST then PATCH wire-level round trip (Q10)
  // =========================================================================

  describe('enabledTools POST -> PATCH wire round trip', () => {
    it('a value set via POST survives serialization through the schema, and PATCH can then replace it', async () => {
      // POST: the request body's enabledTools must pass CreateEmbeddedAgentRequestSchema
      // and be forwarded to the manager unchanged.
      const created = ownedDefinition({ enabledTools: ['Read', 'Glob'] });
      embeddedAgentManager.createEmbeddedAgent.mockReturnValue(Promise.resolve(created));

      const postRes = await app.request('/api/embedded-agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Ollama', provider: VALID_PROVIDER, enabledTools: ['Read', 'Glob'] }),
      });

      expect(postRes.status).toBe(201);
      const postBody = (await postRes.json()) as { embeddedAgent: { enabledTools?: string[] } };
      expect(postBody.embeddedAgent.enabledTools).toEqual(['Read', 'Glob']);
      expect(embeddedAgentManager.createEmbeddedAgent).toHaveBeenCalledWith(
        { name: 'Ollama', provider: VALID_PROVIDER, enabledTools: ['Read', 'Glob'] },
        TEST_AUTH_USER.id
      );

      // PATCH: replace the value; the response reflects the new value end-to-end.
      embeddedAgentManager.getEmbeddedAgent.mockReturnValue(created);
      const patched = ownedDefinition({ enabledTools: ['Grep'] });
      embeddedAgentManager.updateEmbeddedAgent.mockReturnValue(Promise.resolve(patched));

      const patchRes = await app.request('/api/embedded-agents/def-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledTools: ['Grep'] }),
      });

      expect(patchRes.status).toBe(200);
      const patchBody = (await patchRes.json()) as { embeddedAgent: { enabledTools?: string[] } };
      expect(patchBody.embeddedAgent.enabledTools).toEqual(['Grep']);
      expect(embeddedAgentManager.updateEmbeddedAgent).toHaveBeenCalledWith('def-1', {
        enabledTools: ['Grep'],
      });
    });
  });

  // =========================================================================
  // DELETE /api/embedded-agents/:id
  // =========================================================================

  describe('DELETE /api/embedded-agents/:id', () => {
    it('deletes when the requester is the creator', async () => {
      embeddedAgentManager.getEmbeddedAgent.mockReturnValue(ownedDefinition());
      sessionManager.getAllSessions.mockReturnValue([]);
      sessionManager.getAllPersistedSessions.mockReturnValue(Promise.resolve([]));
      embeddedAgentManager.deleteEmbeddedAgent.mockReturnValue(Promise.resolve(true));

      const res = await app.request('/api/embedded-agents/def-1', { method: 'DELETE' });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);
      expect(embeddedAgentManager.deleteEmbeddedAgent).toHaveBeenCalledWith('def-1');
    });

    it('returns 403 when the requester is not the creator', async () => {
      embeddedAgentManager.getEmbeddedAgent.mockReturnValue(
        ownedDefinition({ createdBy: 'someone-else' })
      );

      const res = await app.request('/api/embedded-agents/def-1', { method: 'DELETE' });

      expect(res.status).toBe(403);
      expect(embeddedAgentManager.deleteEmbeddedAgent).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown id', async () => {
      embeddedAgentManager.getEmbeddedAgent.mockReturnValue(undefined);

      const res = await app.request('/api/embedded-agents/nope', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });

    it('warns but still succeeds when a worker references the definition', async () => {
      embeddedAgentManager.getEmbeddedAgent.mockReturnValue(ownedDefinition());
      // An active session with an embedded-agent worker referencing def-1.
      sessionManager.getAllSessions.mockReturnValue([
        {
          id: 's1',
          title: 'Live',
          workers: [{ type: 'embedded-agent', embeddedAgentId: 'def-1' }],
        },
      ]);
      sessionManager.getAllPersistedSessions.mockReturnValue(Promise.resolve([]));
      embeddedAgentManager.deleteEmbeddedAgent.mockReturnValue(Promise.resolve(true));

      const res = await app.request('/api/embedded-agents/def-1', { method: 'DELETE' });

      // Deletion proceeds (warns, does not block with 409).
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);
      expect(embeddedAgentManager.deleteEmbeddedAgent).toHaveBeenCalledWith('def-1');
    });
  });
});
