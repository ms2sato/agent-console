import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import * as os from 'os';
import type { Session, Repository, Worktree, AgentDefinition } from '@agent-console/shared';

// Mock data storage
let mockSessions: Map<string, Session>;
let mockRepositories: Map<string, Repository>;
let sessionIdCounter = 0;

// Mock session manager - simple mock without external logic
vi.mock('../services/session-manager.js', () => ({
  sessionManager: {
    getAllSessions: vi.fn(() => Array.from(mockSessions.values())),
    getSession: vi.fn((id: string) => mockSessions.get(id)),
    createSession: vi.fn((worktreePath: string, repositoryId: string) => {
      const session: Session = {
        id: `test-session-${++sessionIdCounter}`,
        worktreePath,
        repositoryId,
        status: 'running',
        pid: 12345,
        startedAt: new Date().toISOString(),
        activityState: 'idle',
        branch: 'main',
      };
      mockSessions.set(session.id, session);
      return session;
    }),
    killSession: vi.fn((id: string) => {
      if (mockSessions.has(id)) {
        mockSessions.delete(id);
        return true;
      }
      return false;
    }),
    getSessionMetadata: vi.fn(() => undefined),
    restartSession: vi.fn(() => null),
    attachCallbacks: vi.fn(),
    detachCallbacks: vi.fn(),
    getOutputBuffer: vi.fn(() => null),
    getActivityState: vi.fn(() => 'idle'),
    setGlobalActivityCallback: vi.fn(),
    getBranchForPath: vi.fn(() => 'main'),
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
          worktreePath: '/path/1',
          repositoryId: 'repo-1',
          status: 'running',
          pid: 1234,
          startedAt: '2024-01-01T00:00:00.000Z',
          activityState: 'idle',
          branch: 'main',
        });

        const res = await app.request('/api/sessions');
        expect(res.status).toBe(200);

        const body = (await res.json()) as { sessions: Session[] };
        expect(body.sessions.length).toBe(1);
        expect(body.sessions[0].id).toBe('session-1');
      });
    });

    describe('POST /api/sessions', () => {
      it('should create a new session', async () => {
        const res = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreePath: '/test/path', repositoryId: 'test-repo' }),
        });
        expect(res.status).toBe(201);

        const body = (await res.json()) as { session: Session };
        expect(body.session).toBeDefined();
        expect(body.session.worktreePath).toBe('/test/path');
        expect(body.session.repositoryId).toBe('test-repo');
      });
    });

    describe('DELETE /api/sessions/:id', () => {
      it('should delete an existing session', async () => {
        // First create a session
        const createRes = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreePath: '/test', repositoryId: 'test' }),
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

    describe('GET /api/sessions/:id/metadata', () => {
      it('should return metadata for active session', async () => {
        mockSessions.set('active-session', {
          id: 'active-session',
          worktreePath: '/path/to/worktree',
          repositoryId: 'repo-1',
          status: 'running',
          pid: 1234,
          startedAt: '2024-01-01T00:00:00.000Z',
          activityState: 'idle',
          branch: 'main',
        });

        const res = await app.request('/api/sessions/active-session/metadata');
        expect(res.status).toBe(200);

        const body = (await res.json()) as { id: string; worktreePath: string; isActive: boolean };
        expect(body.id).toBe('active-session');
        expect(body.worktreePath).toBe('/path/to/worktree');
        expect(body.isActive).toBe(true);
      });

      it('should return metadata for inactive session from persistence', async () => {
        const { sessionManager } = await import('../services/session-manager.js');
        vi.mocked(sessionManager.getSessionMetadata).mockReturnValue({
          id: 'dead-session',
          worktreePath: '/path/to/dead',
          repositoryId: 'repo-1',
          pid: 12345,
          serverPid: 99999,
          createdAt: '2024-01-01T00:00:00.000Z',
        });
        vi.mocked(sessionManager.getBranchForPath).mockReturnValue('feature-branch');

        const res = await app.request('/api/sessions/dead-session/metadata');
        expect(res.status).toBe(200);

        const body = (await res.json()) as { id: string; isActive: boolean; branch: string };
        expect(body.id).toBe('dead-session');
        expect(body.isActive).toBe(false);
        expect(body.branch).toBe('feature-branch');
      });

      it('should return 404 for non-existent session', async () => {
        const { sessionManager } = await import('../services/session-manager.js');
        vi.mocked(sessionManager.getSessionMetadata).mockReturnValue(undefined);

        const res = await app.request('/api/sessions/non-existent/metadata');
        expect(res.status).toBe(404);
      });
    });

    describe('POST /api/sessions/:id/restart', () => {
      it('should restart a dead session', async () => {
        const { sessionManager } = await import('../services/session-manager.js');
        vi.mocked(sessionManager.restartSession).mockReturnValue({
          id: 'restarted-session',
          worktreePath: '/path/to/worktree',
          repositoryId: 'repo-1',
          status: 'running',
          pid: 9999,
          startedAt: '2024-01-01T00:00:00.000Z',
          activityState: 'idle',
          branch: 'main',
        });

        const res = await app.request('/api/sessions/dead-session/restart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ continueConversation: true }),
        });
        expect(res.status).toBe(200);

        const body = (await res.json()) as { session: Session };
        expect(body.session.id).toBe('restarted-session');
      });

      it('should return 404 when session cannot be restarted', async () => {
        const { sessionManager } = await import('../services/session-manager.js');
        vi.mocked(sessionManager.restartSession).mockReturnValue(null);

        const res = await app.request('/api/sessions/non-existent/restart', {
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
      it('should create a worktree', async () => {
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
          body: JSON.stringify({ branch: 'feature-branch' }),
        });
        expect(res.status).toBe(201);

        const body = (await res.json()) as { worktree: Worktree };
        expect(body.worktree).toBeDefined();
        expect(body.worktree.branch).toBe('feature-branch');
      });

      it('should return 400 when branch is missing', async () => {
        const res = await app.request('/api/repositories/test-repo-id/worktrees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
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
          body: JSON.stringify({ branch: 'existing-branch' }),
        });
        expect(res.status).toBe(400);
      });

      it('should return 404 for non-existent repository', async () => {
        const res = await app.request('/api/repositories/non-existent/worktrees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch: 'new-branch' }),
        });
        expect(res.status).toBe(404);
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
});
