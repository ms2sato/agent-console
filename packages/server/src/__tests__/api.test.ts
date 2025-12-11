import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import * as os from 'os';
import type {
  Session,
  Repository,
  Worktree,
  AgentDefinition,
  Worker,
  CreateSessionRequest,
} from '@agent-console/shared';

// Mock open package
vi.mock('open', () => ({
  default: vi.fn(() => Promise.resolve()),
}));

// Mock fs functions
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: vi.fn((path: string) => {
      if (path.includes('non-existent')) return false;
      return true;
    }),
    statSync: vi.fn((path: string) => ({
      isFile: () => path.includes('.txt') || path.includes('.js'),
      isDirectory: () => !path.includes('.txt') && !path.includes('.js'),
    })),
  };
});

// Mock data storage
let mockSessions: Map<string, Session>;
let mockRepositories: Map<string, Repository>;
let sessionIdCounter = 0;

// Helper to create a mock session
function createMockSession(request: CreateSessionRequest): Session {
  const id = `test-session-${++sessionIdCounter}`;
  const now = new Date().toISOString();
  const workers: Worker[] = [
    {
      id: `${id}-agent`,
      type: 'agent',
      name: 'Claude',
      agentId: request.agentId || 'claude-code',
      createdAt: now,
    },
  ];

  if (request.type === 'worktree') {
    return {
      id,
      type: 'worktree',
      locationPath: request.locationPath,
      repositoryId: request.repositoryId,
      worktreeId: request.worktreeId,
      status: 'active',
      createdAt: now,
      workers,
      initialPrompt: request.initialPrompt,
      title: request.title,
    };
  } else {
    return {
      id,
      type: 'quick',
      locationPath: request.locationPath,
      status: 'active',
      createdAt: now,
      workers,
      initialPrompt: request.initialPrompt,
      title: request.title,
    };
  }
}

// Mock session manager - simple mock without external logic
vi.mock('../services/session-manager.js', () => ({
  sessionManager: {
    getAllSessions: vi.fn(() => Array.from(mockSessions.values())),
    getSession: vi.fn((id: string) => mockSessions.get(id)),
    createSession: vi.fn((request: CreateSessionRequest) => {
      const session = createMockSession(request);
      mockSessions.set(session.id, session);
      return session;
    }),
    deleteSession: vi.fn((id: string) => {
      if (mockSessions.has(id)) {
        mockSessions.delete(id);
        return true;
      }
      return false;
    }),
    getSessionMetadata: vi.fn(() => undefined),
    createWorker: vi.fn(),
    deleteWorker: vi.fn(),
    restartAgentWorker: vi.fn(() => null),
    attachWorkerCallbacks: vi.fn(),
    detachWorkerCallbacks: vi.fn(),
    getWorkerOutputBuffer: vi.fn(() => null),
    getWorkerActivityState: vi.fn(() => 'idle'),
    setGlobalActivityCallback: vi.fn(),
    renameBranch: vi.fn(() => ({ success: true, branch: 'new-branch' })),
  },
}));

// Mock repository manager - simple mock that can be configured per test
vi.mock('../services/repository-manager.js', () => ({
  repositoryManager: {
    getAllRepositories: vi.fn(() => Array.from(mockRepositories.values())),
    getRepository: vi.fn((id: string) => mockRepositories.get(id)),
    registerRepository: vi.fn(),
    unregisterRepository: vi.fn((id: string) => mockRepositories.has(id)),
    findRepositoryByPath: vi.fn(() => undefined),
  },
}));

// Mock worktree service
vi.mock('../services/worktree-service.js', () => ({
  worktreeService: {
    listWorktrees: vi.fn((repoPath: string, repoId: string): Worktree[] => [
      {
        path: repoPath,
        branch: 'main',
        repositoryId: repoId,
        isMain: true,
      },
    ]),
    listBranches: vi.fn(() => ({
      local: ['main', 'develop'],
      remote: ['origin/main', 'origin/develop'],
      defaultBranch: 'main',
    })),
    createWorktree: vi.fn(() => ({ worktreePath: '/test/path', error: null })),
    removeWorktree: vi.fn(() => ({ success: true })),
    isWorktreeOf: vi.fn(() => true),
    generateNextBranchName: vi.fn(() => 'wt-001-abcd'),
    getDefaultBranch: vi.fn(() => 'main'),
  },
}));

