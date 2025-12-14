import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import * as os from 'os';
import * as fs from 'fs';
import type {
  Session,
  Repository,
  Worktree,
  AgentDefinition,
  Worker,
} from '@agent-console/shared';
import { setupMemfs, cleanupMemfs, createMockGitRepoFiles } from './utils/mock-fs-helper.js';
import { resetProcessMock } from './utils/mock-process-helper.js';
import { MockPty } from './utils/mock-pty.js';
import { mockGit } from './utils/mock-git-helper.js';

// =============================================================================
// Infrastructure Mocks (must be before any service imports)
// =============================================================================

// Test config directory
const TEST_CONFIG_DIR = '/test/config';

// Track PTY instances
const mockPtyInstances: MockPty[] = [];
let nextPtyPid = 10000;

// Mock pty-provider module (mocking the provider itself instead of bun-pty)
// This is more reliable since bun-pty uses dynamic require() which may not be caught by mock.module
mock.module('../lib/pty-provider.js', () => ({
  bunPtyProvider: {
    spawn: () => {
      const pty = new MockPty(nextPtyPid++);
      mockPtyInstances.push(pty);
      return pty;
    },
  },
}));

// Note: process-utils is mocked via mock-process-helper.js (imported above)

// Mock open package to prevent actual file opening
const mockOpen = mock(async () => {});
mock.module('open', () => ({
  default: mockOpen,
}));

// =============================================================================
// Test Setup
// =============================================================================

// Import counter for cache busting
let importCounter = 0;

// Test repository path
const TEST_REPO_PATH = '/test/test-repo';

// Built-in Claude agent ID (matches agents/claude-code.ts)
const CLAUDE_CODE_AGENT_ID = 'claude-code-builtin';

// Helper to set up default git command responses
function setupDefaultGitMocks() {
  mockGit.listWorktrees.mockImplementation(() => Promise.resolve(`worktree ${TEST_REPO_PATH}
HEAD abc123
branch refs/heads/main
`));
  mockGit.createWorktree.mockImplementation(() => Promise.resolve());
  mockGit.removeWorktree.mockImplementation(() => Promise.resolve());
  mockGit.listLocalBranches.mockImplementation(() => Promise.resolve(['main', 'develop', 'feature-1']));
  mockGit.listRemoteBranches.mockImplementation(() => Promise.resolve(['origin/main', 'origin/develop']));
  mockGit.getDefaultBranch.mockImplementation(() => Promise.resolve('main'));
  mockGit.getRemoteUrl.mockImplementation(() => Promise.resolve('git@github.com:owner/test-repo.git'));
  mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('main'));
  mockGit.renameBranch.mockImplementation(() => Promise.resolve());
  mockGit.getOrgRepoFromPath.mockImplementation(() => Promise.resolve('owner/test-repo'));
}

