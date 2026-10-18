import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import type { AuthUser } from '@agent-console/shared';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';

import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { JobQueue } from '../../jobs/job-queue.js';
import { registerJobHandlers } from '../../jobs/handlers.js';
import { WorkerOutputFileManager } from '../../lib/worker-output-file.js';
import { SqliteSessionRepository } from '../../repositories/index.js';
import { SqliteRepositoryRepository } from '../../repositories/sqlite-repository-repository.js';
import { SessionManager, type ExecuteHookCommand } from '../../services/session-manager.js';
import { RepositoryManager } from '../../services/repository-manager.js';
import { AgentManager } from '../../services/agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { EmbeddedAgentManager } from '../../services/embedded-agent-manager.js';
import { SqliteEmbeddedAgentRepository } from '../../repositories/sqlite-embedded-agent-repository.js';
import { NotificationManager } from '../../services/notifications/notification-manager.js';
import { SlackHandler } from '../../services/notifications/slack-handler.js';
import { RepositorySlackIntegrationService } from '../../services/notifications/repository-slack-integration-service.js';
import { SingleUserMode } from '../../services/user-mode.js';
import type { UserMode, LoginResult, PtySpawnRequest } from '../../services/user-mode.js';
import type { PtyInstance } from '../../lib/pty-provider.js';
import { setupWebSocketRoutes, notifySessionPaused } from '../routes.js';
import { McpTokenRegistry } from '../../mcp/mcp-auth.js';
import { asWSContext, asUpgradeWebSocket } from './ws-test-helpers.js';
import { asAppContext } from '../../__tests__/test-utils.js';
import { repositoryLookupFromSlug } from '../../__tests__/utils/repository-lookup-mock.js';

const TEST_CONFIG_DIR = '/test/config';

/**
 * Capture the WebSocket handler factory for a given route path.
 * upgradeWebSocket receives a factory function: (c) => { onOpen, onMessage, ... }
 * We capture this factory and call it with a mock context to get the event handlers.
 */
type WebSocketHandlerFactory = (c: { req: { param: (name: string) => string } }) => {
  onOpen: (event: unknown, ws: WSContext) => void;
  onMessage: (event: { data: string | ArrayBuffer }, ws: WSContext) => void;
  onClose: (event: unknown, ws: WSContext) => void;
  onError: (event: Event, ws: WSContext) => void;
};

/**
 * Create a mock WSContext that records sent messages and close calls.
 */
function createMockWs(): WSContext & {
  sentMessages: string[];
  closeCalls: { code?: number; reason?: string }[];
} {
  const sentMessages: string[] = [];
  const closeCalls: { code?: number; reason?: string }[] = [];

  const ws = asWSContext({
    send: (data: string | ArrayBuffer) => {
      sentMessages.push(typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer));
    },
    close: (code?: number, reason?: string) => {
      closeCalls.push({ code, reason });
    },
    readyState: 1, // OPEN
  });
  return Object.assign(ws, { sentMessages, closeCalls });
}

