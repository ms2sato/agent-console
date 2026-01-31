/**
 * Test utilities for Server Bridge Pattern tests.
 *
 * IMPORTANT: Importing this module sets up all required mocks (fs, pty, open, git, process).
 * The mock.module calls are executed when the helper modules are imported.
 *
 * @example
 * ```typescript
 * import { createTestApp, setupTestEnvironment, cleanupTestEnvironment } from '@agent-console/server/__tests__/test-utils';
 *
 * beforeEach(async () => {
 *   await setupTestEnvironment();
 *   app = await createTestApp();
 * });
 *
 * afterEach(async () => {
 *   await cleanupTestEnvironment();
 * });
 * ```
 */
import { Hono } from 'hono';
import { mock } from 'bun:test';
import { MockPty } from './utils/mock-pty.js';

// Import mock helpers - this sets up mock.module calls
import { setupMemfs, cleanupMemfs } from './utils/mock-fs-helper.js';
import { resetProcessMock } from './utils/mock-process-helper.js';
import { resetGitMocks } from './utils/mock-git-helper.js';
import type { Kysely } from 'kysely';
import type { Database } from '../database/schema.js';
import { createDatabaseForTest } from '../database/connection.js';
import { AgentManager, resetAgentManager, setAgentManager } from '../services/agent-manager.js';
import {
  resetRepositoryManager,
  setRepositoryManager,
  RepositoryManager,
} from '../services/repository-manager.js';
import {
  resetSessionManager,
  setSessionManager,
  SessionManager,
} from '../services/session-manager.js';
import { resetJobQueue, initializeJobQueue } from '../jobs/index.js';
import { SqliteAgentRepository, SqliteRepositoryRepository, SqliteSessionRepository } from '../repositories/index.js';
import { NotificationManager } from '../services/notifications/notification-manager.js';
import { SlackHandler } from '../services/notifications/slack-handler.js';
import { setNotificationManager, shutdownNotificationServices } from '../services/notifications/index.js';
import { initializeInboundIntegration } from '../services/inbound/index.js';
import { shutdownAppContext, type AppBindings, type AppContext } from '../app-context.js';
import {
  SystemCapabilitiesService,
  setSystemCapabilities,
  resetSystemCapabilities,
} from '../services/system-capabilities-service.js';

// =============================================================================
// PTY Mock (not in a separate helper file)
// =============================================================================

const mockPtyInstances: MockPty[] = [];
let nextPtyPid = 10000;

mock.module('../lib/pty-provider.js', () => ({
  bunPtyProvider: {
    spawn: () => {
      const pty = new MockPty(nextPtyPid++);
      mockPtyInstances.push(pty);
      return pty;
    },
  },
}));

// =============================================================================
// Database Setup (uses in-memory SQLite via DI)
// =============================================================================

let db: Kysely<Database> | null = null;
let appContext: AppContext | null = null;

// =============================================================================
// Open Mock
// =============================================================================

export const mockOpen = mock(async () => {});
mock.module('open', () => ({
  default: mockOpen,
}));

// =============================================================================
// Test Environment Setup
// =============================================================================

const TEST_CONFIG_DIR = '/test/config';
let importCounter = 0;

/**
 * Sets up the test environment with memfs and required mocks.
 * Must be called in beforeEach with await.
 */
export async function setupTestEnvironment(): Promise<void> {
  await resetJobQueue();
  shutdownNotificationServices();

  setupMemfs({
    [`${TEST_CONFIG_DIR}/.keep`]: '',
  });
  process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

  db = await createDatabaseForTest();
  resetAgentManager();
  const agentManager = await AgentManager.create(new SqliteAgentRepository(db));
  setAgentManager(agentManager);

  // Initialize singleton job queue for routes that depend on it
  const jobQueue = initializeJobQueue({ db });

  // Build managers with explicit dependencies
  const sessionRepository = new SqliteSessionRepository(db);
  const repositoryRepository = new SqliteRepositoryRepository(db);
  resetSessionManager();
  const sessionManager = await SessionManager.create({ sessionRepository, jobQueue });
  resetRepositoryManager();
  const repositoryManager = await RepositoryManager.create({
    repository: repositoryRepository,
    jobQueue,
  });

  repositoryManager.setDependencyCallbacks({
    getSessionsUsingRepository: (repoId) =>
      sessionManager.getSessionsUsingRepository(repoId),
  });

  sessionManager.setRepositoryCallbacks({
    getRepository: (repoId) => repositoryManager.getRepository(repoId),
    isInitialized: () => true,
  });

  const notificationManager = new NotificationManager(new SlackHandler({ db }));
  notificationManager.setSessionExistsCallback((sessionId) =>
    sessionManager.getSession(sessionId) !== undefined
  );

  setSessionManager(sessionManager);
  setRepositoryManager(repositoryManager);
  setNotificationManager(notificationManager);
  resetSystemCapabilities();

  const systemCapabilities = new SystemCapabilitiesService();
  (systemCapabilities as unknown as { capabilities: { vscode: boolean } }).capabilities = {
    vscode: true,
  };
  (systemCapabilities as unknown as { vscodeCommand: string | null }).vscodeCommand = 'code';
  setSystemCapabilities(systemCapabilities);

  // Initialize inbound integration
  const inboundIntegration = initializeInboundIntegration({
    jobQueue,
    sessionManager,
    repositoryManager,
    broadcastToApp: () => {},
  });

  appContext = {
    db,
    jobQueue,
    sessionRepository,
    sessionManager,
    repositoryManager,
    notificationManager,
    inboundIntegration,
    systemCapabilities,
  };

  // Reset PTY tracking
  mockPtyInstances.length = 0;
  nextPtyPid = 10000;

  // Reset process tracking
  resetProcessMock();

  // Reset git mocks
  resetGitMocks();

  // Reset open mock
  mockOpen.mockClear();
}

/**
 * Cleans up the test environment.
 * Must be called in afterEach with await.
 */
export async function cleanupTestEnvironment(): Promise<void> {
  // Reset job queue first (not handled by shutdownAppContext)
  await resetJobQueue();

  // Shutdown AppContext which handles:
  // - Stopping job queue
  // - Disposing notification manager
  // - Closing database
  // - Resetting singletons (SessionManager, RepositoryManager, AgentManager, NotificationServices)
  if (appContext) {
    await shutdownAppContext(appContext, { resetSingletons: true });
    appContext = null;
  }

  // Clean up test database if it wasn't part of AppContext
  if (db) {
    await db.destroy();
    db = null;
  }

  cleanupMemfs();
}

/**
 * Creates a fresh Hono app instance with all routes configured.
 * Uses cache-busting import to ensure fresh service instances.
 */
export async function createTestApp(): Promise<Hono<AppBindings>> {
  const suffix = `?v=${++importCounter}`;
  const { api } = await import(`../routes/api.js${suffix}`);
  const { onApiError } = await import(`../lib/error-handler.js${suffix}`);

  const app = new Hono<AppBindings>();
  const context = appContext;
  if (context) {
    app.use('*', async (c, next) => {
      c.set('appContext', context);
      await next();
    });
  }
  app.onError(onApiError);
  app.route('/api', api);
  return app;
}

/**
 * Gets the test config directory path.
 */
export function getTestConfigDir(): string {
  return TEST_CONFIG_DIR;
}
