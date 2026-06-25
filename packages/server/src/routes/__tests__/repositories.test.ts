import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { GenerateRepositoryDescriptionFn } from '../../services/repository-description-generator.js';
import {
  CloneNameConflictError,
  CloneValidationError,
} from '../../services/repository-clone-service.js';
import { CLONE_ERROR_CODES, CLONE_JOB_STATUS } from '@agent-console/shared';

const mockGenerateDescription = mock<GenerateRepositoryDescriptionFn>(() =>
  Promise.resolve({ description: 'test' })
);

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

// Mock of the clone-and-register service (Issue #834). Captures enqueueClone
// arguments + lets each test stub the resolved/rejected value per-call. The
// real service maintains in-memory state; tests can either drive that state
// directly via getJob.mockReturnValue or via enqueueClone returning a jobId
// the test seeds.
const repositoryCloneService = {
  enqueueClone: mock((_request: unknown) => Promise.resolve('mock-job-id')),
  getJob: mock((_jobId: string) => undefined as any),
};

// Mock of the worktreeService for the /branches and /refresh-default-branch
// routes (Issue #870). Captures the `requestUsername` second arg so each test
// can assert the route forwarded `authUser.username` correctly.
type BranchesResult = { local: string[]; remote: string[]; defaultBranch: string | null };

