import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';

// Mock open package BEFORE importing mock-fs-helper
// The open package internally uses fs and needs to be mocked first
const mockOpen = mock(async () => {});
mock.module('open', () => ({
  default: mockOpen,
}));

// Import mock-fs-helper to set up memfs mocks
import { setupMemfs, cleanupMemfs } from './utils/mock-fs-helper.js';
import {
  SystemCapabilitiesService,
  setSystemCapabilities,
  resetSystemCapabilities,
} from '../services/system-capabilities-service.js';

// Track Bun.spawn calls for VS Code
const spawnCalls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
const originalBunSpawn = Bun.spawn;

/**
 * Create an empty ReadableStream for stdout/stderr.
 */
function createEmptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

// Mock Bun.spawn for VS Code launch
function setupSpawnMock() {
  (Bun as { spawn: typeof Bun.spawn }).spawn = ((
    args: string[],
    options?: Record<string, unknown>
  ) => {
    spawnCalls.push({ args, options: options || {} });
    return {
      exited: Promise.resolve(0),
      stdout: createEmptyStream(),
      stderr: createEmptyStream(),
      kill: () => {},
    };
  }) as typeof Bun.spawn;
}

// Import counter for cache busting
let importCounter = 0;

describe('System API - open-in-vscode', () => {
  beforeEach(() => {
    // Reset spawn tracking
    spawnCalls.length = 0;
    setupSpawnMock();

    // Reset system capabilities singleton
    resetSystemCapabilities();

    // Setup basic memfs
    setupMemfs({
      '/test/existing-dir/.keep': '',
      '/test/existing-file.txt': 'content',
    });
  });

  afterEach(() => {
    cleanupMemfs();
    resetSystemCapabilities();
    (Bun as { spawn: typeof Bun.spawn }).spawn = originalBunSpawn;
  });

  // Helper to create app with mocked system capabilities
  async function createApp(vscodeAvailable: boolean, vscodeCommand: 'code' | 'code-insiders' | null = 'code') {
    const suffix = `?v=${++importCounter}`;

    // Set up mock system capabilities
    const mockCapabilities = new SystemCapabilitiesService();
    // Manually set capabilities to avoid running which command
    (mockCapabilities as unknown as { capabilities: { vscode: boolean } }).capabilities = {
      vscode: vscodeAvailable,
    };
    (mockCapabilities as unknown as { vscodeCommand: string | null }).vscodeCommand = vscodeAvailable
      ? vscodeCommand
      : null;
    setSystemCapabilities(mockCapabilities);

    const { system } = await import(`../routes/system.js${suffix}`);
    const { onApiError } = await import(`../lib/error-handler.js${suffix}`);

    const app = new Hono();
    app.onError(onApiError);
    app.route('/api/system', system);
    return app;
  }

  describe('POST /api/system/open-in-vscode', () => {
    it('should open a directory in VS Code when available', async () => {
      const app = await createApp(true, 'code');

      const res = await app.request('/api/system/open-in-vscode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/test/existing-dir' }),
      });

      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);

      // Verify Bun.spawn was called with VS Code command
      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].args).toEqual(['code', '/test/existing-dir']);
    });

    it('should open a file in VS Code when available', async () => {
      const app = await createApp(true, 'code');

      const res = await app.request('/api/system/open-in-vscode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/test/existing-file.txt' }),
      });

      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);

      // Verify Bun.spawn was called with VS Code command
      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].args).toEqual(['code', '/test/existing-file.txt']);
    });

    it('should use code-insiders when that is the available command', async () => {
      const app = await createApp(true, 'code-insiders');

      const res = await app.request('/api/system/open-in-vscode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/test/existing-dir' }),
      });

      expect(res.status).toBe(200);

      // Verify code-insiders was used
      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].args).toEqual(['code-insiders', '/test/existing-dir']);
    });

    it('should return 400 when VS Code is not available', async () => {
      const app = await createApp(false);

      const res = await app.request('/api/system/open-in-vscode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/test/existing-dir' }),
      });

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('VS Code is not available');

      // Verify Bun.spawn was NOT called
      expect(spawnCalls.length).toBe(0);
    });

    it('should return 404 when path does not exist', async () => {
      const app = await createApp(true, 'code');

      const res = await app.request('/api/system/open-in-vscode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/non-existent/path' }),
      });

      expect(res.status).toBe(404);

      // Verify Bun.spawn was NOT called
      expect(spawnCalls.length).toBe(0);
    });

    it('should return 400 when path is missing', async () => {
      const app = await createApp(true, 'code');

      const res = await app.request('/api/system/open-in-vscode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('should return 400 when path is whitespace only', async () => {
      const app = await createApp(true, 'code');

      const res = await app.request('/api/system/open-in-vscode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '   ' }),
      });

      expect(res.status).toBe(400);
    });

    it('should return 400 when path is empty string', async () => {
      const app = await createApp(true, 'code');

      const res = await app.request('/api/system/open-in-vscode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '' }),
      });

      expect(res.status).toBe(400);
    });
  });
});
