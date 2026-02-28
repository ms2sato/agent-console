import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { MockPty } from '../../__tests__/utils/mock-pty.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';

const TEST_CONFIG_DIR = '/test/config';
process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

// Track PTY instances for exit simulation.
const mockPtyInstances: MockPty[] = [];
let nextPtyPid = 10000;

mock.module('../../lib/pty-provider.js', () => ({
  bunPtyProvider: {
    spawn: () => {
      const pty = new MockPty(nextPtyPid++);
      mockPtyInstances.push(pty);
      return pty;
    },
  },
}));

import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { JobQueue } from '../../jobs/job-queue.js';
import { registerJobHandlers } from '../../jobs/handlers.js';
import { createSessionRepository } from '../../repositories/index.js';
import { SqliteRepositoryRepository } from '../../repositories/sqlite-repository-repository.js';
import { SessionManager } from '../../services/session-manager.js';
import { RepositoryManager } from '../../services/repository-manager.js';
import { AgentManager } from '../../services/agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { NotificationManager } from '../../services/notifications/notification-manager.js';
import { SlackHandler } from '../../services/notifications/slack-handler.js';
import { setupWebSocketRoutes } from '../routes.js';
import type { AppContext } from '../../app-context.js';

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

  return {
    send: (data: string | ArrayBuffer) => {
      sentMessages.push(typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer));
    },
    close: (code?: number, reason?: string) => {
      closeCalls.push({ code, reason });
    },
    readyState: 1, // OPEN
    sentMessages,
    closeCalls,
  } as unknown as WSContext & {
    sentMessages: string[];
    closeCalls: { code?: number; reason?: string }[];
  };
}

describe('Worker WebSocket connection error codes', () => {
  let testJobQueue: JobQueue | null = null;
  let sessionManager: SessionManager;
  let capturedWorkerHandlerFactory: WebSocketHandlerFactory | null = null;

  beforeEach(async () => {
    await closeDatabase();

    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    mockPtyInstances.length = 0;
    nextPtyPid = 10000;
    capturedWorkerHandlerFactory = null;

    resetProcessMock();
    await initializeDatabase(':memory:');

    testJobQueue = new JobQueue(getDatabase());
    registerJobHandlers(testJobQueue);
    const sessionRepository = await createSessionRepository();
    const agentManager = await AgentManager.create(new SqliteAgentRepository(getDatabase()));
    const notificationManager = new NotificationManager(new SlackHandler());
    sessionManager = await SessionManager.create({ sessionRepository, jobQueue: testJobQueue, agentManager });
    const repositoryRepository = new SqliteRepositoryRepository(getDatabase());
    const repositoryManager = await RepositoryManager.create({ repository: repositoryRepository, jobQueue: testJobQueue });

    const appContext = { sessionManager, notificationManager, agentManager, repositoryManager } as unknown as AppContext;

    // Set up routes with a custom upgradeWebSocket that captures the worker handler factory
    const app = new Hono();
    const upgradeWebSocket = (handlerFactory: WebSocketHandlerFactory) => {
      // The last registered handler will be the worker route (registered after app route)
      capturedWorkerHandlerFactory = handlerFactory;
      return handlerFactory;
    };
    await setupWebSocketRoutes(app, upgradeWebSocket as unknown as Parameters<typeof setupWebSocketRoutes>[1], appContext);
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
});
