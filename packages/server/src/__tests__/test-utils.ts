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
 *   setupTestEnvironment();
 *   app = await createTestApp();
 * });
 *
 * afterEach(() => {
 *   cleanupTestEnvironment();
 * });
 * ```
 */
import { Hono } from 'hono';
import { mock } from 'bun:test';
import { MockPty } from './utils/mock-pty.js';

// Import mock helpers - this sets up mock.module calls
import { setupMemfs, cleanupMemfs } from './utils/mock-fs-helper.js';
import { resetProcessMock } from './utils/mock-process-helper.js';

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
 */
export function setupTestEnvironment(): void {
  setupMemfs({
    [`${TEST_CONFIG_DIR}/.keep`]: '',
    [`${TEST_CONFIG_DIR}/agents.json`]: JSON.stringify([]),
    [`${TEST_CONFIG_DIR}/sessions.json`]: JSON.stringify([]),
    [`${TEST_CONFIG_DIR}/repositories.json`]: JSON.stringify([]),
  });
  process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

  // Reset PTY tracking
  mockPtyInstances.length = 0;
  nextPtyPid = 10000;

  // Reset process tracking
  resetProcessMock();

  // Reset open mock
  mockOpen.mockClear();
}

/**
 * Cleans up the test environment.
 */
export function cleanupTestEnvironment(): void {
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