const worktreeService = {
  listBranches: mock<
    (repoPath: string, requestUsername?: string | null) => Promise<BranchesResult>
  >(() => Promise.resolve({ local: [], remote: [], defaultBranch: null })),
  refreshDefaultBranch: mock<
    (repoPath: string, requestUsername?: string | null) => Promise<string>
  >(() => Promise.resolve('main')),
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
  repositoryCloneService.enqueueClone.mockReset();
  repositoryCloneService.enqueueClone.mockImplementation(() => Promise.resolve('mock-job-id'));
  repositoryCloneService.getJob.mockReset();
  worktreeService.listBranches.mockReset();
  worktreeService.listBranches.mockImplementation(() =>
    Promise.resolve({ local: [], remote: [], defaultBranch: null }),
  );
  worktreeService.refreshDefaultBranch.mockReset();
  worktreeService.refreshDefaultBranch.mockImplementation(() => Promise.resolve('main'));
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
      generateRepositoryDescription: mockGenerateDescription as any,
      repositoryCloneService: repositoryCloneService as any,
      worktreeService: worktreeService as any,
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
    it('should thread the authenticated username as requestUser (Issue #835)', async () => {
      // In multi-user mode the generator must run the agent's headless command
      // as the requesting user (via runAsUser). The route is responsible for
      // forwarding `authUser.username` -> `requestUser`. The default test app
      // wires SingleUserMode with TEST_AUTH_USER ('testuser'), so we assert
      // the value lands on the generator call.
      repositoryManager.getRepository.mockReturnValue({ id: 'repo1', path: '/repo' });
      agentManager.getAgent.mockReturnValue({ id: 'claude-code-builtin', command: 'claude' });
      mockGenerateDescription.mockImplementationOnce(() =>
        Promise.resolve({ description: 'A test description.' })
      );

      const res = await app.request('/api/repositories/repo1/generate-description', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      expect(mockGenerateDescription).toHaveBeenCalledTimes(1);
      const firstArg = mockGenerateDescription.mock.calls[0][0];
      expect(firstArg.repositoryPath).toBe('/repo');
      expect(firstArg.requestUser).toBe('testuser');
    });

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

  // =========================================================================
  // GET /api/repositories/:id/branches (Issue #870)
  // POST /api/repositories/:id/refresh-default-branch (Issue #870)
  //
  // These two routes thread `authUser.username` into `worktreeService` so
  // multi-user mode runs git invocations as the requesting user. The test
  // app wires SingleUserMode with TEST_AUTH_USER.username = 'testuser', so
  // we assert that value lands on each service call.
  // =========================================================================

  describe('GET /api/repositories/:id/branches', () => {
    it('forwards authUser.username to worktreeService.listBranches', async () => {
      repositoryManager.getRepository.mockReturnValue({ id: 'repo1', path: '/repo' });
      worktreeService.listBranches.mockImplementationOnce(() =>
        Promise.resolve({ local: ['main'], remote: ['origin/main'], defaultBranch: 'main' }),
      );

      const res = await app.request('/api/repositories/repo1/branches');
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        local: string[];
        remote: string[];
        defaultBranch: string | null;
      };
      expect(body.local).toEqual(['main']);
      expect(body.remote).toEqual(['origin/main']);
      expect(body.defaultBranch).toBe('main');

      expect(worktreeService.listBranches).toHaveBeenCalledTimes(1);
      const [repoPath, requestUsername] = worktreeService.listBranches.mock.calls[0];
      expect(repoPath).toBe('/repo');
      expect(requestUsername).toBe('testuser');
    });

    it('returns 404 when the repository is not registered', async () => {
      repositoryManager.getRepository.mockReturnValue(undefined);

      const res = await app.request('/api/repositories/missing/branches');
      expect(res.status).toBe(404);
      expect(worktreeService.listBranches).toHaveBeenCalledTimes(0);
    });
  });

  describe('POST /api/repositories/:id/refresh-default-branch', () => {
    it('forwards authUser.username to worktreeService.refreshDefaultBranch', async () => {
      repositoryManager.getRepository.mockReturnValue({ id: 'repo1', path: '/repo' });
      worktreeService.refreshDefaultBranch.mockImplementationOnce(() =>
        Promise.resolve('develop'),
      );

      const res = await app.request('/api/repositories/repo1/refresh-default-branch', {
        method: 'POST',
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { defaultBranch: string };
      expect(body.defaultBranch).toBe('develop');

      expect(worktreeService.refreshDefaultBranch).toHaveBeenCalledTimes(1);
      const [repoPath, requestUsername] = worktreeService.refreshDefaultBranch.mock.calls[0];
      expect(repoPath).toBe('/repo');
      expect(requestUsername).toBe('testuser');
    });

    it('maps GitError to a 400 response (network failure surfaces as Validation)', async () => {
      repositoryManager.getRepository.mockReturnValue({ id: 'repo1', path: '/repo' });
      worktreeService.refreshDefaultBranch.mockImplementationOnce(() => {
        throw new GitError('network unreachable', 128, 'fatal: network unreachable');
      });

      const res = await app.request('/api/repositories/repo1/refresh-default-branch', {
        method: 'POST',
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Failed to refresh default branch');
    });
  });

  // =========================================================================
  // POST /api/repositories/clone (Issue #834)
  // =========================================================================
  describe('POST /api/repositories/clone', () => {
    it('returns 202 with jobId, forwarding authUser.username as requestUser', async () => {
      repositoryCloneService.enqueueClone.mockImplementationOnce(() =>
        Promise.resolve('job-abc'),
      );

      const res = await app.request('/api/repositories/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://github.com/org/repo.git',
          description: 'an example',
        }),
      });

      expect(res.status).toBe(202);
      const body = (await res.json()) as { jobId: string; repositoryId: null };
      expect(body.jobId).toBe('job-abc');
      expect(body.repositoryId).toBe(null);

      expect(repositoryCloneService.enqueueClone).toHaveBeenCalledTimes(1);
      const firstArg = repositoryCloneService.enqueueClone.mock.calls[0][0] as any;
      expect(firstArg.url).toBe('https://github.com/org/repo.git');
      expect(firstArg.description).toBe('an example');
      // TEST_AUTH_USER.username from test-utils.ts is 'testuser'.
      expect(firstArg.requestUser).toBe('testuser');
    });

    it('returns 400 when the schema rejects the URL (no service call)', async () => {
      const res = await app.request('/api/repositories/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Leading dash gets rejected by the schema before the route handler
        // body validation -- the service must never be invoked.
        body: JSON.stringify({ url: '--upload-pack=evil' }),
      });
      expect(res.status).toBe(400);
      expect(repositoryCloneService.enqueueClone).toHaveBeenCalledTimes(0);
    });

    it('returns 409 when the service throws CloneNameConflictError', async () => {
      repositoryCloneService.enqueueClone.mockImplementationOnce(() => {
        throw new CloneNameConflictError(
          'Target directory already exists: /var/lib/agent-console/source-repos/repo',
        );
      });

      const res = await app.request('/api/repositories/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://github.com/org/repo.git' }),
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('already exists');
    });

    it('returns 400 when the service throws CloneValidationError', async () => {
      repositoryCloneService.enqueueClone.mockImplementationOnce(() => {
        throw new CloneValidationError('Could not derive a directory name from the URL');
      });

      const res = await app.request('/api/repositories/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/something' }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Could not derive');
    });
  });

  // =========================================================================
  // GET /api/repositories/clone/:jobId (Issue #834)
  // =========================================================================
  describe('GET /api/repositories/clone/:jobId', () => {
    it('returns 404 when the jobId is unknown', async () => {
      repositoryCloneService.getJob.mockReturnValueOnce(undefined);
      const res = await app.request('/api/repositories/clone/missing-job');
      expect(res.status).toBe(404);
    });

    it('returns the pending/cloning status with no repositoryId or error', async () => {
      repositoryCloneService.getJob.mockReturnValueOnce({
        id: 'job-1',
        status: CLONE_JOB_STATUS.CLONING,
        createdAt: 1,
        updatedAt: 2,
      });
      const res = await app.request('/api/repositories/clone/job-1');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.jobId).toBe('job-1');
      expect(body.status).toBe(CLONE_JOB_STATUS.CLONING);
      expect(body.repositoryId).toBeUndefined();
      expect(body.error).toBeUndefined();
    });

    it('returns repositoryId on succeeded', async () => {
      repositoryCloneService.getJob.mockReturnValueOnce({
        id: 'job-2',
        status: CLONE_JOB_STATUS.SUCCEEDED,
        repositoryId: 'repo-xyz',
        createdAt: 1,
        updatedAt: 3,
      });
      const res = await app.request('/api/repositories/clone/job-2');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe(CLONE_JOB_STATUS.SUCCEEDED);
      expect(body.repositoryId).toBe('repo-xyz');
    });

    it('returns error code + message on failed', async () => {
      repositoryCloneService.getJob.mockReturnValueOnce({
        id: 'job-3',
        status: CLONE_JOB_STATUS.FAILED,
        error: {
          code: CLONE_ERROR_CODES.AUTH_FAILED,
          message: 'git@github.com: Permission denied (publickey).',
        },
        createdAt: 1,
        updatedAt: 4,
      });
      const res = await app.request('/api/repositories/clone/job-3');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        jobId: string;
        status: string;
        error: { code: string; message: string };
      };
      expect(body.status).toBe(CLONE_JOB_STATUS.FAILED);
      expect(body.error.code).toBe(CLONE_ERROR_CODES.AUTH_FAILED);
      expect(body.error.message).toContain('Permission denied');
    });
  });
});
