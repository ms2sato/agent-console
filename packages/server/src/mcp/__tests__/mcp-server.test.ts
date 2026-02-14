import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { mockGit, resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import { initializeDatabase, closeDatabase } from '../../database/connection.js';
import { initializeJobQueue, resetJobQueue } from '../../jobs/index.js';
import {
  resetSessionManager,
  SessionManager,
  setSessionManager,
} from '../../services/session-manager.js';
import {
  resetRepositoryManager,
  setRepositoryManager,
  RepositoryManager,
} from '../../services/repository-manager.js';
import { getAgentManager, resetAgentManager } from '../../services/agent-manager.js';
import { JsonSessionRepository } from '../../repositories/index.js';
import { SqliteRepositoryRepository } from '../../repositories/sqlite-repository-repository.js';
import type { PtySpawnOptions } from '../../lib/pty-provider.js';
import { mcpApp } from '../mcp-server.js';

// Mock session-metadata-suggester to avoid spawning real agent processes.
// Must be set up before mcpApp is imported (already satisfied above due to hoisting).
const mockSuggestSessionMetadata = mock(async () => ({
  branch: 'feat/auto-generated-branch',
  title: 'Auto-Generated Title',
}));
mock.module('../../services/session-metadata-suggester.js', () => ({
  suggestSessionMetadata: mockSuggestSessionMetadata,
}));

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
  let mcpSessionId: string;
  // Track unique IDs for tool calls to avoid collisions in the shared transport
  let nextId: number;

  beforeEach(async () => {
    // Reset singletons
    resetSessionManager();
    resetRepositoryManager();
    resetAgentManager();
    await resetJobQueue();
    await closeDatabase();

    // Setup memfs with config directory structure
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    // Initialize in-memory database
    await initializeDatabase(':memory:');

    // Initialize the singleton job queue
    const testJobQueue = initializeJobQueue();

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

    // Create session repository
    const sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);

    // Create SessionManager directly
    sessionManager = await SessionManager.create({
      ptyProvider: ptyFactory.provider,
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
    });
    setSessionManager(sessionManager);

    // Create Hono app and mount MCP routes
    app = new Hono();
    app.route('', mcpApp);

    // Initialize MCP session
    mcpSessionId = await initializeMcp(app);
    nextId = 10;
  });

  afterEach(async () => {
    resetSessionManager();
    resetRepositoryManager();
    resetAgentManager();
    await resetJobQueue();
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
      const agentManager = await getAgentManager();
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
    async function setupRepositoryManager(repos: Array<{
      id: string;
      name: string;
      path: string;
      description?: string | null;
    }> = []): Promise<void> {
      const { getDatabase } = await import('../../database/connection.js');
      const db = getDatabase();
      const sqliteRepoRepo = new SqliteRepositoryRepository(db);
      for (const repo of repos) {
        await sqliteRepoRepo.save({
          ...repo,
          createdAt: new Date().toISOString(),
        });
      }
      const { getJobQueue } = await import('../../jobs/index.js');
      const repoMgr = await RepositoryManager.create({
        jobQueue: getJobQueue(),
        repository: sqliteRepoRepo,
      });
      setRepositoryManager(repoMgr);
    }

    it('should return empty repositories array when no repositories registered', async () => {
      await setupRepositoryManager();
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

      await setupRepositoryManager([{
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

      await setupRepositoryManager([{
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
  // send_message_to_session
  // ===========================================================================

  describe('send_message_to_session', () => {
    it('should return error when session does not exist', async () => {
      const response = await callTool(app, mcpSessionId, 'send_message_to_session', {
        sessionId: 'non-existent',
        workerId: 'worker-1',
        message: 'hello',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Failed to send message');
    });

    it('should return error when worker does not exist', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const response = await callTool(app, mcpSessionId, 'send_message_to_session', {
        sessionId: session.id,
        workerId: 'non-existent-worker',
        message: 'hello',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Failed to send message');
    });

    it('should successfully send message to a worker with active PTY', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Find the agent worker
      const agentWorker = session.workers.find((w) => w.type === 'agent');
      expect(agentWorker).toBeDefined();

      const response = await callTool(app, mcpSessionId, 'send_message_to_session', {
        sessionId: session.id,
        workerId: agentWorker!.id,
        message: 'Do the task',
      }, nextId++);
      const data = parseToolResult(response) as { success: boolean };

      expect(response.result?.isError).toBeUndefined();
      expect(data.success).toBe(true);

      // Verify the PTY received the message
      const mockPty = ptyFactory.instances[0];
      expect(mockPty).toBeDefined();
      // The message content should appear in the written data
      expect(mockPty.writtenData.some((d) => d.includes('Do the task'))).toBe(true);
    });

    it('should write the exact message content to the PTY', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const agentWorker = session.workers.find((w) => w.type === 'agent');
      expect(agentWorker).toBeDefined();

      const specificMessage = 'Refactor the authentication module to use JWT tokens';

      await callTool(app, mcpSessionId, 'send_message_to_session', {
        sessionId: session.id,
        workerId: agentWorker!.id,
        message: specificMessage,
      }, nextId++);

      const mockPty = ptyFactory.instances[0];
      // Verify that the specific message text was written to PTY
      const allWritten = mockPty.writtenData.join('');
      expect(allWritten).toContain(specificMessage);
    });

    it('should return error when sending empty message', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const agentWorker = session.workers.find((w) => w.type === 'agent');
      expect(agentWorker).toBeDefined();

      const response = await callTool(app, mcpSessionId, 'send_message_to_session', {
        sessionId: session.id,
        workerId: agentWorker!.id,
        message: '',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      // Empty message should fail because sendMessage returns null for empty content
      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Failed to send message');
    });
  });

  // ===========================================================================
  // delegate_to_worktree
  // ===========================================================================

  describe('delegate_to_worktree', () => {
    /**
     * Helper to initialize a RepositoryManager with optional pre-seeded repositories.
     * Repositories must have their paths present in memfs to be loaded.
     */
    async function setupRepositoryManager(repos: Array<{
      id: string;
      name: string;
      path: string;
    }> = []): Promise<void> {
      const { getDatabase } = await import('../../database/connection.js');
      const db = getDatabase();
      const sqliteRepoRepo = new SqliteRepositoryRepository(db);
      for (const repo of repos) {
        await sqliteRepoRepo.save({
          ...repo,
          createdAt: new Date().toISOString(),
        });
      }
      const { getJobQueue } = await import('../../jobs/index.js');
      const repoMgr = await RepositoryManager.create({
        jobQueue: getJobQueue(),
        repository: sqliteRepoRepo,
      });
      setRepositoryManager(repoMgr);
    }

    /**
     * Standard setup for delegate_to_worktree tests that need a working repository.
     * Sets up memfs with repo and config dirs, git mocks, and RepositoryManager.
     *
     * @param worktreeBranch - Branch name that the created worktree will report
     * @returns The worktree path that createWorktree will produce
     */
    async function setupDelegateEnvironment(
      worktreeBranch: string = 'feat/test-branch',
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
      await setupRepositoryManager([{
        id: 'test-repo',
        name: 'test',
        path: TEST_REPO_PATH,
      }]);

      return repoWorktreeDir;
    }

    it('should return error when repository not found', async () => {
      // Initialize RepositoryManager with no repositories
      await setupRepositoryManager();

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

      await setupRepositoryManager([{
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

    it('should handle useRemote flag by calling fetchRemote', async () => {
      await setupDelegateEnvironment('feat/remote-branch');

      // fetchRemote is already mocked by mock-git-helper (resolves successfully)

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Work on remote-based feature',
        branch: 'feat/remote-branch',
        useRemote: true,
      }, nextId++);

      expect(response.result?.isError).toBeUndefined();

      // Verify fetchRemote was called (the baseBranch defaults to 'main')
      expect(mockGit.fetchRemote).toHaveBeenCalledWith('main', TEST_REPO_PATH);
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

      await setupRepositoryManager([{
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

    it('should rollback worktree when created worktree cannot be found in list', async () => {
      // Setup environment with worktree creation succeeding but listWorktrees not returning it
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      mockGit.getRemoteUrl.mockImplementation(async () => 'git@github.com:owner/repo.git');
      mockGit.getDefaultBranch.mockImplementation(async () => 'main');

      // createWorktree succeeds (captures the path) but listWorktrees returns
      // only the main worktree, so the created worktree cannot be found
      mockGit.createWorktree.mockImplementation(async () => {
        // Success - worktree is "created" on disk
      });
      mockGit.listWorktrees.mockImplementation(async () => {
        // Only return the main worktree, not the one just created
        return `worktree ${TEST_REPO_PATH}\nHEAD abc123\nbranch refs/heads/main\n`;
      });

      await setupRepositoryManager([{
        id: 'test-repo',
        name: 'test',
        path: TEST_REPO_PATH,
      }]);

      const response = await callTool(app, mcpSessionId, 'delegate_to_worktree', {
        repositoryId: 'test-repo',
        prompt: 'Test worktree not found in list',
        branch: 'feat/ghost-worktree',
      }, nextId++);
      const data = parseToolResult(response) as { error: string };

      expect(response.result?.isError).toBe(true);
      expect(data.error).toContain('Worktree was created but could not be found in the list');

      // Verify removeWorktree was called for rollback
      expect(mockGit.removeWorktree).toHaveBeenCalled();
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

      const { getDatabase } = await import('../../database/connection.js');
      const db = getDatabase();
      const sqliteRepoRepo = new SqliteRepositoryRepository(db);
      await sqliteRepoRepo.save({
        id: 'test-repo',
        name: 'test',
        path: TEST_REPO_PATH,
        createdAt: new Date().toISOString(),
      });
      const { getJobQueue } = await import('../../jobs/index.js');
      const repoMgr = await RepositoryManager.create({
        jobQueue: getJobQueue(),
        repository: sqliteRepoRepo,
      });
      setRepositoryManager(repoMgr);
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
});