// Mock agent manager
vi.mock('../services/agent-manager.js', () => ({
  agentManager: {
    getAllAgents: vi.fn((): AgentDefinition[] => [
      {
        id: 'claude-code',
        name: 'Claude Code',
        command: 'claude',
        isBuiltIn: true,
        registeredAt: '2024-01-01T00:00:00.000Z',
      },
    ]),
    getAgent: vi.fn((id: string): AgentDefinition | undefined => {
      if (id === 'claude-code') {
        return {
          id: 'claude-code',
          name: 'Claude Code',
          command: 'claude',
          isBuiltIn: true,
          registeredAt: '2024-01-01T00:00:00.000Z',
        };
      }
      return undefined;
    }),
    registerAgent: vi.fn(),
    updateAgent: vi.fn(),
    unregisterAgent: vi.fn(),
    getDefaultAgent: vi.fn(() => ({
      id: 'claude-code',
      name: 'Claude Code',
      command: 'claude',
      isBuiltIn: true,
      registeredAt: '2024-01-01T00:00:00.000Z',
    })),
  },
  CLAUDE_CODE_AGENT_ID: 'claude-code',
}));

// Mock session metadata suggester
vi.mock('../services/session-metadata-suggester.js', () => ({
  suggestSessionMetadata: vi.fn(() =>
    Promise.resolve({
      branch: 'feat/default-branch',
      title: 'Default Generated Title',
    })
  ),
}));

