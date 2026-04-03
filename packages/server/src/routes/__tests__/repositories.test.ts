import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

// Mock the description generator BEFORE importing test-utils to ensure proper mock ordering
const mockGenerateDescription = mock(() => Promise.resolve({ description: 'test' }));
mock.module('../../services/repository-description-generator.js', () => ({
  generateRepositoryDescription: mockGenerateDescription,
}));

import type { Hono } from 'hono';
import type { AppBindings } from '../../app-context.js';
import { setupTestEnvironment, cleanupTestEnvironment, createTestApp } from '../../__tests__/test-utils.js';
import { mockGit, GitError } from '../../__tests__/utils/mock-git-helper.js';

// ---------------------------------------------------------------------------
// Mock services
// ---------------------------------------------------------------------------

const repositoryManager = {
  getRepository: mock(() => undefined as any),
  getAllRepositories: mock(() => []),
  registerRepository: mock(() => Promise.resolve({} as any)),
  updateRepository: mock(() => Promise.resolve(undefined as any)),
  unregisterRepository: mock(() => Promise.resolve(true)),
};

const sessionManager = {
  getSessionsUsingRepository: mock(() => [] as any[]),
  getAllPersistedSessions: mock(() => Promise.resolve([] as any[])),
};

const repositorySlackIntegrationService = {
  deleteIntegration: mock(() => Promise.resolve(true)),
  getByRepositoryId: mock(() => Promise.resolve(null)),
  upsert: mock(() => Promise.resolve({} as any)),
};

const agentManager = {
  getAgent: mock(() => undefined as any),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetAllMocks(): void {
  repositoryManager.getRepository.mockReset();
  repositoryManager.getAllRepositories.mockReset();
  repositoryManager.registerRepository.mockReset();
  repositoryManager.updateRepository.mockReset();
  repositoryManager.unregisterRepository.mockReset();
  sessionManager.getSessionsUsingRepository.mockReset();
  sessionManager.getAllPersistedSessions.mockReset();
  repositorySlackIntegrationService.deleteIntegration.mockReset();
  repositorySlackIntegrationService.getByRepositoryId.mockReset();
  repositorySlackIntegrationService.upsert.mockReset();
  agentManager.getAgent.mockReset();
  mockGenerateDescription.mockReset();
  mockGenerateDescription.mockImplementation(() => Promise.resolve({ description: 'test' }));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Repositories API', () => {
  let app: Hono<AppBindings>;

  beforeEach(async () => {
    await setupTestEnvironment();
    resetAllMocks();
    app = await createTestApp({
      repositoryManager: repositoryManager as any,
      sessionManager: sessionManager as any,
      repositorySlackIntegrationService: repositorySlackIntegrationService as any,
      agentManager: agentManager as any,
    });
  });

  afterEach(async () => {
    await cleanupTestEnvironment();
  });

  // =========================================================================
  // DELETE /api/repositories/:id
  // =========================================================================

  describe('DELETE /api/repositories/:id', () => {
    it('should return 409 when repository has active sessions', async () => {
      repositoryManager.getRepository.mockReturnValue({ id: 'repo1', path: '/repo' });
      sessionManager.getSessionsUsingRepository.mockReturnValue([{ id: 's1', title: 'Active Session' }]);
      sessionManager.getAllPersistedSessions.mockReturnValue(Promise.resolve([]));

      const res = await app.request('/api/repositories/repo1', { method: 'DELETE' });
      expect(res.status).toBe(409);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Repository is in use by 1 session(s) (active)');
    });

    it('should return 409 when repository has persisted (inactive) sessions', async () => {
      repositoryManager.getRepository.mockReturnValue({ id: 'repo1', path: '/repo' });
      sessionManager.getSessionsUsingRepository.mockReturnValue([]);
      sessionManager.getAllPersistedSessions.mockReturnValue(
        Promise.resolve([{ id: 's2', title: 'Paused', type: 'worktree', repositoryId: 'repo1' }])
      );

      const res = await app.request('/api/repositories/repo1', { method: 'DELETE' });
      expect(res.status).toBe(409);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Repository is in use by 1 session(s) (inactive)');
    });

    it('should clean up Slack integration and succeed even if cleanup throws', async () => {
      repositoryManager.getRepository.mockReturnValue({ id: 'repo1', path: '/repo' });
      sessionManager.getSessionsUsingRepository.mockReturnValue([]);
      sessionManager.getAllPersistedSessions.mockReturnValue(Promise.resolve([]));
      repositorySlackIntegrationService.deleteIntegration.mockImplementation(() => {
        throw new Error('Slack cleanup failed');
      });
      repositoryManager.unregisterRepository.mockReturnValue(Promise.resolve(true));

      const res = await app.request('/api/repositories/repo1', { method: 'DELETE' });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);
      expect(repositorySlackIntegrationService.deleteIntegration).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // POST /api/repositories/:id/generate-description
  // =========================================================================

  describe('POST /api/repositories/:id/generate-description', () => {
    it('should return 400 for concurrent description generation', async () => {
      let resolveGeneration!: (value: any) => void;
      mockGenerateDescription.mockImplementationOnce(
        () => new Promise((resolve) => { resolveGeneration = resolve; })
      );

      repositoryManager.getRepository.mockReturnValue({ id: 'repo1', path: '/repo' });
      agentManager.getAgent.mockReturnValue({ id: 'claude-code-builtin', command: 'claude' });

      // First request starts generation
      const first = app.request('/api/repositories/repo1/generate-description', { method: 'POST' });

      // Wait for the first request to reach the generator
      while (mockGenerateDescription.mock.calls.length === 0) {
        await new Promise((r) => setTimeout(r, 1));
      }

      // Second request should be blocked
      const second = await app.request('/api/repositories/repo1/generate-description', { method: 'POST' });
      expect(second.status).toBe(400);

      const body = (await second.json()) as { error: string };
      expect(body.error).toContain('already in progress');

      // Resolve the first request to clean up
      resolveGeneration({ description: 'test' });
      await first;
    });
  });

  // =========================================================================
  // GET /api/repositories/:id/branches/:branch/remote-status
  // =========================================================================

  describe('GET /api/repositories/:id/branches/:branch/remote-status', () => {
    it('should return 400 when GitError occurs', async () => {
      repositoryManager.getRepository.mockReturnValue({ id: 'repo1', path: '/repo' });
      mockGit.fetchRemote.mockImplementation(() => {
        throw new GitError('network error', 128, 'fatal: network error');
      });

      const res = await app.request('/api/repositories/repo1/branches/main/remote-status');
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Failed to get remote status');
    });

    it('should return behind and ahead counts on success', async () => {
      repositoryManager.getRepository.mockReturnValue({ id: 'repo1', path: '/repo' });
      mockGit.fetchRemote.mockImplementation(() => Promise.resolve());
      mockGit.getCommitsBehind.mockImplementation(() => Promise.resolve(3));
      mockGit.getCommitsAhead.mockImplementation(() => Promise.resolve(1));

      const res = await app.request('/api/repositories/repo1/branches/main/remote-status');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { behind: number; ahead: number };
      expect(body.behind).toBe(3);
      expect(body.ahead).toBe(1);
    });
  });
});
