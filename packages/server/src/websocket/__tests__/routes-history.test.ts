import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import type { Worker } from '@agent-console/shared';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';

import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { JobQueue } from '../../jobs/job-queue.js';
import { registerJobHandlers } from '../../jobs/handlers.js';
import { WorkerOutputFileManager } from '../../lib/worker-output-file.js';
import { createSessionRepository } from '../../repositories/index.js';
import { SqliteRepositoryRepository } from '../../repositories/sqlite-repository-repository.js';
import { SessionManager } from '../../services/session-manager.js';
import { RepositoryManager } from '../../services/repository-manager.js';
import { AgentManager } from '../../services/agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { EmbeddedAgentManager } from '../../services/embedded-agent-manager.js';
import { SqliteEmbeddedAgentRepository } from '../../repositories/sqlite-embedded-agent-repository.js';
import { NotificationManager } from '../../services/notifications/notification-manager.js';
import { SlackHandler } from '../../services/notifications/slack-handler.js';
import { RepositorySlackIntegrationService } from '../../services/notifications/repository-slack-integration-service.js';
import { SingleUserMode } from '../../services/user-mode.js';
import { setupWebSocketRoutes } from '../routes.js';
import { WebSocketConnectionRegistry } from '../connection-registry.js';
import type { AppContext } from '../../app-context.js';
import { McpTokenRegistry } from '../../mcp/mcp-auth.js';

const TEST_CONFIG_DIR = '/test/config';

type WebSocketHandlerFactory = (c: { req: { param: (name: string) => string } }) => {
  onOpen: (event: unknown, ws: WSContext) => void;
  onMessage: (event: { data: string | ArrayBuffer }, ws: WSContext) => void;
  onClose: (event: unknown, ws: WSContext) => void;
  onError: (event: Event, ws: WSContext) => void;
};

function createMockWs(): WSContext & {
  sentMessages: string[];
  closeCalls: { code?: number; reason?: string }[];
} {
  const sentMessages: string[] = [];
  const closeCalls: { code?: number; reason?: string }[] = [];

  return {
    send: (data: string | ArrayBuffer) => {
      sentMessages.push(typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer));
    },
    close: (code?: number, reason?: string) => {
      closeCalls.push({ code, reason });
    },
    readyState: 1,
    sentMessages,
    closeCalls,
  } as unknown as WSContext & {
    sentMessages: string[];
    closeCalls: { code?: number; reason?: string }[];
  };
}

