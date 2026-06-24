import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { onApiError } from '../../lib/error-handler.js';
import { api } from '../api.js';
import type { AppBindings } from '../../app-context.js';
import type { WorktreeService } from '../../services/worktree-service.js';
import type { RepositoryManager } from '../../services/repository-manager.js';
import type { SessionManager } from '../../services/session-manager.js';
import type { AppServerMessage, Repository } from '@agent-console/shared';
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
    removeOrphanedWorktree: mock(() => Promise.resolve()),
    getWorktreeIndexNumber: mock(() => Promise.resolve(null)),
    // Default no-op for createWorktree; overridden in tests that exercise
    // the POST /worktrees route.
    createWorktree: mock(() => Promise.resolve({ worktreePath: '', error: 'not implemented in mock' })),
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
  // POST /api/repositories/:id/worktrees  (Issue #838: requestUsername plumbing)
  // =========================================================================

  describe('POST /api/repositories/:id/worktrees (Issue #838 requestUsername plumbing)', () => {
    /**
     * The route handler kicks worktree creation off in a fire-and-forget
     * background promise; the HTTP response returns 202 immediately. To
     * deterministically observe the inner `worktreeService.createWorktree`
     * call, the mock resolves a promise the test awaits before asserting.
     */
    function createCapturingWorktreeMock() {
      let resolveCall!: (args: unknown[]) => void;
      const captured = new Promise<unknown[]>((resolve) => {
        resolveCall = resolve;
      });
      const mockFn = mock((...args: unknown[]) => {
        resolveCall(args);
        // Return error so the route's success-broadcast path is skipped --
        // the test only needs to observe the createWorktree call args.
        return Promise.resolve({ worktreePath: '', error: 'short-circuit for test' });
      });
      return { mockFn, captured };
    }

    it("forwards authUser.username as requestUsername to worktreeService.createWorktree", async () => {
      // Mock the agent manager so the route passes the agent validation.
      const mockAgentManager = {
        getAgent: mock(() => ({ id: 'claude-code-builtin', name: 'Claude Code' })),
      } as unknown as Parameters<typeof asAppContext>[0]['agentManager'];

      const { mockFn: createCapture, captured } = createCapturingWorktreeMock();
      (mockWorktreeService as unknown as { createWorktree: typeof createCapture }).createWorktree = createCapture;

      // Re-mount the app with the augmented appContext (agentManager +
      // sessionManager + broadcastToApp + suggestSessionMetadata). The
      // default suggestSessionMetadata is not invoked because we use
      // `mode: 'custom'`, which uses the explicit branch verbatim.
      app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', asAppContext({
          repositoryManager: mockRepositoryManager,
          worktreeService: mockWorktreeService,
          agentManager: mockAgentManager,
          // sessionManager is invoked downstream by createWorktreeWithSession
          // only when the worktree creation succeeds; the short-circuit error
          // above ensures it never runs.
          sessionManager: { createSession: mock() } as unknown as SessionManager,
          broadcastToApp: () => {},
          suggestSessionMetadata: mock(async () => ({ branch: '', title: '', error: 'unused' })),
        }));
        await next();
      });
      app.onError(onApiError);
      app.route('/api', api);

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: 'task-issue-838',
            mode: 'custom',
            branch: 'issue-838-feature',
            baseBranch: 'main',
            useRemote: false,
            autoStartSession: false,
            agentId: 'claude-code-builtin',
          }),
        },
      );

      expect(res.status).toBe(202);

      // The route's fire-and-forget call MUST run before the test ends.
      // The promise resolves the moment createWorktree is invoked.
      const args = await captured;
      // Signature: (repoPath, branch, repoId, baseBranch, requestUsername)
      expect(args[0]).toBe(REPO_PATH);
      expect(args[1]).toBe('issue-838-feature');
      expect(args[2]).toBe(TEST_REPO.id);
      // The default SingleUserMode used by asAppContext is constructed with
      // TEST_AUTH_USER (username='testuser'), so the route MUST forward
      // 'testuser' as the 5th positional arg.
      expect(args[4]).toBe('testuser');
    });

    it("forwards authUser.username as requestUser to suggestSessionMetadata (Issue #856)", async () => {
      // For `mode: 'prompt'`, the route invokes `suggestSessionMetadata` to
      // auto-generate a branch name + title. After Issue #856 the route must
      // thread `authUser.username` down so the headless agent command runs
      // as the requesting user in multi-user mode (via runAsUser inside the
      // suggester). The default SingleUserMode used by asAppContext is
      // constructed with TEST_AUTH_USER (username='testuser'), so we assert
      // the route forwards 'testuser' as `requestUser`.
      const mockAgentManager = {
        getAgent: mock(() => ({ id: 'claude-code-builtin', name: 'Claude Code' })),
      } as unknown as Parameters<typeof asAppContext>[0]['agentManager'];

      // Capture the args the suggester receives. Resolve to an error so the
      // downstream worktree creation falls back to `task-<timestamp>` and we
      // do not need to mock the success-broadcast path further.
      let resolveSuggestionCall!: (args: unknown[]) => void;
      const suggestionCaptured = new Promise<unknown[]>((resolve) => {
        resolveSuggestionCall = resolve;
      });
      const suggestionMock = mock((...args: unknown[]) => {
        resolveSuggestionCall(args);
        return Promise.resolve({ branch: undefined, title: undefined, error: 'short-circuit for test' });
      });

      // Short-circuit the worktree creation so we do not exercise the full
      // pipeline; we only care that the suggester was called with the right
      // requestUser.
      const { mockFn: createCapture } = createCapturingWorktreeMock();
      (mockWorktreeService as unknown as { createWorktree: typeof createCapture }).createWorktree = createCapture;

      app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', asAppContext({
          repositoryManager: mockRepositoryManager,
          worktreeService: mockWorktreeService,
          agentManager: mockAgentManager,
          sessionManager: { createSession: mock() } as unknown as SessionManager,
          broadcastToApp: () => {},
          suggestSessionMetadata: suggestionMock as unknown as Parameters<typeof asAppContext>[0]['suggestSessionMetadata'],
        }));
        await next();
      });
      app.onError(onApiError);
      app.route('/api', api);

      const res = await app.request(
        `/api/repositories/${TEST_REPO.id}/worktrees`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: 'task-issue-856',
            mode: 'prompt',
            initialPrompt: 'Add a dark mode toggle',
            baseBranch: 'main',
            useRemote: false,
            autoStartSession: false,
            agentId: 'claude-code-builtin',
          }),
        },
      );

      expect(res.status).toBe(202);

      // The suggester is invoked from the fire-and-forget IIFE; await the
      // captured-args promise so we observe the call deterministically.
      const args = await suggestionCaptured;
      const req = args[0] as { prompt: string; repositoryPath: string; requestUser: string | null };
      expect(req.prompt).toBe('Add a dark mode toggle');
      expect(req.repositoryPath).toBe(REPO_PATH);
      // Primary assertion: requestUser must equal the authenticated OS user.
      expect(req.requestUser).toBe('testuser');
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

    it('should broadcast worktree-deletion-completed with empty sessionIds when repository is unregistered (orphan async path, refs #815)', async () => {
      // Refs #815. When the repository row is missing from the in-memory
      // registry (e.g., the primary repo dir was deleted out-of-band so
      // RepositoryManager.initialize() skipped it), the worktree has lost
      // its anchor. The deletion service routes into git-less orphan
      // cleanup and the route must emit a SUCCESS broadcast — not failure
      // — with the worktree's session IDs (here: [] because no sessions
      // were registered against this orphaned worktree).
      //
      // This replaces an earlier regression test (PR #816) that asserted
      // a worktree-deletion-failed broadcast. That contract is obsolete:
      // the deletion service no longer gives up partway when the repo is
      // unregistered.
      const broadcasts: AppServerMessage[] = [];

      const mockSessionManager = {
        getAllSessions: () => [],
        killSessionWorkers: mock(() => Promise.resolve()),
        deleteSession: mock(() => Promise.resolve(true)),
      } as unknown as SessionManager;

      app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', asAppContext({
          repositoryManager: mockRepositoryManager,
          worktreeService: mockWorktreeService,
          sessionManager: mockSessionManager,
          broadcastToApp: (msg) => { broadcasts.push(msg); },
        }));
        await next();
      });
      app.onError(onApiError);
      app.route('/api', api);

      const unknownRepoId = 'non-existent-repo-id';
      const res = await app.request(
        `/api/repositories/${unknownRepoId}/worktrees/${encodedPath(WORKTREE_PATH)}?taskId=test-orphan-task`,
        { method: 'DELETE' },
      );

      // Async path returns 202 immediately even when the repo is missing
      expect(res.status).toBe(202);

      // Wait for the background fire-and-forget task to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      const completedBroadcasts = broadcasts.filter(
        (b): b is Extract<AppServerMessage, { type: 'worktree-deletion-completed' }> =>
          b.type === 'worktree-deletion-completed' && b.taskId === 'test-orphan-task',
      );
      expect(completedBroadcasts.length).toBe(1);
      expect(completedBroadcasts[0].sessionIds).toEqual([]);

      // No failure should be emitted for the orphan path.
      const failedBroadcasts = broadcasts.filter(
        (b) => b.type === 'worktree-deletion-failed' && b.taskId === 'test-orphan-task',
      );
      expect(failedBroadcasts.length).toBe(0);

      // The git-less helper must be the one that ran (not the git-bound removeWorktree).
      expect(mockWorktreeService.removeOrphanedWorktree).toHaveBeenCalledWith(WORKTREE_PATH);
      expect(mockWorktreeService.removeWorktree).not.toHaveBeenCalled();
    });
  });
});
