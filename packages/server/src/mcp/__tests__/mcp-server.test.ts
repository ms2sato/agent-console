import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { vol } from 'memfs';
import { Hono } from 'hono';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { mockGit, resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { JobQueue } from '../../jobs/job-queue.js';
import { registerJobHandlers } from '../../jobs/handlers.js';
import { WorkerOutputFileManager } from '../../lib/worker-output-file.js';
import {
  SessionManager,
} from '../../services/session-manager.js';
import {
  RepositoryManager,
} from '../../services/repository-manager.js';
import { AgentManager } from '../../services/agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { JsonSessionRepository } from '../../repositories/index.js';
import { SqliteRepositoryRepository } from '../../repositories/sqlite-repository-repository.js';
import { SqliteWorktreeRepository } from '../../repositories/sqlite-worktree-repository.js';
import { WorktreeService } from '../../services/worktree-service.js';
import type { PtySpawnOptions } from '../../lib/pty-provider.js';
import { TimerManager } from '../../services/timer-manager.js';
import { InteractiveProcessManager } from '../../services/interactive-process-manager.js';
import { AnnotationService } from '../../services/annotation-service.js';
import { InterSessionMessageService } from '../../services/inter-session-message-service.js';
import { SingleUserMode } from '../../services/user-mode.js';
import { createMcpApp } from '../mcp-server.js';
import { createWorktreeWithSession } from '../../services/worktree-creation-service.js';
import { deleteWorktree, _getDeletionsInProgress } from '../../services/worktree-deletion-service.js';

// Mock session-metadata-suggester to avoid spawning real agent processes.
const mockSuggestSessionMetadata = mock(async () => ({
  branch: 'feat/auto-generated-branch',
  title: 'Auto-Generated Title',
}));

// github-pr-service mocks (injected via McpDependencies)
const mockFindOpenPullRequest = mock(async () => null as { number: number; title: string } | null);
const mockFetchPullRequestUrl = mock(async () => null as string | null);

// Test config directory
const TEST_CONFIG_DIR = '/test/config';
const TEST_REPO_PATH = '/test/repo';

// Create mock PTY factory
const ptyFactory = createMockPtyFactory(30000);

// ---------- MCP protocol helpers ----------

/**
 * Initialize MCP session by sending the initialize request and notifications/initialized.
 * Returns the Mcp-Session-Id header value (may be empty if sessions are not managed).
 */
async function initializeMcp(app: Hono): Promise<string> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
      id: 1,
    }),
  });

  expect(res.status).toBe(200);

  const sessionId = res.headers.get('mcp-session-id') ?? '';

  // Send initialized notification
  await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  });

  return sessionId;
}

/**
 * Call an MCP tool and return the parsed JSON-RPC response.
 */
async function callTool(
  app: Hono,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  id: number = 2,
): Promise<{ result?: { content: Array<{ type: string; text: string }>; isError?: boolean }; error?: unknown }> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name, arguments: args },
      id,
    }),
  });

  expect(res.status).toBe(200);
  return (await res.json()) as {
    result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
    error?: unknown;
  };
}

/**
 * Extract the parsed text content from a tool call result.
 */
function parseToolResult(response: Awaited<ReturnType<typeof callTool>>): unknown {
  const text = response.result?.content?.[0]?.text;
  if (!text) return undefined;
  return JSON.parse(text);
}

// ---------- Tests ----------

