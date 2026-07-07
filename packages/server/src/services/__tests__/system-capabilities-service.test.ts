import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import type { ServerConfig } from '../../lib/server-config.js';

// Store original Bun.spawn to restore after tests
const originalBunSpawn = Bun.spawn;

/**
 * Minimal ServerConfig-shaped stub for VS Code capability resolution.
 * Only fields consumed by SystemCapabilitiesService need to be provided.
 */
function makeConfig(overrides: {
  VSCODE_OPEN_MODE?: 'local-spawn' | 'remote-url-scheme';
  VSCODE_REMOTE_HOST?: string;
  AUTH_MODE?: 'none' | 'multi-user';
}): Pick<ServerConfig, 'VSCODE_OPEN_MODE' | 'VSCODE_REMOTE_HOST' | 'AUTH_MODE'> {
  return {
    VSCODE_OPEN_MODE: overrides.VSCODE_OPEN_MODE,
    VSCODE_REMOTE_HOST: overrides.VSCODE_REMOTE_HOST,
    AUTH_MODE: overrides.AUTH_MODE ?? 'none',
  };
}

// Track which commands should be "available"
let availableCommands: Set<string> = new Set();

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

// Mock Bun.spawn to simulate 'which' command behavior
function setupSpawnMock() {
  (Bun as { spawn: typeof Bun.spawn }).spawn = ((
    args: string[],
    _options?: Record<string, unknown>
  ) => {
    // Only handle 'which' commands
    if (args[0] === 'which' && args.length === 2) {
      const command = args[1];
      const isAvailable = availableCommands.has(command);
      return {
        exited: Promise.resolve(isAvailable ? 0 : 1),
        stdout: createEmptyStream(),
        stderr: createEmptyStream(),
        kill: () => {},
      };
    }
    // For other commands, return failure
    return {
      exited: Promise.resolve(1),
      stdout: createEmptyStream(),
      stderr: createEmptyStream(),
      kill: () => {},
    };
  }) as typeof Bun.spawn;
}

// Import counter for cache busting
let importCounter = 0;

