import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchConfig,
  fetchSessions,
  createSession,
  restartSession,
  deleteSession,
  getSessionMetadata,
  fetchRepositories,
  registerRepository,
  unregisterRepository,
  fetchWorktrees,
  fetchBranches,
  ServerUnavailableError,
} from '../api';

// Helper to create mock Response
function createMockResponse(body: unknown, options: { status?: number; ok?: boolean } = {}) {
  const { status = 200, ok = true } = options;
  return {
    ok,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('API Client', () => {
  beforeEach(() => {
    vi.mocked(fetch).mockReset();
  });

  describe('fetchConfig', () => {
    it('should fetch config successfully', async () => {
      const mockConfig = { homeDir: '/home/user' };
      vi.mocked(fetch).mockResolvedValue(createMockResponse(mockConfig));

      const result = await fetchConfig();

      expect(fetch).toHaveBeenCalledWith('/api/config');
      expect(result).toEqual(mockConfig);
    });

    it('should throw error on failure', async () => {
      vi.mocked(fetch).mockResolvedValue(
        createMockResponse({}, { status: 500, ok: false })
      );

      await expect(fetchConfig()).rejects.toThrow('Failed to fetch config');
    });
  });

  describe('fetchSessions', () => {
    it('should fetch sessions successfully', async () => {
      const mockSessions = { sessions: [{ id: '1' }, { id: '2' }] };
      vi.mocked(fetch).mockResolvedValue(createMockResponse(mockSessions));

      const result = await fetchSessions();

      expect(fetch).toHaveBeenCalledWith('/api/sessions');
      expect(result).toEqual(mockSessions);
    });
  });

  describe('createSession', () => {
    it('should create session with default values', async () => {
      const mockSession = { session: { id: '1' } };
      vi.mocked(fetch).mockResolvedValue(createMockResponse(mockSession));

      const result = await createSession();

      expect(fetch).toHaveBeenCalledWith('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          worktreePath: undefined,
          repositoryId: undefined,
          continueConversation: false,
        }),
      });
      expect(result).toEqual(mockSession);
    });

    it('should create session with custom values', async () => {
      const mockSession = { session: { id: '1' } };
      vi.mocked(fetch).mockResolvedValue(createMockResponse(mockSession));

      await createSession('/path/to/worktree', 'repo-id', true);

      expect(fetch).toHaveBeenCalledWith('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          worktreePath: '/path/to/worktree',
          repositoryId: 'repo-id',
          continueConversation: true,
        }),
      });
    });

    it('should extract error message from JSON response', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: vi.fn().mockResolvedValue({ error: 'Detailed error message' }),
      } as unknown as Response);

      await expect(createSession()).rejects.toThrow('Detailed error message');
    });

    it('should fall back to statusText when JSON parsing fails', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: vi.fn().mockRejectedValue(new Error('Parse error')),
      } as unknown as Response);

      // When JSON parsing fails, catches returns { error: res.statusText }
      await expect(createSession()).rejects.toThrow('Internal Server Error');
    });
  });

  describe('restartSession', () => {
    it('should restart session successfully', async () => {
      const mockSession = { session: { id: '1' } };
      vi.mocked(fetch).mockResolvedValue(createMockResponse(mockSession));

      const result = await restartSession('session-id', true);

      expect(fetch).toHaveBeenCalledWith('/api/sessions/session-id/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ continueConversation: true }),
      });
      expect(result).toEqual(mockSession);
    });
  });

  describe('deleteSession', () => {
    it('should delete session successfully', async () => {
      vi.mocked(fetch).mockResolvedValue(createMockResponse({ success: true }));

      await deleteSession('session-id');

      expect(fetch).toHaveBeenCalledWith('/api/sessions/session-id', {
        method: 'DELETE',
      });
    });
  });

  describe('getSessionMetadata', () => {
    it('should return metadata when session exists', async () => {
      const mockMetadata = { id: '1', worktreePath: '/path', isActive: true };
      vi.mocked(fetch).mockResolvedValue(createMockResponse(mockMetadata));

      const result = await getSessionMetadata('session-id');

      expect(result).toEqual(mockMetadata);
    });

    it('should return null when session not found (404)', async () => {
      vi.mocked(fetch).mockResolvedValue(
        createMockResponse({}, { status: 404, ok: false })
      );

      const result = await getSessionMetadata('non-existent');

      expect(result).toBeNull();
    });

    it('should throw ServerUnavailableError on 5xx errors', async () => {
      vi.mocked(fetch).mockResolvedValue(
        createMockResponse({}, { status: 500, ok: false })
      );

      await expect(getSessionMetadata('session-id')).rejects.toThrow(ServerUnavailableError);
    });

    it('should throw ServerUnavailableError on network error', async () => {
      vi.mocked(fetch).mockRejectedValue(new TypeError('Network error'));

      await expect(getSessionMetadata('session-id')).rejects.toThrow(ServerUnavailableError);
    });
  });

  describe('fetchRepositories', () => {
    it('should fetch repositories successfully', async () => {
      const mockRepos = { repositories: [{ id: '1', name: 'repo1' }] };
      vi.mocked(fetch).mockResolvedValue(createMockResponse(mockRepos));

      const result = await fetchRepositories();

      expect(fetch).toHaveBeenCalledWith('/api/repositories');
      expect(result).toEqual(mockRepos);
    });
  });

  describe('registerRepository', () => {
    it('should register repository successfully', async () => {
      const mockRepo = { repository: { id: '1', name: 'repo', path: '/path' } };
      vi.mocked(fetch).mockResolvedValue(createMockResponse(mockRepo));

      const result = await registerRepository('/path/to/repo');

      expect(fetch).toHaveBeenCalledWith('/api/repositories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/path/to/repo' }),
      });
      expect(result).toEqual(mockRepo);
    });

    it('should throw error with message from response', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: vi.fn().mockResolvedValue({ error: 'Not a git repository' }),
      } as unknown as Response);

      await expect(registerRepository('/not/git')).rejects.toThrow('Not a git repository');
    });
  });

  describe('unregisterRepository', () => {
    it('should unregister repository successfully', async () => {
      vi.mocked(fetch).mockResolvedValue(createMockResponse({ success: true }));

      await unregisterRepository('repo-id');

      expect(fetch).toHaveBeenCalledWith('/api/repositories/repo-id', {
        method: 'DELETE',
      });
    });
  });

  describe('fetchWorktrees', () => {
    it('should fetch worktrees successfully', async () => {
      const mockWorktrees = { worktrees: [{ path: '/path', branch: 'main' }] };
      vi.mocked(fetch).mockResolvedValue(createMockResponse(mockWorktrees));

      const result = await fetchWorktrees('repo-id');

      expect(fetch).toHaveBeenCalledWith('/api/repositories/repo-id/worktrees');
      expect(result).toEqual(mockWorktrees);
    });
  });

  describe('fetchBranches', () => {
    it('should fetch branches successfully', async () => {
      const mockBranches = { local: ['main'], remote: ['origin/main'], defaultBranch: 'main' };
      vi.mocked(fetch).mockResolvedValue(createMockResponse(mockBranches));

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
      vi.mocked(fetch).mockResolvedValue(createMockResponse(mockResponse));

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
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: vi.fn().mockResolvedValue({ error: 'Branch already exists' }),
      } as unknown as Response);

      await expect(createWorktree('repo-id', { mode: 'custom', branch: 'existing' })).rejects.toThrow(
        'Branch already exists'
      );
    });
  });

  describe('deleteWorktree', () => {
    it('should delete worktree successfully', async () => {
      const { deleteWorktree } = await import('../api');
      vi.mocked(fetch).mockResolvedValue(createMockResponse({ success: true }));

      await deleteWorktree('repo-id', '/path/to/worktree');

      expect(fetch).toHaveBeenCalledWith(
        '/api/repositories/repo-id/worktrees/%2Fpath%2Fto%2Fworktree',
        { method: 'DELETE' }
      );
    });

    it('should include force flag when specified', async () => {
      const { deleteWorktree } = await import('../api');
      vi.mocked(fetch).mockResolvedValue(createMockResponse({ success: true }));

      await deleteWorktree('repo-id', '/path/to/worktree', true);

      expect(fetch).toHaveBeenCalledWith(
        '/api/repositories/repo-id/worktrees/%2Fpath%2Fto%2Fworktree?force=true',
        { method: 'DELETE' }
      );
    });

    it('should throw error on failure', async () => {
      const { deleteWorktree } = await import('../api');
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: vi.fn().mockResolvedValue({ error: 'Worktree has uncommitted changes' }),
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
      vi.mocked(fetch).mockResolvedValue(createMockResponse(mockAgents));

      const result = await fetchAgents();

      expect(fetch).toHaveBeenCalledWith('/api/agents');
      expect(result).toEqual(mockAgents);
    });

    it('should throw error on failure', async () => {
      const { fetchAgents } = await import('../api');
      vi.mocked(fetch).mockResolvedValue(
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
      vi.mocked(fetch).mockResolvedValue(createMockResponse(mockAgent));

      const result = await fetchAgent('claude-code');

      expect(fetch).toHaveBeenCalledWith('/api/agents/claude-code');
      expect(result).toEqual(mockAgent);
    });

    it('should throw error for non-existent agent', async () => {
      const { fetchAgent } = await import('../api');
      vi.mocked(fetch).mockResolvedValue(
        createMockResponse({}, { status: 404, ok: false })
      );

      await expect(fetchAgent('non-existent')).rejects.toThrow('Failed to fetch agent');
    });
  });

  describe('registerAgent', () => {
    it('should register agent successfully', async () => {
      const { registerAgent } = await import('../api');
      const mockAgent = {
        agent: { id: 'new-agent', name: 'New Agent', command: 'new-cmd', isBuiltIn: false },
      };
      vi.mocked(fetch).mockResolvedValue(createMockResponse(mockAgent));

      const result = await registerAgent({ name: 'New Agent', command: 'new-cmd' });

      expect(fetch).toHaveBeenCalledWith('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Agent', command: 'new-cmd' }),
      });
      expect(result).toEqual(mockAgent);
    });

    it('should throw error on failure', async () => {
      const { registerAgent } = await import('../api');
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: vi.fn().mockResolvedValue({ error: 'Invalid command' }),
      } as unknown as Response);

      await expect(registerAgent({ name: 'Test', command: '' })).rejects.toThrow(
        'Invalid command'
      );
    });
  });

  describe('updateAgent', () => {
    it('should update agent successfully', async () => {
      const { updateAgent } = await import('../api');
      const mockAgent = {
        agent: { id: 'agent-1', name: 'Updated Agent', command: 'cmd', isBuiltIn: false },
      };
      vi.mocked(fetch).mockResolvedValue(createMockResponse(mockAgent));

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
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: vi.fn().mockResolvedValue({ error: 'Cannot update built-in agent' }),
      } as unknown as Response);

      await expect(updateAgent('claude-code', { name: 'New Name' })).rejects.toThrow(
        'Cannot update built-in agent'
      );
    });
  });

  describe('unregisterAgent', () => {
    it('should unregister agent successfully', async () => {
      const { unregisterAgent } = await import('../api');
      vi.mocked(fetch).mockResolvedValue(createMockResponse({ success: true }));

      await unregisterAgent('agent-1');

      expect(fetch).toHaveBeenCalledWith('/api/agents/agent-1', {
        method: 'DELETE',
      });
    });

    it('should throw error when unregistering built-in agent', async () => {
      const { unregisterAgent } = await import('../api');
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: vi.fn().mockResolvedValue({ error: 'Cannot unregister built-in agent' }),
      } as unknown as Response);

      await expect(unregisterAgent('claude-code')).rejects.toThrow(
        'Cannot unregister built-in agent'
      );
    });
  });
});
