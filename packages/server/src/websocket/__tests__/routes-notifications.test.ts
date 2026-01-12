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

import { resetAgentManager } from '../../services/agent-manager.js';
import {
  getNotificationManager,
  setNotificationManager,
  shutdownNotificationServices,
} from '../../services/notifications/index.js';
import { getSessionManager, resetSessionManager, setSessionManager } from '../../services/session-manager.js';
import { resetRepositoryManager, setRepositoryManager } from '../../services/repository-manager.js';
import { createTestContext, shutdownAppContext, type AppBindings, type AppContext } from '../../app-context.js';
import { setupWebSocketRoutes } from '../routes.js';

describe('WebSocket routes notifications', () => {
  let appContext: AppContext;

  beforeEach(async () => {
    resetRepositoryManager();
    resetAgentManager();
    resetSessionManager();
    shutdownNotificationServices();

    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    mockPtyInstances.length = 0;
    nextPtyPid = 10000;

    resetProcessMock();

    appContext = await createTestContext();
    setSessionManager(appContext.sessionManager);
    setRepositoryManager(appContext.repositoryManager);
    setNotificationManager(appContext.notificationManager);
  });

  afterEach(async () => {
    await shutdownAppContext(appContext, { resetSingletons: true });
    resetRepositoryManager();
    resetAgentManager();
    cleanupMemfs();
  });

  it('should include repository info for worktree session worker exits', async () => {
    const app = new Hono<AppBindings>();
    const upgradeWebSocket = (handler: (c: unknown) => unknown) => handler;
    await setupWebSocketRoutes(app, upgradeWebSocket);

    const sessionManager = getSessionManager();
    const notificationManager = getNotificationManager();
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
    const app = new Hono<AppBindings>();
    const upgradeWebSocket = (handler: (c: unknown) => unknown) => handler;
    await setupWebSocketRoutes(app, upgradeWebSocket);

    const sessionManager = getSessionManager();
    const notificationManager = getNotificationManager();
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
