/**
 * Client-Server Boundary Test: System API
 *
 * Tests that the client API functions call the correct server endpoints.
 * This catches endpoint path mismatches between client and server.
 *
 * Key scenario: openInVSCode must call /api/system/open-in-vscode (not /api/system/open-vscode)
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Hono } from 'hono';

// Import test utilities from server package
import {
  createTestApp,
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';

// Import system capabilities service helpers
import {
  SystemCapabilitiesService,
  setSystemCapabilities,
  resetSystemCapabilities,
} from '@agent-console/server/src/services/system-capabilities-service';

// Import mock-fs-helper to add test paths
import { setupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';

// Import client API functions
import { openInVSCode, openPath } from '@agent-console/client/src/lib/api';

// Import integration test utilities
import { createFetchBridge, findRequest } from './test-utils';

// Track Bun.spawn calls for VS Code
const spawnCalls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
const originalBunSpawn = Bun.spawn;

// Mock Bun.spawn for VS Code launch
function setupSpawnMock() {
  (Bun as { spawn: typeof Bun.spawn }).spawn = ((
    args: string[],
    options?: Record<string, unknown>
  ) => {
    spawnCalls.push({ args, options: options || {} });
    return {
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      kill: () => {},
    };
  }) as typeof Bun.spawn;
}

/**
 * Set up mock system capabilities with VS Code enabled.
 */
function setupMockSystemCapabilities(vscodeAvailable: boolean = true) {
  const mockCapabilities = new SystemCapabilitiesService();
  // Manually set capabilities to avoid running 'which' command
  (mockCapabilities as unknown as { capabilities: { vscode: boolean } }).capabilities = {
    vscode: vscodeAvailable,
  };
  (mockCapabilities as unknown as { vscodeCommand: string | null }).vscodeCommand = vscodeAvailable
    ? 'code'
    : null;
  setSystemCapabilities(mockCapabilities);
}

describe('Client-Server Boundary: System API', () => {
  let app: Hono;
  let bridge: ReturnType<typeof createFetchBridge> | null = null;

  beforeEach(async () => {
    // Reset spawn tracking
    spawnCalls.length = 0;
    setupSpawnMock();

    // Set up test environment (memfs, database, etc.)
    await setupTestEnvironment();

    // Add test paths to memfs - must be done after setupTestEnvironment
    // because setupTestEnvironment resets memfs
    setupMemfs({
      '/test/config/.keep': '',
      '/test/worktree-dir/.keep': '',
      '/test/some-file.txt': 'content',
    });
    process.env.AGENT_CONSOLE_HOME = '/test/config';

    // Set up system capabilities BEFORE creating the app
    // because api.ts calls getSystemCapabilities() at import time for /api/config
    resetSystemCapabilities();
    setupMockSystemCapabilities(true);

    // Create test app with all routes
    app = await createTestApp();

    // Create fetch bridge to capture and forward requests
    bridge = createFetchBridge(app);
  });

  afterEach(async () => {
    bridge?.restore();
    resetSystemCapabilities();
    (Bun as { spawn: typeof Bun.spawn }).spawn = originalBunSpawn;
    await cleanupTestEnvironment();
  });

  describe('openInVSCode', () => {
    it('should call the correct endpoint /api/system/open-in-vscode', async () => {
      // Call the client API function
      await openInVSCode('/test/worktree-dir');

      // Verify the client sent request to the correct endpoint
      const request = findRequest(bridge.capturedRequests, 'POST', '/api/system/open-in-vscode');
      expect(request).toBeDefined();
      expect(request!.url).toBe('/api/system/open-in-vscode');
      expect(request!.method).toBe('POST');
      expect(request!.body).toEqual({ path: '/test/worktree-dir' });

      // Verify Bun.spawn was called (server processed the request)
      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].args).toEqual(['code', '/test/worktree-dir']);
    });

    it('should return error when VS Code is not available', async () => {
      // Reset and set up without VS Code
      resetSystemCapabilities();
      setupMockSystemCapabilities(false);

      // Recreate app with new capabilities
      app = await createTestApp();
      bridge.restore();
      bridge = createFetchBridge(app);

      // Call should throw due to server returning error
      await expect(openInVSCode('/test/worktree-dir')).rejects.toThrow(
        'VS Code is not available on this system'
      );

      // Verify the endpoint was still called correctly
      const request = findRequest(bridge.capturedRequests, 'POST', '/api/system/open-in-vscode');
      expect(request).toBeDefined();
    });

    it('should return error when path does not exist', async () => {
      await expect(openInVSCode('/non-existent/path')).rejects.toThrow();

      // Verify the endpoint was still called correctly
      const request = findRequest(bridge.capturedRequests, 'POST', '/api/system/open-in-vscode');
      expect(request).toBeDefined();
      expect(request!.body).toEqual({ path: '/non-existent/path' });
    });
  });

  describe('openPath', () => {
    it('should call the correct endpoint /api/system/open', async () => {
      // Call the client API function
      await openPath('/test/worktree-dir');

      // Verify the client sent request to the correct endpoint
      const request = findRequest(bridge.capturedRequests, 'POST', '/api/system/open');
      expect(request).toBeDefined();
      expect(request!.url).toBe('/api/system/open');
      expect(request!.method).toBe('POST');
      expect(request!.body).toEqual({ path: '/test/worktree-dir' });
    });

    it('should return error when path does not exist', async () => {
      await expect(openPath('/non-existent/path')).rejects.toThrow();

      // Verify the endpoint was still called correctly
      const request = findRequest(bridge.capturedRequests, 'POST', '/api/system/open');
      expect(request).toBeDefined();
      expect(request!.body).toEqual({ path: '/non-existent/path' });
    });

    it('should handle file path (opens containing directory)', async () => {
      // Call the client API function with a file path
      await openPath('/test/some-file.txt');

      // Verify the client sent request to the correct endpoint
      const request = findRequest(bridge.capturedRequests, 'POST', '/api/system/open');
      expect(request).toBeDefined();
      expect(request!.body).toEqual({ path: '/test/some-file.txt' });
    });
  });
});
