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
});
