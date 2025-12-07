import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';

// Create mock PTY factory with different start PID to avoid conflicts
const ptyFactory = createMockPtyFactory(20000);

// Mock node-pty
vi.mock('node-pty', () => ptyFactory.createMock());

// Mock env filter
vi.mock('../env-filter.js', () => ({
  getChildProcessEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
}));

describe('ShellManager', () => {
  beforeEach(() => {
    vi.resetModules();
    ptyFactory.reset();
  });

  describe('createShell', () => {
    it('should create a new shell and return id', async () => {
      const { shellManager } = await import('../shell-manager.js');

      const id = shellManager.createShell('/test/cwd', vi.fn(), vi.fn());

      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
    });

    it('should spawn PTY with correct options', async () => {
      const pty = await import('node-pty');
      const { shellManager } = await import('../shell-manager.js');

      shellManager.createShell('/test/cwd', vi.fn(), vi.fn());

      expect(vi.mocked(pty.spawn)).toHaveBeenCalled();
      const callArgs = vi.mocked(pty.spawn).mock.calls[0];
      expect(callArgs[2]).toMatchObject({ cwd: '/test/cwd' });
    });

    it('should call onData callback when PTY outputs data', async () => {
      const { shellManager } = await import('../shell-manager.js');

      const onData = vi.fn();
      shellManager.createShell('/test/cwd', onData, vi.fn());

      // Simulate PTY output
      ptyFactory.instances[0].simulateData('Hello from shell');

      expect(onData).toHaveBeenCalledWith('Hello from shell');
    });

    it('should call onExit callback when PTY exits', async () => {
      const { shellManager } = await import('../shell-manager.js');

      const onExit = vi.fn();
      const id = shellManager.createShell('/test/cwd', vi.fn(), onExit);

      // Simulate PTY exit
      ptyFactory.instances[0].simulateExit(0);

      expect(onExit).toHaveBeenCalledWith(0, null);

      // Shell should be removed from map
      expect(shellManager.getShell(id)).toBeUndefined();
    });

    it('should remove shell from map on exit', async () => {
      const { shellManager } = await import('../shell-manager.js');

      const id = shellManager.createShell('/test/cwd', vi.fn(), vi.fn());
      expect(shellManager.getShell(id)).toBeDefined();

      // Simulate exit
      ptyFactory.instances[0].simulateExit(0);

      expect(shellManager.getShell(id)).toBeUndefined();
    });
  });

  describe('writeInput', () => {
    it('should write input to PTY', async () => {
      const { shellManager } = await import('../shell-manager.js');

      const id = shellManager.createShell('/test/cwd', vi.fn(), vi.fn());
      shellManager.writeInput(id, 'ls -la\n');

      expect(ptyFactory.instances[0].writtenData).toContain('ls -la\n');
    });

    it('should not throw for non-existent shell', async () => {
      const { shellManager } = await import('../shell-manager.js');

      // Should not throw
      expect(() => {
        shellManager.writeInput('non-existent', 'test');
      }).not.toThrow();
    });
  });

  describe('resize', () => {
    it('should resize PTY', async () => {
      const { shellManager } = await import('../shell-manager.js');

      const id = shellManager.createShell('/test/cwd', vi.fn(), vi.fn());
      shellManager.resize(id, 80, 24);

      expect(ptyFactory.instances[0].currentCols).toBe(80);
      expect(ptyFactory.instances[0].currentRows).toBe(24);
    });

    it('should not throw for non-existent shell', async () => {
      const { shellManager } = await import('../shell-manager.js');

      // Should not throw
      expect(() => {
        shellManager.resize('non-existent', 80, 24);
      }).not.toThrow();
    });
  });

  describe('destroyShell', () => {
    it('should kill PTY and remove from map', async () => {
      const { shellManager } = await import('../shell-manager.js');

      const id = shellManager.createShell('/test/cwd', vi.fn(), vi.fn());
      expect(shellManager.getShell(id)).toBeDefined();

      shellManager.destroyShell(id);

      expect(ptyFactory.instances[0].killed).toBe(true);
      expect(shellManager.getShell(id)).toBeUndefined();
    });

    it('should not throw for non-existent shell', async () => {
      const { shellManager } = await import('../shell-manager.js');

      // Should not throw
      expect(() => {
        shellManager.destroyShell('non-existent');
      }).not.toThrow();
    });
  });

  describe('getShell', () => {
    it('should return shell by id', async () => {
      const { shellManager } = await import('../shell-manager.js');

      const id = shellManager.createShell('/test/cwd', vi.fn(), vi.fn());
      const shell = shellManager.getShell(id);

      expect(shell).toBeDefined();
      expect(shell?.id).toBe(id);
      expect(shell?.cwd).toBe('/test/cwd');
    });

    it('should return undefined for non-existent shell', async () => {
      const { shellManager } = await import('../shell-manager.js');

      const shell = shellManager.getShell('non-existent');
      expect(shell).toBeUndefined();
    });
  });
});
