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
import { mockProcess, resetProcessMock } from './utils/mock-process-helper.js';
import { MockPty } from './utils/mock-pty.js';
import { mockGit, GitError } from './utils/mock-git-helper.js';

// Set up test config directory BEFORE any service imports to ensure
// services use the test config path when their modules are loaded
const TEST_CONFIG_DIR = '/test/config';
process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

// =============================================================================
// Infrastructure Mocks (must be before any service imports)
// =============================================================================

// Track PTY instances
const mockPtyInstances: MockPty[] = [];
let nextPtyPid = 10000;

// Mock pty-provider module to avoid spawning real PTY processes in tests
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

// Mock session-metadata-suggester to avoid running actual agent commands
const mockSuggestSessionMetadata = mock(async () => ({
  branch: 'suggested-branch',
  title: 'Suggested Title',
}));
mock.module('../services/session-metadata-suggester.js', () => ({
  suggestSessionMetadata: mockSuggestSessionMetadata,
}));

// Note: We use the real database connection module with in-memory SQLite.
// This avoids mock.module which applies globally and affects other test files.

// Import singleton reset functions to ensure fresh state between tests
import { resetRepositoryManager, initializeRepositoryManager } from '../services/repository-manager.js';
import { resetSessionManager, initializeSessionManager } from '../services/session-manager.js';
import { createSessionRepository } from '../repositories/index.js';
import { resetAgentManager } from '../services/agent-manager.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../database/connection.js';
import { JobQueue, resetJobQueue } from '../jobs/index.js';
import {
  SystemCapabilitiesService,
  setSystemCapabilities,
  resetSystemCapabilities,
} from '../services/system-capabilities-service.js';

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
  mockGit.refreshDefaultBranch.mockImplementation(() => Promise.resolve('main'));
  mockGit.getRemoteUrl.mockImplementation(() => Promise.resolve('git@github.com:owner/test-repo.git'));
  mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('main'));
  mockGit.renameBranch.mockImplementation(() => Promise.resolve());
  mockGit.getOrgRepoFromPath.mockImplementation(() => Promise.resolve('owner/test-repo'));
  mockGit.fetchRemote.mockImplementation(() => Promise.resolve());
  mockGit.fetchAllRemote.mockImplementation(() => Promise.resolve());
  mockGit.getCommitsBehind.mockImplementation(() => Promise.resolve(0));
  mockGit.getCommitsAhead.mockImplementation(() => Promise.resolve(0));
}

// Test JobQueue instance (created fresh for each test)
let testJobQueue: JobQueue | null = null;

