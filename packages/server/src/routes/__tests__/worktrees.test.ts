import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { onApiError } from '../../lib/error-handler.js';
import { api } from '../api.js';
import type { AppBindings } from '../../app-context.js';
import type { WorktreeService } from '../../services/worktree-service.js';
import type { RepositoryManager } from '../../services/repository-manager.js';
import type { Repository } from '@agent-console/shared';
import { asAppContext } from '../../__tests__/test-utils.js';
import { mockGit, resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { _getPullsInProgress, _getDeletionsInProgress } from '../worktrees.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_CONFIG_DIR = '/test/config';
const REPO_PATH = `${TEST_CONFIG_DIR}/repositories/owner/repo`;

const TEST_REPO: Repository = {
  id: 'repo-1',
  name: 'test-repo',
  path: REPO_PATH,
  createdAt: new Date().toISOString(),
};

const WORKTREE_PATH = `${REPO_PATH}/worktrees/wt-1`;

// ---------------------------------------------------------------------------
// Mock services
// ---------------------------------------------------------------------------

function createMockWorktreeService() {
  return {
    listWorktrees: mock(() => Promise.resolve([])),
    isWorktreeOf: mock(() => Promise.resolve(true)),
    getDefaultBranch: mock(() => Promise.resolve('main')),
    listLocalBranches: mock(() => Promise.resolve([])),
    listRemoteBranches: mock(() => Promise.resolve([])),
    executeHookCommand: mock(() => Promise.resolve(null)),
    removeWorktree: mock(() => Promise.resolve({ success: true })),
    getWorktreeIndexNumber: mock(() => Promise.resolve(null)),
  } as unknown as WorktreeService;
}

function createMockRepositoryManager() {
  return {
    getRepository: mock((id: string) => (id === TEST_REPO.id ? TEST_REPO : undefined)),
    getAllRepositories: mock(() => [TEST_REPO]),
  } as unknown as RepositoryManager;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Worktrees API', () => {
  let app: Hono<AppBindings>;
  let mockWorktreeService: WorktreeService;
  let mockRepositoryManager: RepositoryManager;

  beforeEach(() => {
    resetGitMocks();

    mockWorktreeService = createMockWorktreeService();
    mockRepositoryManager = createMockRepositoryManager();

    // Setup memfs with the worktree directory structure
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
      [`${REPO_PATH}/.keep`]: '',
      [`${WORKTREE_PATH}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    // Set default git mock behavior
    mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('feature-branch'));

    // Build the Hono app with mocked services
    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', asAppContext({
        repositoryManager: mockRepositoryManager,
        worktreeService: mockWorktreeService,
      }));
      await next();
    });
    app.onError(onApiError);
    app.route('/api', api);
  });

  afterEach(() => {
    _getPullsInProgress().clear();
    _getDeletionsInProgress().clear();
    cleanupMemfs();
  });

  // =========================================================================
  // GET /api/repositories/:id/worktrees
  // =========================================================================

  describe('GET /api/repositories/:id/worktrees', () => {
    it('should return 404 for unknown repository ID', async () => {
      const res = await app.request('/api/repositories/unknown-id/worktrees', {
        method: 'GET',
      });

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Repository');
    });

    it('should return worktrees array for valid repo', async () => {
      const mockWorktrees = [
        { path: WORKTREE_PATH, branch: 'feature-1', isMainWorktree: false },
      ];
      (mockWorktreeService.listWorktrees as ReturnType<typeof mock>)
        .mockImplementation(() => Promise.resolve(mockWorktrees));

      const res = await app.request(`/api/repositories/${TEST_REPO.id}/worktrees`, {
        method: 'GET',
      });

      expect(res.status).toBe(200);

      const body = (await res.json()) as { worktrees: unknown[] };
      expect(body.worktrees).toBeArray();
      expect(body.worktrees).toHaveLength(1);
    });
  });

  // =========================================================================
  // POST /api/repositories/:id/worktrees/pull
  // =========================================================================

  describe('POST /api/repositories/:id/worktrees/pull', () => {
    const pullRequest = (worktreePath: string, taskId = 'task-1') => ({
      method: 'POST' as const,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worktreePath, taskId }),
    });

    it('should return 404 for unknown repository', async () => {
      const res = await app.request(
        '/api/repositories/unknown-id/worktrees/pull',
        pullRequest(WORKTREE_PATH),
      );

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Repository');
    });

    it('should return 400 when worktreePath is outside managed directory', async () => {
      const outsidePath = '/outside/managed/dir';
      // Create the directory in memfs so stat succeeds
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${REPO_PATH}/.keep`]: '',
        [`${WORKTREE_PATH}/.keep`]: '',
        [`${outsidePath}/.keep`]: '',
      });

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(outsidePath),
      );

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('outside managed directory');
    });

    it('should return 400 for path traversal attempt', async () => {
      // Attempt to escape via /../
      const traversalPath = `${TEST_CONFIG_DIR}/repositories/owner/repo/worktrees/wt-1/../../../../../../etc/passwd`;

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(traversalPath),
      );

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      // resolvePath normalizes the traversal, so it ends up outside managed dir
      expect(body.error).toContain('outside managed directory');
    });

    it('should return 400 when isWorktreeOf returns false', async () => {
      (mockWorktreeService.isWorktreeOf as ReturnType<typeof mock>)
        .mockImplementation(() => Promise.resolve(false));

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(WORKTREE_PATH),
      );

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Invalid worktree path');
    });

    it('should return 400 when worktree directory does not exist', async () => {
      const nonexistentPath = `${REPO_PATH}/worktrees/does-not-exist`;

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(nonexistentPath),
      );

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('does not exist');
    });

    it('should return 400 for detached HEAD', async () => {
      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('(detached)'));

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(WORKTREE_PATH),
      );

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('detached HEAD');
    });

    it('should return 409 for concurrent pull guard', async () => {
      _getPullsInProgress().add(WORKTREE_PATH);

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(WORKTREE_PATH),
      );

      expect(res.status).toBe(409);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('already in progress');
    });

    it('should return 409 when deletion is in progress', async () => {
      _getDeletionsInProgress().add(WORKTREE_PATH);

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(WORKTREE_PATH),
      );

      expect(res.status).toBe(409);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('being deleted');
    });

    it('should return 202 for valid pull request', async () => {
      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(WORKTREE_PATH),
      );

      expect(res.status).toBe(202);

      const body = (await res.json()) as { accepted: boolean };
      expect(body.accepted).toBe(true);
    });

    it('should return 202 even when background pull encounters an error', async () => {
      // Simulate pullFastForward throwing — the fire-and-forget IIFE's
      // internal try-catch handles it, and the outer .catch() guards
      // against any unexpected escapes. Either way, the HTTP response
      // is 202 Accepted because it returns before the async work runs.
      mockGit.pullFastForward.mockImplementation(() => Promise.reject(new Error('network timeout')));

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(WORKTREE_PATH),
      );

      expect(res.status).toBe(202);

      const body = (await res.json()) as { accepted: boolean };
      expect(body.accepted).toBe(true);
    });

    it('should allow pull on primary worktree (repo root)', async () => {
      // The primary worktree is the repo root itself, which may be outside
      // the managed worktrees subdirectory. The route skips the boundary
      // check for the primary worktree.
      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        pullRequest(REPO_PATH),
      );

      expect(res.status).toBe(202);

      const body = (await res.json()) as { accepted: boolean };
      expect(body.accepted).toBe(true);

      // isWorktreeOf should NOT have been called for the primary worktree
      expect(mockWorktreeService.isWorktreeOf).not.toHaveBeenCalled();
    });

    it('should return 400 for missing worktreePath', async () => {
      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: 'task-1' }),
        },
      );

      expect(res.status).toBe(400);
    });

    it('should return 400 for empty worktreePath', async () => {
      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreePath: '   ', taskId: 'task-1' }),
        },
      );

      expect(res.status).toBe(400);
    });

    it('should return 400 for missing taskId', async () => {
      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreePath: WORKTREE_PATH }),
        },
      );

      expect(res.status).toBe(400);
    });

    it('should return 400 for empty taskId', async () => {
      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/pull`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreePath: WORKTREE_PATH, taskId: '' }),
        },
      );

      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // DELETE /api/repositories/:id/worktrees/*
  // =========================================================================

  describe('DELETE /api/repositories/:id/worktrees/*', () => {
    const encodedPath = (wtPath: string) => encodeURIComponent(wtPath);

    it('should return 409 when deletion already in progress', async () => {
      _getDeletionsInProgress().add(WORKTREE_PATH);

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/${encodedPath(WORKTREE_PATH)}`,
        { method: 'DELETE' },
      );

      expect(res.status).toBe(409);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Deletion already in progress');
    });

    it('should return 409 when pull is in progress', async () => {
      _getPullsInProgress().add(WORKTREE_PATH);

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/${encodedPath(WORKTREE_PATH)}`,
        { method: 'DELETE' },
      );

      expect(res.status).toBe(409);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Pull is in progress');
    });

    it('should return 400 for empty worktree path', async () => {
      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees/`,
        { method: 'DELETE' },
      );

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('required');
    });
  });
});
