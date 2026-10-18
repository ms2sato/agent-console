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
import { serverConfig } from '../../lib/server-config.js';
import { SharedAccountRegistry } from '../../services/shared-account-registry.js';
import { triggerRefresh } from '../../services/git-diff-service.js';
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

  it('accepts a worker WebSocket for a file-viewer worker: no error or exit frame, no close, no PTY; a client frame is answered with UNSUPPORTED_OPERATION and the socket stays open', async () => {
    expect(capturedWorkerHandlerFactory).not.toBeNull();

    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code',
    });
    const viewer = await sessionManager.createWorker(session.id, { type: 'file-viewer' });
    expect(viewer).not.toBeNull();

    const handlers = capturedWorkerHandlerFactory!({
      req: {
        param: (name: string) => {
          if (name === 'sessionId') return session.id;
          if (name === 'workerId') return viewer!.id;
          return '';
        },
      },
    });
    const mockWs = createMockWs();
    const ptyCountBefore = ptyFactory.instances.length;

    handlers.onOpen({}, mockWs);

    expect(mockWs.sentMessages).toEqual([]);
    expect(mockWs.closeCalls).toEqual([]);
    // Nothing was activated or attached on its behalf.
    expect(ptyFactory.instances.length).toBe(ptyCountBefore);

    handlers.onMessage({ data: JSON.stringify({ type: 'input', data: 'x' }) }, mockWs);
    await Bun.sleep(50);
    expect(mockWs.sentMessages.map((m) => JSON.parse(m))).toEqual([
      { type: 'error', message: 'The file viewer accepts no client messages', code: 'UNSUPPORTED_OPERATION' },
    ]);
    expect(mockWs.closeCalls).toEqual([]);

    handlers.onClose({}, mockWs);
  });

  it('closes a file-viewer socket opened while the session is pausing with SESSION_PAUSED (the viewer branch sits below the pausing check)', async () => {
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
    const viewer = await sessionManager.createWorker(session.id, { type: 'file-viewer' });
    expect(viewer).not.toBeNull();
    const pause = sessionManager.pauseSession(session.id);
    for (let i = 0; i < 400 && held.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(sessionManager.isPausing(session.id)).toBe(true);

    const handlers = capturedWorkerHandlerFactory!({
      req: { param: (name: string) => (name === 'sessionId' ? session.id : name === 'workerId' ? viewer!.id : '') },
    });
    const mockWs = createMockWs();
    handlers.onOpen({}, mockWs);
    for (let i = 0; i < 400 && mockWs.closeCalls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(JSON.parse(mockWs.sentMessages[0])).toEqual({ type: 'error', message: 'Session is pausing', code: 'SESSION_PAUSED' });
    expect(mockWs.closeCalls).toEqual([{ code: 1000, reason: 'Session is pausing' }]);

    resolveHook({ success: true });
    await pause;
  });

  // Two tabs on one git-diff worker: the socket's own close must release only its own watch (the socket is
  // passed to the handler). Polarity: with cleanupWorkerConnection calling handleGitDiffDisconnection without
  // the socket, the close of ws1 stops every connection of the worker and ws2 receives nothing.
  it('closing one git-diff socket leaves the other tab receiving diff frames on a refresh trigger', async () => {
    expect(capturedWorkerHandlerFactory).not.toBeNull();
    const session = await sessionManager.createSession({
      type: 'worktree',
      locationPath: '/test/path',
      repositoryId: 'repo-1',
      worktreeId: 'feature-branch',
      agentId: 'claude-code',
    });
    const diffWorker = session.workers.find((w) => w.type === 'git-diff');
    expect(diffWorker).toBeDefined();
    const openSocket = () => {
      const handlers = capturedWorkerHandlerFactory!({
        req: { param: (name: string) => (name === 'sessionId' ? session.id : name === 'workerId' ? diffWorker!.id : '') },
      });
      const ws = createMockWs();
      handlers.onOpen({}, ws);
      return { handlers, ws };
    };
    const tab1 = openSocket();
    const tab2 = openSocket();
    await Bun.sleep(150); // the initial diff frames (data or error: the diff source is not under test)
    tab1.ws.sentMessages.length = 0;
    tab2.ws.sentMessages.length = 0;

    tab1.handlers.onClose({}, tab1.ws);
    triggerRefresh(session.locationPath);
    await Bun.sleep(300);

    expect(tab1.ws.sentMessages).toEqual([]);
    expect(tab2.ws.sentMessages.length).toBeGreaterThan(0);
    tab2.handlers.onClose({}, tab2.ws);
  });

  it('notifySessionPaused sends SESSION_PAUSED and closes with 1000 on an open file-viewer socket', async () => {
    expect(capturedWorkerHandlerFactory).not.toBeNull();

    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code',
    });
    const viewer = await sessionManager.createWorker(session.id, { type: 'file-viewer' });
    const handlers = capturedWorkerHandlerFactory!({
      req: { param: (name: string) => (name === 'sessionId' ? session.id : name === 'workerId' ? viewer!.id : '') },
    });
    const mockWs = createMockWs();
    handlers.onOpen({}, mockWs);
    mockWs.sentMessages.length = 0;

    notifySessionPaused(session.id);

    expect(JSON.parse(mockWs.sentMessages[0])).toMatchObject({ type: 'error', code: 'SESSION_PAUSED' });
    expect(JSON.parse(mockWs.sentMessages[1])).toMatchObject({ type: 'exit', exitCode: 0 });
    expect(mockWs.closeCalls.length).toBe(1);
    expect(mockWs.closeCalls[0].code).toBe(1000);
    handlers.onClose({}, mockWs);
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

// =========================================================================
// File-viewer socket: access is checked BEFORE the upgrade (403)
// =========================================================================

describe('File-viewer worker WebSocket access guard', () => {
  const ptyFactory = createMockPtyFactory(30000);
  let testJobQueue: JobQueue | null = null;
  let app: InstanceType<typeof Hono>;
  let sessionManager: SessionManager;

  async function sessionWithViewer(createdBy: string | undefined, locationPath = '/test/path') {
    const session = await sessionManager.createSession({ type: 'quick', locationPath, agentId: 'claude-code' });
    // No public setter: a user row would be needed for the foreign key, so set the owner on the in-memory session
    // (the same private-field access routes/__tests__/workers.test.ts uses to simulate ownership).
    if (createdBy) sessionManager['sessions'].get(session.id)!.createdBy = createdBy;
    const viewer = await sessionManager.createWorker(session.id, { type: 'file-viewer' });
    const agent = session.workers.find((w) => w.type === 'agent')!;
    return { session, viewer: viewer!, agent };
  }

  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    ptyFactory.reset();
    resetProcessMock();
    await initializeDatabase(':memory:');

    testJobQueue = new JobQueue(getDatabase());
    registerJobHandlers(testJobQueue, new WorkerOutputFileManager());
    const agentManager = await AgentManager.create(new SqliteAgentRepository(getDatabase()));
    const embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(getDatabase()));
    const notificationManager = new NotificationManager(new SlackHandler(new RepositorySlackIntegrationService(getDatabase())));
    const userMode = new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' });
    sessionManager = await SessionManager.create({
      sessionRepository: new SqliteSessionRepository(getDatabase()),
      jobQueue: testJobQueue,
      agentManager,
      embeddedAgentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      userMode,
      repositoryLookup: repositoryLookupFromSlug(async () => 'test-repo'),
      repositoryEnvLookup: {
        getRepositoryInfo: () => ({ name: 'test-repo', path: '/test/repo' }),
        getWorktreeIndexNumber: async () => 0,
      },
    });
    const repositoryManager = await RepositoryManager.create({
      repository: new SqliteRepositoryRepository(getDatabase()),
      jobQueue: testJobQueue,
    });
    const appContext = asAppContext({
      sessionManager,
      notificationManager,
      agentManager,
      embeddedAgentManager,
      repositoryManager,
      userMode,
      sharedAccountRegistry: SharedAccountRegistry.createDisabled(),
    });

    app = new Hono();
    // The upgrade step itself: reaching it means the guards let the request through.
    const upgradeWebSocket = (_factory: WebSocketHandlerFactory) => (c: { text: (body: string) => Response }) => c.text('UPGRADED');
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

  const url = (sessionId: string, workerId: string) => `/ws/session/${sessionId}/worker/${workerId}`;

  it('403 before the upgrade for a multi-user caller who may not operate the session; the owner reaches the upgrade', async () => {
    const other = await sessionWithViewer('someone-else-id');
    const own = await sessionWithViewer('test-user-id');
    const originalAuthMode = serverConfig.AUTH_MODE;
    (serverConfig as { AUTH_MODE: string }).AUTH_MODE = 'multi-user';
    try {
      const denied = await app.request(url(other.session.id, other.viewer.id));
      expect(denied.status).toBe(403);
      expect(await denied.text()).toBe('Only the session owner can view this session\'s files');
      const allowed = await app.request(url(own.session.id, own.viewer.id));
      expect(allowed.status).toBe(200);
      expect(await allowed.text()).toBe('UPGRADED');
    } finally {
      (serverConfig as { AUTH_MODE: string }).AUTH_MODE = originalAuthMode;
    }
  });

  it('does not apply the viewer check to other worker types (control: the agent worker of the same foreign session still upgrades)', async () => {
    const other = await sessionWithViewer('someone-else-id');
    const originalAuthMode = serverConfig.AUTH_MODE;
    (serverConfig as { AUTH_MODE: string }).AUTH_MODE = 'multi-user';
    try {
      const response = await app.request(url(other.session.id, other.agent.id));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('UPGRADED');
    } finally {
      (serverConfig as { AUTH_MODE: string }).AUTH_MODE = originalAuthMode;
    }
  });

  it('single-user mode never checks ownership', async () => {
    const other = await sessionWithViewer('someone-else-id');
    const response = await app.request(url(other.session.id, other.viewer.id));
    expect(response.status).toBe(200);
  });
});
