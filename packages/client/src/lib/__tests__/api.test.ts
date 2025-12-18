import { describe, it, expect as bunExpect, mock, beforeEach, afterAll } from 'bun:test';
import {
  fetchConfig,
  createSession,
  getSession,
  deleteSession,
  createWorker,
  deleteWorker,
  restartAgentWorker,
  fetchRepositories,
  registerRepository,
  unregisterRepository,
  fetchWorktrees,
  fetchBranches,
  ServerUnavailableError,
} from '../api';

// Workaround: Bun's expect is stricter than vitest's for toEqual type checking
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const expect = (value: unknown): any => bunExpect(value);

// Save original fetch and set up mock
const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response()));
globalThis.fetch = mockFetch as unknown as typeof fetch;

// Restore original fetch after all tests
afterAll(() => {
  globalThis.fetch = originalFetch;
});

// Helper to create mock Response
function createMockResponse(body: unknown, options: { status?: number; ok?: boolean } = {}) {
  const { status = 200, ok = true } = options;
  return {
    ok,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: mock(() => Promise.resolve(body)),
  } as unknown as Response;
}

describe('API Client', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('fetchConfig', () => {
    it('should fetch config successfully', async () => {
      const mockConfig = { homeDir: '/home/user' };
      mockFetch.mockResolvedValue(createMockResponse(mockConfig));

      const result = await fetchConfig();

      expect(fetch).toHaveBeenCalledWith('/api/config');
      expect(result).toEqual(mockConfig);
    });

    it('should throw error on failure', async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({}, { status: 500, ok: false })
      );

      await expect(fetchConfig()).rejects.toThrow('Failed to fetch config');
    });
  });

  describe('createSession', () => {
    it('should create worktree session', async () => {
      const mockSession = { session: { id: '1', type: 'worktree' } };
      mockFetch.mockResolvedValue(createMockResponse(mockSession));

      const result = await createSession({
        type: 'worktree',
        repositoryId: 'repo-1',
        worktreeId: 'main',
        locationPath: '/path/to/worktree',
      });

      expect(fetch).toHaveBeenCalledWith('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'worktree',
          repositoryId: 'repo-1',
          worktreeId: 'main',
          locationPath: '/path/to/worktree',
        }),
      });
      expect(result).toEqual(mockSession);
    });

    it('should create quick session', async () => {
      const mockSession = { session: { id: '1', type: 'quick' } };
      mockFetch.mockResolvedValue(createMockResponse(mockSession));

      const result = await createSession({
        type: 'quick',
        locationPath: '/path/to/project',
      });

      expect(fetch).toHaveBeenCalledWith('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'quick',
          locationPath: '/path/to/project',
        }),
      });
      expect(result).toEqual(mockSession);
    });

    it('should extract error message from JSON response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({ error: 'Detailed error message' })),
      } as unknown as Response);

      await expect(createSession({ type: 'quick', locationPath: '/path' })).rejects.toThrow('Detailed error message');
    });

    it('should fall back to statusText when JSON parsing fails', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: mock(() => Promise.reject(new Error('Parse error'))),
      } as unknown as Response);

      await expect(createSession({ type: 'quick', locationPath: '/path' })).rejects.toThrow('Internal Server Error');
    });
  });

  describe('getSession', () => {
    it('should return session when exists', async () => {
      const mockSession = { session: { id: '1', type: 'worktree', status: 'active' } };
      mockFetch.mockResolvedValue(createMockResponse(mockSession));

      const result = await getSession('session-id');

      expect(result).toEqual(mockSession.session);
    });

    it('should return null when session not found (404)', async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({}, { status: 404, ok: false })
      );

      const result = await getSession('non-existent');

      expect(result).toBeNull();
    });

    it('should throw ServerUnavailableError on 5xx errors', async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({}, { status: 500, ok: false })
      );

      await expect(getSession('session-id')).rejects.toThrow(ServerUnavailableError);
    });

    it('should throw ServerUnavailableError on network error', async () => {
      mockFetch.mockRejectedValue(new TypeError('Network error'));

      await expect(getSession('session-id')).rejects.toThrow(ServerUnavailableError);
    });
  });

  describe('deleteSession', () => {
    it('should delete session successfully', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await deleteSession('session-id');

      expect(fetch).toHaveBeenCalledWith('/api/sessions/session-id', {
        method: 'DELETE',
      });
    });
  });

  describe('createWorker', () => {
    // Note: Client API only supports creating terminal workers
    // Agent workers are created automatically by the server during session creation

    it('should create terminal worker', async () => {
      const mockWorker = { worker: { id: 'worker-2', type: 'terminal', name: 'Shell 1' } };
      mockFetch.mockResolvedValue(createMockResponse(mockWorker));

      const result = await createWorker('session-id', { type: 'terminal', name: 'Shell 1' });

      expect(fetch).toHaveBeenCalledWith('/api/sessions/session-id/workers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'terminal', name: 'Shell 1' }),
      });
      expect(result).toEqual(mockWorker);
    });
  });

  describe('deleteWorker', () => {
    it('should delete worker successfully', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await deleteWorker('session-id', 'worker-id');

      expect(fetch).toHaveBeenCalledWith('/api/sessions/session-id/workers/worker-id', {
        method: 'DELETE',
      });
    });
  });

  describe('restartAgentWorker', () => {
    it('should restart agent worker', async () => {
      const mockWorker = { worker: { id: 'worker-1', type: 'agent', name: 'Claude' } };
      mockFetch.mockResolvedValue(createMockResponse(mockWorker));

      const result = await restartAgentWorker('session-id', 'worker-id', true);

      expect(fetch).toHaveBeenCalledWith('/api/sessions/session-id/workers/worker-id/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ continueConversation: true }),
      });
      expect(result).toEqual(mockWorker);
    });
  });

  describe('fetchRepositories', () => {
    it('should fetch repositories successfully', async () => {
      const mockRepos = { repositories: [{ id: '1', name: 'repo1' }] };
      mockFetch.mockResolvedValue(createMockResponse(mockRepos));

      const result = await fetchRepositories();

      expect(fetch).toHaveBeenCalledWith('/api/repositories');
      expect(result).toEqual(mockRepos);
    });
  });

  describe('registerRepository', () => {
    it('should register repository successfully', async () => {
      const mockRepo = { repository: { id: '1', name: 'repo', path: '/path' } };
      mockFetch.mockResolvedValue(createMockResponse(mockRepo));

      const result = await registerRepository('/path/to/repo');

      expect(fetch).toHaveBeenCalledWith('/api/repositories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/path/to/repo' }),
      });
      expect(result).toEqual(mockRepo);
    });

    it('should throw error with message from response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({ error: 'Not a git repository' })),
      } as unknown as Response);

      await expect(registerRepository('/not/git')).rejects.toThrow('Not a git repository');
    });
  });

  describe('unregisterRepository', () => {
    it('should unregister repository successfully', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await unregisterRepository('repo-id');

      expect(fetch).toHaveBeenCalledWith('/api/repositories/repo-id', {
        method: 'DELETE',
      });
    });
  });

  describe('fetchWorktrees', () => {
    it('should fetch worktrees successfully', async () => {
      const mockWorktrees = { worktrees: [{ path: '/path', branch: 'main' }] };
      mockFetch.mockResolvedValue(createMockResponse(mockWorktrees));

      const result = await fetchWorktrees('repo-id');

      expect(fetch).toHaveBeenCalledWith('/api/repositories/repo-id/worktrees');
      expect(result).toEqual(mockWorktrees);
    });
  });

  describe('fetchBranches', () => {
    it('should fetch branches successfully', async () => {
      const mockBranches = { local: ['main'], remote: ['origin/main'], defaultBranch: 'main' };
      mockFetch.mockResolvedValue(createMockResponse(mockBranches));

      const result = await fetchBranches('repo-id');

      expect(fetch).toHaveBeenCalledWith('/api/repositories/repo-id/branches');
      expect(result).toEqual(mockBranches);
    });
  });

  describe('createWorktree', () => {
    it('should create worktree successfully with custom mode', async () => {
      const { createWorktree } = await import('../api');
      const mockResponse = {
        worktree: { path: '/path/to/worktree', branch: 'feature-1' },
        session: null,
      };
      mockFetch.mockResolvedValue(createMockResponse(mockResponse));

      const result = await createWorktree('repo-id', { mode: 'custom', branch: 'feature-1' });

      expect(fetch).toHaveBeenCalledWith('/api/repositories/repo-id/worktrees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'custom', branch: 'feature-1' }),
      });
      expect(result).toEqual(mockResponse);
    });

    it('should throw error on failure', async () => {
      const { createWorktree } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({ error: 'Branch already exists' })),
      } as unknown as Response);

      await expect(createWorktree('repo-id', { mode: 'custom', branch: 'existing' })).rejects.toThrow(
        'Branch already exists'
      );
    });
  });

  describe('deleteWorktree', () => {
    it('should delete worktree successfully', async () => {
      const { deleteWorktree } = await import('../api');
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await deleteWorktree('repo-id', '/path/to/worktree');

      expect(fetch).toHaveBeenCalledWith(
        '/api/repositories/repo-id/worktrees/%2Fpath%2Fto%2Fworktree',
        { method: 'DELETE' }
      );
    });

    it('should include force flag when specified', async () => {
      const { deleteWorktree } = await import('../api');
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await deleteWorktree('repo-id', '/path/to/worktree', true);

      expect(fetch).toHaveBeenCalledWith(
        '/api/repositories/repo-id/worktrees/%2Fpath%2Fto%2Fworktree?force=true',
        { method: 'DELETE' }
      );
    });

    it('should throw error on failure', async () => {
      const { deleteWorktree } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({ error: 'Worktree has uncommitted changes' })),
      } as unknown as Response);

      await expect(deleteWorktree('repo-id', '/path')).rejects.toThrow(
        'Worktree has uncommitted changes'
      );
    });
  });

  describe('fetchAgents', () => {
    it('should fetch agents successfully', async () => {
      const { fetchAgents } = await import('../api');
      const mockAgents = {
        agents: [
          { id: 'claude-code', name: 'Claude Code', command: 'claude', isBuiltIn: true },
        ],
      };
      mockFetch.mockResolvedValue(createMockResponse(mockAgents));

      const result = await fetchAgents();

      expect(fetch).toHaveBeenCalledWith('/api/agents');
      expect(result).toEqual(mockAgents);
    });

    it('should throw error on failure', async () => {
      const { fetchAgents } = await import('../api');
      mockFetch.mockResolvedValue(
        createMockResponse({}, { status: 500, ok: false })
      );

      await expect(fetchAgents()).rejects.toThrow('Failed to fetch agents');
    });
  });

  describe('fetchAgent', () => {
    it('should fetch agent by id', async () => {
      const { fetchAgent } = await import('../api');
      const mockAgent = {
        agent: { id: 'claude-code', name: 'Claude Code', command: 'claude', isBuiltIn: true },
      };
      mockFetch.mockResolvedValue(createMockResponse(mockAgent));

      const result = await fetchAgent('claude-code');

      expect(fetch).toHaveBeenCalledWith('/api/agents/claude-code');
      expect(result).toEqual(mockAgent);
    });

    it('should throw error for non-existent agent', async () => {
      const { fetchAgent } = await import('../api');
      mockFetch.mockResolvedValue(
        createMockResponse({}, { status: 404, ok: false })
      );

      await expect(fetchAgent('non-existent')).rejects.toThrow('Failed to fetch agent');
    });
  });

  describe('registerAgent', () => {
    it('should register agent successfully', async () => {
      const { registerAgent } = await import('../api');
      const mockAgent = {
        agent: {
          id: 'new-agent',
          name: 'New Agent',
          commandTemplate: 'new-cmd {{prompt}}',
          isBuiltIn: false,
          capabilities: {
            supportsContinue: false,
            supportsHeadlessMode: false,
            supportsActivityDetection: false,
          },
        },
      };
      mockFetch.mockResolvedValue(createMockResponse(mockAgent));

      const result = await registerAgent({ name: 'New Agent', commandTemplate: 'new-cmd {{prompt}}' });

      expect(fetch).toHaveBeenCalledWith('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Agent', commandTemplate: 'new-cmd {{prompt}}' }),
      });
      expect(result).toEqual(mockAgent);
    });

    it('should throw error on failure', async () => {
      const { registerAgent } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({ error: 'Invalid commandTemplate' })),
      } as unknown as Response);

      await expect(registerAgent({ name: 'Test', commandTemplate: '' })).rejects.toThrow(
        'Invalid commandTemplate'
      );
    });
  });

  describe('updateAgent', () => {
    it('should update agent successfully', async () => {
      const { updateAgent } = await import('../api');
      const mockAgent = {
        agent: { id: 'agent-1', name: 'Updated Agent', command: 'cmd', isBuiltIn: false },
      };
      mockFetch.mockResolvedValue(createMockResponse(mockAgent));

      const result = await updateAgent('agent-1', { name: 'Updated Agent' });

      expect(fetch).toHaveBeenCalledWith('/api/agents/agent-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated Agent' }),
      });
      expect(result).toEqual(mockAgent);
    });

    it('should throw error when updating built-in agent', async () => {
      const { updateAgent } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({ error: 'Cannot update built-in agent' })),
      } as unknown as Response);

      await expect(updateAgent('claude-code', { name: 'New Name' })).rejects.toThrow(
        'Cannot update built-in agent'
      );
    });
  });

  describe('unregisterAgent', () => {
    it('should unregister agent successfully', async () => {
      const { unregisterAgent } = await import('../api');
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await unregisterAgent('agent-1');

      expect(fetch).toHaveBeenCalledWith('/api/agents/agent-1', {
        method: 'DELETE',
      });
    });

    it('should throw error when unregistering built-in agent', async () => {
      const { unregisterAgent } = await import('../api');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: mock(() => Promise.resolve({ error: 'Cannot unregister built-in agent' })),
      } as unknown as Response);

      await expect(unregisterAgent('claude-code')).rejects.toThrow(
        'Cannot unregister built-in agent'
      );
    });
  });
});
