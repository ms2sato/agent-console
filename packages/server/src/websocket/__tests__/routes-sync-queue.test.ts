import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import type { AppServerMessage } from '@agent-console/shared';
import { WS_CLOSE_CODE } from '@agent-console/shared';
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
import { NotificationManager } from '../../services/notifications/notification-manager.js';
import { SlackHandler } from '../../services/notifications/slack-handler.js';
import { RepositorySlackIntegrationService } from '../../services/notifications/repository-slack-integration-service.js';
import { SingleUserMode } from '../../services/user-mode.js';
import { setupWebSocketRoutes, broadcastToApp } from '../routes.js';
import { WebSocketConnectionRegistry } from '../connection-registry.js';
import type { AppContext } from '../../app-context.js';

const TEST_CONFIG_DIR = '/test/config';

/**
 * Capture the app WebSocket handler factory.
 * upgradeWebSocket receives a factory function: (c) => { onOpen, onMessage, ... }
 * We capture both app and worker handler factories.
 */
type WebSocketHandlerFactory = (c: { req: { param: (name: string) => string } }) => {
  onOpen: (event: unknown, ws: WSContext) => void;
  onMessage: (event: { data: string | ArrayBuffer }, ws: WSContext) => void;
  onClose: (event: unknown, ws: WSContext) => void;
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
    readyState: 1, // OPEN
    sentMessages,
    closeCalls,
  } as unknown as WSContext & {
    sentMessages: string[];
    closeCalls: { code?: number; reason?: string }[];
  };
}

describe('App WebSocket sync-queue handling', () => {
  const ptyFactory = createMockPtyFactory(10000);
  let testJobQueue: JobQueue | null = null;
  let testRegistry: WebSocketConnectionRegistry;
  let capturedAppHandlerFactory: WebSocketHandlerFactory | null = null;

  beforeEach(async () => {
    await closeDatabase();

    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    ptyFactory.reset();
    capturedAppHandlerFactory = null;
    testRegistry = new WebSocketConnectionRegistry();

    resetProcessMock();
    await initializeDatabase(':memory:');

    testJobQueue = new JobQueue(getDatabase());
    registerJobHandlers(testJobQueue, new WorkerOutputFileManager());
    const sessionRepository = await createSessionRepository();
    const agentManager = await AgentManager.create(new SqliteAgentRepository(getDatabase()));
    const notificationManager = new NotificationManager(new SlackHandler(new RepositorySlackIntegrationService(getDatabase())));
    const sessionManager = await SessionManager.create({
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager,
      ptyProvider: ptyFactory.provider,
    });
    const repositoryRepository = new SqliteRepositoryRepository(getDatabase());
    const repositoryManager = await RepositoryManager.create({ repository: repositoryRepository, jobQueue: testJobQueue });
    const userMode = new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' });

    const appContext = { sessionManager, notificationManager, agentManager, repositoryManager, userMode } as unknown as AppContext;

    const app = new Hono();
    // Capture the app handler factory (first call to upgradeWebSocket)
    let callCount = 0;
    const upgradeWebSocket = (handlerFactory: WebSocketHandlerFactory) => {
      callCount++;
      if (callCount === 1) {
        capturedAppHandlerFactory = handlerFactory;
      }
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

  it('should queue messages during sync and replay them after sync completes', async () => {
    expect(capturedAppHandlerFactory).not.toBeNull();

    const mockWs = createMockWs();
    // Manually simulate what onOpen does: add client and start syncing
    testRegistry.addAppClient(mockWs as unknown as WSContext);
    testRegistry.startSyncing(mockWs as unknown as WSContext);

    // Broadcast messages while syncing - these should be queued
    const msg1: AppServerMessage = { type: 'session-deleted', sessionId: 'sess-1' };
    const msg2: AppServerMessage = { type: 'session-deleted', sessionId: 'sess-2' };
    broadcastToApp(msg1);
    broadcastToApp(msg2);

    // Messages should NOT have been sent directly (they should be queued)
    const directMessages = mockWs.sentMessages.filter(m => {
      const parsed = JSON.parse(m);
      return parsed.type === 'session-deleted';
    });
    expect(directMessages).toHaveLength(0);

    // Verify queue has the messages
    const queue = testRegistry.getSyncQueue(mockWs as unknown as WSContext);
    expect(queue).toBeDefined();
    expect(queue!.length).toBe(2);

    // Simulate sync completion: replay queued messages and stop syncing
    for (const queuedMsg of queue!) {
      mockWs.send(JSON.stringify(queuedMsg));
    }
    testRegistry.stopSyncing(mockWs as unknown as WSContext);

    // Now the queued messages should have been sent
    const replayedMessages = mockWs.sentMessages.filter(m => {
      const parsed = JSON.parse(m);
      return parsed.type === 'session-deleted';
    });
    expect(replayedMessages).toHaveLength(2);

    const replayed1 = JSON.parse(replayedMessages[0]);
    const replayed2 = JSON.parse(replayedMessages[1]);
    expect(replayed1.sessionId).toBe('sess-1');
    expect(replayed2.sessionId).toBe('sess-2');
  });

  it('should force client reconnect on sync-queue overflow', () => {
    const mockWs = createMockWs();

    // Add client and start syncing
    testRegistry.addAppClient(mockWs as unknown as WSContext);
    testRegistry.startSyncing(mockWs as unknown as WSContext);

    // Fill the queue to capacity (MAX_SYNC_QUEUE_SIZE = 100)
    for (let i = 0; i < 100; i++) {
      const msg: AppServerMessage = { type: 'session-deleted', sessionId: `sess-${i}` };
      broadcastToApp(msg);
    }

    // Queue should be full but client still connected
    expect(mockWs.closeCalls).toHaveLength(0);

    // One more message should trigger overflow
    const overflowMsg: AppServerMessage = { type: 'session-deleted', sessionId: 'overflow' };
    broadcastToApp(overflowMsg);

    // Client should have been disconnected with INTERNAL_ERROR code
    expect(mockWs.closeCalls).toHaveLength(1);
    expect(mockWs.closeCalls[0].code).toBe(WS_CLOSE_CODE.INTERNAL_ERROR);
    expect(mockWs.closeCalls[0].reason).toBe('Sync queue overflow');
  });

  it('should deliver messages normally to non-syncing clients', () => {
    const mockWs = createMockWs();

    // Add client without syncing
    testRegistry.addAppClient(mockWs as unknown as WSContext);

    const msg: AppServerMessage = { type: 'session-deleted', sessionId: 'sess-1' };
    broadcastToApp(msg);

    // Message should have been sent directly
    expect(mockWs.sentMessages).toHaveLength(1);
    const parsed = JSON.parse(mockWs.sentMessages[0]);
    expect(parsed.type).toBe('session-deleted');
    expect(parsed.sessionId).toBe('sess-1');
  });

  it('should remove dead clients with non-OPEN readyState', () => {
    // Create a mock WS with CLOSED readyState
    const deadWs = createMockWs();
    (deadWs as unknown as { readyState: number }).readyState = 3; // CLOSED

    testRegistry.addAppClient(deadWs as unknown as WSContext);
    expect(testRegistry.appClientCount).toBe(1);

    // Broadcasting should detect and remove the dead client
    const msg: AppServerMessage = { type: 'session-deleted', sessionId: 'sess-1' };
    broadcastToApp(msg);

    expect(testRegistry.appClientCount).toBe(0);
    expect(deadWs.sentMessages).toHaveLength(0);
  });
});
