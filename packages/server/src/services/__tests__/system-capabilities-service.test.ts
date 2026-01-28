import { describe, it, expect, beforeEach, afterAll } from 'bun:test';

// Store original Bun.spawn to restore after tests
const originalBunSpawn = Bun.spawn;

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

  async function getService() {
    const module = await import(`../system-capabilities-service.js?v=${++importCounter}`);
    return new module.SystemCapabilitiesService();
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

  describe('singleton functions', () => {
    it('should throw when getSystemCapabilities is called before initialization', async () => {
      const module = await import(`../system-capabilities-service.js?v=${++importCounter}`);
      module.resetSystemCapabilities();

      expect(() => module.getSystemCapabilities()).toThrow(
        'SystemCapabilitiesService not initialized'
      );
    });

    it('should return instance after setSystemCapabilities is called', async () => {
      const module = await import(`../system-capabilities-service.js?v=${++importCounter}`);
      module.resetSystemCapabilities();

      const service = new module.SystemCapabilitiesService();
      module.setSystemCapabilities(service);

      expect(module.getSystemCapabilities()).toBe(service);
    });

    it('should throw when setSystemCapabilities is called twice', async () => {
      const module = await import(`../system-capabilities-service.js?v=${++importCounter}`);
      module.resetSystemCapabilities();

      const service1 = new module.SystemCapabilitiesService();
      const service2 = new module.SystemCapabilitiesService();

      module.setSystemCapabilities(service1);

      expect(() => module.setSystemCapabilities(service2)).toThrow(
        'SystemCapabilitiesService already initialized'
      );
    });
  });
});