describe('API Routes Integration', () => {
  beforeEach(async () => {
    // Close any existing database connection and initialize fresh in-memory database
    await closeDatabase();
    await resetJobQueue();
    await initializeDatabase(':memory:');

    // Reset service singletons to ensure fresh state for each test
    resetSessionManager();
    resetRepositoryManager();
    resetAgentManager();
    resetSystemCapabilities();

    // Set up mock system capabilities
    const mockCapabilities = new SystemCapabilitiesService();
    // Manually set capabilities to avoid running which command
    (mockCapabilities as unknown as { capabilities: { vscode: boolean } }).capabilities = { vscode: true };
    (mockCapabilities as unknown as { vscodeCommand: string | null }).vscodeCommand = 'code';
    setSystemCapabilities(mockCapabilities);

    // Create a test JobQueue with the shared database connection
    testJobQueue = new JobQueue(getDatabase());

    // Setup memfs with config directory, mock git repo, and common test paths
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
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
    mockGit.refreshDefaultBranch.mockReset();
    mockGit.getRemoteUrl.mockReset();
    mockGit.getCurrentBranch.mockReset();
    mockGit.renameBranch.mockReset();
    mockGit.getOrgRepoFromPath.mockReset();
    mockGit.fetchRemote.mockReset();
    mockGit.fetchAllRemote.mockReset();
    mockGit.getCommitsBehind.mockReset();
    mockGit.getCommitsAhead.mockReset();
    mockOpen.mockClear();

    // Reset session metadata suggester mock
    mockSuggestSessionMetadata.mockReset();
    mockSuggestSessionMetadata.mockImplementation(async () => ({
      branch: 'suggested-branch',
      title: 'Suggested Title',
    }));

    // Setup default git command responses
    setupDefaultGitMocks();
  });

  afterEach(async () => {
    // Clean up test JobQueue
    if (testJobQueue) {
      await testJobQueue.stop();
      testJobQueue = null;
    }
    await closeDatabase();
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

    // Initialize managers with test JobQueue
    // This ensures cleanup operations have a valid jobQueue
    if (testJobQueue) {
      const sessionRepository = await createSessionRepository();
      await initializeSessionManager({ sessionRepository, jobQueue: testJobQueue });
      await initializeRepositoryManager({ jobQueue: testJobQueue });
    }

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
        // createSession creates both agent and git-diff workers
        expect(body.session.workers.length).toBe(2);
        expect(body.session.workers.some((w: Worker) => w.type === 'agent')).toBe(true);
        expect(body.session.workers.some((w: Worker) => w.type === 'git-diff')).toBe(true);

        // Verify PTY was spawned (only agent worker has PTY)
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

        // Verify session was persisted by fetching it again
        const getRes = await app.request(`/api/sessions/${session.id}`);
        expect(getRes.status).toBe(200);
        const body = (await getRes.json()) as { session: Session };
        expect(body.session.locationPath).toBe('/test/path');
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

      it('should include remoteUrl when repository has a git remote', async () => {
        const app = await createApp();
        const repoPath = createUniqueRepoPath();
        setupTestGitRepo(repoPath);

        const createRes = await app.request('/api/repositories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: repoPath }),
        });

        expect(createRes.status).toBe(201);

        const res = await app.request('/api/repositories');
        const body = (await res.json()) as { repositories: Repository[] };
        const repo = body.repositories.find((item) => item.path === repoPath);
        expect(repo?.remoteUrl).toBe('git@github.com:owner/test-repo.git');
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

    describe('GET /api/repositories/:id/github', () => {
      it('should redirect to GitHub repository URL', async () => {
        const app = await createApp();
        const repoPath = createUniqueRepoPath();
        setupTestGitRepo(repoPath);

        const createRes = await app.request('/api/repositories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: repoPath }),
        });

        expect(createRes.status).toBe(201);
        const createBody = (await createRes.json()) as { repository: Repository };

        const res = await app.request(`/api/repositories/${createBody.repository.id}/github`);
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('https://github.com/owner/test-repo');
      });

      it('should return 400 when repository has no git remote', async () => {
        const app = await createApp();
        const repoPath = createUniqueRepoPath();
        setupTestGitRepo(repoPath);

        const createRes = await app.request('/api/repositories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: repoPath }),
        });

        expect(createRes.status).toBe(201);
        const createBody = (await createRes.json()) as { repository: Repository };

        mockGit.getRemoteUrl.mockImplementationOnce(() => Promise.resolve(null));

        const res = await app.request(`/api/repositories/${createBody.repository.id}/github`);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe('Repository does not have a git remote');
      });

      it('should return 400 when repository remote is not GitHub', async () => {
        const app = await createApp();
        const repoPath = createUniqueRepoPath();
        setupTestGitRepo(repoPath);

        const createRes = await app.request('/api/repositories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: repoPath }),
        });

        expect(createRes.status).toBe(201);
        const createBody = (await createRes.json()) as { repository: Repository };

        mockGit.getRemoteUrl.mockImplementationOnce(() =>
          Promise.resolve('git@bitbucket.org:owner/test-repo.git')
        );

        const res = await app.request(`/api/repositories/${createBody.repository.id}/github`);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe('Repository remote is not GitHub');
      });

      it('should return 400 when GitHub remote cannot be parsed', async () => {
        const app = await createApp();
        const repoPath = createUniqueRepoPath();
        setupTestGitRepo(repoPath);

        const createRes = await app.request('/api/repositories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: repoPath }),
        });

        expect(createRes.status).toBe(201);
        const createBody = (await createRes.json()) as { repository: Repository };

        mockGit.getRemoteUrl.mockImplementationOnce(() =>
          Promise.resolve('https://github.com/owner')
        );

        const res = await app.request(`/api/repositories/${createBody.repository.id}/github`);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe('Failed to parse GitHub repository from remote');
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

    describe('PATCH /api/repositories/:id', () => {
      it('should update repository setupCommand successfully', async () => {
        const app = await createApp();
        const repoPath = createUniqueRepoPath();
        setupTestGitRepo(repoPath);

        // Register repository first
        const createRes = await app.request('/api/repositories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: repoPath }),
        });
        expect(createRes.status).toBe(201);
        const { repository: created } = (await createRes.json()) as { repository: Repository };

        // Verify initially no setupCommand
        expect(created.setupCommand).toBeUndefined();

        // Update setupCommand
        const patchRes = await app.request(`/api/repositories/${created.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setupCommand: 'npm install && npm run build' }),
        });
        expect(patchRes.status).toBe(200);

        const { repository: updated } = (await patchRes.json()) as { repository: Repository };
        expect(updated.setupCommand).toBe('npm install && npm run build');
        expect(updated.id).toBe(created.id);
        expect(updated.path).toBe(created.path);
      });

      it('should clear setupCommand with empty string', async () => {
        const app = await createApp();
        const repoPath = createUniqueRepoPath();
        setupTestGitRepo(repoPath);

        // Register repository
        const createRes = await app.request('/api/repositories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: repoPath }),
        });
        expect(createRes.status).toBe(201);
        const { repository: created } = (await createRes.json()) as { repository: Repository };

        // Set setupCommand first
        const setRes = await app.request(`/api/repositories/${created.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setupCommand: 'npm install' }),
        });
        expect(setRes.status).toBe(200);
        const { repository: withSetup } = (await setRes.json()) as { repository: Repository };
        expect(withSetup.setupCommand).toBe('npm install');

        // Clear setupCommand with empty string
        const clearRes = await app.request(`/api/repositories/${created.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setupCommand: '' }),
        });
        expect(clearRes.status).toBe(200);

        const { repository: cleared } = (await clearRes.json()) as { repository: Repository };
        expect(cleared.setupCommand).toBeNull();
      });

      it('should return 404 for non-existent repository', async () => {
        const app = await createApp();

        const res = await app.request('/api/repositories/non-existent-id', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setupCommand: 'npm install' }),
        });
        expect(res.status).toBe(404);
      });

      it('should accept setupCommand with template variables', async () => {
        const app = await createApp();
        const repoPath = createUniqueRepoPath();
        setupTestGitRepo(repoPath);

        // Register repository
        const createRes = await app.request('/api/repositories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: repoPath }),
        });
        expect(createRes.status).toBe(201);
        const { repository: created } = (await createRes.json()) as { repository: Repository };

        // Set setupCommand with template variables
        const commandWithTemplates = 'export PORT={{WORKTREE_NUM + 3000}} && npm start';
        const patchRes = await app.request(`/api/repositories/${created.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setupCommand: commandWithTemplates }),
        });
        expect(patchRes.status).toBe(200);

        const { repository: updated } = (await patchRes.json()) as { repository: Repository };
        expect(updated.setupCommand).toBe(commandWithTemplates);
      });

      it('should return 400 for invalid request body', async () => {
        const app = await createApp();
        const repoPath = createUniqueRepoPath();
        setupTestGitRepo(repoPath);

        // Register repository
        const createRes = await app.request('/api/repositories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: repoPath }),
        });
        expect(createRes.status).toBe(201);
        const { repository: created } = (await createRes.json()) as { repository: Repository };

        // Try to update with invalid body (wrong type for setupCommand)
        const patchRes = await app.request(`/api/repositories/${created.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setupCommand: 12345 }), // number instead of string
        });
        expect(patchRes.status).toBe(400);
      });

      it('should preserve remoteUrl in response', async () => {
        const app = await createApp();
        const repoPath = createUniqueRepoPath();
        setupTestGitRepo(repoPath);

        // Register repository
        const createRes = await app.request('/api/repositories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: repoPath }),
        });
        expect(createRes.status).toBe(201);
        const { repository: created } = (await createRes.json()) as { repository: Repository };
        expect(created.remoteUrl).toBe('git@github.com:owner/test-repo.git');

        // Update setupCommand
        const patchRes = await app.request(`/api/repositories/${created.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setupCommand: 'npm install' }),
        });
        expect(patchRes.status).toBe(200);

        const { repository: updated } = (await patchRes.json()) as { repository: Repository };
        // remoteUrl should still be included
        expect(updated.remoteUrl).toBe('git@github.com:owner/test-repo.git');
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

    describe('POST /api/repositories/:id/refresh-default-branch', () => {
      it('should refresh and return the default branch', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        // Mock refreshDefaultBranch to return 'develop' (simulating remote changed)
        mockGit.refreshDefaultBranch.mockImplementationOnce(() => Promise.resolve('develop'));

        const res = await app.request(`/api/repositories/${repo.id}/refresh-default-branch`, {
          method: 'POST',
        });
        expect(res.status).toBe(200);

        const body = (await res.json()) as { defaultBranch: string };
        expect(body.defaultBranch).toBe('develop');
      });

      it('should return 404 for non-existent repository', async () => {
        const app = await createApp();

        const res = await app.request('/api/repositories/non-existent/refresh-default-branch', {
          method: 'POST',
        });
        expect(res.status).toBe(404);
      });

      it('should return 400 when git command fails', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        // Mock refreshDefaultBranch to reject with GitError (simulating network error)
        mockGit.refreshDefaultBranch.mockImplementationOnce(() =>
          Promise.reject(new GitError('git remote set-head failed: network error', 128, 'fatal: unable to access'))
        );

        const res = await app.request(`/api/repositories/${repo.id}/refresh-default-branch`, {
          method: 'POST',
        });
        expect(res.status).toBe(400);

        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('Failed to refresh default branch');
      });
    });

    describe('GET /api/repositories/:id/branches/:branch/remote-status', () => {
      it('should return behind and ahead counts', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        // Mock the git functions to return specific values
        mockGit.fetchRemote.mockImplementation(() => Promise.resolve());
        mockGit.getCommitsBehind.mockImplementation(() => Promise.resolve(3));
        mockGit.getCommitsAhead.mockImplementation(() => Promise.resolve(2));

        const res = await app.request(`/api/repositories/${repo.id}/branches/main/remote-status`);
        expect(res.status).toBe(200);

        const body = (await res.json()) as { behind: number; ahead: number };
        expect(body.behind).toBe(3);
        expect(body.ahead).toBe(2);

        // Verify fetchRemote was called with correct branch
        expect(mockGit.fetchRemote).toHaveBeenCalledWith('main', repo.path);
      });

      it('should return 404 for non-existent repository', async () => {
        const app = await createApp();

        const res = await app.request('/api/repositories/non-existent/branches/main/remote-status');
        expect(res.status).toBe(404);
      });

      it('should return 400 when git operation fails', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        // Mock fetchRemote to throw GitError
        mockGit.fetchRemote.mockImplementation(() =>
          Promise.reject(new GitError('git fetch failed: network error', 128, 'fatal: unable to access'))
        );

        const res = await app.request(`/api/repositories/${repo.id}/branches/main/remote-status`);
        expect(res.status).toBe(400);

        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('Failed to get remote status');
      });

      it('should return 400 when getCommitsBehind fails with GitError', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        // fetchRemote succeeds but getCommitsBehind fails
        mockGit.fetchRemote.mockImplementation(() => Promise.resolve());
        mockGit.getCommitsBehind.mockImplementation(() =>
          Promise.reject(new GitError('branch not found', 128, 'fatal: unknown revision'))
        );

        const res = await app.request(`/api/repositories/${repo.id}/branches/feature/remote-status`);
        expect(res.status).toBe(400);

        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('Failed to get remote status');
      });

      it('should handle branch names with special characters', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        mockGit.fetchRemote.mockImplementation(() => Promise.resolve());
        mockGit.getCommitsBehind.mockImplementation(() => Promise.resolve(1));
        mockGit.getCommitsAhead.mockImplementation(() => Promise.resolve(0));

        // URL encode the branch name with slash
        const res = await app.request(`/api/repositories/${repo.id}/branches/feature%2Fmy-feature/remote-status`);
        expect(res.status).toBe(200);

        const body = (await res.json()) as { behind: number; ahead: number };
        expect(body.behind).toBe(1);
        expect(body.ahead).toBe(0);
      });
    });

    describe('POST /api/repositories/:id/fetch', () => {
      it('should fetch all remote branches successfully', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        mockGit.fetchAllRemote.mockImplementation(() => Promise.resolve());

        const res = await app.request(`/api/repositories/${repo.id}/fetch`, {
          method: 'POST',
        });
        expect(res.status).toBe(200);

        const body = (await res.json()) as { success: boolean };
        expect(body.success).toBe(true);

        // Verify fetchAllRemote was called with correct path
        expect(mockGit.fetchAllRemote).toHaveBeenCalledWith(repo.path);
      });

      it('should return 404 for non-existent repository', async () => {
        const app = await createApp();

        const res = await app.request('/api/repositories/non-existent/fetch', {
          method: 'POST',
        });
        expect(res.status).toBe(404);
      });

      it('should return 400 when git operation fails', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        // Mock fetchAllRemote to throw GitError
        mockGit.fetchAllRemote.mockImplementation(() =>
          Promise.reject(new GitError('git fetch failed: network error', 128, 'fatal: unable to access'))
        );

        const res = await app.request(`/api/repositories/${repo.id}/fetch`, {
          method: 'POST',
        });
        expect(res.status).toBe(400);

        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('Failed to fetch remote');
      });

      it('should rethrow non-GitError exceptions', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        // Mock fetchAllRemote to throw a generic error (not GitError)
        mockGit.fetchAllRemote.mockImplementation(() =>
          Promise.reject(new Error('unexpected internal error'))
        );

        const res = await app.request(`/api/repositories/${repo.id}/fetch`, {
          method: 'POST',
        });
        // Generic errors should result in 500
        expect(res.status).toBe(500);
      });
    });

    describe('POST /api/repositories/:id/worktrees', () => {
      // Helper to generate unique task IDs
      const generateTaskId = () => `task-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      it('should accept worktree creation request with custom branch mode', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        const res = await app.request(`/api/repositories/${repo.id}/worktrees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: generateTaskId(),
            mode: 'custom',
            branch: 'test-feature',
          }),
        });

        // API returns 202 Accepted for async processing
        expect(res.status).toBe(202);

        const body = await res.json() as { accepted: boolean };
        expect(body.accepted).toBe(true);
      });

      it('should return 400 for invalid mode', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        const res = await app.request(`/api/repositories/${repo.id}/worktrees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: generateTaskId(), mode: 'invalid' }),
        });
        expect(res.status).toBe(400);
      });

      it('should return 400 when taskId is missing', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        const res = await app.request(`/api/repositories/${repo.id}/worktrees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'custom', branch: 'test' }),
        });
        expect(res.status).toBe(400);

        // Validation fails because taskId is required in all union members
        // The exact error message depends on Valibot's union validation
        const body = (await res.json()) as { error: string };
        expect(body.error).toBeDefined();
      });

      it('should return 400 when prompt mode lacks initialPrompt', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        const res = await app.request(`/api/repositories/${repo.id}/worktrees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: generateTaskId(), mode: 'prompt' }),
        });
        expect(res.status).toBe(400);
      });

      it('should return 400 when prompt mode has empty initialPrompt', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        const res = await app.request(`/api/repositories/${repo.id}/worktrees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: generateTaskId(), mode: 'prompt', initialPrompt: '   ' }),
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
          body: JSON.stringify({ taskId: generateTaskId(), mode: 'custom', branch: 'test' }),
        });
        expect(res.status).toBe(404);
      });

      it('should accept worktree creation with useRemote false in custom mode', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        const res = await app.request(`/api/repositories/${repo.id}/worktrees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: generateTaskId(),
            mode: 'custom',
            branch: 'feature-test',
            baseBranch: 'develop',
            useRemote: false,
          }),
        });

        expect(res.status).toBe(202);
        const body = await res.json() as { accepted: boolean };
        expect(body.accepted).toBe(true);
      });

      it('should accept worktree creation with useRemote true in custom mode', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        const res = await app.request(`/api/repositories/${repo.id}/worktrees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: generateTaskId(),
            mode: 'custom',
            branch: 'feature-test',
            baseBranch: 'develop',
            useRemote: true,
          }),
        });

        expect(res.status).toBe(202);
        const body = await res.json() as { accepted: boolean };
        expect(body.accepted).toBe(true);
      });

      it('should accept worktree creation without useRemote in custom mode', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        const res = await app.request(`/api/repositories/${repo.id}/worktrees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: generateTaskId(),
            mode: 'custom',
            branch: 'feature-test',
            baseBranch: 'main',
          }),
        });

        expect(res.status).toBe(202);
        const body = await res.json() as { accepted: boolean };
        expect(body.accepted).toBe(true);
      });

      it('should accept worktree creation with existing mode', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        const res = await app.request(`/api/repositories/${repo.id}/worktrees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: generateTaskId(),
            mode: 'existing',
            branch: 'existing-branch',
            useRemote: true, // This should be accepted (ignored during async processing)
          }),
        });

        expect(res.status).toBe(202);
        const body = await res.json() as { accepted: boolean };
        expect(body.accepted).toBe(true);
      });

      it('should accept worktree creation with useRemote true in prompt mode', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        const res = await app.request(`/api/repositories/${repo.id}/worktrees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: generateTaskId(),
            mode: 'prompt',
            initialPrompt: 'Add new feature X',
            baseBranch: 'main',
            useRemote: true,
          }),
        });

        expect(res.status).toBe(202);
        const body = await res.json() as { accepted: boolean };
        expect(body.accepted).toBe(true);
      });

      it('should accept worktree creation with useRemote false in prompt mode', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        const res = await app.request(`/api/repositories/${repo.id}/worktrees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: generateTaskId(),
            mode: 'prompt',
            initialPrompt: 'Add new feature Y',
            baseBranch: 'develop',
            useRemote: false,
          }),
        });

        expect(res.status).toBe(202);
        const body = await res.json() as { accepted: boolean };
        expect(body.accepted).toBe(true);
      });

      it('should accept worktree creation even when fetch will fail (async processing handles it)', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        // Mock fetchRemote to fail - but this happens during async processing
        mockGit.fetchRemote.mockImplementation(() =>
          Promise.reject(new GitError('network error', 128, 'fatal: unable to access'))
        );

        const res = await app.request(`/api/repositories/${repo.id}/worktrees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: generateTaskId(),
            mode: 'custom',
            branch: 'feature-test',
            baseBranch: 'main',
            useRemote: true,
          }),
        });

        // API immediately returns 202 - fetch failure is handled in background
        expect(res.status).toBe(202);
        const body = await res.json() as { accepted: boolean };
        expect(body.accepted).toBe(true);
      });

      it('should return 400 when agent does not exist', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        const res = await app.request(`/api/repositories/${repo.id}/worktrees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: generateTaskId(),
            mode: 'custom',
            branch: 'test-feature',
            agentId: 'non-existent-agent',
          }),
        });

        // Agent validation happens synchronously before accepting
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('Agent not found');
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
        // (path is outside the managed repositories directory)
        const res = await app.request(`/api/repositories/${repo.id}/worktrees/%2Fother%2Fpath`, {
          method: 'DELETE',
        });
        expect(res.status).toBe(400);

        const body = (await res.json()) as { error: string };
        // Path validation catches this as "outside managed directory" before checking if it's a worktree
        expect(body.error).toContain('outside managed directory');
      });

      it('should return 409 when deletion is already in progress for the same worktree', async () => {
        const app = await createApp();
        const { repo } = await registerTestRepo(app);

        // The worktree path must be within the managed repositories directory
        const worktreePath = `${TEST_CONFIG_DIR}/repositories/owner/test-repo/worktrees/feature-1`;

        // Pre-populate the deletion guard to simulate an in-progress deletion
        const { _getDeletionsInProgress } = await import('../routes/repositories.js');
        const deletionsInProgress = _getDeletionsInProgress();
        deletionsInProgress.add(worktreePath);

        try {
          const encodedPath = encodeURIComponent(worktreePath);

          const res = await app.request(
            `/api/repositories/${repo.id}/worktrees/${encodedPath}`,
            { method: 'DELETE' }
          );

          expect(res.status).toBe(409);
          const body = (await res.json()) as { error: string };
          expect(body.error).toBe('Deletion already in progress');
        } finally {
          deletionsInProgress.clear();
        }
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
          body: JSON.stringify({ name: 'My Agent', commandTemplate: 'my-agent {{prompt}}' }),
        });
        expect(res.status).toBe(201);

        const body = (await res.json()) as { agent: AgentDefinition };
        expect(body.agent.name).toBe('My Agent');
        expect(body.agent.commandTemplate).toBe('my-agent {{prompt}}');
        expect(body.agent.isBuiltIn).toBe(false);
      });

      it('should return 400 when name is missing', async () => {
        const app = await createApp();

        const res = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commandTemplate: 'my-agent {{prompt}}' }),
        });
        expect(res.status).toBe(400);
      });

      it('should return 400 when commandTemplate is missing', async () => {
        const app = await createApp();

        const res = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'My Agent' }),
        });
        expect(res.status).toBe(400);
      });

      it('should accept valid askingPatterns', async () => {
        const app = await createApp();

        const res = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Test Agent',
            commandTemplate: 'test {{prompt}}',
            activityPatterns: {
              askingPatterns: ['Do you want.*\\?', '\\[y\\].*\\[n\\]'],
            },
          }),
        });
        expect(res.status).toBe(201);

        const body = (await res.json()) as { agent: AgentDefinition };
        expect(body.agent.activityPatterns?.askingPatterns).toEqual([
          'Do you want.*\\?',
          '\\[y\\].*\\[n\\]',
        ]);
      });

      it('should return 400 when askingPatterns contains invalid regex', async () => {
        const app = await createApp();

        const res = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Test Agent',
            commandTemplate: 'test {{prompt}}',
            activityPatterns: {
              askingPatterns: ['[invalid regex'],
            },
          }),
        });
        expect(res.status).toBe(400);
      });

      it('should return 400 when any askingPattern is invalid', async () => {
        const app = await createApp();

        const res = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Test Agent',
            commandTemplate: 'test {{prompt}}',
            activityPatterns: {
              askingPatterns: ['valid.*', '(unclosed', 'also-valid'],
            },
          }),
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
          body: JSON.stringify({ name: 'My Agent', commandTemplate: 'my-agent {{prompt}}' }),
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

      it('should accept valid askingPatterns on update', async () => {
        const app = await createApp();

        // Create a custom agent first
        const createRes = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'My Agent', commandTemplate: 'my-agent {{prompt}}' }),
        });
        const { agent: created } = (await createRes.json()) as { agent: AgentDefinition };

        // Update with valid askingPatterns
        const res = await app.request(`/api/agents/${created.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            activityPatterns: {
              askingPatterns: ['Do you want.*\\?', '\\[y\\].*\\[n\\]'],
            },
          }),
        });
        expect(res.status).toBe(200);

        const body = (await res.json()) as { agent: AgentDefinition };
        expect(body.agent.activityPatterns?.askingPatterns).toEqual([
          'Do you want.*\\?',
          '\\[y\\].*\\[n\\]',
        ]);
      });

      it('should return 400 when askingPatterns contains invalid regex on update', async () => {
        const app = await createApp();

        // Create a custom agent first
        const createRes = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'My Agent', commandTemplate: 'my-agent {{prompt}}' }),
        });
        const { agent: created } = (await createRes.json()) as { agent: AgentDefinition };

        // Update with invalid askingPatterns
        const res = await app.request(`/api/agents/${created.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            activityPatterns: {
              askingPatterns: ['[invalid regex'],
            },
          }),
        });
        expect(res.status).toBe(400);
      });
    });

    describe('DELETE /api/agents/:id', () => {
      it('should delete a custom agent', async () => {
        const app = await createApp();

        // Create a custom agent first
        const createRes = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'My Agent', commandTemplate: 'my-agent {{prompt}}' }),
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

      it('should return 400 for built-in agent even when it is in use by sessions', async () => {
        const app = await createApp();

        // Get agents to find built-in one
        const listRes = await app.request('/api/agents');
        const { agents } = (await listRes.json()) as { agents: AgentDefinition[] };
        const builtInAgent = agents.find((a) => a.isBuiltIn)!;

        // Create a session using the built-in agent
        const sessionRes = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
            agentId: builtInAgent.id,
          }),
        });
        expect(sessionRes.status).toBe(201);

        // Try to delete the built-in agent - should return 400, not 409
        // Built-in check should happen before in-use check
        const res = await app.request(`/api/agents/${builtInAgent.id}`, {
          method: 'DELETE',
        });
        expect(res.status).toBe(400);

        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('Built-in');
      });

      it('should return 404 for non-existent agent', async () => {
        const app = await createApp();

        const res = await app.request('/api/agents/non-existent', {
          method: 'DELETE',
        });
        expect(res.status).toBe(404);
      });

      it('should return 409 when agent is in use by active session', async () => {
        const app = await createApp();

        // Create a custom agent first
        const createAgentRes = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'My Custom Agent', commandTemplate: 'custom-agent {{prompt}}' }),
        });
        const { agent: customAgent } = (await createAgentRes.json()) as { agent: AgentDefinition };

        // Create a session using this custom agent
        const createSessionRes = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
            agentId: customAgent.id,
          }),
        });
        expect(createSessionRes.status).toBe(201);

        // Try to delete the agent while session is active
        const deleteRes = await app.request(`/api/agents/${customAgent.id}`, {
          method: 'DELETE',
        });
        expect(deleteRes.status).toBe(409);

        const body = (await deleteRes.json()) as { error: string };
        expect(body.error).toContain('in use');
      });

      it('should return 409 with correct count when multiple sessions use the agent', async () => {
        const app = await createApp();

        // Create a custom agent
        const createAgentRes = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Shared Agent', commandTemplate: 'shared-agent {{prompt}}' }),
        });
        const { agent } = (await createAgentRes.json()) as { agent: AgentDefinition };

        // Create two sessions using this agent
        const session1Res = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
            agentId: agent.id,
            title: 'First Session',
          }),
        });
        expect(session1Res.status).toBe(201);

        const session2Res = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
            agentId: agent.id,
            title: 'Second Session',
          }),
        });
        expect(session2Res.status).toBe(201);

        // Try to delete the agent
        const deleteRes = await app.request(`/api/agents/${agent.id}`, {
          method: 'DELETE',
        });
        expect(deleteRes.status).toBe(409);

        const body = (await deleteRes.json()) as { error: string };
        expect(body.error).toContain('2 session(s)');
        expect(body.error).toContain('First Session');
        expect(body.error).toContain('Second Session');
      });

      it('should use session ID in error when session has no title', async () => {
        const app = await createApp();

        // Create a custom agent
        const createAgentRes = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Test Agent', commandTemplate: 'test-agent {{prompt}}' }),
        });
        const { agent } = (await createAgentRes.json()) as { agent: AgentDefinition };

        // Create a session WITHOUT title
        const sessionRes = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
            agentId: agent.id,
            // No title
          }),
        });
        const { session } = (await sessionRes.json()) as { session: Session };

        // Try to delete the agent
        const deleteRes = await app.request(`/api/agents/${agent.id}`, {
          method: 'DELETE',
        });
        expect(deleteRes.status).toBe(409);

        const body = (await deleteRes.json()) as { error: string };
        // Should contain session ID since no title was provided
        expect(body.error).toContain(session.id);
      });

      it('should not modify agent when delete is rejected with 409', async () => {
        const app = await createApp();

        // Create a custom agent
        const createAgentRes = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Protected Agent',
            commandTemplate: 'protected {{prompt}}',
            description: 'Should remain unchanged',
          }),
        });
        const { agent: originalAgent } = (await createAgentRes.json()) as { agent: AgentDefinition };

        // Create a session using this agent
        await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
            agentId: originalAgent.id,
          }),
        });

        // Try to delete - should fail
        const deleteRes = await app.request(`/api/agents/${originalAgent.id}`, {
          method: 'DELETE',
        });
        expect(deleteRes.status).toBe(409);

        // Verify agent still exists and is unchanged
        const getRes = await app.request(`/api/agents/${originalAgent.id}`);
        expect(getRes.status).toBe(200);

        const { agent } = (await getRes.json()) as { agent: AgentDefinition };
        expect(agent.name).toBe(originalAgent.name);
        expect(agent.commandTemplate).toBe(originalAgent.commandTemplate);
        expect(agent.description).toBe(originalAgent.description);
      });

      it('should allow deleting agent after all sessions are deleted', async () => {
        const app = await createApp();

        // Create a custom agent
        const createAgentRes = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Deletable Agent', commandTemplate: 'deletable {{prompt}}' }),
        });
        const { agent } = (await createAgentRes.json()) as { agent: AgentDefinition };

        // Create a session using this agent
        const sessionRes = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
            agentId: agent.id,
          }),
        });
        const { session } = (await sessionRes.json()) as { session: Session };

        // Try to delete - should fail
        const deleteRes1 = await app.request(`/api/agents/${agent.id}`, {
          method: 'DELETE',
        });
        expect(deleteRes1.status).toBe(409);

        // Delete the session
        const deleteSessionRes = await app.request(`/api/sessions/${session.id}`, {
          method: 'DELETE',
        });
        expect(deleteSessionRes.status).toBe(200);

        // Now deleting the agent should succeed
        const deleteRes2 = await app.request(`/api/agents/${agent.id}`, {
          method: 'DELETE',
        });
        expect(deleteRes2.status).toBe(200);

        const body = (await deleteRes2.json()) as { success: boolean };
        expect(body.success).toBe(true);

        // Verify agent is gone
        const getRes = await app.request(`/api/agents/${agent.id}`);
        expect(getRes.status).toBe(404);
      });

      it('should return 409 when agent is used only by inactive sessions', async () => {
        const app = await createApp();

        // Create a custom agent
        const createAgentRes = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Inactive Test Agent', commandTemplate: 'inactive-test {{prompt}}' }),
        });
        const { agent } = (await createAgentRes.json()) as { agent: AgentDefinition };

        // Mark a fake server as alive so the session won't be inherited by this server
        const fakeServerPid = 99999;
        mockProcess.markAlive(fakeServerPid);

        // Directly write an inactive session to SQLite database (not in memory)
        // Using a "live" serverPid means it belongs to another server (not inherited by this one)
        const db = getDatabase();
        const createdAt = new Date().toISOString();
        await db.insertInto('sessions').values({
          id: 'inactive-session-1',
          type: 'quick',
          location_path: '/test/path',
          server_pid: fakeServerPid,
          created_at: createdAt,
          title: 'Inactive Session',
        }).execute();
        await db.insertInto('workers').values({
          id: 'worker-1',
          session_id: 'inactive-session-1',
          type: 'agent',
          name: 'Agent',
          agent_id: agent.id,
          pid: 88888,
          created_at: createdAt,
        }).execute();

        // Try to delete the agent - should fail because of inactive session in persistence
        const deleteRes = await app.request(`/api/agents/${agent.id}`, {
          method: 'DELETE',
        });
        expect(deleteRes.status).toBe(409);

        const body = (await deleteRes.json()) as { error: string };
        expect(body.error).toContain('1 session(s)');
        expect(body.error).toContain('(inactive)');
        expect(body.error).toContain('Inactive Session');
      });

      it('should return 409 with correct breakdown for mixed active/inactive sessions', async () => {
        const app = await createApp();

        // Create a custom agent
        const createAgentRes = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Mixed Test Agent', commandTemplate: 'mixed-test {{prompt}}' }),
        });
        const { agent } = (await createAgentRes.json()) as { agent: AgentDefinition };

        // Create an active session via API
        const sessionRes = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'quick',
            locationPath: '/test/path',
            agentId: agent.id,
            title: 'Active Session',
          }),
        });
        expect(sessionRes.status).toBe(201);

        // Mark a fake server as alive so the session won't be inherited by this server
        const fakeServerPid = 99999;
        mockProcess.markAlive(fakeServerPid);

        // Add an inactive session directly to SQLite database (different ID, not in memory)
        // Using a "live" serverPid means it belongs to another server
        const db = getDatabase();
        const createdAt = new Date().toISOString();
        await db.insertInto('sessions').values({
          id: 'inactive-session-2',
          type: 'quick',
          location_path: '/test/path',
          server_pid: fakeServerPid,
          created_at: createdAt,
          title: 'Inactive Session',
        }).execute();
        await db.insertInto('workers').values({
          id: 'worker-2',
          session_id: 'inactive-session-2',
          type: 'agent',
          name: 'Agent',
          agent_id: agent.id,
          pid: 88888,
          created_at: createdAt,
        }).execute();

        // Try to delete the agent - should show both active and inactive
        const deleteRes = await app.request(`/api/agents/${agent.id}`, {
          method: 'DELETE',
        });
        expect(deleteRes.status).toBe(409);

        const body = (await deleteRes.json()) as { error: string };
        expect(body.error).toContain('2 session(s)');
        expect(body.error).toContain('1 active');
        expect(body.error).toContain('1 inactive');
        expect(body.error).toContain('Active Session');
        expect(body.error).toContain('Inactive Session');
      });

      it('should return 409 when agent is in use by worktree session', async () => {
        const app = await createApp();

        // Create a custom agent
        const createAgentRes = await app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Worktree Agent', commandTemplate: 'worktree-agent {{prompt}}' }),
        });
        const { agent } = (await createAgentRes.json()) as { agent: AgentDefinition };

        // Create a worktree session using this agent
        const sessionRes = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'worktree',
            locationPath: TEST_REPO_PATH,
            repositoryId: 'test-repo',
            worktreeId: 'main',
            agentId: agent.id,
            title: 'Worktree Session',
          }),
        });
        expect(sessionRes.status).toBe(201);

        // Try to delete the agent while worktree session is active
        const deleteRes = await app.request(`/api/agents/${agent.id}`, {
          method: 'DELETE',
        });
        expect(deleteRes.status).toBe(409);

        const body = (await deleteRes.json()) as { error: string };
        expect(body.error).toContain('in use');
        expect(body.error).toContain('Worktree Session');
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