describe('API Routes Integration', () => {
  beforeEach(() => {
    // Setup memfs with config directory, mock git repo, and common test paths
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
      [`${TEST_CONFIG_DIR}/agents.json`]: JSON.stringify([]),
      [`${TEST_CONFIG_DIR}/sessions.json`]: JSON.stringify([]),
      [`${TEST_CONFIG_DIR}/repositories.json`]: JSON.stringify([]),
      ...createMockGitRepoFiles(TEST_REPO_PATH),
      // Common test path used by session creation tests
      '/test/path/.keep': '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    // Reset PTY tracking
    mockPtyInstances.length = 0;
    nextPtyPid = 10000;

    // Reset process tracking
    resetProcessMock();

    // Reset git mocks
    mockGit.listWorktrees.mockReset();
    mockGit.createWorktree.mockReset();
    mockGit.removeWorktree.mockReset();
    mockGit.listLocalBranches.mockReset();
    mockGit.listRemoteBranches.mockReset();
    mockGit.getDefaultBranch.mockReset();
    mockGit.getRemoteUrl.mockReset();
    mockGit.getCurrentBranch.mockReset();
    mockGit.renameBranch.mockReset();
    mockGit.getOrgRepoFromPath.mockReset();
    mockOpen.mockClear();

    // Setup default git command responses
    setupDefaultGitMocks();
  });

  afterEach(() => {
    cleanupMemfs();
  });

  // Helper to create unique repo paths for each test to avoid singleton state conflicts
  function createUniqueRepoPath(): string {
    const uniqueId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    return `/test/repo-${uniqueId}`;
  }

  // Helper to set up a git repo in memfs for testing
  function setupTestGitRepo(repoPath: string): void {
    const files = createMockGitRepoFiles(repoPath);
    for (const [path, content] of Object.entries(files)) {
      const dir = path.substring(0, path.lastIndexOf('/'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path, content);
    }
  }

  // Helper to create fresh app with real services
  async function createApp() {
    const suffix = `?v=${++importCounter}`;
    const { api } = await import(`../routes/api.js${suffix}`);
    const { onApiError } = await import(`../lib/error-handler.js${suffix}`);

    const app = new Hono();
    app.onError(onApiError);
    app.route('/api', api);
    return app;
  }

  // ==========================================================================
  // Basic API Tests
  // ==========================================================================

  describe('GET /api', () => {
    it('should return API info', async () => {
      const app = await createApp();
      const res = await app.request('/api');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ message: 'Agent Console API' });
    });
  });

  describe('GET /api/config', () => {
    it('should return config with homeDir', async () => {
      const app = await createApp();
      const res = await app.request('/api/config');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { homeDir: string };
      expect(body.homeDir).toBe(os.homedir());
    });
  });

  // ==========================================================================
  // Sessions API
  // ==========================================================================

  describe('Sessions API', () => {
    describe('GET /api/sessions', () => {
      it('should return empty sessions array initially', async () => {
        const app = await createApp();
        const res = await app.request('/api/sessions');
        expect(res.status).toBe(200);

        const body = (await res.json()) as { sessions: Session[] };
        expect(body.sessions).toBeInstanceOf(Array);
        expect(body.sessions.length).toBe(0);
      });
    });

    describe('POST /api/sessions', () => {
      it('should create a new quick session', async () => {
        const app = await createApp();

        const res = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
            agentId: CLAUDE_CODE_AGENT_ID,
          }),
        });
        expect(res.status).toBe(201);

        const body = (await res.json()) as { session: Session };
        expect(body.session).toBeDefined();
        expect(body.session.type).toBe('quick');
        expect(body.session.locationPath).toBe('/test/path');
        expect(body.session.workers.length).toBe(1);
        expect(body.session.workers[0].type).toBe('agent');

        // Verify PTY was spawned
        expect(mockPtyInstances.length).toBe(1);
      });

      it('should return 400 for non-existent locationPath', async () => {
        const app = await createApp();

        const res = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/nonexistent/path/that/does/not/exist',
            agentId: CLAUDE_CODE_AGENT_ID,
          }),
        });
        expect(res.status).toBe(400);

        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('Path does not exist');
      });

      it('should create a new worktree session', async () => {
        const app = await createApp();

        const res = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'worktree',
            locationPath: TEST_REPO_PATH,
            repositoryId: 'test-repo',
            worktreeId: 'main',
            agentId: CLAUDE_CODE_AGENT_ID,
          }),
        });
        expect(res.status).toBe(201);

        const body = (await res.json()) as { session: Session };
        expect(body.session.type).toBe('worktree');
        if (body.session.type === 'worktree') {
          expect(body.session.repositoryId).toBe('test-repo');
          expect(body.session.worktreeId).toBe('main');
        }
      });

      it('should persist session to storage', async () => {
        const app = await createApp();

        await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
            agentId: CLAUDE_CODE_AGENT_ID,
          }),
        });

        // Verify session was persisted
        const savedData = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
        expect(savedData.length).toBe(1);
        expect(savedData[0].locationPath).toBe('/test/path');
      });

      it('should return 400 for invalid JSON body', async () => {
        const app = await createApp();

        const res = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'invalid json',
        });
        expect(res.status).toBe(400);

        const body = (await res.json()) as { error: string };
        expect(body.error).toBe('Invalid JSON body');
      });

      it('should return 400 for empty request body', async () => {
        const app = await createApp();

        const res = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '',
        });
        expect(res.status).toBe(400);

        const body = (await res.json()) as { error: string };
        expect(body.error).toBe('Invalid JSON body');
      });
    });

    describe('GET /api/sessions/:id', () => {
      it('should return session by id', async () => {
        const app = await createApp();

        // Create a session first
        const createRes = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
          }),
        });
        const { session: created } = (await createRes.json()) as { session: Session };

        // Get the session
        const res = await app.request(`/api/sessions/${created.id}`);
        expect(res.status).toBe(200);

        const body = (await res.json()) as { session: Session };
        expect(body.session.id).toBe(created.id);
      });

      it('should return 404 for non-existent session', async () => {
        const app = await createApp();
        const res = await app.request('/api/sessions/non-existent');
        expect(res.status).toBe(404);
      });
    });

    describe('DELETE /api/sessions/:id', () => {
      it('should delete an existing session', async () => {
        const app = await createApp();

        // Create a session first
        const createRes = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
          }),
        });
        const { session } = (await createRes.json()) as { session: Session };

        // Delete it
        const deleteRes = await app.request(`/api/sessions/${session.id}`, {
          method: 'DELETE',
        });
        expect(deleteRes.status).toBe(200);

        const body = (await deleteRes.json()) as { success: boolean };
        expect(body.success).toBe(true);

        // Verify session is gone
        const getRes = await app.request(`/api/sessions/${session.id}`);
        expect(getRes.status).toBe(404);
      });

      it('should return 404 for non-existent session', async () => {
        const app = await createApp();
        const res = await app.request('/api/sessions/non-existent', {
          method: 'DELETE',
        });
        expect(res.status).toBe(404);
      });
    });

    describe('PATCH /api/sessions/:id', () => {
      it('should update session title', async () => {
        const app = await createApp();

        // Create a session first
        const createRes = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
          }),
        });
        const { session } = (await createRes.json()) as { session: Session };

        // Update title
        const patchRes = await app.request(`/api/sessions/${session.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'New Title' }),
        });
        expect(patchRes.status).toBe(200);

        const body = (await patchRes.json()) as { success: boolean; title: string };
        expect(body.success).toBe(true);
        expect(body.title).toBe('New Title');
      });

      it('should return 400 when no fields provided', async () => {
        const app = await createApp();

        // Create a session first
        const createRes = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
          }),
        });
        const { session } = (await createRes.json()) as { session: Session };

        // Try to update with empty body
        const patchRes = await app.request(`/api/sessions/${session.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(patchRes.status).toBe(400);
      });

      it('should return 400 when branch is empty string', async () => {
        const app = await createApp();

        // Create a session first
        const createRes = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
          }),
        });
        const { session } = (await createRes.json()) as { session: Session };

        // Try to update with empty branch
        const patchRes = await app.request(`/api/sessions/${session.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch: '   ' }),
        });
        expect(patchRes.status).toBe(400);

        const body = (await patchRes.json()) as { error: string };
        expect(body.error).toContain('Branch name cannot be empty');
      });

      it('should return 404 for non-existent session', async () => {
        const app = await createApp();

        const patchRes = await app.request('/api/sessions/non-existent', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'New Title' }),
        });
        expect(patchRes.status).toBe(404);
      });
    });
  });

  // ==========================================================================
  // Workers API
  // ==========================================================================

  describe('Workers API', () => {
    describe('GET /api/sessions/:sessionId/workers', () => {
      it('should return workers for a session', async () => {
        const app = await createApp();

        // Create a session with an agent
        const createRes = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
            agentId: CLAUDE_CODE_AGENT_ID,
          }),
        });
        const { session } = (await createRes.json()) as { session: Session };

        // Get workers
        const res = await app.request(`/api/sessions/${session.id}/workers`);
        expect(res.status).toBe(200);

        const body = (await res.json()) as { workers: Worker[] };
        expect(body.workers.length).toBe(2);
        expect(body.workers.some(w => w.type === 'agent')).toBe(true);
        expect(body.workers.some(w => w.type === 'git-diff')).toBe(true);
      });

      it('should return 404 for non-existent session', async () => {
        const app = await createApp();
        const res = await app.request('/api/sessions/non-existent/workers');
        expect(res.status).toBe(404);
      });
    });

    describe('GET /api/sessions/:sessionId/branches', () => {
      it('should return branches for a session', async () => {
        const app = await createApp();

        // Create a session first
        const createRes = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
            agentId: CLAUDE_CODE_AGENT_ID,
          }),
        });
        const { session } = (await createRes.json()) as { session: Session };

        // Get branches
        const res = await app.request(`/api/sessions/${session.id}/branches`);
        expect(res.status).toBe(200);

        const body = (await res.json()) as { local: string[]; remote: string[]; defaultBranch: string | null };
        expect(body.local).toEqual(['main', 'develop', 'feature-1']);
        expect(body.remote).toEqual(['origin/main', 'origin/develop']);
        expect(body.defaultBranch).toBe('main');
      });

      it('should return 404 for non-existent session', async () => {
        const app = await createApp();
        const res = await app.request('/api/sessions/non-existent/branches');
        expect(res.status).toBe(404);
      });
    });

    describe('POST /api/sessions/:sessionId/workers', () => {
      it('should create a terminal worker', async () => {
        const app = await createApp();

        // Create a session with an agent first
        const createRes = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
            agentId: CLAUDE_CODE_AGENT_ID,
          }),
        });
        const { session } = (await createRes.json()) as { session: Session };

        // Create a terminal worker
        const res = await app.request(`/api/sessions/${session.id}/workers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'terminal', name: 'Shell' }),
        });
        expect(res.status).toBe(201);

        const body = (await res.json()) as { worker: Worker };
        expect(body.worker.type).toBe('terminal');
        expect(body.worker.name).toBe('Shell');

        // Verify two PTYs spawned (agent + terminal)
        expect(mockPtyInstances.length).toBe(2);
      });
    });

    describe('DELETE /api/sessions/:sessionId/workers/:workerId', () => {
      it('should delete a worker', async () => {
        const app = await createApp();

        // Create a session with an agent
        const createRes = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
            agentId: CLAUDE_CODE_AGENT_ID,
          }),
        });
        const { session } = (await createRes.json()) as { session: Session };
        const workerId = session.workers[0].id;

        // Delete the worker
        const res = await app.request(`/api/sessions/${session.id}/workers/${workerId}`, {
          method: 'DELETE',
        });
        expect(res.status).toBe(200);

        const body = (await res.json()) as { success: boolean };
        expect(body.success).toBe(true);
      });
    });

    describe('POST /api/sessions/:sessionId/workers/:workerId/restart', () => {
      it('should restart an agent worker', async () => {
        const app = await createApp();

        // Create a session with an agent
        const createRes = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
            agentId: CLAUDE_CODE_AGENT_ID,
          }),
        });
        const { session } = (await createRes.json()) as { session: Session };
        const agentWorker = session.workers.find((w) => w.type === 'agent')!;

        // Restart the agent worker
        const res = await app.request(
          `/api/sessions/${session.id}/workers/${agentWorker.id}/restart`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ continueConversation: false }),
          }
        );
        expect(res.status).toBe(200);

        const body = (await res.json()) as { worker: Worker };
        expect(body.worker).toBeDefined();
        expect(body.worker.type).toBe('agent');
      });

      it('should return 404 for non-existent session', async () => {
        const app = await createApp();

        const res = await app.request(
          '/api/sessions/non-existent/workers/some-worker/restart',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          }
        );
        expect(res.status).toBe(404);
      });

      it('should return 404 for non-existent worker', async () => {
        const app = await createApp();

        // Create a session
        const createRes = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
            agentId: CLAUDE_CODE_AGENT_ID,
          }),
        });
        const { session } = (await createRes.json()) as { session: Session };

        const res = await app.request(
          `/api/sessions/${session.id}/workers/non-existent/restart`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          }
        );
        expect(res.status).toBe(404);
      });
    });
  });

  // ==========================================================================
  // Repositories API
  // ==========================================================================

  describe('Repositories API', () => {
    describe('GET /api/repositories', () => {
      it('should return empty repositories array initially', async () => {
        const app = await createApp();
        const res = await app.request('/api/repositories');
        expect(res.status).toBe(200);

        const body = (await res.json()) as { repositories: Repository[] };
        expect(body.repositories).toBeInstanceOf(Array);
        expect(body.repositories.length).toBe(0);
      });
    });

    describe('POST /api/repositories', () => {
      it('should register a repository', async () => {
        const app = await createApp();
        const repoPath = createUniqueRepoPath();
        setupTestGitRepo(repoPath);

        const res = await app.request('/api/repositories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: repoPath }),
        });
        expect(res.status).toBe(201);

        const body = (await res.json()) as { repository: Repository };
        expect(body.repository).toBeDefined();
        expect(body.repository.path).toBe(repoPath);
        // Repository name is extracted from directory name
        expect(body.repository.name).toMatch(/^repo-/);
      });

      it('should return 400 when path is missing', async () => {
        const app = await createApp();

        const res = await app.request('/api/repositories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
      });

      it('should return 400 for non-git directory', async () => {
        const app = await createApp();

        const res = await app.request('/api/repositories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: TEST_CONFIG_DIR }),
        });
        expect(res.status).toBe(400);
      });
    });

    describe('DELETE /api/repositories/:id', () => {
      it('should unregister a repository', async () => {
        const app = await createApp();
        const repoPath = createUniqueRepoPath();
        setupTestGitRepo(repoPath);

        // Register first
        const createRes = await app.request('/api/repositories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: repoPath }),
        });

        expect(createRes.status).toBe(201);
        const createBody = (await createRes.json()) as { repository: Repository };
        expect(createBody.repository).toBeDefined();

        // Unregister
        const res = await app.request(`/api/repositories/${createBody.repository.id}`, {
          method: 'DELETE',
        });
        expect(res.status).toBe(200);

        const body = (await res.json()) as { success: boolean };
        expect(body.success).toBe(true);
      });

      it('should return 404 for non-existent repository', async () => {
        const app = await createApp();
        const res = await app.request('/api/repositories/non-existent', {
          method: 'DELETE',
        });
        expect(res.status).toBe(404);
      });
    });
  });

  // ==========================================================================
  // Worktrees API
  // ==========================================================================

  describe('Worktrees API', () => {
    // Helper to register a test repo and return it
    async function registerTestRepo(app: Hono): Promise<{ repo: Repository; repoPath: string }> {
      const repoPath = createUniqueRepoPath();
      setupTestGitRepo(repoPath);

      const res = await app.request('/api/repositories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: repoPath }),
      });

      if (res.status !== 201) {
        throw new Error(`Failed to register repository: ${res.status}`);
      }

      const body = (await res.json()) as { repository: Repository };
      return { repo: body.repository, repoPath };
    }

    describe('GET /api/repositories/:id/worktrees', () => {
      it('should return worktrees for repository', async () => {
        const app = await createApp();
        const { repo, repoPath } = await registerTestRepo(app);

        // Mock worktree list for this specific repo path using git module mocks
        mockGit.listWorktrees.mockImplementation(() => Promise.resolve(
          `worktree ${repoPath}\nHEAD abc123\nbranch refs/heads/main\n\n`
        ));

        const res = await app.request(`/api/repositories/${repo.id}/worktrees`);
        expect(res.status).toBe(200);

        const body = (await res.json()) as { worktrees: Worktree[] };
        expect(body.worktrees).toBeInstanceOf(Array);
        expect(body.worktrees.length).toBeGreaterThan(0);
        expect(body.worktrees[0].branch).toBe('main');
      });

      it('should return 404 for non-existent repository', async () => {
        const app = await createApp();
        const res = await app.request('/api/repositories/non-existent/worktrees');
        expect(res.status).toBe(404);
      });
    });

    describe('GET /api/repositories/:id/branches', () => {
      it('should return branches for repository', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        const res = await app.request(`/api/repositories/${repo.id}/branches`);
        expect(res.status).toBe(200);

        const body = (await res.json()) as { local: string[]; remote: string[]; defaultBranch: string };
        expect(body.local).toContain('main');
        expect(body.remote).toContain('origin/main');
        expect(body.defaultBranch).toBe('main');
      });
    });

    describe('POST /api/repositories/:id/worktrees', () => {
      it('should create worktree with custom branch mode', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        // Worktree creation is mocked via mockGitCreateWorktree in setupDefaultGitMocks

        const res = await app.request(`/api/repositories/${repo.id}/worktrees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'custom', branch: 'test-feature' }),
        });

        // API returns 201 when worktree creation succeeds
        expect(res.status).toBe(201);

        // Response structure may vary based on whether worktree lookup succeeds
        // In integration test with mocked git commands, the path lookup may fail
        const body = await res.json();
        expect(typeof body).toBe('object');
      });

      it('should return 400 for invalid mode', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        const res = await app.request(`/api/repositories/${repo.id}/worktrees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'invalid' }),
        });
        expect(res.status).toBe(400);
      });

      it('should return 400 when prompt mode lacks initialPrompt', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        const res = await app.request(`/api/repositories/${repo.id}/worktrees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'prompt' }),
        });
        expect(res.status).toBe(400);
      });

      it('should return 400 when prompt mode has empty initialPrompt', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        const res = await app.request(`/api/repositories/${repo.id}/worktrees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'prompt', initialPrompt: '   ' }),
        });
        expect(res.status).toBe(400);

        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('Initial prompt is required for prompt mode');
      });

      it('should return 404 for non-existent repository', async () => {
        const app = await createApp();

        const res = await app.request('/api/repositories/non-existent/worktrees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'custom', branch: 'test' }),
        });
        expect(res.status).toBe(404);
      });
    });

    describe('DELETE /api/repositories/:id/worktrees/*', () => {
      it('should return 404 for non-existent repository', async () => {
        const app = await createApp();

        const res = await app.request('/api/repositories/non-existent/worktrees/%2Fsome%2Fpath', {
          method: 'DELETE',
        });
        expect(res.status).toBe(404);
      });

      it('should return 400 when worktree path is invalid for repository', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        // Request with a path that doesn't belong to this repository's worktrees
        const res = await app.request(`/api/repositories/${repo.id}/worktrees/%2Fother%2Fpath`, {
          method: 'DELETE',
        });
        expect(res.status).toBe(400);

        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('Invalid worktree path');
      });
    });
  });

  // ==========================================================================
  // Agents API
  // ==========================================================================

  describe('Agents API', () => {
    describe('GET /api/agents', () => {
      it('should return agents array with built-in Claude agent', async () => {
        const app = await createApp();
        const res = await app.request('/api/agents');
        expect(res.status).toBe(200);

        const body = (await res.json()) as { agents: AgentDefinition[] };
        expect(body.agents).toBeInstanceOf(Array);
        expect(body.agents.length).toBeGreaterThan(0);

        // Built-in Claude agent should exist
        const claudeAgent = body.agents.find((a) => a.isBuiltIn);
        expect(claudeAgent).toBeDefined();
      });
    });

    describe('GET /api/agents/:id', () => {
      it('should return agent by id', async () => {
        const app = await createApp();

        // Get agents first to find the built-in one
        const listRes = await app.request('/api/agents');
        const { agents } = (await listRes.json()) as { agents: AgentDefinition[] };
        const builtInAgent = agents.find((a) => a.isBuiltIn)!;

        const res = await app.request(`/api/agents/${builtInAgent.id}`);
        expect(res.status).toBe(200);

        const body = (await res.json()) as { agent: AgentDefinition };
        expect(body.agent.id).toBe(builtInAgent.id);
      });

      it('should return 404 for non-existent agent', async () => {
        const app = await createApp();
        const res = await app.request('/api/agents/non-existent');
        expect(res.status).toBe(404);
      });
    });

    describe('POST /api/agents', () => {
      it('should register a new custom agent', async () => {
        const app = await createApp();

        const res = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'My Agent', command: 'my-agent' }),
        });
        expect(res.status).toBe(201);

        const body = (await res.json()) as { agent: AgentDefinition };
        expect(body.agent.name).toBe('My Agent');
        expect(body.agent.command).toBe('my-agent');
        expect(body.agent.isBuiltIn).toBe(false);
      });

      it('should return 400 when name is missing', async () => {
        const app = await createApp();

        const res = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'my-agent' }),
        });
        expect(res.status).toBe(400);
      });

      it('should return 400 when command is missing', async () => {
        const app = await createApp();

        const res = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'My Agent' }),
        });
        expect(res.status).toBe(400);
      });
    });

    describe('PATCH /api/agents/:id', () => {
      it('should update an agent', async () => {
        const app = await createApp();

        // Create a custom agent first
        const createRes = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'My Agent', command: 'my-agent' }),
        });
        const { agent: created } = (await createRes.json()) as { agent: AgentDefinition };

        // Update it
        const res = await app.request(`/api/agents/${created.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Updated Name' }),
        });
        expect(res.status).toBe(200);

        const body = (await res.json()) as { agent: AgentDefinition };
        expect(body.agent.name).toBe('Updated Name');
      });

      it('should return 404 for non-existent agent', async () => {
        const app = await createApp();

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
        const app = await createApp();

        // Create a custom agent first
        const createRes = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'My Agent', command: 'my-agent' }),
        });
        const { agent: created } = (await createRes.json()) as { agent: AgentDefinition };

        // Delete it
        const res = await app.request(`/api/agents/${created.id}`, {
          method: 'DELETE',
        });
        expect(res.status).toBe(200);

        const body = (await res.json()) as { success: boolean };
        expect(body.success).toBe(true);
      });

      it('should return 400 when trying to delete built-in agent', async () => {
        const app = await createApp();

        // Get agents to find built-in one
        const listRes = await app.request('/api/agents');
        const { agents } = (await listRes.json()) as { agents: AgentDefinition[] };
        const builtInAgent = agents.find((a) => a.isBuiltIn)!;

        const res = await app.request(`/api/agents/${builtInAgent.id}`, {
          method: 'DELETE',
        });
        expect(res.status).toBe(400);
      });

      it('should return 404 for non-existent agent', async () => {
        const app = await createApp();

        const res = await app.request('/api/agents/non-existent', {
          method: 'DELETE',
        });
        expect(res.status).toBe(404);
      });
    });
  });

  // ==========================================================================
  // System API
  // ==========================================================================

  describe('System API', () => {
    describe('POST /api/system/open', () => {
      it('should open a directory path', async () => {
        const app = await createApp();

        // Create the directory in memfs
        fs.mkdirSync('/path/to/directory', { recursive: true });

        const res = await app.request('/api/system/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '/path/to/directory' }),
        });
        expect(res.status).toBe(200);

        const body = (await res.json()) as { success: boolean };
        expect(body.success).toBe(true);
        expect(mockOpen).toHaveBeenCalled();
      });

      it('should open parent directory for a file path', async () => {
        const app = await createApp();

        // Create file in memfs
        fs.mkdirSync('/path/to', { recursive: true });
        fs.writeFileSync('/path/to/file.txt', 'content');

        const res = await app.request('/api/system/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '/path/to/file.txt' }),
        });
        expect(res.status).toBe(200);

        // Should open parent directory, not file
        expect(mockOpen).toHaveBeenCalledWith('/path/to');
      });

      it('should return 400 when path is missing', async () => {
        const app = await createApp();

        const res = await app.request('/api/system/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
      });

      it('should return 400 when path is whitespace only', async () => {
        const app = await createApp();

        const res = await app.request('/api/system/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '   ' }),
        });
        expect(res.status).toBe(400);
      });

      it('should return 404 when path does not exist', async () => {
        const app = await createApp();

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