describe('Worker WebSocket connection error codes', () => {
  const ptyFactory = createMockPtyFactory(10000);
  let testJobQueue: JobQueue | null = null;
  let sessionManager: SessionManager;
  let embeddedAgentManager: EmbeddedAgentManager;
  let capturedWorkerHandlerFactory: WebSocketHandlerFactory | null = null;
  // The repository pause command's runner; a test replaces it to hold a pause open.
  let pauseHook: ExecuteHookCommand;

  beforeEach(async () => {
    await closeDatabase();

    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    ptyFactory.reset();
    capturedWorkerHandlerFactory = null;
    pauseHook = mock<ExecuteHookCommand>(async () => ({ success: true }));

    resetProcessMock();
    await initializeDatabase(':memory:');

    testJobQueue = new JobQueue(getDatabase());
    registerJobHandlers(testJobQueue, new WorkerOutputFileManager());
    const sessionRepository = new SqliteSessionRepository(getDatabase());
    const agentManager = await AgentManager.create(new SqliteAgentRepository(getDatabase()));
    embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(getDatabase()));
    const notificationManager = new NotificationManager(new SlackHandler(new RepositorySlackIntegrationService(getDatabase())));
    sessionManager = await SessionManager.create({
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager,
      embeddedAgentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      repositoryLookup: repositoryLookupFromSlug(async () => 'test-repo'),
      repositoryEnvLookup: {
        getRepositoryInfo: () => ({ name: 'test-repo', path: '/test/repo', pauseCommand: 'docker compose stop' }),
        getWorktreeIndexNumber: async () => 0,
      },
      executeHookCommand: (...args) => pauseHook(...args),
    });
    const repositoryRepository = new SqliteRepositoryRepository(getDatabase());
    const repositoryManager = await RepositoryManager.create({ repository: repositoryRepository, jobQueue: testJobQueue });
    const userMode = new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' });

    const appContext = asAppContext({ sessionManager, notificationManager, agentManager, embeddedAgentManager, repositoryManager, userMode });

    // Set up routes with a custom upgradeWebSocket that captures the worker handler factory
    const app = new Hono();
    const upgradeWebSocket = (handlerFactory: WebSocketHandlerFactory) => {
      // The last registered handler will be the worker route (registered after app route)
      capturedWorkerHandlerFactory = handlerFactory;
      return handlerFactory;
    };
    await setupWebSocketRoutes(app, asUpgradeWebSocket(upgradeWebSocket), appContext);
  });

  afterEach(async () => {
    if (testJobQueue) {
      await testJobQueue.stop();
      testJobQueue = null;
    }

    await closeDatabase();
    cleanupMemfs();
  });

  it('should send SESSION_DELETED error code when session does not exist', () => {
    expect(capturedWorkerHandlerFactory).not.toBeNull();

    // Create a mock context with non-existent session ID
    const mockContext = {
      req: {
        param: (name: string) => {
          if (name === 'sessionId') return 'non-existent-session';
          if (name === 'workerId') return 'some-worker';
          return '';
        },
      },
    };

    // Get the WebSocket event handlers
    const handlers = capturedWorkerHandlerFactory!(mockContext);
    const mockWs = createMockWs();

    // Trigger onOpen - session does not exist
    handlers.onOpen({}, mockWs);

    // Verify error message was sent with SESSION_DELETED code
    expect(mockWs.sentMessages.length).toBeGreaterThanOrEqual(1);
    const errorMessage = JSON.parse(mockWs.sentMessages[0]);
    expect(errorMessage.type).toBe('error');
    expect(errorMessage.message).toBe('Session not found');
    expect(errorMessage.code).toBe('SESSION_DELETED');

    // Verify exit message was also sent
    const exitMessage = JSON.parse(mockWs.sentMessages[1]);
    expect(exitMessage.type).toBe('exit');
    expect(exitMessage.exitCode).toBe(1);

    // Verify connection was closed
    expect(mockWs.closeCalls.length).toBe(1);
  });

  it('should send WORKER_NOT_FOUND error code when worker does not exist in session', async () => {
    expect(capturedWorkerHandlerFactory).not.toBeNull();

    // Create a real session
    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code',
    });

    // Create a mock context with valid session but non-existent worker
    const mockContext = {
      req: {
        param: (name: string) => {
          if (name === 'sessionId') return session.id;
          if (name === 'workerId') return 'non-existent-worker';
          return '';
        },
      },
    };

    // Get the WebSocket event handlers
    const handlers = capturedWorkerHandlerFactory!(mockContext);
    const mockWs = createMockWs();

    // Trigger onOpen - session exists but worker does not
    handlers.onOpen({}, mockWs);

    // Verify error message was sent with WORKER_NOT_FOUND code
    expect(mockWs.sentMessages.length).toBeGreaterThanOrEqual(1);
    const errorMessage = JSON.parse(mockWs.sentMessages[0]);
    expect(errorMessage.type).toBe('error');
    expect(errorMessage.message).toBe('Worker not found');
    expect(errorMessage.code).toBe('WORKER_NOT_FOUND');

    // Verify exit message was also sent
    const exitMessage = JSON.parse(mockWs.sentMessages[1]);
    expect(exitMessage.type).toBe('exit');
    expect(exitMessage.exitCode).toBe(1);

    // Verify connection was closed
    expect(mockWs.closeCalls.length).toBe(1);
  });

  it('closes a worker socket opened while the session is pausing with SESSION_PAUSED and does not spawn a PTY', async () => {
    expect(capturedWorkerHandlerFactory).not.toBeNull();

    let resolveHook!: (result: Awaited<ReturnType<ExecuteHookCommand>>) => void;
    const held = mock<ExecuteHookCommand>(
      () =>
        new Promise((resolve) => {
          resolveHook = resolve;
        }),
    );
    pauseHook = held;

    const session = await sessionManager.createSession({
      type: 'worktree',
      locationPath: '/test/path',
      repositoryId: 'repo-1',
      worktreeId: 'feature-branch',
      agentId: 'claude-code',
    });
    const agentWorker = session.workers.find((w) => w.type === 'agent')!;
    const pause = sessionManager.pauseSession(session.id);
    for (let i = 0; i < 400 && held.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(sessionManager.isPausing(session.id)).toBe(true);
    const spawnsBefore = ptyFactory.instances.length;

    const handlers = capturedWorkerHandlerFactory!({
      req: { param: (name: string) => (name === 'sessionId' ? session.id : name === 'workerId' ? agentWorker.id : '') },
    });
    const mockWs = createMockWs();
    handlers.onOpen({}, mockWs);
    for (let i = 0; i < 400 && mockWs.closeCalls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const errorMessage = JSON.parse(mockWs.sentMessages[0]);
    expect(errorMessage).toEqual({ type: 'error', message: 'Session is pausing', code: 'SESSION_PAUSED' });
    expect(mockWs.closeCalls).toEqual([{ code: 1000, reason: 'Session is pausing' }]);
    expect(ptyFactory.instances.length).toBe(spawnsBefore);

    resolveHook({ success: true });
    await pause;
  });

  it('closes an embedded-agent worker socket opened while the session is pausing with SESSION_PAUSED and never activates it', async () => {
    expect(capturedWorkerHandlerFactory).not.toBeNull();

    let resolveHook!: (result: Awaited<ReturnType<ExecuteHookCommand>>) => void;
    const held = mock<ExecuteHookCommand>(
      () =>
        new Promise((resolve) => {
          resolveHook = resolve;
        }),
    );
    pauseHook = held;

    const definition = await embeddedAgentManager.createEmbeddedAgent(
      { engine: 'openai-api', name: 'Local model', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      'test-user-id',
    );
    const session = await sessionManager.createSession({
      type: 'worktree',
      locationPath: '/test/path',
      repositoryId: 'repo-1',
      worktreeId: 'feature-branch',
      agentId: 'claude-code',
    });
    const embeddedWorker = await sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId: definition.id,
    });
    const activate = spyOn(sessionManager, 'activateEmbeddedAgentWorker');
    const restore = spyOn(sessionManager, 'restoreWorker');

    const pause = sessionManager.pauseSession(session.id);
    for (let i = 0; i < 400 && held.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(sessionManager.isPausing(session.id)).toBe(true);

    const handlers = capturedWorkerHandlerFactory!({
      req: { param: (name: string) => (name === 'sessionId' ? session.id : name === 'workerId' ? embeddedWorker!.id : '') },
    });
    const mockWs = createMockWs();
    handlers.onOpen({}, mockWs);
    for (let i = 0; i < 400 && mockWs.closeCalls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const errorMessage = JSON.parse(mockWs.sentMessages[0]);
    expect(errorMessage).toEqual({ type: 'error', message: 'Session is pausing', code: 'SESSION_PAUSED' });
    expect(mockWs.closeCalls).toEqual([{ code: 1000, reason: 'Session is pausing' }]);
    expect(activate).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();

    resolveHook({ success: true });
    await pause;
  });

  it('should send SESSION_PAUSED error code when notifySessionPaused is called', async () => {
    expect(capturedWorkerHandlerFactory).not.toBeNull();

    // Create a real session with a worker
    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code',
    });

    const agentWorker = session.workers.find(w => w.type === 'agent');
    expect(agentWorker).toBeDefined();

    // Open a WebSocket connection for this worker (adds it to the module-level registry)
    const mockContext = {
      req: {
        param: (name: string) => {
          if (name === 'sessionId') return session.id;
          if (name === 'workerId') return agentWorker!.id;
          return '';
        },
      },
    };

    const handlers = capturedWorkerHandlerFactory!(mockContext);
    const mockWs = createMockWs();

    // Trigger onOpen - this registers the connection in the registry
    handlers.onOpen({}, mockWs);

    // Clear any messages sent during onOpen (initial state, etc.)
    mockWs.sentMessages.length = 0;
    mockWs.closeCalls.length = 0;

    // Call notifySessionPaused - this uses the module-level registry
    notifySessionPaused(session.id);

    // Verify error message was sent with SESSION_PAUSED code
    expect(mockWs.sentMessages.length).toBeGreaterThanOrEqual(2);
    const errorMessage = JSON.parse(mockWs.sentMessages[0]);
    expect(errorMessage.type).toBe('error');
    expect(errorMessage.message).toBe('Session has been paused');
    expect(errorMessage.code).toBe('SESSION_PAUSED');

    // Verify exit message was sent with exitCode 0 (intentional pause)
    const exitMessage = JSON.parse(mockWs.sentMessages[1]);
    expect(exitMessage.type).toBe('exit');
    expect(exitMessage.exitCode).toBe(0);

    // Verify connection was closed
    expect(mockWs.closeCalls.length).toBe(1);
  });
});

