import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import type { AppBindings } from '../../app-context.js';
import { onApiError } from '../../lib/error-handler.js';
import { asAppContext } from '../../__tests__/test-utils.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { mockGit, resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import {
  mockWorktreeService,
  resetWorktreeServiceMocks,
} from '../../__tests__/utils/mock-worktree-service-helper.js';
import { getRepositoriesDir } from '../../lib/config.js';
import type { Repository, Session, Worktree } from '@agent-console/shared';

// --- Mock broadcastToApp (safe: no test tests this module directly) ---

const mockBroadcastToApp = mock(() => {});
mock.module('../../websocket/routes.js', () => ({
  broadcastToApp: mockBroadcastToApp,
}));

// --- Mock github-pr-service (safe: no test tests this module directly) ---

mock.module('../../services/github-pr-service.js', () => ({
  findOpenPullRequest: mock(() => Promise.resolve(null)),
}));

// --- Mock session-metadata-suggester (safe: no test tests this module directly) ---

mock.module('../../services/session-metadata-suggester.js', () => ({
  suggestSessionMetadata: mock(() =>
    Promise.resolve({ branch: 'test-branch', title: 'Test' }),
  ),
}));

// --- Import route AFTER mocks are set up ---
// Use dynamic import so mock.module calls above take effect.

const { worktrees, _getPullsInProgress } = await import('../worktrees.js');

// Import real deletion service functions (NOT mocked — controlled via Set)
const { _getDeletionsInProgress } = await import(
  '../../services/worktree-deletion-service.js'
);

// --- Test constants ---

const TEST_CONFIG_DIR = '/test/config';
const REPO_ID = 'repo-1';
const REPO_PATH = '/external/repos/my-repo';
const REPO: Repository = {
  id: REPO_ID,
  name: 'my-repo',
  path: REPO_PATH,
  createdAt: '2024-01-01T00:00:00Z',
};

function createMockRepositoryManager(repos: Repository[] = [REPO]) {
  const repoMap = new Map(repos.map((r) => [r.id, r]));
  return {
    getRepository: (id: string) => repoMap.get(id),
  };
}

function createMockSessionManager() {
  return {
    getAllSessions: mock(() => [] as Session[]),
    killSessionWorkers: mock(() => Promise.resolve()),
    deleteSession: mock(() => Promise.resolve(true)),
  };
}

function createApp(
  repositoryManager = createMockRepositoryManager(),
  sessionManager = createMockSessionManager(),
): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set(
      'appContext',
      asAppContext({
        repositoryManager: repositoryManager as never,
        sessionManager: sessionManager as never,
      }),
    );
    await next();
  });
  app.onError(onApiError);
  app.route('/api/repositories', worktrees);
  return app;
}

