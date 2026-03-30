import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { AgentManager } from '../agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { WorkerManager } from '../worker-manager.js';
import { SingleUserMode } from '../user-mode.js';
import type { InternalAgentWorker, InternalTerminalWorker } from '../worker-types.js';
import type { PtySpawnOptions } from '../../lib/pty-provider.js';
import { SessionDataPathResolver } from '../../lib/session-data-path-resolver.js';

/**
 * Tests for AgentConsole context environment variable injection.
 *
 * Verifies that agent worker PTY processes receive AGENT_CONSOLE_* env vars
 * for self-awareness and MCP tool integration, while terminal workers do not.
 */
describe('WorkerManager - AgentConsole env var injection', () => {
  const ptyFactory = createMockPtyFactory(20000);
  let workerManager: WorkerManager;

  beforeEach(async () => {
    await closeDatabase();

    setupMemfs({ '/test/config/.keep': '' });
    process.env.AGENT_CONSOLE_HOME = '/test/config';

    // Use in-memory database for test isolation
    await initializeDatabase(':memory:');

    const db = getDatabase();
    const agentManager = await AgentManager.create(new SqliteAgentRepository(db));

    ptyFactory.reset();
    const userMode = new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' });
    workerManager = new WorkerManager(userMode, agentManager);
  });

  afterEach(async () => {
    await closeDatabase();
    cleanupMemfs();
  });

  /**
   * Create a minimal agent worker for testing (pty: null, ready for activation).
   */
  function createTestAgentWorker(id: string = 'worker-1'): InternalAgentWorker {
    return {
      id,
      type: 'agent',
      name: 'Test Agent',
      createdAt: new Date().toISOString(),
      agentId: 'claude-code',
      pty: null,
      outputBuffer: '',
      outputOffset: 0,
      activityState: 'unknown',
      activityDetector: null,
      connectionCallbacks: new Map(),
    };
  }

  /**
   * Create a minimal terminal worker for testing (pty: null, ready for activation).
   */
  function createTestTerminalWorker(id: string = 'terminal-1'): InternalTerminalWorker {
    return {
      id,
      type: 'terminal',
      name: 'Test Terminal',
      createdAt: new Date().toISOString(),
      pty: null,
      outputBuffer: '',
      outputOffset: 0,
      connectionCallbacks: new Map(),
    };
  }

  /**
   * Extract the env object from the most recent PTY spawn call.
   * The mock spawn is called as spawn(command, args, options).
   */
  function getLastSpawnEnv(): Record<string, string> | undefined {
    const calls = ptyFactory.spawn.mock.calls as unknown as Array<[string, string[], PtySpawnOptions]>;
    const lastCall = calls[calls.length - 1];
    return lastCall[2]?.env;
  }

  describe('agent worker PTY processes', () => {
    it('should include AGENT_CONSOLE_BASE_URL with server port', async () => {
      const worker = createTestAgentWorker();

      await workerManager.activateAgentWorkerPty(worker, {
        sessionId: 'session-123',
        locationPath: '/test/path',
        repositoryEnvVars: {},
        username: 'testuser',
        resolver: new SessionDataPathResolver(),
        agentId: 'claude-code',
        continueConversation: false,
      });

      const env = getLastSpawnEnv();
      expect(env).toBeDefined();
      // serverConfig.PORT defaults to process.env.PORT || '3457'
      expect(env!.AGENT_CONSOLE_BASE_URL).toMatch(/^http:\/\/localhost:\d+$/);
    });

    it('should include AGENT_CONSOLE_SESSION_ID', async () => {
      const worker = createTestAgentWorker();

      await workerManager.activateAgentWorkerPty(worker, {
        sessionId: 'session-abc-123',
        locationPath: '/test/path',
        repositoryEnvVars: {},
        username: 'testuser',
        resolver: new SessionDataPathResolver(),
        agentId: 'claude-code',
        continueConversation: false,
      });

      const env = getLastSpawnEnv();
      expect(env!.AGENT_CONSOLE_SESSION_ID).toBe('session-abc-123');
    });

    it('should include AGENT_CONSOLE_WORKER_ID matching the worker id', async () => {
      const worker = createTestAgentWorker('worker-xyz-789');

      await workerManager.activateAgentWorkerPty(worker, {
        sessionId: 'session-123',
        locationPath: '/test/path',
        repositoryEnvVars: {},
        username: 'testuser',
        resolver: new SessionDataPathResolver(),
        agentId: 'claude-code',
        continueConversation: false,
      });

      const env = getLastSpawnEnv();
      expect(env!.AGENT_CONSOLE_WORKER_ID).toBe('worker-xyz-789');
    });

    it('should include AGENT_CONSOLE_REPOSITORY_ID for worktree sessions', async () => {
      const worker = createTestAgentWorker();

      await workerManager.activateAgentWorkerPty(worker, {
        sessionId: 'session-123',
        locationPath: '/test/path',
        repositoryEnvVars: {},
        username: 'testuser',
        resolver: new SessionDataPathResolver(),
        agentId: 'claude-code',
        continueConversation: false,
        repositoryId: 'repo-456',
      });

      const env = getLastSpawnEnv();
      expect(env!.AGENT_CONSOLE_REPOSITORY_ID).toBe('repo-456');
    });

    it('should NOT include AGENT_CONSOLE_REPOSITORY_ID for quick sessions', async () => {
      const worker = createTestAgentWorker();

      await workerManager.activateAgentWorkerPty(worker, {
        sessionId: 'session-123',
        locationPath: '/test/path',
        repositoryEnvVars: {},
        username: 'testuser',
        resolver: new SessionDataPathResolver(),
        agentId: 'claude-code',
        continueConversation: false,
        // repositoryId is not provided (quick session)
      });

      const env = getLastSpawnEnv();
      expect(env!.AGENT_CONSOLE_REPOSITORY_ID).toBeUndefined();
    });

    it('should include all four env vars for worktree sessions', async () => {
      const worker = createTestAgentWorker('wkr-all-four');

      await workerManager.activateAgentWorkerPty(worker, {
        sessionId: 'sess-all-four',
        locationPath: '/test/worktree/path',
        repositoryEnvVars: {},
        username: 'testuser',
        resolver: new SessionDataPathResolver(),
        agentId: 'claude-code',
        continueConversation: false,
        repositoryId: 'repo-all-four',
      });

      const env = getLastSpawnEnv();
      expect(env!.AGENT_CONSOLE_BASE_URL).toBeDefined();
      expect(env!.AGENT_CONSOLE_SESSION_ID).toBe('sess-all-four');
      expect(env!.AGENT_CONSOLE_WORKER_ID).toBe('wkr-all-four');
      expect(env!.AGENT_CONSOLE_REPOSITORY_ID).toBe('repo-all-four');
    });

    it('should use the exact port from serverConfig for AGENT_CONSOLE_BASE_URL', async () => {
      const worker = createTestAgentWorker();

      await workerManager.activateAgentWorkerPty(worker, {
        sessionId: 'session-123',
        locationPath: '/test/path',
        repositoryEnvVars: {},
        username: 'testuser',
        resolver: new SessionDataPathResolver(),
        agentId: 'claude-code',
        continueConversation: false,
      });

      const env = getLastSpawnEnv();
      expect(env).toBeDefined();
      // serverConfig.PORT defaults to process.env.PORT || '3457'
      const expectedPort = process.env.PORT || '3457';
      expect(env!.AGENT_CONSOLE_BASE_URL).toBe(`http://localhost:${expectedPort}`);
    });

    it('should include AGENT_CONSOLE_REPOSITORY_ID when repositoryId contains special characters', async () => {
      const worker = createTestAgentWorker();

      await workerManager.activateAgentWorkerPty(worker, {
        sessionId: 'session-123',
        locationPath: '/test/path',
        repositoryEnvVars: {},
        username: 'testuser',
        resolver: new SessionDataPathResolver(),
        agentId: 'claude-code',
        continueConversation: false,
        repositoryId: 'org/repo-name',
      });

      const env = getLastSpawnEnv();
      expect(env!.AGENT_CONSOLE_REPOSITORY_ID).toBe('org/repo-name');
    });

    it('should not overwrite AGENT_CONSOLE vars with repository env vars', async () => {
      const worker = createTestAgentWorker('real-worker');

      await workerManager.activateAgentWorkerPty(worker, {
        sessionId: 'real-session',
        locationPath: '/test/path',
        repositoryEnvVars: {
          // Attempt to override via repository env vars
          AGENT_CONSOLE_BASE_URL: 'http://malicious:9999',
          AGENT_CONSOLE_SESSION_ID: 'spoofed-session',
        },
        username: 'testuser',
        resolver: new SessionDataPathResolver(),
        agentId: 'claude-code',
        continueConversation: false,
        repositoryId: 'repo-1',
      });

      const env = getLastSpawnEnv();
      // AgentConsole env vars are applied after repositoryEnvVars, so they take precedence
      expect(env!.AGENT_CONSOLE_BASE_URL).not.toBe('http://malicious:9999');
      expect(env!.AGENT_CONSOLE_SESSION_ID).toBe('real-session');
      expect(env!.AGENT_CONSOLE_WORKER_ID).toBe('real-worker');
    });
  });

  describe('parent session env vars for agent workers', () => {
    it('should include AGENT_CONSOLE_PARENT_SESSION_ID when parentSessionId is provided', async () => {
      const worker = createTestAgentWorker();

      await workerManager.activateAgentWorkerPty(worker, {
        sessionId: 'session-123',
        locationPath: '/test/path',
        repositoryEnvVars: {},
        username: 'testuser',
        resolver: new SessionDataPathResolver(),
        agentId: 'claude-code',
        continueConversation: false,
        context: { parentSessionId: 'parent-sess-abc' },
      });

      const env = getLastSpawnEnv();
      expect(env!.AGENT_CONSOLE_PARENT_SESSION_ID).toBe('parent-sess-abc');
    });

    it('should include AGENT_CONSOLE_PARENT_WORKER_ID when parentWorkerId is provided', async () => {
      const worker = createTestAgentWorker();

      await workerManager.activateAgentWorkerPty(worker, {
        sessionId: 'session-123',
        locationPath: '/test/path',
        repositoryEnvVars: {},
        username: 'testuser',
        resolver: new SessionDataPathResolver(),
        agentId: 'claude-code',
        continueConversation: false,
        context: { parentWorkerId: 'parent-wkr-xyz' },
      });

      const env = getLastSpawnEnv();
      expect(env!.AGENT_CONSOLE_PARENT_WORKER_ID).toBe('parent-wkr-xyz');
    });

    it('should NOT include parent env vars when context is not provided', async () => {
      const worker = createTestAgentWorker();

      await workerManager.activateAgentWorkerPty(worker, {
        sessionId: 'session-123',
        locationPath: '/test/path',
        repositoryEnvVars: {},
        username: 'testuser',
        resolver: new SessionDataPathResolver(),
        agentId: 'claude-code',
        continueConversation: false,
        // context is intentionally omitted
      });

      const env = getLastSpawnEnv();
      expect(env!.AGENT_CONSOLE_PARENT_SESSION_ID).toBeUndefined();
      expect(env!.AGENT_CONSOLE_PARENT_WORKER_ID).toBeUndefined();
    });

    it('should not allow repository env vars to overwrite parent env vars', async () => {
      const worker = createTestAgentWorker('secure-worker');

      await workerManager.activateAgentWorkerPty(worker, {
        sessionId: 'secure-session',
        locationPath: '/test/path',
        repositoryEnvVars: {
          // Attempt to spoof parent env vars via repository settings
          AGENT_CONSOLE_PARENT_SESSION_ID: 'spoofed-parent-session',
          AGENT_CONSOLE_PARENT_WORKER_ID: 'spoofed-parent-worker',
        },
        username: 'testuser',
        resolver: new SessionDataPathResolver(),
        agentId: 'claude-code',
        continueConversation: false,
        context: {
          parentSessionId: 'real-parent-session',
          parentWorkerId: 'real-parent-worker',
        },
      });

      const env = getLastSpawnEnv();
      // AgentConsole env vars are applied after repositoryEnvVars, so they take precedence
      expect(env!.AGENT_CONSOLE_PARENT_SESSION_ID).toBe('real-parent-session');
      expect(env!.AGENT_CONSOLE_PARENT_WORKER_ID).toBe('real-parent-worker');
    });
  });

  describe('terminal worker PTY processes', () => {
    it('should NOT include any AGENT_CONSOLE env vars', () => {
      const worker = createTestTerminalWorker();

      workerManager.activateTerminalWorkerPty(worker, {
        sessionId: 'session-123',
        locationPath: '/test/path',
        repositoryEnvVars: {},
        username: 'testuser',
        resolver: new SessionDataPathResolver(),
      });

      const env = getLastSpawnEnv();
      expect(env).toBeDefined();
      expect(env!.AGENT_CONSOLE_BASE_URL).toBeUndefined();
      expect(env!.AGENT_CONSOLE_SESSION_ID).toBeUndefined();
      expect(env!.AGENT_CONSOLE_WORKER_ID).toBeUndefined();
      expect(env!.AGENT_CONSOLE_REPOSITORY_ID).toBeUndefined();
    });
  });
});