describe('Worker WebSocket history and notifications', () => {
  const ptyFactory = createMockPtyFactory(10000);
  let testJobQueue: JobQueue | null = null;
  let sessionManager: SessionManager;
  let testRegistry: WebSocketConnectionRegistry;
  let capturedWorkerHandlerFactory: WebSocketHandlerFactory | null = null;

  beforeEach(async () => {
    await closeDatabase();

    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    ptyFactory.reset();
    capturedWorkerHandlerFactory = null;
    testRegistry = new WebSocketConnectionRegistry();

    resetProcessMock();
    await initializeDatabase(':memory:');

    testJobQueue = new JobQueue(getDatabase());
    registerJobHandlers(testJobQueue, new WorkerOutputFileManager());
    const sessionRepository = await createSessionRepository();
    const agentManager = await AgentManager.create(new SqliteAgentRepository(getDatabase()));
    const embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(getDatabase()));
    const notificationManager = new NotificationManager(new SlackHandler(new RepositorySlackIntegrationService(getDatabase())));
    sessionManager = await SessionManager.create({
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      repositoryLookup: { getRepositorySlug: () => 'test-repo' },
      repositoryEnvLookup: {
        getRepositoryInfo: () => ({ name: 'test-repo', path: '/test/repo' }),
        getWorktreeIndexNumber: async () => 0,
      },
    });
    const repositoryRepository = new SqliteRepositoryRepository(getDatabase());
    const repositoryManager = await RepositoryManager.create({ repository: repositoryRepository, jobQueue: testJobQueue });
    const userMode = new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' });

    const appContext = { sessionManager, notificationManager, agentManager, embeddedAgentManager, repositoryManager, userMode } as unknown as AppContext;

    const app = new Hono();
    const upgradeWebSocket = (handlerFactory: WebSocketHandlerFactory) => {
      // Last registered handler is the worker route
      capturedWorkerHandlerFactory = handlerFactory;
      return handlerFactory;
    };
    await setupWebSocketRoutes(app, upgradeWebSocket as unknown as Parameters<typeof setupWebSocketRoutes>[1], appContext, testRegistry);
  });

  afterEach(async () => {
    if (testJobQueue) {
      await testJobQueue.stop();
      testJobQueue = null;
    }

    await closeDatabase();
    cleanupMemfs();
  });

  /**
   * Helper: create a session with an agent worker and return the handler + mock WS.
   * Opens the WebSocket connection and waits for the async restoreWorker to complete.
   */
  async function createSessionAndConnect(): Promise<{
    sessionId: string;
    workerId: string;
    handlers: ReturnType<WebSocketHandlerFactory>;
    mockWs: ReturnType<typeof createMockWs>;
  }> {
    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code',
    });

    const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
    expect(agentWorker).toBeDefined();

    const mockContext = {
      req: {
        param: (name: string) => {
          if (name === 'sessionId') return session.id;
          if (name === 'workerId') return agentWorker.id;
          return '';
        },
      },
    };

    const handlers = capturedWorkerHandlerFactory!(mockContext);
    const mockWs = createMockWs();

    // Trigger onOpen - this starts async restoreWorker
    handlers.onOpen({}, mockWs);

    // Wait for async setup to complete (restoreWorker + setupPtyWorkerHandlers)
    await new Promise(resolve => setTimeout(resolve, 100));

    return { sessionId: session.id, workerId: agentWorker.id, handlers, mockWs };
  }

  // =========================================================================
  // History request tests
  // =========================================================================

  describe('request-history', () => {
    it('should return history with offset on request', async () => {
      const { handlers, mockWs } = await createSessionAndConnect();

      // Clear messages from connection setup
      mockWs.sentMessages.length = 0;

      // Send request-history message
      const requestMsg = JSON.stringify({ type: 'request-history' });
      handlers.onMessage({ data: requestMsg }, mockWs);

      // Wait for async history fetch
      await new Promise(resolve => setTimeout(resolve, 200));

      // Should have received a history response
      const historyMessages = mockWs.sentMessages
        .map(m => JSON.parse(m))
        .filter(m => m.type === 'history');

      expect(historyMessages).toHaveLength(1);
      expect(historyMessages[0]).toHaveProperty('data');
      expect(historyMessages[0]).toHaveProperty('offset');
      expect(typeof historyMessages[0].offset).toBe('number');
    });

    it('should pass the recent-window line cap for incremental sync (fromOffset > 0)', async () => {
      const { sessionId, workerId, handlers, mockWs } = await createSessionAndConnect();

      // The incremental read receives the recent-window line cap so the
      // archived-out / stale fallback branches (§3.1) can bound their payload.
      const spy = spyOn(sessionManager, 'getWorkerOutputHistory').mockResolvedValue({
        data: 'incremental data',
        offset: 700,
        startOffset: 500,
        epoch: 111,
      });

      // Clear messages from connection setup
      mockWs.sentMessages.length = 0;

      // Send request-history with fromOffset (incremental sync)
      const requestMsg = JSON.stringify({ type: 'request-history', fromOffset: 500 });
      handlers.onMessage({ data: requestMsg }, mockWs);

      // Wait for async history fetch
      await new Promise(resolve => setTimeout(resolve, 200));

      // Verify getWorkerOutputHistory was called with fromOffset=500 and a numeric line cap
      expect(spy).toHaveBeenCalled();
      const call = spy.mock.calls[0];
      expect(call[0]).toBe(sessionId);
      expect(call[1]).toBe(workerId);
      expect(call[2]).toBe(500);
      expect(typeof call[3]).toBe('number');

      const historyMessages = mockWs.sentMessages
        .map(m => JSON.parse(m))
        .filter(m => m.type === 'history');

      expect(historyMessages).toHaveLength(1);
      expect(historyMessages[0].data).toBe('incremental data');
      expect(historyMessages[0].offset).toBe(700);
      expect(historyMessages[0].startOffset).toBe(500);
      expect(historyMessages[0].epoch).toBe(111);
    });

    it('should apply line limit for initial load (fromOffset = 0)', async () => {
      const { handlers, mockWs } = await createSessionAndConnect();

      const spy = spyOn(sessionManager, 'getWorkerOutputHistory').mockResolvedValue({
        data: 'initial data',
        offset: 100,
        startOffset: 0,
        epoch: 222,
      });

      mockWs.sentMessages.length = 0;

      const requestMsg = JSON.stringify({ type: 'request-history' });
      handlers.onMessage({ data: requestMsg }, mockWs);

      await new Promise(resolve => setTimeout(resolve, 200));

      // Verify maxLines was passed for initial load (fromOffset=0)
      expect(spy).toHaveBeenCalled();
      const call = spy.mock.calls[0];
      expect(call[2]).toBe(0); // fromOffset
      expect(typeof call[3]).toBe('number'); // maxLines should be a number, not undefined
    });

    it('should return timedOut flag when history request times out', async () => {
      const { handlers, mockWs } = await createSessionAndConnect();

      // Spy on getWorkerOutputHistory to make it take longer than the timeout
      spyOn(sessionManager, 'getWorkerOutputHistory').mockImplementation(() => {
        // Return a promise that never resolves (will be beaten by the 5s timeout)
        return new Promise(() => {});
      });

      // Clear messages from connection setup
      mockWs.sentMessages.length = 0;

      // Send request-history
      const requestMsg = JSON.stringify({ type: 'request-history' });
      handlers.onMessage({ data: requestMsg }, mockWs);

      // Wait for the 5-second timeout + some buffer
      await new Promise(resolve => setTimeout(resolve, 5500));

      const historyMessages = mockWs.sentMessages
        .map(m => JSON.parse(m))
        .filter(m => m.type === 'history');

      expect(historyMessages).toHaveLength(1);
      expect(historyMessages[0].timedOut).toBe(true);
      expect(historyMessages[0].data).toBe('');
      expect(historyMessages[0].offset).toBe(0);
    }, 10000); // Extended timeout for 5s history timeout

    it('should send HISTORY_LOAD_FAILED on non-timeout error', async () => {
      const { handlers, mockWs } = await createSessionAndConnect();

      // Spy on getWorkerOutputHistory to throw a non-timeout error
      spyOn(sessionManager, 'getWorkerOutputHistory').mockImplementation(() => {
        return Promise.reject(new Error('Disk read error'));
      });

      // Clear messages from connection setup
      mockWs.sentMessages.length = 0;

      const requestMsg = JSON.stringify({ type: 'request-history' });
      handlers.onMessage({ data: requestMsg }, mockWs);

      // Wait for async error handling
      await new Promise(resolve => setTimeout(resolve, 200));

      const errorMessages = mockWs.sentMessages
        .map(m => JSON.parse(m))
        .filter(m => m.type === 'error');

      expect(errorMessages).toHaveLength(1);
      expect(errorMessages[0].code).toBe('HISTORY_LOAD_FAILED');
    });
  });

  // =========================================================================
  // History messages carry absolute startOffset + epoch (§3.1 / §3.4)
  // =========================================================================

  describe('history startOffset + epoch', () => {
    it('an initial history response carries startOffset and epoch fields', async () => {
      const { handlers, mockWs } = await createSessionAndConnect();

      const spy = spyOn(sessionManager, 'getWorkerOutputHistory').mockResolvedValue({
        data: 'recent window',
        offset: 4242,
        startOffset: 4000,
        epoch: 1782950400000,
      });

      mockWs.sentMessages.length = 0;
      handlers.onMessage({ data: JSON.stringify({ type: 'request-history' }) }, mockWs);
      await new Promise(resolve => setTimeout(resolve, 200));

      const history = mockWs.sentMessages.map(m => JSON.parse(m)).filter(m => m.type === 'history');
      expect(history).toHaveLength(1);
      expect(history[0].startOffset).toBe(4000);
      expect(history[0].epoch).toBe(1782950400000);
      expect(history[0].offset).toBe(4242);
      spy.mockRestore();
    });
  });

  // =========================================================================
  // Server restart detection tests
  // =========================================================================

  describe('server restart detection', () => {
    it('should send server-restarted message when worker was restored', async () => {
      // Create a session and let the PTY be spawned
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;

      // Spy on restoreWorker to simulate a restored PTY (wasRestored = true)
      spyOn(sessionManager, 'restoreWorker').mockResolvedValue({
        success: true,
        wasRestored: true,
        worker: { type: 'agent' },
      });

      const mockContext = {
        req: {
          param: (name: string) => {
            if (name === 'sessionId') return session.id;
            if (name === 'workerId') return agentWorker.id;
            return '';
          },
        },
      };

      const handlers = capturedWorkerHandlerFactory!(mockContext);
      const mockWs = createMockWs();

      handlers.onOpen({}, mockWs);

      // Wait for async setup
      await new Promise(resolve => setTimeout(resolve, 200));

      // Find server-restarted message
      const restartMessages = mockWs.sentMessages
        .map(m => JSON.parse(m))
        .filter(m => m.type === 'server-restarted');

      expect(restartMessages).toHaveLength(1);
      expect(restartMessages[0]).toHaveProperty('serverPid');
      expect(typeof restartMessages[0].serverPid).toBe('number');
    });

    it('should NOT send server-restarted message when worker was not restored', async () => {
      const { mockWs } = await createSessionAndConnect();

      // Check that no server-restarted message was sent during normal connection
      const restartMessages = mockWs.sentMessages
        .map(m => JSON.parse(m))
        .filter(m => m.type === 'server-restarted');

      expect(restartMessages).toHaveLength(0);
    });
  });
});