describe('Worktrees API', () => {
  let app: Hono<AppBindings>;
  let repositoriesDir: string;

  beforeEach(() => {
    // Compute repositoriesDir using the same config function as production code
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    repositoriesDir = getRepositoriesDir();

    // Valid worktree path inside managed directory
    const validWorktreePath = `${repositoriesDir}/owner/repo/worktrees/wt-001`;

    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
      // Create the repo path directory
      [`${REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      // Create a valid worktree directory inside managed dir
      [`${validWorktreePath}/.git`]: 'gitdir: ...',
    });

    resetGitMocks();
    resetWorktreeServiceMocks();
    mockBroadcastToApp.mockClear();
    _getPullsInProgress().clear();
    _getDeletionsInProgress().clear();

    app = createApp();
  });

  afterEach(() => {
    _getPullsInProgress().clear();
    _getDeletionsInProgress().clear();
    cleanupMemfs();
  });

  // =========================================================================
  // GET /:id/worktrees
  // =========================================================================

  describe('GET /:id/worktrees', () => {
    it('returns 404 for unknown repository', async () => {
      const res = await app.request('/api/repositories/nonexistent/worktrees');

      expect(res.status).toBe(404);
    });

    it('returns worktrees for a valid repository', async () => {
      const fakeWorktrees: Worktree[] = [
        { path: '/some/path', branch: 'main', isMain: true, repositoryId: REPO_ID },
      ];
      mockWorktreeService.listWorktrees.mockImplementation(() =>
        Promise.resolve(fakeWorktrees),
      );

      const res = await app.request(`/api/repositories/${REPO_ID}/worktrees`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.worktrees).toEqual(fakeWorktrees);
    });
  });

  // =========================================================================
  // POST /:id/worktrees/pull - Security-critical
  // =========================================================================

  describe('POST /:id/worktrees/pull', () => {
    function pullRequest(
      repoId: string,
      worktreePath: string,
      taskId = 'task-001',
    ) {
      return app.request(`/api/repositories/${repoId}/worktrees/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktreePath, taskId }),
      });
    }

    it('returns 404 for unknown repository', async () => {
      const res = await pullRequest('nonexistent', '/any/path');

      expect(res.status).toBe(404);
    });

    it('returns 400 when worktree path is outside managed directory', async () => {
      // Path traversal attempt: path outside the managed repositories directory
      const evilPath = '/tmp/evil/path';

      const res = await pullRequest(REPO_ID, evilPath);

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toContain('outside managed directory');
    });

    it('returns 400 when worktree path uses traversal to escape managed directory', async () => {
      // Path traversal via ../ that resolves outside the managed directory
      const traversalPath = `${repositoriesDir}/../../../etc/passwd`;

      const res = await pullRequest(REPO_ID, traversalPath);

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toContain('outside managed directory');
    });

    it('returns 400 when isWorktreeOf returns false', async () => {
      // Path is inside the managed directory but not a valid worktree of this repo
      const fakePath = `${repositoriesDir}/other-repo/worktrees/wt-fake`;
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${fakePath}/.git`]: 'gitdir: ...',
      });
      mockWorktreeService.isWorktreeOf.mockImplementation(() =>
        Promise.resolve(false),
      );

      const res = await pullRequest(REPO_ID, fakePath);

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toContain('Invalid worktree path');
    });

    it('returns 400 when worktree directory does not exist', async () => {
      const nonExistentPath = `${repositoriesDir}/owner/repo/worktrees/wt-missing`;
      // Directory does not exist in memfs

      const res = await pullRequest(REPO_ID, nonExistentPath);

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toContain('does not exist');
    });

    it('returns 409 when worktree is being deleted', async () => {
      const wtPath = `${repositoriesDir}/owner/repo/worktrees/wt-001`;
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${wtPath}/.git`]: 'gitdir: ...',
      });
      _getDeletionsInProgress().add(wtPath);

      const res = await pullRequest(REPO_ID, wtPath);

      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toContain('being deleted');
    });

    it('returns 400 when HEAD is detached', async () => {
      const wtPath = `${repositoriesDir}/owner/repo/worktrees/wt-001`;
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${wtPath}/.git`]: 'gitdir: ...',
      });
      mockGit.getCurrentBranch.mockImplementation(() =>
        Promise.resolve('(detached)'),
      );

      const res = await pullRequest(REPO_ID, wtPath);

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toContain('detached HEAD');
    });

    it('returns 400 when branch is unknown', async () => {
      const wtPath = `${repositoriesDir}/owner/repo/worktrees/wt-001`;
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${wtPath}/.git`]: 'gitdir: ...',
      });
      mockGit.getCurrentBranch.mockImplementation(() =>
        Promise.resolve('(unknown)'),
      );

      const res = await pullRequest(REPO_ID, wtPath);

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toContain('detached HEAD');
    });

    it('returns 409 when pull is already in progress for the same worktree', async () => {
      const wtPath = `${repositoriesDir}/owner/repo/worktrees/wt-001`;
      // Pre-add path to the pulls-in-progress guard
      _getPullsInProgress().add(wtPath);

      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${wtPath}/.git`]: 'gitdir: ...',
      });

      const res = await pullRequest(REPO_ID, wtPath);

      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toContain('already in progress');
    });

    it('returns 202 and accepts valid pull request', async () => {
      const wtPath = `${repositoriesDir}/owner/repo/worktrees/wt-001`;
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${wtPath}/.git`]: 'gitdir: ...',
      });
      mockGit.getCurrentBranch.mockImplementation(() =>
        Promise.resolve('feature-branch'),
      );

      const res = await pullRequest(REPO_ID, wtPath);

      expect(res.status).toBe(202);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.accepted).toBe(true);
    });

    it('allows pull on primary worktree (repo root) even though it is outside managed dir', async () => {
      // The primary worktree path equals repo.path, which may be outside repositoriesDir.
      // This is the special case: isMain === true skips boundary check.
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      });
      mockGit.getCurrentBranch.mockImplementation(() =>
        Promise.resolve('main'),
      );

      const res = await pullRequest(REPO_ID, REPO_PATH);

      expect(res.status).toBe(202);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.accepted).toBe(true);
    });

    it('rejects empty worktreePath with validation error', async () => {
      const res = await app.request(
        `/api/repositories/${REPO_ID}/worktrees/pull`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreePath: '', taskId: 'task-001' }),
        },
      );

      // Valibot validation rejects empty string due to minLength(1)
      expect(res.status).toBe(400);
    });

    it('rejects missing taskId with validation error', async () => {
      const res = await app.request(
        `/api/repositories/${REPO_ID}/worktrees/pull`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreePath: '/some/path' }),
        },
      );

      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // DELETE /:id/worktrees/*
  // =========================================================================

  describe('DELETE /:id/worktrees/*', () => {
    function deleteRequest(
      repoId: string,
      worktreePath: string,
      options: { taskId?: string; force?: boolean } = {},
    ) {
      const params = new URLSearchParams();
      if (options.taskId) params.set('taskId', options.taskId);
      if (options.force) params.set('force', 'true');
      const query = params.toString() ? `?${params.toString()}` : '';

      return app.request(
        `/api/repositories/${repoId}/worktrees/${encodeURIComponent(worktreePath)}${query}`,
        { method: 'DELETE' },
      );
    }

    it('returns 409 when deletion is already in progress', async () => {
      const wtPath = '/some/worktree/path';
      _getDeletionsInProgress().add(wtPath);

      const res = await deleteRequest(REPO_ID, wtPath, { taskId: 'task-del' });

      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toContain('Deletion already in progress');
    });

    it('returns 409 when pull is in progress for the worktree', async () => {
      const wtPath = '/some/worktree/path';
      _getPullsInProgress().add(wtPath);

      const res = await deleteRequest(REPO_ID, wtPath, { taskId: 'task-del' });

      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toContain('Pull is in progress');
    });

    it('returns 202 for async deletion with taskId', async () => {
      // Use a path inside the managed directory so deleteWorktree validation passes
      const wtPath = `${repositoriesDir}/owner/repo/worktrees/wt-001`;
      // Set up mock to allow deleteWorktree to succeed
      mockWorktreeService.removeWorktree.mockImplementation(() =>
        Promise.resolve({ success: true }),
      );

      const res = await deleteRequest(REPO_ID, wtPath, { taskId: 'task-del' });

      expect(res.status).toBe(202);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.accepted).toBe(true);
    });

    it('returns 200 for synchronous deletion without taskId', async () => {
      // Use a path inside the managed directory so deleteWorktree validation passes
      const wtPath = `${repositoriesDir}/owner/repo/worktrees/wt-001`;
      mockWorktreeService.removeWorktree.mockImplementation(() =>
        Promise.resolve({ success: true }),
      );

      const res = await deleteRequest(REPO_ID, wtPath);

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.success).toBe(true);
    });

    it('returns 400 when worktree path is empty', async () => {
      // The route pattern /:id/worktrees/* requires something after /worktrees/
      // An empty path after encoding would hit the validation check
      const res = await app.request(
        `/api/repositories/${REPO_ID}/worktrees/`,
        { method: 'DELETE' },
      );

      // Hono wildcard with empty path - route may not match or returns validation error
      expect([400, 404]).toContain(res.status);
    });
  });
});
