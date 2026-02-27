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
import { initializeDatabase, closeDatabase } from '../database/connection.js';
import { getAgentManager, resetAgentManager } from '../services/agent-manager.js';
import { getRepositoryManager, resetRepositoryManager } from '../services/repository-manager.js';
import { getSessionManager, resetSessionManager } from '../services/session-manager.js';
import { getSystemCapabilities } from '../services/system-capabilities-service.js';
import { getJobQueue } from '../jobs/index.js';
import { getNotificationManager } from '../services/notifications/index.js';
import type { AppBindings, AppContext } from '../app-context.js';

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

// Tests use initializeDatabase(':memory:') to get an in-memory database.
// This avoids native file system operations that would bypass memfs.
// migration.test.ts uses real file system with temp directories and
// doesn't import test-utils.ts, so it's not affected by this setup.

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
  setupMemfs({
    [`${TEST_CONFIG_DIR}/.keep`]: '',
  });
  process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

  // Initialize in-memory database (bypasses native file operations)
  await initializeDatabase(':memory:');

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
  // Reset singleton managers BEFORE closing database
  // to ensure they don't hold references to destroyed DB connections
  resetSessionManager();
  resetRepositoryManager();
  resetAgentManager();
  await closeDatabase();
  cleanupMemfs();
}

/**
 * Safely retrieves a singleton that may not be initialized.
 * Returns undefined instead of throwing if the getter fails.
 */
function safeGet<T>(getter: () => T): T | undefined {
  try {
    return getter();
  } catch {
    return undefined;
  }
}

/**
 * Creates a fresh Hono app instance with all routes configured.
 * Uses cache-busting import to ensure fresh service instances.
 */
export async function createTestApp(): Promise<Hono<AppBindings>> {
  const suffix = `?v=${++importCounter}`;
  const { api } = await import(`../routes/api.js${suffix}`);
  const { onApiError } = await import(`../lib/error-handler.js${suffix}`);

  // Build partial AppContext from available singletons.
  // Tests only initialize the services they need, so we safely
  // retrieve each one (undefined if not yet initialized).
  const appContext = {
    sessionManager: safeGet(getSessionManager),
    repositoryManager: safeGet(getRepositoryManager),
    systemCapabilities: safeGet(getSystemCapabilities),
    notificationManager: safeGet(getNotificationManager),
    jobQueue: safeGet(getJobQueue),
    agentManager: await getAgentManager().catch(() => undefined),
  } as unknown as AppContext;

  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('appContext', appContext);
    await next();
  });
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
