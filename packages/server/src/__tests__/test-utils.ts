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
  await closeDatabase();
  cleanupMemfs();
}

/**
 * Creates a fresh Hono app instance with all routes configured.
 * Uses cache-busting import to ensure fresh service instances.
 */
export async function createTestApp(): Promise<Hono> {
  const suffix = `?v=${++importCounter}`;
  const { api } = await import(`../routes/api.js${suffix}`);
  const { onApiError } = await import(`../lib/error-handler.js${suffix}`);

  const app = new Hono();
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
