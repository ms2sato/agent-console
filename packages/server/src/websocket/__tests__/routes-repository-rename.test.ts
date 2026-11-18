import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Hono } from 'hono';
import type { WSContext, WSReadyState } from 'hono/ws';
import type { Repository } from '@agent-console/shared';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import {
  makeRepositoryLookup,
  makeRepositoryEnvLookup,
} from '../../__tests__/utils/repository-lookup-mock.js';

import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { JobQueue } from '../../jobs/job-queue.js';
import { registerJobHandlers } from '../../jobs/handlers.js';
import { WorkerOutputFileManager } from '../../lib/worker-output-file.js';
import { SqliteSessionRepository } from '../../repositories/index.js';
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
import { McpTokenRegistry } from '../../mcp/mcp-auth.js';
import { asWSContext, asUpgradeWebSocket } from './ws-test-helpers.js';
import { asAppContext } from '../../__tests__/test-utils.js';

const TEST_CONFIG_DIR = '/test/config';

/**
 * `readyState` defaults to OPEN. Accepts an override so callers that need a
 * dead-client shape (e.g. CLOSED) can set it at construction time -- WSContext's
 * real `readyState` is a getter with no setter, so mutating it after
 * construction is not an option.
 */
function createMockWs(readyState: WSReadyState = 1): WSContext & {
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
    readyState,
  });
  return Object.assign(ws, { sentMessages, closeCalls });
}

describe('Repository rename wiring in setupWebSocketRoutes', () => {
  const ptyFactory = createMockPtyFactory(10000);
  let testJobQueue: JobQueue | null = null;
  let testRegistry: WebSocketConnectionRegistry;
  let sessionManager: SessionManager;
  let installedCallbacks: Parameters<RepositoryManager['setLifecycleCallbacks']>[0] | null = null;

  beforeEach(async () => {
    await closeDatabase();

    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    ptyFactory.reset();
    installedCallbacks = null;
    testRegistry = new WebSocketConnectionRegistry();

    resetProcessMock();
    await initializeDatabase(':memory:');

    testJobQueue = new JobQueue(getDatabase());
    registerJobHandlers(testJobQueue, new WorkerOutputFileManager());
    const sessionRepository = new SqliteSessionRepository(getDatabase());
    const agentManager = await AgentManager.create(new SqliteAgentRepository(getDatabase()));
    const embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(getDatabase()));
    const notificationManager = new NotificationManager(new SlackHandler(new RepositorySlackIntegrationService(getDatabase())));
    sessionManager = await SessionManager.create({
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      repositoryLookup: makeRepositoryLookup(() => 'test-repo'),
      repositoryEnvLookup: makeRepositoryEnvLookup({
        mapping: () => ({ name: 'test-repo', path: '/test/repo' }),
      }),
    });
    const repositoryManager = await RepositoryManager.create({
      repository: new SqliteRepositoryRepository(getDatabase()),
      jobQueue: testJobQueue,
    });
    // Capture the lifecycle callbacks the routes install on the real manager.
    const realSetLifecycleCallbacks = repositoryManager.setLifecycleCallbacks.bind(repositoryManager);
    spyOn(repositoryManager, 'setLifecycleCallbacks').mockImplementation((callbacks) => {
      installedCallbacks = callbacks;
      realSetLifecycleCallbacks(callbacks);
    });
    const userMode = new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' });

    const appContext = asAppContext({ sessionManager, notificationManager, agentManager, embeddedAgentManager, repositoryManager, userMode });

    const app = new Hono();
    const upgradeWebSocket = (handlerFactory: unknown) => handlerFactory;
    await setupWebSocketRoutes(app, asUpgradeWebSocket(upgradeWebSocket), appContext, testRegistry);
  });

  afterEach(async () => {
    if (testJobQueue) {
      await testJobQueue.stop();
      testJobQueue = null;
    }

    await closeDatabase();
    cleanupMemfs();
  });

  it('onRepositoryNameChanged broadcasts session-updated for the live sessions of that repository only', async () => {
    expect(installedCallbacks).not.toBeNull();

    const renamedSession = await sessionManager.createSession({
      type: 'worktree',
      locationPath: '/test/path-a',
      repositoryId: 'repo-1',
      worktreeId: 'main',
      agentId: 'claude-code',
    });
    const unrelatedSession = await sessionManager.createSession({
      type: 'worktree',
      locationPath: '/test/path-b',
      repositoryId: 'repo-2',
      worktreeId: 'main',
      agentId: 'claude-code',
    });

    const mockWs = createMockWs();
    testRegistry.addAppClient(mockWs);

    await installedCallbacks!.onRepositoryNameChanged({ id: 'repo-1', name: 'Renamed' } as Repository);

    const updatedIds = mockWs.sentMessages
      .map((m) => JSON.parse(m) as { type: string; session?: { id: string } })
      .filter((m) => m.type === 'session-updated')
      .map((m) => m.session?.id);
    expect(updatedIds).toEqual([renamedSession.id]);
    expect(updatedIds).not.toContain(unrelatedSession.id);
  });
});