describe('SystemCapabilitiesService', () => {
  beforeEach(() => {
    // Reset available commands
    availableCommands = new Set();
    setupSpawnMock();
  });

  afterAll(() => {
    // Restore original Bun.spawn
    (Bun as { spawn: typeof Bun.spawn }).spawn = originalBunSpawn;
  });

  async function getService(configOverrides: Parameters<typeof makeConfig>[0] = {}) {
    const module = await import(`../system-capabilities-service.js?v=${++importCounter}`);
    return new module.SystemCapabilitiesService(makeConfig(configOverrides));
  }

  describe('detect()', () => {
    it('should set vscode to true when code command exists', async () => {
      availableCommands.add('code');

      const service = await getService();
      await service.detect();

      expect(service.hasVSCode()).toBe(true);
      expect(service.getVSCodeCommand()).toBe('code');
    });

    it('should set vscode to true when code-insiders command exists', async () => {
      availableCommands.add('code-insiders');

      const service = await getService();
      await service.detect();

      expect(service.hasVSCode()).toBe(true);
      expect(service.getVSCodeCommand()).toBe('code-insiders');
    });

    it('should prefer code over code-insiders when both exist', async () => {
      availableCommands.add('code');
      availableCommands.add('code-insiders');

      const service = await getService();
      await service.detect();

      expect(service.hasVSCode()).toBe(true);
      expect(service.getVSCodeCommand()).toBe('code');
    });

    it('should fallback to code-insiders when code is not available', async () => {
      // Only code-insiders available, not code
      availableCommands.add('code-insiders');

      const service = await getService();
      await service.detect();

      expect(service.hasVSCode()).toBe(true);
      expect(service.getVSCodeCommand()).toBe('code-insiders');
    });

    it('should set vscode to false when neither command exists', async () => {
      // No commands available

      const service = await getService();
      await service.detect();

      expect(service.hasVSCode()).toBe(false);
      expect(service.getVSCodeCommand()).toBe(null);
    });
  });

  describe('hasVSCode()', () => {
    it('should return true when VS Code is available', async () => {
      availableCommands.add('code');

      const service = await getService();
      await service.detect();

      expect(service.hasVSCode()).toBe(true);
    });

    it('should return false when VS Code is not available', async () => {
      const service = await getService();
      await service.detect();

      expect(service.hasVSCode()).toBe(false);
    });

    it('should return false before detect() is called', async () => {
      const service = await getService();
      // Do not call detect()

      expect(service.hasVSCode()).toBe(false);
    });
  });

  describe('getVSCodeCommand()', () => {
    it('should return code when code command is available', async () => {
      availableCommands.add('code');

      const service = await getService();
      await service.detect();

      expect(service.getVSCodeCommand()).toBe('code');
    });

    it('should return code-insiders when only code-insiders is available', async () => {
      availableCommands.add('code-insiders');

      const service = await getService();
      await service.detect();

      expect(service.getVSCodeCommand()).toBe('code-insiders');
    });

    it('should return null when VS Code is not available', async () => {
      const service = await getService();
      await service.detect();

      expect(service.getVSCodeCommand()).toBe(null);
    });

    it('should return null before detect() is called', async () => {
      const service = await getService();
      // Do not call detect()

      expect(service.getVSCodeCommand()).toBe(null);
    });
  });

  describe('getCapabilities()', () => {
    it('should return capabilities after detect() is called', async () => {
      availableCommands.add('code');

      const service = await getService();
      await service.detect();

      const capabilities = service.getCapabilities();
      expect(capabilities.vscode).toBe(true);
    });

    it('should throw error if detect() has not been called', async () => {
      const service = await getService();

      expect(() => service.getCapabilities()).toThrow(
        'SystemCapabilitiesService not initialized. Call detect() first.'
      );
    });
  });

  // =========================================================================
  // vscodeOpenMode resolution
  // =========================================================================

  describe('vscodeOpenMode', () => {
    it('honors VSCODE_OPEN_MODE=local-spawn regardless of AUTH_MODE', async () => {
      const service = await getService({
        VSCODE_OPEN_MODE: 'local-spawn',
        AUTH_MODE: 'multi-user',
      });
      await service.detect();

      expect(service.getVSCodeOpenMode()).toBe('local-spawn');
      expect(service.getCapabilities().vscodeOpenMode).toBe('local-spawn');
    });

    it('honors VSCODE_OPEN_MODE=remote-url-scheme regardless of AUTH_MODE', async () => {
      const service = await getService({
        VSCODE_OPEN_MODE: 'remote-url-scheme',
        AUTH_MODE: 'none',
      });
      await service.detect();

      expect(service.getVSCodeOpenMode()).toBe('remote-url-scheme');
    });

    it('defaults to remote-url-scheme when AUTH_MODE=multi-user and VSCODE_OPEN_MODE unset', async () => {
      const service = await getService({ AUTH_MODE: 'multi-user' });
      await service.detect();

      expect(service.getVSCodeOpenMode()).toBe('remote-url-scheme');
    });

    it('defaults to local-spawn when AUTH_MODE=none and VSCODE_OPEN_MODE unset', async () => {
      const service = await getService({ AUTH_MODE: 'none' });
      await service.detect();

      expect(service.getVSCodeOpenMode()).toBe('local-spawn');
    });

    it('reports vscode=true in remote-url-scheme mode even when no local binary exists', async () => {
      // No commands available on the server host
      const service = await getService({ VSCODE_OPEN_MODE: 'remote-url-scheme' });
      await service.detect();

      expect(service.hasVSCode()).toBe(true);
      expect(service.getCapabilities().vscode).toBe(true);
      // vscodeCommand still reflects the local detection result (null here);
      // the REST guard uses vscodeOpenMode, not vscodeCommand, to reject.
      expect(service.getVSCodeCommand()).toBe(null);
    });

    it('reports vscode=false in local-spawn mode when no local binary exists', async () => {
      const service = await getService({ VSCODE_OPEN_MODE: 'local-spawn' });
      await service.detect();

      expect(service.hasVSCode()).toBe(false);
      expect(service.getCapabilities().vscode).toBe(false);
    });

    it('reports vscode=true in local-spawn mode when a local binary exists', async () => {
      availableCommands.add('code');

      const service = await getService({ VSCODE_OPEN_MODE: 'local-spawn' });
      await service.detect();

      expect(service.hasVSCode()).toBe(true);
      expect(service.getVSCodeCommand()).toBe('code');
    });

    it('getVSCodeOpenMode() throws before detect()', async () => {
      const service = await getService();

      expect(() => service.getVSCodeOpenMode()).toThrow(
        'SystemCapabilitiesService not initialized. Call detect() first.'
      );
    });
  });

  // =========================================================================
  // vscodeRemoteHost resolution
  // =========================================================================

  describe('vscodeRemoteHost', () => {
    it('surfaces VSCODE_REMOTE_HOST when set', async () => {
      const service = await getService({
        VSCODE_OPEN_MODE: 'remote-url-scheme',
        VSCODE_REMOTE_HOST: 'dev.example.com',
      });
      await service.detect();

      expect(service.getVSCodeRemoteHost()).toBe('dev.example.com');
      expect(service.getCapabilities().vscodeRemoteHost).toBe('dev.example.com');
    });

    it('returns null when VSCODE_REMOTE_HOST is unset', async () => {
      const service = await getService({ VSCODE_OPEN_MODE: 'remote-url-scheme' });
      await service.detect();

      expect(service.getVSCodeRemoteHost()).toBe(null);
      expect(service.getCapabilities().vscodeRemoteHost).toBe(null);
    });

    it('getVSCodeRemoteHost() throws before detect()', async () => {
      const service = await getService();

      expect(() => service.getVSCodeRemoteHost()).toThrow(
        'SystemCapabilitiesService not initialized. Call detect() first.'
      );
    });
  });

});
