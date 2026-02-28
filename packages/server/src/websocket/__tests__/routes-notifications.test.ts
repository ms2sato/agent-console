import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { Hono } from 'hono';
import type { Worker } from '@agent-console/shared';
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
import { asAppContext } from '../../__tests__/test-utils.js';

/**
 * Create a no-op upgradeWebSocket stub for tests that only need setupWebSocketRoutes
 * to register callbacks (not actually handle WebSocket connections).
 *
 * UpgradeWebSocket has overloaded call signatures with incompatible return types
 * (MiddlewareHandler vs Promise<Response>), so a passthrough stub cannot satisfy
 * the interface without casting through unknown. This helper centralizes that cast.
 */
function createUpgradeWebSocketStub(): Parameters<typeof setupWebSocketRoutes>[1] {
  return ((handler: unknown) => handler) as unknown as Parameters<typeof setupWebSocketRoutes>[1];
}

describe('WebSocket routes notifications', () => {
  let testJobQueue: JobQueue | null = null;
  let sessionManager: SessionManager;
  let notificationManager: NotificationManager;
  let appContext: AppContext;

  beforeEach(async () => {
    await closeDatabase();

    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    mockPtyInstances.length = 0;
    nextPtyPid = 10000;

    resetProcessMock();
    await initializeDatabase(':memory:');

    testJobQueue = new JobQueue(getDatabase());
    registerJobHandlers(testJobQueue);
    const sessionRepository = await createSessionRepository();
    const agentManager = await AgentManager.create(new SqliteAgentRepository(getDatabase()));
    notificationManager = new NotificationManager(new SlackHandler());
    sessionManager = await SessionManager.create({ sessionRepository, jobQueue: testJobQueue, agentManager });
    const repositoryRepository = new SqliteRepositoryRepository(getDatabase());
    const repositoryManager = await RepositoryManager.create({ repository: repositoryRepository, jobQueue: testJobQueue });

    appContext = asAppContext({ sessionManager, notificationManager, agentManager, repositoryManager });
  });

  afterEach(async () => {
    if (testJobQueue) {
      await testJobQueue.stop();
      testJobQueue = null;
    }

    await closeDatabase();
    cleanupMemfs();
  });

  it('should include repository info for worktree session worker exits', async () => {
    const app = new Hono();
    await setupWebSocketRoutes(app, createUpgradeWebSocketStub(), appContext);
    const onWorkerExitSpy = spyOn(notificationManager, 'onWorkerExit');

    const session = await sessionManager.createSession({
      type: 'worktree',
      locationPath: '/test/path',
      repositoryId: 'repo-1',
      worktreeId: 'main',
      agentId: 'claude-code',
    });
    const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;

    const pty = mockPtyInstances[0];
    expect(pty).toBeDefined();
    pty.simulateExit(0);

    expect(onWorkerExitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: session.id,
        worktreeId: 'main',
        repositoryId: 'repo-1',
      }),
      { id: agentWorker.id },
      0
    );
  });

  it('should set repository info to null for quick session worker exits', async () => {
    const app = new Hono();
    await setupWebSocketRoutes(app, createUpgradeWebSocketStub(), appContext);
    const onWorkerExitSpy = spyOn(notificationManager, 'onWorkerExit');

    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code',
    });
    const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;

    const pty = mockPtyInstances[0];
    expect(pty).toBeDefined();
    pty.simulateExit(0);

    expect(onWorkerExitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: session.id,
        worktreeId: null,
        repositoryId: null,
      }),
      { id: agentWorker.id },
      0
    );
  });
});