describe('API Routes', () => {
  let app: Hono;

  beforeEach(async () => {
    // Reset modules to get fresh imports
    vi.resetModules();

    // Reset mock data
    mockSessions = new Map();
    mockRepositories = new Map();
    sessionIdCounter = 0;

    // Import and mount the actual API router with error handler
    const { api } = await import('../routes/api.js');
    const { onApiError } = await import('../lib/error-handler.js');
    app = new Hono();
    app.onError(onApiError);
    app.route('/api', api);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api', () => {
    it('should return API info', async () => {
      const res = await app.request('/api');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ message: 'Agent Console API' });
    });
  });

  describe('GET /api/config', () => {
    it('should return config with homeDir', async () => {
      const res = await app.request('/api/config');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { homeDir: string };
      expect(body.homeDir).toBe(os.homedir());
    });
  });

  describe('Sessions API', () => {
    describe('GET /api/sessions', () => {
      it('should return empty sessions array initially', async () => {
        const res = await app.request('/api/sessions');
        expect(res.status).toBe(200);

        const body = (await res.json()) as { sessions: Session[] };
        expect(body.sessions).toBeInstanceOf(Array);
        expect(body.sessions.length).toBe(0);
      });

      it('should return sessions when they exist', async () => {
        // Pre-populate mock data
        mockSessions.set('session-1', {
          id: 'session-1',
          type: 'worktree',
          locationPath: '/path/1',
          repositoryId: 'repo-1',
          worktreeId: 'main',
          status: 'active',
          createdAt: '2024-01-01T00:00:00.000Z',
          workers: [],
        });

        const res = await app.request('/api/sessions');
        expect(res.status).toBe(200);

        const body = (await res.json()) as { sessions: Session[] };
        expect(body.sessions.length).toBe(1);
        expect(body.sessions[0].id).toBe('session-1');
      });
    });

    describe('POST /api/sessions', () => {
      it('should create a new worktree session', async () => {
        const res = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'worktree',
            locationPath: '/test/path',
            repositoryId: 'test-repo',
            worktreeId: 'main',
          }),
        });
        expect(res.status).toBe(201);

        const body = (await res.json()) as { session: Session };
        expect(body.session).toBeDefined();
        expect(body.session.locationPath).toBe('/test/path');
        expect(body.session.type).toBe('worktree');
      });

      it('should create a new quick session', async () => {
        const res = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
          }),
        });
        expect(res.status).toBe(201);

        const body = (await res.json()) as { session: Session };
        expect(body.session).toBeDefined();
        expect(body.session.type).toBe('quick');
      });
    });

    describe('DELETE /api/sessions/:id', () => {
      it('should delete an existing session', async () => {
        // First create a session
        const createRes = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test',
          }),
        });
        const { session } = (await createRes.json()) as { session: Session };

        // Then delete it
        const deleteRes = await app.request(`/api/sessions/${session.id}`, {
          method: 'DELETE',
        });
        expect(deleteRes.status).toBe(200);

        const body = (await deleteRes.json()) as { success: boolean };
        expect(body.success).toBe(true);
      });

      it('should return 404 for non-existent session', async () => {
        const res = await app.request('/api/sessions/non-existent', {
          method: 'DELETE',
        });
        expect(res.status).toBe(404);
      });
    });

    describe('GET /api/sessions/:id', () => {
      it('should return session for active session', async () => {
        mockSessions.set('active-session', {
          id: 'active-session',
          type: 'worktree',
          locationPath: '/path/to/worktree',
          repositoryId: 'repo-1',
          worktreeId: 'main',
          status: 'active',
          createdAt: '2024-01-01T00:00:00.000Z',
          workers: [],
        });

        const res = await app.request('/api/sessions/active-session');
        expect(res.status).toBe(200);

        const body = (await res.json()) as { session: Session };
        expect(body.session.id).toBe('active-session');
        expect(body.session.locationPath).toBe('/path/to/worktree');
      });

      it('should return 404 for non-existent session', async () => {
        const { sessionManager } = await import('../services/session-manager.js');
        vi.mocked(sessionManager.getSessionMetadata).mockReturnValue(undefined);

        const res = await app.request('/api/sessions/non-existent');
        expect(res.status).toBe(404);
      });
    });
  });

  describe('Workers API', () => {
    describe('GET /api/sessions/:sessionId/workers', () => {
      it('should return workers for a session', async () => {
        mockSessions.set('test-session', {
          id: 'test-session',
          type: 'quick',
          locationPath: '/test',
          status: 'active',
          createdAt: '2024-01-01T00:00:00.000Z',
          workers: [
            {
              id: 'worker-1',
              type: 'agent',
              name: 'Claude',
              agentId: 'claude-code',
              createdAt: '2024-01-01T00:00:00.000Z',
            },
          ],
        });

        const res = await app.request('/api/sessions/test-session/workers');
        expect(res.status).toBe(200);

        const body = (await res.json()) as { workers: Worker[] };
        expect(body.workers.length).toBe(1);
        expect(body.workers[0].id).toBe('worker-1');
      });

      it('should return 404 for non-existent session', async () => {
        const res = await app.request('/api/sessions/non-existent/workers');
        expect(res.status).toBe(404);
      });
    });

    describe('POST /api/sessions/:sessionId/workers', () => {
      it('should create a worker in a session', async () => {
        mockSessions.set('test-session', {
          id: 'test-session',
          type: 'quick',
          locationPath: '/test',
          status: 'active',
          createdAt: '2024-01-01T00:00:00.000Z',
          workers: [],
        });

        const { sessionManager } = await import('../services/session-manager.js');
        vi.mocked(sessionManager.createWorker).mockReturnValue({
          id: 'new-worker',
          type: 'terminal',
          name: 'Shell',
          createdAt: '2024-01-01T00:00:00.000Z',
        });

        const res = await app.request('/api/sessions/test-session/workers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'terminal', name: 'Shell' }),
        });
        expect(res.status).toBe(201);

        const body = (await res.json()) as { worker: Worker };
        expect(body.worker.id).toBe('new-worker');
      });

      it('should return 404 for non-existent session', async () => {
        const res = await app.request('/api/sessions/non-existent/workers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'terminal', name: 'Shell' }),
        });
        expect(res.status).toBe(404);
      });
    });

    describe('DELETE /api/sessions/:sessionId/workers/:workerId', () => {
      it('should delete a worker', async () => {
        mockSessions.set('test-session', {
          id: 'test-session',
          type: 'quick',
          locationPath: '/test',
          status: 'active',
          createdAt: '2024-01-01T00:00:00.000Z',
          workers: [
            {
              id: 'worker-1',
              type: 'terminal',
              name: 'Shell',
              createdAt: '2024-01-01T00:00:00.000Z',
            },
          ],
        });

        const { sessionManager } = await import('../services/session-manager.js');
        vi.mocked(sessionManager.deleteWorker).mockReturnValue(true);

        const res = await app.request('/api/sessions/test-session/workers/worker-1', {
          method: 'DELETE',
        });
        expect(res.status).toBe(200);

        const body = (await res.json()) as { success: boolean };
        expect(body.success).toBe(true);
      });

      it('should return 404 for non-existent worker', async () => {
        mockSessions.set('test-session', {
          id: 'test-session',
          type: 'quick',
          locationPath: '/test',
          status: 'active',
          createdAt: '2024-01-01T00:00:00.000Z',
          workers: [],
        });

        const { sessionManager } = await import('../services/session-manager.js');
        vi.mocked(sessionManager.deleteWorker).mockReturnValue(false);

        const res = await app.request('/api/sessions/test-session/workers/non-existent', {
          method: 'DELETE',
        });
        expect(res.status).toBe(404);
      });
    });

    describe('POST /api/sessions/:sessionId/workers/:workerId/restart', () => {
      it('should restart an agent worker', async () => {
        const { sessionManager } = await import('../services/session-manager.js');
        vi.mocked(sessionManager.restartAgentWorker).mockReturnValue({
          id: 'worker-1',
          type: 'agent',
          name: 'Claude',
          agentId: 'claude-code',
          createdAt: '2024-01-01T00:00:00.000Z',
        });

        const res = await app.request('/api/sessions/test-session/workers/worker-1/restart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ continueConversation: true }),
        });
        expect(res.status).toBe(200);

        const body = (await res.json()) as { worker: Worker };
        expect(body.worker.id).toBe('worker-1');
      });

      it('should return 404 when worker cannot be restarted', async () => {
        const { sessionManager } = await import('../services/session-manager.js');
        vi.mocked(sessionManager.restartAgentWorker).mockReturnValue(null);

        const res = await app.request('/api/sessions/test-session/workers/worker-1/restart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(404);
      });
    });
  });

  describe('Repositories API', () => {
    describe('GET /api/repositories', () => {
      it('should return empty repositories array initially', async () => {
        const res = await app.request('/api/repositories');
        expect(res.status).toBe(200);

        const body = (await res.json()) as { repositories: Repository[] };
        expect(body.repositories).toBeInstanceOf(Array);
        expect(body.repositories.length).toBe(0);
      });

      it('should return repositories when they exist', async () => {
        mockRepositories.set('repo-1', {
          id: 'repo-1',
          name: 'test-repo',
          path: '/path/to/repo',
          registeredAt: '2024-01-01T00:00:00.000Z',
        });

        const res = await app.request('/api/repositories');
        expect(res.status).toBe(200);

        const body = (await res.json()) as { repositories: Repository[] };
        expect(body.repositories.length).toBe(1);
        expect(body.repositories[0].name).toBe('test-repo');
      });
    });

    describe('POST /api/repositories', () => {
      it('should return 400 when path is missing', async () => {
        const res = await app.request('/api/repositories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
      });

      it('should register repository successfully', async () => {
        const { repositoryManager } = await import('../services/repository-manager.js');

        // Configure mock to return a repository
        vi.mocked(repositoryManager.registerRepository).mockReturnValue({
          id: 'new-repo-id',
          name: 'my-repo',
          path: '/path/to/my-repo',
          registeredAt: new Date().toISOString(),
        });

        const res = await app.request('/api/repositories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '/path/to/my-repo' }),
        });
        expect(res.status).toBe(201);

        const body = (await res.json()) as { repository: Repository };
        expect(body.repository).toBeDefined();
        expect(body.repository.path).toBe('/path/to/my-repo');
      });

      it('should return 400 when repository registration fails', async () => {
        const { repositoryManager } = await import('../services/repository-manager.js');

        // Configure mock to throw an error
        vi.mocked(repositoryManager.registerRepository).mockImplementation(() => {
          throw new Error('Path does not exist: /non/existent');
        });

        const res = await app.request('/api/repositories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '/non/existent' }),
        });
        expect(res.status).toBe(400);

        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('Path does not exist');
      });
    });

    describe('DELETE /api/repositories/:id', () => {
      it('should return 404 for non-existent repository', async () => {
        const res = await app.request('/api/repositories/non-existent', {
          method: 'DELETE',
        });
        expect(res.status).toBe(404);
      });

      it('should delete existing repository', async () => {
        // Pre-populate mock data
        mockRepositories.set('repo-to-delete', {
          id: 'repo-to-delete',
          name: 'test-repo',
          path: '/path/to/repo',
          registeredAt: '2024-01-01T00:00:00.000Z',
        });

        const { repositoryManager } = await import('../services/repository-manager.js');
        vi.mocked(repositoryManager.unregisterRepository).mockReturnValue(true);

        const res = await app.request('/api/repositories/repo-to-delete', {
          method: 'DELETE',
        });
        expect(res.status).toBe(200);

        const body = (await res.json()) as { success: boolean };
        expect(body.success).toBe(true);
      });
    });
  });

  describe('Worktree API', () => {
    beforeEach(() => {
      // Set up a repository for worktree tests
      mockRepositories.set('test-repo-id', {
        id: 'test-repo-id',
        name: 'test-repo',
        path: '/path/to/repo',
        registeredAt: '2024-01-01T00:00:00.000Z',
      });
    });

    describe('GET /api/repositories/:id/worktrees', () => {
      it('should return worktrees for repository', async () => {
        const res = await app.request('/api/repositories/test-repo-id/worktrees');
        expect(res.status).toBe(200);

        const body = (await res.json()) as { worktrees: Worktree[] };
        expect(body.worktrees).toBeInstanceOf(Array);
        expect(body.worktrees[0].branch).toBe('main');
      });

      it('should return 404 for non-existent repository', async () => {
        const res = await app.request('/api/repositories/non-existent/worktrees');
        expect(res.status).toBe(404);
      });
    });

    describe('POST /api/repositories/:id/worktrees', () => {
      it('should create a worktree with custom branch', async () => {
        const { worktreeService } = await import('../services/worktree-service.js');
        vi.mocked(worktreeService.createWorktree).mockResolvedValue({
          worktreePath: '/path/to/new/worktree',
          error: undefined,
        });
        vi.mocked(worktreeService.listWorktrees).mockReturnValue([
          {
            path: '/path/to/new/worktree',
            branch: 'feature-branch',
            repositoryId: 'test-repo-id',
            isMain: false,
          },
        ]);

        const res = await app.request('/api/repositories/test-repo-id/worktrees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'custom', branch: 'feature-branch' }),
        });
        expect(res.status).toBe(201);

        const body = (await res.json()) as { worktree: Worktree };
        expect(body.worktree).toBeDefined();
        expect(body.worktree.branch).toBe('feature-branch');
      });

      it('should use existing branch with mode existing', async () => {
        const { worktreeService } = await import('../services/worktree-service.js');
        vi.mocked(worktreeService.createWorktree).mockResolvedValue({
          worktreePath: '/path/to/worktree',
          error: undefined,
        });
        vi.mocked(worktreeService.listWorktrees).mockReturnValue([
          {
            path: '/path/to/worktree',
            branch: 'existing-branch',
            repositoryId: 'test-repo-id',
            isMain: false,
          },
        ]);

        const res = await app.request('/api/repositories/test-repo-id/worktrees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'existing', branch: 'existing-branch' }),
        });
        expect(res.status).toBe(201);

        // baseBranch should be undefined for existing mode
        expect(vi.mocked(worktreeService.createWorktree)).toHaveBeenCalledWith(
          '/path/to/repo',
          'existing-branch',
          undefined
        );
      });

      it('should return 400 when worktree creation fails', async () => {
        const { worktreeService } = await import('../services/worktree-service.js');
        vi.mocked(worktreeService.createWorktree).mockResolvedValue({
          worktreePath: '',
          error: 'Branch already exists',
        });

        const res = await app.request('/api/repositories/test-repo-id/worktrees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'custom', branch: 'existing-branch' }),
        });
        expect(res.status).toBe(400);
      });

      it('should return 400 for invalid mode', async () => {
        const res = await app.request('/api/repositories/test-repo-id/worktrees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'invalid' }),
        });
        expect(res.status).toBe(400);
      });

      it('should return 404 for non-existent repository', async () => {
        const res = await app.request('/api/repositories/non-existent/worktrees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'custom', branch: 'new-branch' }),
        });
        expect(res.status).toBe(404);
      });

      it('should pass initialPrompt and title to createSession when autoStartSession is true', async () => {
        const { worktreeService } = await import('../services/worktree-service.js');
        const { sessionManager } = await import('../services/session-manager.js');

        vi.mocked(worktreeService.createWorktree).mockResolvedValue({
          worktreePath: '/path/to/new/worktree',
          error: undefined,
        });
        vi.mocked(worktreeService.listWorktrees).mockReturnValue([
          {
            path: '/path/to/new/worktree',
            branch: 'feature-branch',
            repositoryId: 'test-repo-id',
            isMain: false,
          },
        ]);

        const res = await app.request('/api/repositories/test-repo-id/worktrees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'custom',
            branch: 'feature-branch',
            autoStartSession: true,
            initialPrompt: 'Add unit tests for session manager',
            title: 'Session Manager Tests',
          }),
        });
        expect(res.status).toBe(201);

        // Verify createSession was called with initialPrompt and title
        expect(vi.mocked(sessionManager.createSession)).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'worktree',
            initialPrompt: 'Add unit tests for session manager',
            title: 'Session Manager Tests',
          })
        );

        // Verify the response includes the session with initialPrompt and title
        const body = (await res.json()) as { worktree: Worktree; session: Session };
        expect(body.session).toBeDefined();
        expect(body.session.initialPrompt).toBe('Add unit tests for session manager');
        expect(body.session.title).toBe('Session Manager Tests');
      });

      it('should use generated title from suggester in prompt mode when title is not provided', async () => {
        const { worktreeService } = await import('../services/worktree-service.js');
        const { sessionManager } = await import('../services/session-manager.js');
        const { suggestSessionMetadata } = await import('../services/session-metadata-suggester.js');

        // Mock suggester to return both branch and title
        vi.mocked(suggestSessionMetadata).mockResolvedValue({
          branch: 'feat/generated-branch',
          title: 'Generated Title from Suggester',
        });

        vi.mocked(worktreeService.createWorktree).mockResolvedValue({
          worktreePath: '/path/to/generated/worktree',
          error: undefined,
        });
        vi.mocked(worktreeService.listWorktrees).mockReturnValue([
          {
            path: '/path/to/generated/worktree',
            branch: 'feat/generated-branch',
            repositoryId: 'test-repo-id',
            isMain: false,
          },
        ]);

        const res = await app.request('/api/repositories/test-repo-id/worktrees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'prompt',
            initialPrompt: 'Add a new feature for user authentication',
            autoStartSession: true,
            // Note: title is NOT provided - should use generated title
          }),
        });
        expect(res.status).toBe(201);

        // Verify createSession was called with the generated title
        expect(vi.mocked(sessionManager.createSession)).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'worktree',
            initialPrompt: 'Add a new feature for user authentication',
            title: 'Generated Title from Suggester',
          })
        );

        // Verify the response includes the session with generated title
        const body = (await res.json()) as { worktree: Worktree; session: Session };
        expect(body.session).toBeDefined();
        expect(body.session.title).toBe('Generated Title from Suggester');
      });

      it('should use fallback branch name when suggester fails', async () => {
        const { worktreeService } = await import('../services/worktree-service.js');
        const { sessionManager } = await import('../services/session-manager.js');
        const { suggestSessionMetadata } = await import('../services/session-metadata-suggester.js');

        // Mock suggester to return error (JSON extraction failed)
        vi.mocked(suggestSessionMetadata).mockResolvedValue({
          error: 'Failed to extract JSON from response',
        });

        vi.mocked(worktreeService.createWorktree).mockResolvedValue({
          worktreePath: '/path/to/fallback/worktree',
          error: undefined,
        });
        vi.mocked(worktreeService.listWorktrees).mockReturnValue([
          {
            path: '/path/to/fallback/worktree',
            branch: 'task-1234567890',
            repositoryId: 'test-repo-id',
            isMain: false,
          },
        ]);

        const res = await app.request('/api/repositories/test-repo-id/worktrees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'prompt',
            initialPrompt: 'Add a new feature',
            autoStartSession: true,
          }),
        });

        // Should succeed with fallback branch name
        expect(res.status).toBe(201);

        // Verify worktree was created with fallback branch name pattern
        expect(vi.mocked(worktreeService.createWorktree)).toHaveBeenCalledWith(
          '/path/to/repo',
          expect.stringMatching(/^task-\d+$/),
          'main'
        );

        // Verify session was created without title (undefined)
        expect(vi.mocked(sessionManager.createSession)).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'worktree',
            initialPrompt: 'Add a new feature',
            title: undefined,
          })
        );
      });
    });

    describe('DELETE /api/repositories/:id/worktrees/*', () => {
      it('should delete a worktree', async () => {
        const res = await app.request('/api/repositories/test-repo-id/worktrees/%2Fpath%2Fto%2Fworktree', {
          method: 'DELETE',
        });
        expect(res.status).toBe(200);

        const body = (await res.json()) as { success: boolean };
        expect(body.success).toBe(true);
      });

      it('should return 400 when worktree removal fails', async () => {
        const { worktreeService } = await import('../services/worktree-service.js');
        vi.mocked(worktreeService.removeWorktree).mockResolvedValue({
          success: false,
          error: 'Worktree has uncommitted changes',
        });

        const res = await app.request('/api/repositories/test-repo-id/worktrees/%2Fpath%2Fto%2Fworktree', {
          method: 'DELETE',
        });
        expect(res.status).toBe(400);
      });

      it('should return 404 for non-existent repository', async () => {
        const res = await app.request('/api/repositories/non-existent/worktrees/%2Fpath', {
          method: 'DELETE',
        });
        expect(res.status).toBe(404);
      });
    });

    describe('GET /api/repositories/:id/branches', () => {
      it('should return branches for repository', async () => {
        const res = await app.request('/api/repositories/test-repo-id/branches');
        expect(res.status).toBe(200);

        const body = (await res.json()) as { local: string[]; remote: string[] };
        expect(body.local).toContain('main');
        expect(body.remote).toContain('origin/main');
      });

      it('should return 404 for non-existent repository', async () => {
        const res = await app.request('/api/repositories/non-existent/branches');
        expect(res.status).toBe(404);
      });
    });
  });

  describe('Agents API', () => {
    describe('GET /api/agents', () => {
      it('should return agents array', async () => {
        const res = await app.request('/api/agents');
        expect(res.status).toBe(200);

        const body = (await res.json()) as { agents: AgentDefinition[] };
        expect(body.agents).toBeInstanceOf(Array);
        expect(body.agents.length).toBeGreaterThan(0);
      });
    });

    describe('GET /api/agents/:id', () => {
      it('should return agent by id', async () => {
        const res = await app.request('/api/agents/claude-code');
        expect(res.status).toBe(200);

        const body = (await res.json()) as { agent: AgentDefinition };
        expect(body.agent.id).toBe('claude-code');
      });

      it('should return 404 for non-existent agent', async () => {
        const res = await app.request('/api/agents/non-existent');
        expect(res.status).toBe(404);
      });
    });

    describe('POST /api/agents', () => {
      it('should register a new agent', async () => {
        const { agentManager } = await import('../services/agent-manager.js');
        vi.mocked(agentManager.registerAgent).mockReturnValue({
          id: 'new-agent-id',
          name: 'My Agent',
          command: 'my-agent',
          isBuiltIn: false,
          registeredAt: '2024-01-01T00:00:00.000Z',
        });

        const res = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'My Agent', command: 'my-agent' }),
        });
        expect(res.status).toBe(201);

        const body = (await res.json()) as { agent: AgentDefinition };
        expect(body.agent.name).toBe('My Agent');
      });

      it('should return 400 when name is missing', async () => {
        const res = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'my-agent' }),
        });
        expect(res.status).toBe(400);
      });

      it('should return 400 when command is missing', async () => {
        const res = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'My Agent' }),
        });
        expect(res.status).toBe(400);
      });
    });

    describe('PATCH /api/agents/:id', () => {
      it('should update an existing agent', async () => {
        const { agentManager } = await import('../services/agent-manager.js');
        vi.mocked(agentManager.updateAgent).mockReturnValue({
          id: 'claude-code',
          name: 'Updated Name',
          command: 'claude',
          isBuiltIn: true,
          registeredAt: '2024-01-01T00:00:00.000Z',
        });

        const res = await app.request('/api/agents/claude-code', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Updated Name' }),
        });
        expect(res.status).toBe(200);

        const body = (await res.json()) as { agent: AgentDefinition };
        expect(body.agent.name).toBe('Updated Name');
      });

      it('should return 404 for non-existent agent', async () => {
        const { agentManager } = await import('../services/agent-manager.js');
        vi.mocked(agentManager.updateAgent).mockReturnValue(null);

        const res = await app.request('/api/agents/non-existent', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'New Name' }),
        });
        expect(res.status).toBe(404);
      });
    });

    describe('DELETE /api/agents/:id', () => {
      it('should delete a custom agent', async () => {
        const { agentManager } = await import('../services/agent-manager.js');
        vi.mocked(agentManager.getAgent).mockReturnValue({
          id: 'custom-agent',
          name: 'Custom Agent',
          command: 'custom',
          isBuiltIn: false,
          registeredAt: '2024-01-01T00:00:00.000Z',
        });
        vi.mocked(agentManager.unregisterAgent).mockReturnValue(true);

        const res = await app.request('/api/agents/custom-agent', {
          method: 'DELETE',
        });
        expect(res.status).toBe(200);

        const body = (await res.json()) as { success: boolean };
        expect(body.success).toBe(true);
      });

      it('should return 400 when trying to delete built-in agent', async () => {
        const { agentManager } = await import('../services/agent-manager.js');
        vi.mocked(agentManager.getAgent).mockReturnValue({
          id: 'claude-code',
          name: 'Claude Code',
          command: 'claude',
          isBuiltIn: true,
          registeredAt: '2024-01-01T00:00:00.000Z',
        });

        const res = await app.request('/api/agents/claude-code', {
          method: 'DELETE',
        });
        expect(res.status).toBe(400);
      });

      it('should return 404 for non-existent agent', async () => {
        const { agentManager } = await import('../services/agent-manager.js');
        vi.mocked(agentManager.getAgent).mockReturnValue(undefined);

        const res = await app.request('/api/agents/non-existent', {
          method: 'DELETE',
        });
        expect(res.status).toBe(404);
      });
    });
  });

  describe('System API', () => {
    describe('POST /api/system/open', () => {
      it('should open a directory path', async () => {
        const open = (await import('open')).default;

        const res = await app.request('/api/system/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '/path/to/directory' }),
        });
        expect(res.status).toBe(200);

        const body = (await res.json()) as { success: boolean };
        expect(body.success).toBe(true);
        expect(open).toHaveBeenCalled();
      });

      it('should open parent directory for a file path', async () => {
        const open = (await import('open')).default;

        const res = await app.request('/api/system/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '/path/to/file.txt' }),
        });
        expect(res.status).toBe(200);

        const body = (await res.json()) as { success: boolean };
        expect(body.success).toBe(true);
        // Should open the parent directory, not the file itself
        expect(open).toHaveBeenCalledWith('/path/to');
      });

      it('should return 400 when path is missing', async () => {
        const res = await app.request('/api/system/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
      });

      it('should return 404 when path does not exist', async () => {
        const res = await app.request('/api/system/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '/non-existent/path' }),
        });
        expect(res.status).toBe(404);
      });
    });
  });
});