// =========================================================================
// C4: WebSocket auth rejection tests
// =========================================================================

describe('WebSocket authentication rejection (C4)', () => {
  const ptyFactory = createMockPtyFactory(20000);
  let testJobQueue: JobQueue | null = null;
  let app: InstanceType<typeof Hono>;

  /**
   * A UserMode that always rejects authentication.
   * Used to test that unauthenticated WebSocket connections are rejected
   * at the HTTP level (401) before the WebSocket upgrade.
   */
  class RejectingUserMode implements UserMode {
    authenticate(_resolveToken: () => string | undefined): AuthUser | null {
      return null;
    }
    async login(_username: string, _password: string): Promise<LoginResult | null> {
      return null;
    }
    spawnPty(_request: PtySpawnRequest): PtyInstance {
      throw new Error('Should not be called in auth rejection tests');
    }
  }

  beforeEach(async () => {
    await closeDatabase();

    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    ptyFactory.reset();

    resetProcessMock();
    await initializeDatabase(':memory:');

    testJobQueue = new JobQueue(getDatabase());
    registerJobHandlers(testJobQueue, new WorkerOutputFileManager());
    const sessionRepository = new SqliteSessionRepository(getDatabase());
    const agentManager = await AgentManager.create(new SqliteAgentRepository(getDatabase()));
    const embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(getDatabase()));
    const notificationManager = new NotificationManager(new SlackHandler(new RepositorySlackIntegrationService(getDatabase())));
    const sessionManager = await SessionManager.create({
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager,
      embeddedAgentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      repositoryLookup: repositoryLookupFromSlug(async () => 'test-repo'),
      repositoryEnvLookup: {
        getRepositoryInfo: () => ({ name: 'test-repo', path: '/test/repo' }),
        getWorktreeIndexNumber: async () => 0,
      },
    });
    const repositoryRepository = new SqliteRepositoryRepository(getDatabase());
    const repositoryManager = await RepositoryManager.create({ repository: repositoryRepository, jobQueue: testJobQueue });

    // Use a UserMode that always rejects authentication
    const userMode = new RejectingUserMode();

    const appContext = asAppContext({ sessionManager, notificationManager, agentManager, embeddedAgentManager, repositoryManager, userMode });

    // Set up routes with a mock upgradeWebSocket
    app = new Hono();
    const upgradeWebSocket = (handlerFactory: WebSocketHandlerFactory) => {
      return handlerFactory;
    };
    await setupWebSocketRoutes(app, asUpgradeWebSocket(upgradeWebSocket), appContext);
  });

  afterEach(async () => {
    if (testJobQueue) {
      await testJobQueue.stop();
      testJobQueue = null;
    }

    await closeDatabase();
    cleanupMemfs();
  });

  it('should reject unauthenticated /ws/app connection with 401 at HTTP level', async () => {
    const response = await app.request('/ws/app');

    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Authentication required');
  });

  it('should reject unauthenticated /ws/session/:id/worker/:id connection with 401 at HTTP level', async () => {
    const response = await app.request('/ws/session/some-session/worker/some-worker');

    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Authentication required');
  });
});