describe('MCP Server Tools', () => {
  let app: Hono;
  let sessionManager: SessionManager;
  let agentManager: AgentManager;
  let repositoryManager: RepositoryManager;
  let timerManager: TimerManager;
  let interactiveProcessManager: InteractiveProcessManager;
  let worktreeService: WorktreeService;
  let annotationService: AnnotationService;
  let testJobQueue: JobQueue;
  let mcpSessionId: string;
  // Track unique IDs for tool calls to avoid collisions in the shared transport
  let nextId: number;

  /**
   * Re-create the MCP app and initialize a new MCP session.
   * Call this after replacing the repositoryManager to ensure
   * the MCP tools see the updated dependencies.
   */
  async function remountMcpApp(): Promise<void> {
    const mcpApp = createMcpApp({ sessionManager, repositoryManager, agentManager, timerManager, interactiveProcessManager, worktreeService, annotationService, interSessionMessageService: new InterSessionMessageService(), suggestSessionMetadata: mockSuggestSessionMetadata, createWorktreeWithSession, deleteWorktree, broadcastToApp: () => {}, findOpenPullRequest: mockFindOpenPullRequest, fetchPullRequestUrl: mockFetchPullRequestUrl });
    app = new Hono();
    app.route('', mcpApp);
    mcpSessionId = await initializeMcp(app);
  }

  beforeEach(async () => {
    await closeDatabase();

    // Setup memfs with config directory structure
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    // Initialize in-memory database
    await initializeDatabase(':memory:');

    // Create job queue with the in-memory database
    testJobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(testJobQueue, new WorkerOutputFileManager());

    // Reset process mock and mark current process as alive
    resetProcessMock();
    mockProcess.markAlive(process.pid);

    // Reset PTY factory
    ptyFactory.reset();

    // Reset git mocks to defaults
    resetGitMocks();

    // Reset session metadata suggester mock
    mockSuggestSessionMetadata.mockReset();
    mockSuggestSessionMetadata.mockImplementation(async () => ({
      branch: 'feat/auto-generated-branch',
      title: 'Auto-Generated Title',
    }));

    // Reset worktree-deletion-service state
    _getDeletionsInProgress().clear();

    // Reset github-pr-service mocks
    mockFindOpenPullRequest.mockReset();
    mockFindOpenPullRequest.mockImplementation(async () => null);
    mockFetchPullRequestUrl.mockReset();
    mockFetchPullRequestUrl.mockImplementation(async () => null);

    // Create session repository
    const sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);

    // Create AgentManager for dependency injection
    const db = getDatabase();
    agentManager = await AgentManager.create(new SqliteAgentRepository(db));

    // Create AnnotationService
    annotationService = new AnnotationService();

    // Create SessionManager directly
    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager,
      annotationService,
      repositoryLookup: { getRepositorySlug: (id: string) => repositoryManager?.getRepositorySlug(id) },
      repositoryEnvLookup: {
        getRepositoryInfo: (id: string) => {
          const r = repositoryManager?.getRepository(id);
          return r ? { name: r.name, path: r.path, envVars: r.envVars } : undefined;
        },
        getWorktreeIndexNumber: async () => 0,
      },
    });

    // Create RepositoryManager (initially empty). Tests that create worktree
    // sessions via sessionManager must call `registerRepoForTests('repo-1')`
    // before doing so.
    repositoryManager = await RepositoryManager.create({ jobQueue: testJobQueue });

    // Create TimerManager (no-op callback for tests)
    timerManager = new TimerManager(() => {});

    // Create InteractiveProcessManager (no-op callbacks for tests)
    interactiveProcessManager = new InteractiveProcessManager(() => {}, () => {});

    // Create WorktreeService with in-memory database
    worktreeService = new WorktreeService({ db });

    // Create MCP app with injected dependencies and initialize MCP session
    await remountMcpApp();
    nextId = 10;
  });

  /**
   * Register `repo-1` in the current RepositoryManager so tests that create
   * worktree sessions via `sessionManager.createSession({ repositoryId: 'repo-1' })`
   * can resolve the slug. After Stage 2 of the session-data-path refactor,
   * unknown repositories throw RepositoryNotFoundError at creation time.
   */
  async function registerTestRepo(
    id = 'repo-1',
    name = 'test-repo',
    repoPath = '/test/repo',
  ): Promise<void> {
    const db = getDatabase();
    const sqliteRepoRepo = new SqliteRepositoryRepository(db);
    await sqliteRepoRepo.save({
      id,
      name,
      path: repoPath,
      createdAt: new Date().toISOString(),
    });
    // Ensure the path exists in memfs so RepositoryManager.initialize()
    // doesn't filter it out on load.
    const fs = await import('fs');
    fs.mkdirSync(repoPath, { recursive: true });
    repositoryManager = await RepositoryManager.create({
      repository: sqliteRepoRepo,
      jobQueue: testJobQueue,
    });
    await remountMcpApp();
  }

  afterEach(async () => {
    timerManager.disposeAll();
    interactiveProcessManager.disposeAll();
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
    resetProcessMock();
  });

  // ===========================================================================
  // list_agents
  // ===========================================================================

  describe('list_agents', () => {
    it('should return the built-in claude-code agent by default', async () => {
      const response = await callTool(app, mcpSessionId, 'list_agents', {}, nextId++);
      const data = parseToolResult(response) as {
        agents: Array<{
          id: string;
          name: string;
          description?: string;
          isBuiltIn: boolean;
          capabilities: {
            supportsContinue: boolean;
            supportsHeadlessMode: boolean;
            supportsActivityDetection: boolean;
          };
        }>;
      };

      expect(response.result?.isError).toBeUndefined();
      expect(data.agents.length).toBeGreaterThanOrEqual(1);

      const builtIn = data.agents.find((a) => a.id === 'claude-code-builtin');
      expect(builtIn).toBeDefined();
      expect(builtIn!.name).toBe('Claude Code');
      expect(builtIn!.isBuiltIn).toBe(true);
      expect(builtIn!.capabilities).toBeDefined();
    });

    it('should include custom agents after registration', async () => {
      await agentManager.registerAgent({
        name: 'Custom Agent',
        commandTemplate: 'custom-agent {{prompt}}',
        description: 'A custom test agent',
      });

      const response = await callTool(app, mcpSessionId, 'list_agents', {}, nextId++);
      const data = parseToolResult(response) as {
        agents: Array<{
          id: string;
          name: string;
          description?: string;
          isBuiltIn: boolean;
        }>;
      };

      expect(data.agents).toHaveLength(2);

      const custom = data.agents.find((a) => a.name === 'Custom Agent');
      expect(custom).toBeDefined();
      expect(custom!.description).toBe('A custom test agent');
      expect(custom!.isBuiltIn).toBe(false);
    });

    it('should not expose internal template fields', async () => {
      const response = await callTool(app, mcpSessionId, 'list_agents', {}, nextId++);
      const data = parseToolResult(response) as {
        agents: Array<Record<string, unknown>>;
      };

      for (const agent of data.agents) {
        expect(agent).not.toHaveProperty('commandTemplate');
        expect(agent).not.toHaveProperty('continueTemplate');
        expect(agent).not.toHaveProperty('headlessTemplate');
        expect(agent).not.toHaveProperty('activityPatterns');
        expect(agent).not.toHaveProperty('createdAt');
      }
    });

    it('should include all capability flags as booleans', async () => {
      const response = await callTool(app, mcpSessionId, 'list_agents', {}, nextId++);
      const data = parseToolResult(response) as {
        agents: Array<{
          capabilities: {
            supportsContinue: unknown;
            supportsHeadlessMode: unknown;
            supportsActivityDetection: unknown;
          };
        }>;
      };

      for (const agent of data.agents) {
        expect(agent.capabilities).toBeDefined();
        expect(typeof agent.capabilities.supportsContinue).toBe('boolean');
        expect(typeof agent.capabilities.supportsHeadlessMode).toBe('boolean');
        expect(typeof agent.capabilities.supportsActivityDetection).toBe('boolean');
      }
    });
  });

  // ===========================================================================
  // list_repositories
  // ===========================================================================

  describe('list_repositories', () => {
    async function setupRepoManager(repos: Array<{
      id: string;
      name: string;
      path: string;
      description?: string | null;
    }> = []): Promise<void> {
      const db = getDatabase();
      const sqliteRepoRepo = new SqliteRepositoryRepository(db);
      for (const repo of repos) {
        await sqliteRepoRepo.save({
          ...repo,
          createdAt: new Date().toISOString(),
        });
      }
      repositoryManager = await RepositoryManager.create({
        jobQueue: testJobQueue,
        repository: sqliteRepoRepo,
      });
      await remountMcpApp();
    }

    it('should return empty repositories array when no repositories registered', async () => {
      await setupRepoManager();
      const response = await callTool(app, mcpSessionId, 'list_repositories', {}, nextId++);
      const data = parseToolResult(response) as { repositories: unknown[] };
      expect(response.result?.isError).toBeUndefined();
      expect(data.repositories).toEqual([]);
    });

    it('should return repository info with id, name, and description', async () => {
      // Need to set up memfs with the repo path for RepositoryManager to load it
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      // Mock getRemoteUrl to return a known URL
      mockGit.getRemoteUrl.mockImplementation(async () => 'git@github.com:owner/repo.git');

      await setupRepoManager([{
        id: 'repo-1',
        name: 'my-repo',
        path: TEST_REPO_PATH,
        description: 'A test repository for unit tests',
      }]);

      const response = await callTool(app, mcpSessionId, 'list_repositories', {}, nextId++);
      const data = parseToolResult(response) as {
        repositories: Array<Record<string, unknown>>;
      };

      expect(response.result?.isError).toBeUndefined();
      expect(data.repositories).toHaveLength(1);
      expect(data.repositories[0].id).toBe('repo-1');
      expect(data.repositories[0].name).toBe('my-repo');
      expect(data.repositories[0].remoteUrl).toBe('git@github.com:owner/repo.git');
      expect(data.repositories[0].description).toBe('A test repository for unit tests');
    });

    it('should not expose path, setupCommand, or envVars', async () => {
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
      mockGit.getRemoteUrl.mockImplementation(async () => 'git@github.com:owner/repo.git');

      await setupRepoManager([{
        id: 'repo-1',
        name: 'my-repo',
        path: TEST_REPO_PATH,
      }]);

      const response = await callTool(app, mcpSessionId, 'list_repositories', {}, nextId++);
      const data = parseToolResult(response) as {
        repositories: Array<Record<string, unknown>>;
      };

      for (const repo of data.repositories) {
        expect(repo).not.toHaveProperty('path');
        expect(repo).not.toHaveProperty('setupCommand');
        expect(repo).not.toHaveProperty('envVars');
      }
    });
  });

  // ===========================================================================
  // list_sessions
  // ===========================================================================

  describe('list_sessions', () => {
    it('should return empty sessions array when no sessions exist', async () => {
      const response = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      const data = parseToolResult(response) as { sessions: unknown[] };

      expect(response.result?.isError).toBeUndefined();
      expect(data.sessions).toEqual([]);
    });

    it('should return session info after creating a session', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      const data = parseToolResult(response) as { sessions: Array<{ id: string; type: string; status: string; workers: unknown[] }> };

      expect(response.result?.isError).toBeUndefined();
      expect(data.sessions).toHaveLength(1);
      expect(data.sessions[0].id).toBe(session.id);
      expect(data.sessions[0].type).toBe('quick');
      expect(data.sessions[0].status).toBe('active');
      expect(data.sessions[0].workers.length).toBeGreaterThan(0);
    });

    it('should return multiple sessions', async () => {
      await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path1',
        agentId: 'claude-code',
      });
      await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path2',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      const data = parseToolResult(response) as { sessions: unknown[] };

      expect(data.sessions).toHaveLength(2);
    });

    it('should include worktreeId for worktree sessions', async () => {
      await registerTestRepo();
      await sessionManager.createSession({
        type: 'worktree',
        locationPath: '/test/worktree',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      const data = parseToolResult(response) as { sessions: Array<{ worktreeId?: string }> };

      expect(data.sessions[0].worktreeId).toBe('feature-branch');
    });

    it('should include repositoryId and repositoryName for worktree sessions', async () => {
      await registerTestRepo();
      await sessionManager.createSession({
        type: 'worktree',
        locationPath: '/test/worktree',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      const data = parseToolResult(response) as {
        sessions: Array<{ repositoryId?: string; repositoryName?: string; type: string }>;
      };

      expect(data.sessions[0].repositoryId).toBe('repo-1');
      expect(data.sessions[0].repositoryName).toBeDefined();
    });

    it('should not include repositoryId for quick sessions', async () => {
      await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      const data = parseToolResult(response) as {
        sessions: Array<{ repositoryId?: string }>;
      };

      expect(data.sessions[0].repositoryId).toBeUndefined();
    });
  });

  // ===========================================================================
  // get_session_status
  // ===========================================================================

  describe('get_session_status', () => {
    it('should return session info for an existing session', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
        title: 'Test Session',
      });

      const response = await callTool(app, mcpSessionId, 'get_session_status', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as {
        sessionId: string;
        status: string;
        title: string;
        workers: Array<{ id: string; type: string; activityState: string }>;
      };

      expect(response.result?.isError).toBeUndefined();
      expect(data.sessionId).toBe(session.id);
      expect(data.status).toBe('active');
      expect(data.title).toBe('Test Session');
      expect(data.workers.length).toBeGreaterThan(0);
    });

    it('should return error for non-existent session', async () => {
      const response = await callTool(app, mcpSessionId, 'get_session_status', {
        sessionId: 'non-existent-id',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Session not found');
    });

    it('should include worktreeId for worktree sessions', async () => {
      await registerTestRepo();
      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: '/test/worktree',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'get_session_status', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as { worktreeId?: string };

      expect(data.worktreeId).toBe('feature-branch');
    });

    it('should include repositoryId and repositoryName for worktree sessions', async () => {
      await registerTestRepo();
      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: '/test/worktree',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'get_session_status', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as {
        repositoryId?: string;
        repositoryName?: string;
      };

      expect(data.repositoryId).toBe('repo-1');
      expect(data.repositoryName).toBeDefined();
    });

    it('should report worker activity states', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'get_session_status', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as {
        workers: Array<{ id: string; type: string; activityState: string }>;
      };

      // Agent workers should have an activity state
      const agentWorker = data.workers.find((w) => w.type === 'agent');
      expect(agentWorker).toBeDefined();
      expect(agentWorker!.activityState).toBeDefined();
    });

    it('should report terminated worker when PTY has exited', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Simulate PTY exit for the agent worker
      const agentPty = ptyFactory.instances[0];
      expect(agentPty).toBeDefined();
      agentPty.simulateExit(0);

      const response = await callTool(app, mcpSessionId, 'get_session_status', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as {
        workers: Array<{ id: string; type: string; activityState: string }>;
      };

      // After PTY exit, the activity state should reflect the terminated state
      const agentWorker = data.workers.find((w) => w.type === 'agent');
      expect(agentWorker).toBeDefined();
      // ActivityDetector is disposed on exit, so getWorkerActivityState returns undefined
      // which mapWorkers converts to 'unknown'
      expect(agentWorker!.activityState).toBeDefined();
    });
  });

  // ===========================================================================
  // send_session_message
  // ===========================================================================

  describe('send_session_message', () => {
    it('should return error when target session does not exist', async () => {
      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: 'non-existent',
        content: 'hello',
        fromSessionId: 'test-sender',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toBe('Session non-existent not found');
    });

    it('should return error when explicit worker does not exist in target session', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        toWorkerId: 'non-existent-worker',
        content: 'hello',
        fromSessionId: 'test-sender',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain(`Worker non-existent-worker not found in session ${session.id}`);
    });

    it('should return error when explicit toWorkerId targets a git-diff worker', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Find the git-diff worker created by default
      const gitDiffWorker = session.workers.find((w) => w.type === 'git-diff');
      expect(gitDiffWorker).toBeDefined();

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        toWorkerId: gitDiffWorker!.id,
        content: 'hello',
        fromSessionId: 'test-sender',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('does not support inbound messages');
    });

    it('should return error when session has no agent workers', async () => {
      // Create a session (which creates an agent worker and a git-diff worker by default)
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Delete the default agent worker so only the git-diff worker remains
      const agentWorker = session.workers.find((w) => w.type === 'agent');
      expect(agentWorker).toBeDefined();
      await sessionManager.deleteWorker(session.id, agentWorker!.id);

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        content: 'hello',
        fromSessionId: 'test-sender',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toBe(`Session ${session.id} has no agent workers`);
    });

    it('should return error when multiple agent workers exist without explicit toWorkerId', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Add a second agent worker
      await sessionManager.createWorker(session.id, {
        type: 'agent',
        agentId: 'claude-code-builtin',
      });

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        content: 'hello',
        fromSessionId: 'test-sender',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('has multiple agent workers');
      expect(data.error).toContain('Specify toWorkerId explicitly');
      expect(data.error).toContain('Use get_session_status to discover available workers');
    });

    it('should auto-resolve single agent worker when toWorkerId is omitted', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        content: 'task completed successfully',
        fromSessionId: 'test-sender',
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { messageId: string; path: string };
      expect(data.messageId).toBeDefined();
      expect(data.path).toBeDefined();
    });

    it('should write message file content to disk', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const messageContent = JSON.stringify({ status: 'completed', summary: 'All tests pass' });

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        content: messageContent,
        fromSessionId: 'sender-session',
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { messageId: string; path: string };

      // Verify file exists and has correct content
      const fileContent = vol.readFileSync(data.path, 'utf-8');
      expect(fileContent).toBe(messageContent);
    });

    it('should send PTY notification with internal:message format', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // The agent worker's PTY is the first instance created
      const mockPty = ptyFactory.instances[0];
      expect(mockPty).toBeDefined();

      await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        content: 'check this out',
        fromSessionId: 'sender-session-123',
      }, nextId++);

      // Verify PTY received the inbound:message notification
      const allWritten = mockPty.writtenData.join('');
      expect(allWritten).toContain('[internal:message]');
      expect(allWritten).toContain('source=session');
      expect(allWritten).toContain('from=sender-session-123');
      expect(allWritten).toContain('intent=triage');
    });

    it('should split notification text and Enter keystroke into separate writes with delay', async () => {
      jest.useFakeTimers();
      try {
        const session = await sessionManager.createSession({
          type: 'quick',
          locationPath: '/test/path',
          agentId: 'claude-code',
        });

        const mockPty = ptyFactory.instances[0];
        expect(mockPty).toBeDefined();

        // Clear any writes from session creation
        mockPty.writtenData.length = 0;

        await callTool(app, mcpSessionId, 'send_session_message', {
          toSessionId: session.id,
          content: 'split test',
          fromSessionId: 'sender-abc',
        }, nextId++);

        // Before the timer fires, notification text + reply instructions should be written
        expect(mockPty.writtenData).toHaveLength(2);
        expect(mockPty.writtenData[0]).toContain('[internal:message]');
        expect(mockPty.writtenData[0]).not.toContain('\r');
        // The notification text should NOT end with \n (no trailing newline)
        expect(mockPty.writtenData[0].endsWith('\n')).toBe(false);
        expect(mockPty.writtenData[1]).toContain('[Reply Instructions]');
        expect(mockPty.writtenData[1]).toContain('sender-abc');

        // Advance past the 150ms delay
        jest.advanceTimersByTime(150);

        // Now the Enter keystroke should have been sent as a third write
        expect(mockPty.writtenData).toHaveLength(3);
        expect(mockPty.writtenData[2]).toBe('\r');
      } finally {
        jest.useRealTimers();
      }
    });

    it('should include reply instructions in PTY notification', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const mockPty = ptyFactory.instances[0];
      expect(mockPty).toBeDefined();

      await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        content: 'need your help',
        fromSessionId: 'requester-session-456',
      }, nextId++);

      // Reply instructions are the second write (index 1), after the notification (index 0)
      const replyInstructions = mockPty.writtenData[1];
      expect(replyInstructions).toContain('[Reply Instructions]');
      expect(replyInstructions).toContain('toSessionId: "requester-session-456"');
      expect(replyInstructions).toContain('AGENT_CONSOLE_SESSION_ID');
    });

    it('should include sender session title in notification summary', async () => {
      // Create sender session with a title
      const senderSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/sender-path',
        agentId: 'claude-code',
        title: 'Backend Auth Task',
      });

      // Create target session
      const targetSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/target-path',
        agentId: 'claude-code',
      });

      await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: targetSession.id,
        content: 'auth fix is done',
        fromSessionId: senderSession.id,
      }, nextId++);

      // Check all PTY instances for the notification containing the sender's title
      const allPtyWrites = ptyFactory.instances
        .map((p) => p.writtenData.join(''))
        .join('|||');
      expect(allPtyWrites).toContain('Backend Auth Task');
    });

    it('should succeed with explicit toWorkerId targeting', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const agentWorker = session.workers.find((w) => w.type === 'agent');
      expect(agentWorker).toBeDefined();

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        toWorkerId: agentWorker!.id,
        content: 'explicit target message',
        fromSessionId: 'sender-x',
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { messageId: string; path: string };
      expect(data.messageId).toContain('sender-x');
      expect(data.path).toBeDefined();

      // Verify file content
      const fileContent = vol.readFileSync(data.path, 'utf-8');
      expect(fileContent).toBe('explicit target message');
    });

    it('should return error when message content exceeds size limit', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const oversizedContent = 'x'.repeat(64 * 1024 + 1);

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        content: oversizedContent,
        fromSessionId: 'test-sender',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Message content too large');
    });

    it('should return validation error when fromSessionId is omitted', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'send_session_message', {
        toSessionId: session.id,
        content: 'no sender info',
        // fromSessionId is intentionally omitted
      }, nextId++);

      // The MCP SDK validates parameters via zod schema and returns a JSON-RPC error
      // when required parameters are missing
      if (response.error) {
        // JSON-RPC level error
        expect(response.error).toBeDefined();
      } else {
        // Or the tool handler catches it and returns isError
        expect(response.result?.isError).toBe(true);
      }
    });
  });

  // ===========================================================================
  // delegate_to_worktree
  // ===========================================================================

  describe('delegate_to_worktree', () => {
    /**
     * Helper to initialize a RepositoryManager with optional pre-seeded repositories.
     * Repositories must have their paths present in memfs to be loaded.
     * Updates the outer `repositoryManager` and re-mounts the MCP app.
     */
    async function setupDelegateRepoManager(repos: Array<{
      id: string;
      name: string;
      path: string;
      defaultAgentId?: string | null;
    }> = []): Promise<void> {
      const db = getDatabase();
      const sqliteRepoRepo = new SqliteRepositoryRepository(db);
      for (const repo of repos) {
        await sqliteRepoRepo.save({
          ...repo,
          createdAt: new Date().toISOString(),
        });
      }
      repositoryManager = await RepositoryManager.create({
        jobQueue: testJobQueue,
        repository: sqliteRepoRepo,
      });
      await remountMcpApp();
    }

    /**
     * Standard setup for delegate_to_worktree tests that need a working repository.
     * Sets up memfs with repo and config dirs, git mocks, and RepositoryManager.
     *
     * @param worktreeBranch - Branch name that the created worktree will report
     * @param options.defaultAgentId - Optional default agent ID for the repository
     * @returns The worktree path that createWorktree will produce
     */
    async function setupDelegateEnvironment(
      worktreeBranch: string = 'feat/test-branch',
      options?: { defaultAgentId?: string | null },
    ): Promise<string> {
      // The orgRepo extracted from the mock remote URL (git@github.com:owner/repo.git)
      const orgRepo = 'owner/repo';
      // The worktree path follows the pattern: AGENT_CONSOLE_HOME/repositories/<orgRepo>/worktrees/wt-001-xxxx
      // but we need to match what worktreeService actually produces.
      // We use a known pattern for the index store directory.
      const repoWorktreeDir = `${TEST_CONFIG_DIR}/repositories/${orgRepo}/worktrees`;

      // Setup memfs with config dir and repo path
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      // Configure git mocks for worktree operations
      mockGit.getRemoteUrl.mockImplementation(async () => 'git@github.com:owner/repo.git');
      mockGit.getDefaultBranch.mockImplementation(async () => 'main');
      mockGit.createWorktree.mockImplementation(async () => {
        // Simulate git creating the worktree directory - noop since we mock listWorktrees
      });

      // listWorktrees must return the created worktree. Since the actual worktree path
      // includes a random suffix, we configure listWorktrees dynamically:
      // After createWorktree is called, we know the path from the index store.
      // However, the simpler approach is to return a porcelain output that includes
      // both the main repo and a worktree at a known path.
      // We intercept createWorktree to capture the path, then use it in listWorktrees.
      let capturedWorktreePath = '';
      mockGit.createWorktree.mockImplementation(async (...args: unknown[]) => {
        capturedWorktreePath = args[0] as string;
      });

      mockGit.listWorktrees.mockImplementation(async () => {
        if (capturedWorktreePath) {
          return `worktree ${TEST_REPO_PATH}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${capturedWorktreePath}\nHEAD def456\nbranch refs/heads/${worktreeBranch}\n`;
        }
        return `worktree ${TEST_REPO_PATH}\nHEAD abc123\nbranch refs/heads/main\n`;
      });

      // Setup RepositoryManager with the test repository
      await setupDelegateRepoManager([{
        id: 'test-repo',
        name: 'test',
        path: TEST_REPO_PATH,
        defaultAgentId: options?.defaultAgentId,
      }]);

      return repoWorktreeDir;
    }

    /**
     * Find a PTY spawn call whose command arguments contain the given substring.
     * Returns undefined if no matching call is found.
     */
    function findSpawnCallByCommand(commandSubstring: string): unknown[] | undefined {
      const calls = ptyFactory.spawn.mock.calls as unknown as Array<[string, string[], unknown]>;
      return calls.find((call) => {
        const cmd = call[1]?.join(' ') ?? '';
        return cmd.includes(commandSubstring);
      });
    }

    it('should return error when repository not found', async () => {
      // Initialize RepositoryManager with no repositories
      await setupDelegateRepoManager();

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'non-existent-repo',
        prompt: 'Implement feature X',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Repository not found');
    });

    it('should return error when agent not found', async () => {
      // The repository path must exist in memfs for RepositoryManager.initialize() to load it
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        '/test/repo/.git/HEAD': 'ref: refs/heads/main',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      await setupDelegateRepoManager([{
        id: 'test-repo',
        name: 'test',
        path: '/test/repo',
      }]);

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Do something',
        agentId: 'non-existent-agent',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Agent not found');
    });

    it('should successfully create worktree, session, and start agent worker', async () => {
      await setupDelegateEnvironment('feat/my-feature');


      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Implement feature X',
        branch: 'feat/my-feature',
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as {
        sessionId: string;
        workerId: string;
        worktreePath: string;
        branch: string;
      };

      // Verify result contains all expected fields
      expect(data.sessionId).toBeDefined();
      expect(data.sessionId.length).toBeGreaterThan(0);
      expect(data.workerId).toBeDefined();
      expect(data.workerId.length).toBeGreaterThan(0);
      expect(data.worktreePath).toBeDefined();
      expect(data.worktreePath.length).toBeGreaterThan(0);
      expect(data.branch).toBe('feat/my-feature');

      // Verify the session exists via list_sessions
      const listResponse = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      const listData = parseToolResult(listResponse) as {
        sessions: Array<{
          id: string;
          type: string;
          worktreeId?: string;
          workers: Array<{ id: string; type: string }>;
        }>;
      };

      expect(listData.sessions.length).toBeGreaterThanOrEqual(1);
      const delegatedSession = listData.sessions.find((s) => s.id === data.sessionId);
      expect(delegatedSession).toBeDefined();
      expect(delegatedSession!.type).toBe('worktree');
      expect(delegatedSession!.worktreeId).toBe('feat/my-feature');

      // Verify the session has an agent worker
      const agentWorker = delegatedSession!.workers.find((w) => w.type === 'agent');
      expect(agentWorker).toBeDefined();
      expect(agentWorker!.id).toBe(data.workerId);
    });

    it('should auto-generate branch name from prompt when branch param is omitted', async () => {
      mockSuggestSessionMetadata.mockImplementation(async () => ({
        branch: 'feat/auto-generated-branch',
        title: 'Auto-Generated Title',
      }));

      await setupDelegateEnvironment('feat/auto-generated-branch');


      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Implement automatic branch generation',
        // branch is intentionally omitted
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as {
        branch: string;
      };

      // The branch should come from suggestSessionMetadata
      expect(data.branch).toBe('feat/auto-generated-branch');

      // Verify suggestSessionMetadata was called
      expect(mockSuggestSessionMetadata).toHaveBeenCalled();
    });

    it('should use explicit branch name when provided', async () => {
      await setupDelegateEnvironment('my-explicit-branch');


      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Do some work',
        branch: 'my-explicit-branch',
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { branch: string };
      expect(data.branch).toBe('my-explicit-branch');

      // suggestSessionMetadata should NOT have been called when branch is explicitly provided
      expect(mockSuggestSessionMetadata).not.toHaveBeenCalled();
    });

    it('should pass custom title through to the created session', async () => {
      await setupDelegateEnvironment('feat/titled-task');


      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Add dark mode support',
        branch: 'feat/titled-task',
        title: 'Dark Mode Feature',
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { sessionId: string };

      // Verify the session has the custom title
      const statusResponse = await callTool(app, mcpSessionId, 'get_session_status', {
        sessionId: data.sessionId,
      }, nextId++);
      const statusData = parseToolResult(statusResponse) as { title?: string };

      expect(statusData.title).toBe('Dark Mode Feature');
    });

    it('should call fetchRemote by default when useRemote is omitted', async () => {
      await setupDelegateEnvironment('feat/remote-branch');

      // fetchRemote is already mocked by mock-git-helper (resolves successfully)

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Work on remote-based feature',
        branch: 'feat/remote-branch',
        // useRemote is intentionally omitted — should default to true
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      // Verify fetchRemote was called (the baseBranch defaults to 'main')
      expect(mockGit.fetchRemote).toHaveBeenCalledWith('main', TEST_REPO_PATH);
    });

    it('should skip fetchRemote when useRemote is explicitly false', async () => {
      await setupDelegateEnvironment('feat/local-branch');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Work on local-only feature',
        branch: 'feat/local-branch',
        useRemote: false,
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      // Verify fetchRemote was NOT called
      expect(mockGit.fetchRemote).not.toHaveBeenCalled();
    });

    it('should return error when worktree creation fails', async () => {
      // Setup environment but make createWorktree fail
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      mockGit.getRemoteUrl.mockImplementation(async () => 'git@github.com:owner/repo.git');
      mockGit.getDefaultBranch.mockImplementation(async () => 'main');

      // Make createWorktree throw a GitError
      const { GitError } = await import('../../lib/git.js');
      mockGit.createWorktree.mockImplementation(async () => {
        throw new GitError('fatal: branch already exists', 128, 'fatal: branch already exists');
      });

      await setupDelegateRepoManager([{
        id: 'test-repo',
        name: 'test',
        path: TEST_REPO_PATH,
      }]);

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Try to create duplicate worktree',
        branch: 'existing-branch',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Worktree creation failed');
    });

    it('should find worktree via DB even when git does not report it (orphaned)', async () => {
      // Setup environment with worktree creation succeeding but git listWorktrees
      // not returning it. With DB-based tracking, the worktree is still found as
      // an orphaned entry because createWorktree saves a record to the DB.
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      mockGit.getRemoteUrl.mockImplementation(async () => 'git@github.com:owner/repo.git');
      mockGit.getDefaultBranch.mockImplementation(async () => 'main');

      mockGit.createWorktree.mockImplementation(async () => {
        // Success - worktree is "created" on disk
      });
      mockGit.listWorktrees.mockImplementation(async () => {
        // Only return the main worktree; the created worktree is NOT in git output
        return `worktree ${TEST_REPO_PATH}\nHEAD abc123\nbranch refs/heads/main\n`;
      });

      await setupDelegateRepoManager([{
        id: 'test-repo',
        name: 'test',
        path: TEST_REPO_PATH,
      }]);

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test orphaned worktree lookup via DB',
        branch: 'feat/ghost-worktree',
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as {
        sessionId: string;
        worktreePath: string;
      };
      expect(data.sessionId).toBeDefined();
      expect(data.worktreePath).toBeDefined();
    });

    it('should rollback worktree when session is deleted before delegation completes', async () => {
      await setupDelegateEnvironment('feat/deleted-session');

      // Intercept createSession: after it creates the session, immediately delete it
      // to simulate a concurrent deletion race condition
      const originalCreateSession = sessionManager.createSession.bind(sessionManager);
      sessionManager.createSession = async (...args: Parameters<typeof sessionManager.createSession>) => {
        const session = await originalCreateSession(...args);
        // Delete the session immediately to simulate race condition
        await sessionManager.deleteSession(session.id);
        return session;
      };

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test session deleted during delegation',
        branch: 'feat/deleted-session',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Session was deleted before delegation could complete');

      // Verify removeWorktree was called for rollback
      expect(mockGit.removeWorktree).toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Agent selection priority: agentId > repo.defaultAgentId > CLAUDE_CODE
    // -----------------------------------------------------------------------

    it('should use repository defaultAgentId when agentId is not provided', async () => {
      const registered = await agentManager.registerAgent({
        name: 'Repo Default Agent',
        commandTemplate: 'repo-default-agent {{prompt}}',
      });

      await setupDelegateEnvironment('feat/repo-default', {
        defaultAgentId: registered.id,
      });


      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test repo default agent selection',
        branch: 'feat/repo-default',
        // agentId is intentionally omitted
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      expect(findSpawnCallByCommand('repo-default-agent')).toBeDefined();
    });

    it('should fall back to claude-code-builtin when agentId is not provided and repository has no defaultAgentId', async () => {
      await setupDelegateEnvironment('feat/no-default');


      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test fallback to claude-code-builtin',
        branch: 'feat/no-default',
        // agentId is intentionally omitted
      }, nextId++);

      // Success proves claude-code-builtin was used (the only registered agent)
      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { sessionId: string };
      expect(data.sessionId).toBeDefined();
    });

    it('should use explicit agentId even when repository has defaultAgentId', async () => {
      const repoDefault = await agentManager.registerAgent({
        name: 'Repo Default Agent',
        commandTemplate: 'repo-default-agent {{prompt}}',
      });
      const explicitAgent = await agentManager.registerAgent({
        name: 'Explicit Agent',
        commandTemplate: 'explicit-agent {{prompt}}',
      });

      await setupDelegateEnvironment('feat/explicit-override', {
        defaultAgentId: repoDefault.id,
      });


      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test explicit agentId overrides repo default',
        branch: 'feat/explicit-override',
        agentId: explicitAgent.id,
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      expect(findSpawnCallByCommand('explicit-agent')).toBeDefined();
      expect(findSpawnCallByCommand('repo-default-agent')).toBeUndefined();
    });

    it('should return error when repository defaultAgentId references a deleted agent', async () => {
      // Register an agent, then set it as the repository default
      const tempAgent = await agentManager.registerAgent({
        name: 'Soon Deleted Agent',
        commandTemplate: 'soon-deleted {{prompt}}',
      });

      await setupDelegateEnvironment('feat/deleted-default', {
        defaultAgentId: tempAgent.id,
      });

      // Delete the agent. The DB cascades ON DELETE SET NULL for default_agent_id,
      // but RepositoryManager's in-memory cache still holds the stale defaultAgentId.
      await agentManager.unregisterAgent(tempAgent.id);

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test deleted default agent',
        branch: 'feat/deleted-default',
        // agentId is intentionally omitted so the stale defaultAgentId is used
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Agent not found');
    });

    // -----------------------------------------------------------------------
    // Agent name resolution (agentName parameter)
    // -----------------------------------------------------------------------

    it('should resolve agentName to agentId', async () => {
      await agentManager.registerAgent({
        name: 'My Custom Agent',
        commandTemplate: 'my-custom-agent {{prompt}}',
      });

      await setupDelegateEnvironment('feat/agent-name-test');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test agentName resolution',
        branch: 'feat/agent-name-test',
        agentName: 'My Custom Agent',
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      expect(findSpawnCallByCommand('my-custom-agent')).toBeDefined();
    });

    it('should return error when agentName matches no agent', async () => {
      await setupDelegateEnvironment('feat/no-match');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test non-existent agentName',
        branch: 'feat/no-match',
        agentName: 'Non-Existent Agent',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('No agent found with name: Non-Existent Agent');
    });

    it('should return error when agentName matches multiple agents', async () => {
      await agentManager.registerAgent({
        name: 'Ambiguous Agent',
        commandTemplate: 'ambiguous-1 {{prompt}}',
      });
      await agentManager.registerAgent({
        name: 'Ambiguous Agent',
        commandTemplate: 'ambiguous-2 {{prompt}}',
      });

      await setupDelegateEnvironment('feat/ambiguous');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test ambiguous agentName',
        branch: 'feat/ambiguous',
        agentName: 'Ambiguous Agent',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Multiple agents match name "Ambiguous Agent"');
      expect(data.error).toContain('Use agentId to specify');
    });

    it('should use agentId when both agentId and agentName are provided', async () => {
      const agentById = await agentManager.registerAgent({
        name: 'Agent By Id',
        commandTemplate: 'agent-by-id {{prompt}}',
      });
      await agentManager.registerAgent({
        name: 'Agent By Name',
        commandTemplate: 'agent-by-name {{prompt}}',
      });

      await setupDelegateEnvironment('feat/both-params');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test agentId takes precedence over agentName',
        branch: 'feat/both-params',
        agentId: agentById.id,
        agentName: 'Agent By Name',
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      expect(findSpawnCallByCommand('agent-by-id')).toBeDefined();
      expect(findSpawnCallByCommand('agent-by-name')).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // Message callback prompt (parentSessionId / parentWorkerId)
    // -----------------------------------------------------------------------

    /**
     * Extract the __AGENT_PROMPT__ env var from the PTY spawn call
     * that matches the given session ID.
     */
    function getAgentPromptForSession(sessionId: string): string {
      const calls = ptyFactory.spawn.mock.calls as unknown as Array<[string, string[], PtySpawnOptions]>;
      const matchingCall = calls.find((call) =>
        call[2]?.env?.AGENT_CONSOLE_SESSION_ID === sessionId,
      );
      expect(matchingCall).toBeDefined();
      const agentPrompt = matchingCall![2].env!.__AGENT_PROMPT__;
      expect(agentPrompt).toBeDefined();
      return agentPrompt!;
    }

    it('should append callback instructions to prompt when parent IDs are provided', async () => {
      await setupDelegateEnvironment('feat/callback-test');


      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Implement callback feature',
        branch: 'feat/callback-test',
        parentSessionId: 'caller-session-123',
        parentWorkerId: 'caller-worker-456',
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { sessionId: string };
      const agentPrompt = getAgentPromptForSession(data.sessionId);

      // Should contain both the original prompt and callback instructions
      expect(agentPrompt).toContain('Implement callback feature');
      expect(agentPrompt).toContain('toSessionId: "caller-session-123"');
      expect(agentPrompt).toContain('toWorkerId: "caller-worker-456"');
      expect(agentPrompt).toContain('[Message Callback Instructions]');

      // Verify structure includes separator and all required fields
      expect(agentPrompt).toContain('\n---\n');
      expect(agentPrompt).toContain('Task completion');
      expect(agentPrompt).toContain('send_session_message');
      expect(agentPrompt).toContain('fromSessionId: Use your AGENT_CONSOLE_SESSION_ID environment variable');
      expect(agentPrompt).toContain('You have a parent session');

      // Verify PR merge notification instructions
      expect(agentPrompt).toContain('PR merged');
      expect(agentPrompt).toContain('[inbound:pr:merged]');

      // Verify consultation instructions
      expect(agentPrompt).toContain('Questions or concerns');
      expect(agentPrompt).toContain('wait for a response');

      // Verify numbered list structure
      expect(agentPrompt).toMatch(/1\.\s+\*\*Task completion\*\*/);
      expect(agentPrompt).toMatch(/2\.\s+\*\*PR merged\*\*/);
      expect(agentPrompt).toMatch(/3\.\s+\*\*Questions or concerns\*\*/);

      // Verify section order: PR merged instructions come before wait-for-response instruction
      const prMergedIndex = agentPrompt.indexOf('[inbound:pr:merged]');
      const waitForResponseIndex = agentPrompt.indexOf('wait for a response');
      expect(prMergedIndex).toBeGreaterThan(-1);
      expect(waitForResponseIndex).toBeGreaterThan(-1);
      expect(prMergedIndex).toBeLessThan(waitForResponseIndex);

      // Verify the old monolithic prompt text is replaced (not present alongside new structure)
      // The old single-paragraph text directed the agent "to the requesting session" — the new
      // three-section structure uses "report your results back." without that suffix.
      expect(agentPrompt).not.toContain('you MUST report your results back to the requesting session');
    });

    it('should NOT append callback instructions when skipMessageCallbackPrompt is true', async () => {
      await setupDelegateEnvironment('feat/skip-callback');


      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Implement feature without callback',
        branch: 'feat/skip-callback',
        parentSessionId: 'caller-session-123',
        parentWorkerId: 'caller-worker-456',
        skipMessageCallbackPrompt: true,
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { sessionId: string };
      const agentPrompt = getAgentPromptForSession(data.sessionId);

      expect(agentPrompt).toContain('Implement feature without callback');
      expect(agentPrompt).not.toContain('[Message Callback Instructions]');
      expect(agentPrompt).not.toContain('toSessionId');
      expect(agentPrompt).not.toContain('toWorkerId');
    });

    it('should return validation error when only parentSessionId is provided', async () => {
      await setupDelegateEnvironment('feat/partial-caller');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test partial parent IDs',
        branch: 'feat/partial-caller',
        parentSessionId: 'caller-session-123',
        // parentWorkerId is intentionally omitted
      }, nextId++);

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('parentSessionId and parentWorkerId must be provided together');
    });

    it('should return validation error when only parentWorkerId is provided', async () => {
      await setupDelegateEnvironment('feat/partial-worker');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test partial parent IDs',
        branch: 'feat/partial-worker',
        // parentSessionId is intentionally omitted
        parentWorkerId: 'caller-worker-456',
      }, nextId++);

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('parentSessionId and parentWorkerId must be provided together');
    });

    it('should NOT include callback instructions when parent IDs are not provided', async () => {
      await setupDelegateEnvironment('feat/no-caller');


      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Normal delegation without caller IDs',
        branch: 'feat/no-caller',
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { sessionId: string };
      const agentPrompt = getAgentPromptForSession(data.sessionId);

      expect(agentPrompt).toContain('Normal delegation without caller IDs');
      expect(agentPrompt).not.toContain('[Message Callback Instructions]');
      expect(agentPrompt).not.toContain('toSessionId');
      expect(agentPrompt).not.toContain('toWorkerId');
    });

    it('should inherit createdBy from parent session', async () => {
      await setupDelegateEnvironment('feat/inherit-created-by');


      // Create a parent session with a known createdBy
      const parentSession = await sessionManager.createSession({
        type: 'quick',
        locationPath: TEST_REPO_PATH,
      }, { createdBy: 'parent-user-abc' });

      // Delegate with parentSessionId referencing the parent
      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test createdBy inheritance',
        branch: 'feat/inherit-created-by',
        parentSessionId: parentSession.id,
        parentWorkerId: 'dummy-worker-id',
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { sessionId: string };

      // Verify the child session inherited createdBy from the parent
      const childSession = sessionManager.getSession(data.sessionId);
      expect(childSession).toBeDefined();
      expect(childSession!.createdBy).toBe('parent-user-abc');
    });

    it('should accept optional templateVars parameter and create session successfully', async () => {
      await setupDelegateEnvironment('feat/template-vars');

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test with template variables',
        branch: 'feat/template-vars',
        templateVars: { model: 'gpt-4' },
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as {
        sessionId: string;
        workerId: string;
        worktreePath: string;
        branch: string;
      };

      // Verify result contains all expected fields
      expect(data.sessionId).toBeDefined();
      expect(data.sessionId.length).toBeGreaterThan(0);
      expect(data.workerId).toBeDefined();
      expect(data.worktreePath).toBeDefined();
      expect(data.branch).toBe('feat/template-vars');

      // Verify the session exists via list_sessions
      const listResponse = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      const listData = parseToolResult(listResponse) as {
        sessions: Array<{
          id: string;
          type: string;
        }>;
      };

      const delegatedSession = listData.sessions.find((s) => s.id === data.sessionId);
      expect(delegatedSession).toBeDefined();
    });
  });

  // ===========================================================================
  // Parent session metadata persistence through MCP
  // ===========================================================================

  describe('parent session metadata persistence', () => {
    /**
     * Reuse the delegate environment setup from the delegate_to_worktree block.
     */
    async function setupParentMetadataEnvironment(
      worktreeBranch: string = 'feat/parent-meta-test',
    ): Promise<void> {
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      mockGit.getRemoteUrl.mockImplementation(async () => 'git@github.com:owner/repo.git');
      mockGit.getDefaultBranch.mockImplementation(async () => 'main');

      let capturedWorktreePath = '';
      mockGit.createWorktree.mockImplementation(async (...args: unknown[]) => {
        capturedWorktreePath = args[0] as string;
      });

      mockGit.listWorktrees.mockImplementation(async () => {
        if (capturedWorktreePath) {
          return `worktree ${TEST_REPO_PATH}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${capturedWorktreePath}\nHEAD def456\nbranch refs/heads/${worktreeBranch}\n`;
        }
        return `worktree ${TEST_REPO_PATH}\nHEAD abc123\nbranch refs/heads/main\n`;
      });

      const db = getDatabase();
      const sqliteRepoRepo = new SqliteRepositoryRepository(db);
      await sqliteRepoRepo.save({
        id: 'test-repo',
        name: 'test',
        path: TEST_REPO_PATH,
        createdAt: new Date().toISOString(),
      });
      repositoryManager = await RepositoryManager.create({
        jobQueue: testJobQueue,
        repository: sqliteRepoRepo,
      });
      await remountMcpApp();
    }

    it('should persist parentSessionId and parentWorkerId when delegate_to_worktree is called with them', async () => {
      await setupParentMetadataEnvironment('feat/persist-parent');


      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test parent metadata persistence',
        branch: 'feat/persist-parent',
        parentSessionId: 'parent-sess-abc',
        parentWorkerId: 'parent-wkr-xyz',
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { sessionId: string };

      // Verify via get_session_status that parentSessionId/parentWorkerId are returned
      const statusResponse = await callTool(app, mcpSessionId, 'get_session_status', {
        sessionId: data.sessionId,
      }, nextId++);
      const statusData = parseToolResult(statusResponse) as {
        parentSessionId?: string;
        parentWorkerId?: string;
      };

      expect(statusData.parentSessionId).toBe('parent-sess-abc');
      expect(statusData.parentWorkerId).toBe('parent-wkr-xyz');
    });

    it('should return parentSessionId and parentWorkerId in list_sessions response', async () => {
      await setupParentMetadataEnvironment('feat/list-parent');


      const delegateResponse = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test parent metadata in list_sessions',
        branch: 'feat/list-parent',
        parentSessionId: 'parent-sess-list',
        parentWorkerId: 'parent-wkr-list',
      }, nextId++);

      expect(delegateResponse.result?.isError).toBeUndefined();

      const delegateData = parseToolResult(delegateResponse) as { sessionId: string };

      // Verify via list_sessions that parentSessionId/parentWorkerId appear
      const listResponse = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);
      const listData = parseToolResult(listResponse) as {
        sessions: Array<{
          id: string;
          parentSessionId?: string;
          parentWorkerId?: string;
        }>;
      };

      const delegatedSession = listData.sessions.find((s) => s.id === delegateData.sessionId);
      expect(delegatedSession).toBeDefined();
      expect(delegatedSession!.parentSessionId).toBe('parent-sess-list');
      expect(delegatedSession!.parentWorkerId).toBe('parent-wkr-list');
    });

    it('should not include parentSessionId/parentWorkerId when not provided', async () => {
      await setupParentMetadataEnvironment('feat/no-parent-meta');


      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Delegate without parent metadata',
        branch: 'feat/no-parent-meta',
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as { sessionId: string };

      const statusResponse = await callTool(app, mcpSessionId, 'get_session_status', {
        sessionId: data.sessionId,
      }, nextId++);
      const statusData = parseToolResult(statusResponse) as {
        parentSessionId?: string;
        parentWorkerId?: string;
      };

      expect(statusData.parentSessionId).toBeUndefined();
      expect(statusData.parentWorkerId).toBeUndefined();
    });
  });

  // ===========================================================================
  // E2E env var injection via delegate_to_worktree
  // ===========================================================================

  describe('delegate_to_worktree env var injection', () => {
    /**
     * Helper to set up the delegate environment for env var tests.
     * Same pattern as the delegate_to_worktree describe block above.
     */
    async function setupDelegateEnvironmentForEnv(): Promise<void> {
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      mockGit.getRemoteUrl.mockImplementation(async () => 'git@github.com:owner/repo.git');
      mockGit.getDefaultBranch.mockImplementation(async () => 'main');

      let capturedWorktreePath = '';
      mockGit.createWorktree.mockImplementation(async (...args: unknown[]) => {
        capturedWorktreePath = args[0] as string;
      });

      mockGit.listWorktrees.mockImplementation(async () => {
        if (capturedWorktreePath) {
          return `worktree ${TEST_REPO_PATH}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${capturedWorktreePath}\nHEAD def456\nbranch refs/heads/feat/env-test\n`;
        }
        return `worktree ${TEST_REPO_PATH}\nHEAD abc123\nbranch refs/heads/main\n`;
      });

      const db = getDatabase();
      const sqliteRepoRepo = new SqliteRepositoryRepository(db);
      await sqliteRepoRepo.save({
        id: 'test-repo',
        name: 'test',
        path: TEST_REPO_PATH,
        createdAt: new Date().toISOString(),
      });
      repositoryManager = await RepositoryManager.create({
        jobQueue: testJobQueue,
        repository: sqliteRepoRepo,
      });
      await remountMcpApp();
    }

    it('should spawn agent worker PTY with AGENT_CONSOLE env vars', async () => {
      await setupDelegateEnvironmentForEnv();


      // Record how many PTY instances existed before this call
      const ptyCountBefore = ptyFactory.instances.length;

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test env var injection',
        branch: 'feat/env-test',
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      const data = parseToolResult(response) as {
        sessionId: string;
        workerId: string;
      };

      // The delegate_to_worktree creates a session which spawns an agent worker PTY.
      // createSession also creates a git-diff worker, but that doesn't spawn a PTY.
      // So we should have at least one new PTY instance.
      expect(ptyFactory.instances.length).toBeGreaterThan(ptyCountBefore);

      // Find the PTY spawn call for the agent worker (the last one created by delegate)
      // The spawn calls include the env in the options parameter
      const calls = ptyFactory.spawn.mock.calls as unknown as Array<[string, string[], PtySpawnOptions]>;

      // Find the spawn call that includes AGENT_CONSOLE_SESSION_ID matching our session
      const matchingCall = calls.find((call) =>
        call[2]?.env?.AGENT_CONSOLE_SESSION_ID === data.sessionId,
      );
      expect(matchingCall).toBeDefined();

      const env = matchingCall![2].env!;
      expect(env.AGENT_CONSOLE_REPOSITORY_ID).toBe('test-repo');
      expect(env.AGENT_CONSOLE_BASE_URL).toMatch(/^http:\/\/localhost:\d+$/);
      expect(env.AGENT_CONSOLE_SESSION_ID).toBe(data.sessionId);
      expect(env.AGENT_CONSOLE_WORKER_ID).toBe(data.workerId);
    });
  });

  // ===========================================================================
  // close_session
  // ===========================================================================

  describe('close_session', () => {
    it('should close an existing session', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'close_session', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as { sessionId: string; deleted: boolean };

      expect(response.result?.isError).toBeUndefined();
      expect(data.sessionId).toBe(session.id);
      expect(data.deleted).toBe(true);

      // Verify session is actually gone
      expect(sessionManager.getSession(session.id)).toBeUndefined();
    });

    it('should return error for non-existent session', async () => {
      const response = await callTool(app, mcpSessionId, 'close_session', {
        sessionId: 'non-existent',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Session not found');
    });
  });

  // ===========================================================================
  // remove_worktree
  // ===========================================================================

  describe('remove_worktree', () => {
    // Paths under the repositories dir (TEST_CONFIG_DIR/repositories/) so
    // validateWorktreePath's boundary check passes.
    const REPOS_DIR = `${TEST_CONFIG_DIR}/repositories`;
    const WT_REPO_PATH = `${REPOS_DIR}/test-repo`;
    const WT_WORKTREE_PATH = `${REPOS_DIR}/test-repo/worktrees/wt-1`;

    /**
     * Helper to set up a RepositoryManager with a test repository,
     * insert worktree records for path validation, and re-mount the MCP app.
     */
    async function setupForDeletion(opts: {
      repoId?: string;
      repoPath?: string;
      worktreePaths?: string[];
    } = {}): Promise<void> {
      const repoId = opts.repoId ?? 'test-repo';
      const repoPath = opts.repoPath ?? WT_REPO_PATH;
      const worktreePaths = opts.worktreePaths ?? [WT_WORKTREE_PATH];

      // Ensure repo paths exist in memfs
      const fsEntries: Record<string, string> = {
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${repoPath}/.git/HEAD`]: 'ref: refs/heads/main',
      };
      setupMemfs(fsEntries);
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      const db = getDatabase();

      // Register repository. Name uses slug-safe characters only (no spaces)
      // because SessionManager uses the name as the data-scope slug.
      const sqliteRepoRepo = new SqliteRepositoryRepository(db);
      await sqliteRepoRepo.save({
        id: repoId,
        name: 'test-repo',
        path: repoPath,
        createdAt: new Date().toISOString(),
      });
      repositoryManager = await RepositoryManager.create({
        jobQueue: testJobQueue,
        repository: sqliteRepoRepo,
      });

      // Insert worktree records so isWorktreeOf returns true
      const worktreeRepo = new SqliteWorktreeRepository(db);
      for (let i = 0; i < worktreePaths.length; i++) {
        await worktreeRepo.save({
          id: `wt-${i}`,
          repositoryId: repoId,
          path: worktreePaths[i],
          indexNumber: i + 1,
          createdAt: new Date().toISOString(),
        });
      }

      // No callback wiring needed — SessionManager was constructed with
      // repositoryLookup/repositoryEnvLookup that route through
      // repositoryManager for slug/name/path.
      await remountMcpApp();
    }

    it('should return error for non-existent session', async () => {
      const response = await callTool(app, mcpSessionId, 'remove_worktree', {
        sessionId: 'non-existent',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Session not found');
    });

    it('should return error for non-worktree session', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'remove_worktree', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('not a worktree session');
    });

    it('should return error when repository is not found', async () => {
      // After Stage 2 of session-data-path refactor, worktree session creation
      // fails fast with RepositoryNotFoundError if the repository is unknown.
      // See docs/design/session-data-path.md §6.
      await expect(
        sessionManager.createSession({
          type: 'worktree',
          locationPath: WT_WORKTREE_PATH,
          repositoryId: 'non-existent-repo',
          worktreeId: 'feature-branch',
          agentId: 'claude-code',
        }),
      ).rejects.toThrow('Repository not found');
    });

    it('should return error for main worktree session', async () => {
      await setupForDeletion();

      // locationPath === repo.path makes isMainWorktree true
      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: WT_REPO_PATH,
        repositoryId: 'test-repo',
        worktreeId: 'main',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'remove_worktree', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Cannot remove the main worktree');
    });

    it('should return error when deletion is already in progress', async () => {
      await setupForDeletion();

      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: WT_WORKTREE_PATH,
        repositoryId: 'test-repo',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      _getDeletionsInProgress().add(WT_WORKTREE_PATH);

      const response = await callTool(app, mcpSessionId, 'remove_worktree', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('already in progress');

      _getDeletionsInProgress().delete(WT_WORKTREE_PATH);
    });

    it('should successfully remove worktree and delete session', async () => {
      await setupForDeletion();

      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: WT_WORKTREE_PATH,
        repositoryId: 'test-repo',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      mockGit.removeWorktree.mockImplementation(async () => {});

      const response = await callTool(app, mcpSessionId, 'remove_worktree', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as {
        sessionId: string;
        worktreePath: string;
        removed: boolean;
      };

      expect(response.result?.isError).toBeUndefined();
      expect(data.sessionId).toBe(session.id);
      expect(data.worktreePath).toBe(WT_WORKTREE_PATH);
      expect(data.removed).toBe(true);

      // Session should be deleted by deleteWorktree
      expect(sessionManager.getSession(session.id)).toBeUndefined();
    });

    it('should preserve session when worktree removal fails', async () => {
      await setupForDeletion();

      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: WT_WORKTREE_PATH,
        repositoryId: 'test-repo',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      mockGit.removeWorktree.mockImplementation(async () => {
        throw new Error('Worktree has uncommitted changes');
      });

      const response = await callTool(app, mcpSessionId, 'remove_worktree', {
        sessionId: session.id,
      }, nextId++);

      expect(response.result?.isError).toBe(true);

      // Session should be preserved for retry
      expect(sessionManager.getSession(session.id)).toBeDefined();
    });

    it('should block deletion when branch has an open PR', async () => {
      await setupForDeletion();

      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: WT_WORKTREE_PATH,
        repositoryId: 'test-repo',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      mockFindOpenPullRequest.mockImplementation(async () => ({
        number: 123,
        title: 'Add new feature',
      }));

      const response = await callTool(app, mcpSessionId, 'remove_worktree', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('WARNING: Cannot remove worktree.');
      expect(data.error).toContain('open PR #123');
      expect(data.error).toContain('Merge or close the PR first, then retry.');

      // Session should be preserved
      expect(sessionManager.getSession(session.id)).toBeDefined();
    });

    it('should allow deletion with force=true even when branch has an open PR', async () => {
      await setupForDeletion();

      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: WT_WORKTREE_PATH,
        repositoryId: 'test-repo',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      mockFindOpenPullRequest.mockImplementation(async () => ({
        number: 456,
        title: 'Important PR',
      }));

      mockGit.removeWorktree.mockImplementation(async () => {});

      const response = await callTool(app, mcpSessionId, 'remove_worktree', {
        sessionId: session.id,
        force: true,
      }, nextId++);
      const data = parseToolResult(response) as {
        sessionId: string;
        removed: boolean;
      };

      expect(response.result?.isError).toBeUndefined();
      expect(data.removed).toBe(true);
      expect(mockFindOpenPullRequest).not.toHaveBeenCalled();
    });

    it('should block deletion when PR check fails (fail-closed)', async () => {
      await setupForDeletion();

      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: WT_WORKTREE_PATH,
        repositoryId: 'test-repo',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      mockFindOpenPullRequest.mockImplementation(async () => {
        throw new Error('gh: command not found');
      });

      const response = await callTool(app, mcpSessionId, 'remove_worktree', {
        sessionId: session.id,
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Failed to check for open PRs');

      // Session should be preserved
      expect(sessionManager.getSession(session.id)).toBeDefined();
    });
  });

  // ===========================================================================
  // Timer tools (create_timer, list_timers, delete_timer)
  // ===========================================================================

  describe('timer tools', () => {
    // Helper: create a session with an agent worker and return both IDs
    async function createSessionWithWorker(): Promise<{ sessionId: string; workerId: string }> {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;
      return { sessionId: session.id, workerId };
    }

    describe('create_timer', () => {
      it('should create a timer and return timer details', async () => {
        const { sessionId, workerId } = await createSessionWithWorker();

        const response = await callTool(app, mcpSessionId, 'create_timer', {
          sessionId,
          workerId,
          intervalSeconds: 60,
          action: 'Check CI status',
        }, nextId++);

        const data = parseToolResult(response) as {
          timerId: string;
          sessionId: string;
          workerId: string;
          intervalSeconds: number;
          action: string;
        };

        expect(response.result?.isError).toBeUndefined();
        expect(data.timerId).toBeDefined();
        expect(typeof data.timerId).toBe('string');
        expect(data.sessionId).toBe(sessionId);
        expect(data.workerId).toBe(workerId);
        expect(data.intervalSeconds).toBe(60);
        expect(data.action).toBe('Check CI status');
      });

      it('should return error for non-existent session', async () => {
        const response = await callTool(app, mcpSessionId, 'create_timer', {
          sessionId: 'non-existent-session',
          workerId: 'some-worker',
          intervalSeconds: 60,
          action: 'Check CI status',
        }, nextId++);

        const data = parseToolResult(response) as { error: string };

        expect(response.result?.isError).toBe(true);
        expect(data.error).toContain('Session non-existent-session not found');
      });

      it('should return error for non-existent worker', async () => {
        const { sessionId } = await createSessionWithWorker();

        const response = await callTool(app, mcpSessionId, 'create_timer', {
          sessionId,
          workerId: 'non-existent-worker',
          intervalSeconds: 60,
          action: 'Check CI status',
        }, nextId++);

        const data = parseToolResult(response) as { error: string };

        expect(response.result?.isError).toBe(true);
        expect(data.error).toContain('Worker non-existent-worker not found');
      });

      it('should return error when interval is below minimum', async () => {
        const { sessionId, workerId } = await createSessionWithWorker();

        const response = await callTool(app, mcpSessionId, 'create_timer', {
          sessionId,
          workerId,
          intervalSeconds: 5,
          action: 'Too frequent',
        }, nextId++);

        // The zod schema enforces min(10), so this may be caught at validation level
        // or by the TimerManager. Either way it should be an error.
        if (response.error) {
          expect(response.error).toBeDefined();
        } else {
          expect(response.result?.isError).toBe(true);
        }
      });
    });

    describe('list_timers', () => {
      it('should return empty array when no timers exist', async () => {
        const response = await callTool(app, mcpSessionId, 'list_timers', {}, nextId++);
        const data = parseToolResult(response) as { timers: unknown[] };

        expect(response.result?.isError).toBeUndefined();
        expect(data.timers).toEqual([]);
      });

      it('should list created timers', async () => {
        const { sessionId, workerId } = await createSessionWithWorker();

        // Create two timers
        await callTool(app, mcpSessionId, 'create_timer', {
          sessionId, workerId, intervalSeconds: 60, action: 'Action A',
        }, nextId++);
        await callTool(app, mcpSessionId, 'create_timer', {
          sessionId, workerId, intervalSeconds: 120, action: 'Action B',
        }, nextId++);

        const response = await callTool(app, mcpSessionId, 'list_timers', {}, nextId++);
        const data = parseToolResult(response) as {
          timers: Array<{ sessionId: string; action: string }>;
        };

        expect(response.result?.isError).toBeUndefined();
        expect(data.timers).toHaveLength(2);
      });

      it('should filter timers by sessionId', async () => {
        const s1 = await createSessionWithWorker();
        const s2 = await createSessionWithWorker();

        await callTool(app, mcpSessionId, 'create_timer', {
          sessionId: s1.sessionId, workerId: s1.workerId, intervalSeconds: 60, action: 'Session 1 timer',
        }, nextId++);
        await callTool(app, mcpSessionId, 'create_timer', {
          sessionId: s2.sessionId, workerId: s2.workerId, intervalSeconds: 60, action: 'Session 2 timer',
        }, nextId++);

        // Filter by session 1
        const response = await callTool(app, mcpSessionId, 'list_timers', {
          sessionId: s1.sessionId,
        }, nextId++);
        const data = parseToolResult(response) as {
          timers: Array<{ sessionId: string; action: string }>;
        };

        expect(response.result?.isError).toBeUndefined();
        expect(data.timers).toHaveLength(1);
        expect(data.timers[0].sessionId).toBe(s1.sessionId);
        expect(data.timers[0].action).toBe('Session 1 timer');
      });
    });

    describe('delete_timer', () => {
      it('should delete an existing timer', async () => {
        const { sessionId, workerId } = await createSessionWithWorker();

        // Create a timer
        const createResponse = await callTool(app, mcpSessionId, 'create_timer', {
          sessionId, workerId, intervalSeconds: 60, action: 'To be deleted',
        }, nextId++);
        const created = parseToolResult(createResponse) as { timerId: string };

        // Delete it
        const deleteResponse = await callTool(app, mcpSessionId, 'delete_timer', {
          timerId: created.timerId,
        }, nextId++);
        const data = parseToolResult(deleteResponse) as { deleted: boolean };

        expect(deleteResponse.result?.isError).toBeUndefined();
        expect(data.deleted).toBe(true);

        // Verify it no longer appears in list
        const listResponse = await callTool(app, mcpSessionId, 'list_timers', {}, nextId++);
        const listData = parseToolResult(listResponse) as { timers: unknown[] };
        expect(listData.timers).toHaveLength(0);
      });

      it('should return error for non-existent timer', async () => {
        const response = await callTool(app, mcpSessionId, 'delete_timer', {
          timerId: 'non-existent-timer-id',
        }, nextId++);

        const data = parseToolResult(response) as { error: string };

        expect(response.result?.isError).toBe(true);
        expect(data.error).toContain('Timer not found');
      });
    });
  });

  // ===========================================================================
  // Interactive process tools (run_process, write_process_response, kill_process, list_processes)
  // ===========================================================================

  describe('interactive process tools', () => {
    async function createSessionWithWorker(): Promise<{ sessionId: string; workerId: string }> {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;
      return { sessionId: session.id, workerId };
    }

    afterEach(() => {
      interactiveProcessManager.disposeAll();
    });

    describe('run_process', () => {
      it('should start a process and return process details', async () => {
        const { sessionId, workerId } = await createSessionWithWorker();

        const response = await callTool(app, mcpSessionId, 'run_process', {
          command: 'echo hello',
          sessionId,
          workerId,
        }, nextId++);

        const data = parseToolResult(response) as {
          processId: string;
          sessionId: string;
          workerId: string;
          command: string;
        };

        expect(response.result?.isError).toBeUndefined();
        expect(data.processId).toBeDefined();
        expect(typeof data.processId).toBe('string');
        expect(data.sessionId).toBe(sessionId);
        expect(data.workerId).toBe(workerId);
        expect(data.command).toBe('echo hello');
      });

      it('should pass cwd to the spawned process when provided', async () => {
        const { sessionId, workerId } = await createSessionWithWorker();
        const tmpDir = await import('os').then((os) => os.tmpdir());

        const response = await callTool(app, mcpSessionId, 'run_process', {
          command: 'pwd',
          sessionId,
          workerId,
          cwd: tmpDir,
        }, nextId++);

        const data = parseToolResult(response) as {
          processId: string;
          command: string;
        };

        expect(response.result?.isError).toBeUndefined();
        expect(data.processId).toBeDefined();
        expect(data.command).toBe('pwd');
      });

      it('should return error for non-existent session', async () => {
        const response = await callTool(app, mcpSessionId, 'run_process', {
          command: 'echo hello',
          sessionId: 'non-existent-session',
          workerId: 'some-worker',
        }, nextId++);

        const data = parseToolResult(response) as { error: string };

        expect(response.result?.isError).toBe(true);
        expect(data.error).toContain('Session non-existent-session not found');
      });

      it('should return error for non-existent worker', async () => {
        const { sessionId } = await createSessionWithWorker();

        const response = await callTool(app, mcpSessionId, 'run_process', {
          command: 'echo hello',
          sessionId,
          workerId: 'non-existent-worker',
        }, nextId++);

        const data = parseToolResult(response) as { error: string };

        expect(response.result?.isError).toBe(true);
        expect(data.error).toContain('Worker non-existent-worker not found');
      });
    });

    describe('list_processes', () => {
      it('should return empty array when no processes exist', async () => {
        const response = await callTool(app, mcpSessionId, 'list_processes', {}, nextId++);
        const data = parseToolResult(response) as { processes: unknown[] };

        expect(response.result?.isError).toBeUndefined();
        expect(data.processes).toEqual([]);
      });

      it('should list running processes', async () => {
        const { sessionId, workerId } = await createSessionWithWorker();

        await callTool(app, mcpSessionId, 'run_process', {
          command: 'sleep 60',
          sessionId,
          workerId,
        }, nextId++);

        const response = await callTool(app, mcpSessionId, 'list_processes', {}, nextId++);
        const data = parseToolResult(response) as {
          processes: Array<{ sessionId: string; command: string }>;
        };

        expect(response.result?.isError).toBeUndefined();
        expect(data.processes).toHaveLength(1);
        expect(data.processes[0].command).toBe('sleep 60');
      });
    });

    describe('kill_process', () => {
      it('should kill a running process', async () => {
        const { sessionId, workerId } = await createSessionWithWorker();

        const createResponse = await callTool(app, mcpSessionId, 'run_process', {
          command: 'sleep 60',
          sessionId,
          workerId,
        }, nextId++);
        const created = parseToolResult(createResponse) as { processId: string };

        const killResponse = await callTool(app, mcpSessionId, 'kill_process', {
          processId: created.processId,
        }, nextId++);
        const data = parseToolResult(killResponse) as { killed: boolean };

        expect(killResponse.result?.isError).toBeUndefined();
        expect(data.killed).toBe(true);

        // Verify it no longer appears in list as running
        const listResponse = await callTool(app, mcpSessionId, 'list_processes', {}, nextId++);
        const listData = parseToolResult(listResponse) as { processes: unknown[] };
        expect(listData.processes).toHaveLength(0);
      });

      it('should return error for non-existent process', async () => {
        const response = await callTool(app, mcpSessionId, 'kill_process', {
          processId: 'non-existent-process-id',
        }, nextId++);

        const data = parseToolResult(response) as { error: string };

        expect(response.result?.isError).toBe(true);
        expect(data.error).toContain('Process not found');
      });
    });

    describe('write_process_response', () => {
      it('should return error for non-existent process', async () => {
        const response = await callTool(app, mcpSessionId, 'write_process_response', {
          processId: 'non-existent-process-id',
          content: 'hello',
        }, nextId++);

        const data = parseToolResult(response) as { error: string };

        expect(response.result?.isError).toBe(true);
        expect(data.error).toContain('Process not found');
      });
    });
  });

  // ===========================================================================
  // MCP protocol validation
  // ===========================================================================

  describe('MCP protocol validation', () => {
    it('should return error when delegate_to_worktree is called without repositoryId', async () => {
      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        // repositoryId is missing
        prompt: 'Do something',
      }, nextId++);

      // The MCP SDK validates parameters via zod schema and returns a JSON-RPC error
      // when required parameters are missing
      if (response.error) {
        // JSON-RPC level error
        expect(response.error).toBeDefined();
      } else {
        // Or the tool handler catches it and returns isError
        expect(response.result?.isError).toBe(true);
      }
    });

    it('should return error when get_session_status is called without sessionId', async () => {
      const response = await callTool(app, mcpSessionId, 'get_session_status', {
        // sessionId is missing
      }, nextId++);

      // The MCP SDK validates parameters via zod schema
      if (response.error) {
        expect(response.error).toBeDefined();
      } else {
        expect(response.result?.isError).toBe(true);
      }
    });
  });

  // ===========================================================================
  // restart_all_agents
  // ===========================================================================

  describe('restart_all_agents', () => {
    it('should restart all agent workers and return summary', async () => {
      // Create a session with an agent worker
      await sessionManager.createSession({
        type: 'quick',
        locationPath: TEST_REPO_PATH,
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'restart_all_agents', {}, nextId++);
      const data = parseToolResult(response) as { restarted: number; failed: number; results: unknown[] };

      expect(response.result?.isError).toBeUndefined();
      expect(data.restarted).toBe(1);
      expect(data.failed).toBe(0);
      expect(data.results).toHaveLength(1);
    });

    it('should return empty results when no sessions exist', async () => {
      const response = await callTool(app, mcpSessionId, 'restart_all_agents', {}, nextId++);
      const data = parseToolResult(response) as { restarted: number; failed: number; results: unknown[] };

      expect(response.result?.isError).toBeUndefined();
      expect(data.restarted).toBe(0);
      expect(data.failed).toBe(0);
      expect(data.results).toHaveLength(0);
    });
  });
});
