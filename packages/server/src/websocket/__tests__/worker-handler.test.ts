import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WSContext } from 'hono/ws';

// Mock session manager
vi.mock('../../services/session-manager.js', () => ({
  sessionManager: {
    getSession: vi.fn(),
    getWorkerOutputBuffer: vi.fn(() => ''),
    writeWorkerInput: vi.fn(),
    resizeWorker: vi.fn(),
    createSession: vi.fn(),
    attachWorkerCallbacks: vi.fn(),
  },
}));

// Mock fs for image handling tests
vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe('Worker Handler', () => {
  let mockWs: WSContext;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    // Create mock WebSocket context
    mockWs = {
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1, // OPEN
    } as unknown as WSContext;
  });

  describe('handleWorkerMessage', () => {
    it('should handle input message', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');
      const { handleWorkerMessage } = await import('../worker-handler.js');

      const message = JSON.stringify({ type: 'input', data: 'hello world' });
      handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      expect(sessionManager.writeWorkerInput).toHaveBeenCalledWith('test-session', 'worker-1', 'hello world');
    });

    it('should handle resize message', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');
      const { handleWorkerMessage } = await import('../worker-handler.js');

      const message = JSON.stringify({ type: 'resize', cols: 80, rows: 24 });
      handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      expect(sessionManager.resizeWorker).toHaveBeenCalledWith('test-session', 'worker-1', 80, 24);
    });

    it('should handle image message', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');
      const fs = await import('node:fs');
      const { handleWorkerMessage } = await import('../worker-handler.js');

      // Base64 encoded small PNG
      const base64Image = 'iVBORw0KGgo='; // minimal base64 data
      const message = JSON.stringify({
        type: 'image',
        data: base64Image,
        mimeType: 'image/png',
      });

      handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      // Should write file
      expect(fs.writeFileSync).toHaveBeenCalled();

      // Should write file path to session
      expect(sessionManager.writeWorkerInput).toHaveBeenCalled();
      const writtenPath = vi.mocked(sessionManager.writeWorkerInput).mock.calls[0][2];
      expect(writtenPath).toContain('.png');
    });

    it('should handle ArrayBuffer message', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');
      const { handleWorkerMessage } = await import('../worker-handler.js');

      const message = new TextEncoder().encode(
        JSON.stringify({ type: 'input', data: 'test' })
      ).buffer;
      handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      expect(sessionManager.writeWorkerInput).toHaveBeenCalledWith('test-session', 'worker-1', 'test');
    });

    it('should handle invalid JSON gracefully', async () => {
      const { handleWorkerMessage } = await import('../worker-handler.js');

      // Should not throw
      expect(() => {
        handleWorkerMessage(mockWs, 'test-session', 'worker-1', 'not valid json');
      }).not.toThrow();
    });

    it('should handle unknown message type gracefully', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');
      const { handleWorkerMessage } = await import('../worker-handler.js');

      const message = JSON.stringify({ type: 'unknown', data: 'test' });
      handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      // Should not call any methods
      expect(sessionManager.writeWorkerInput).not.toHaveBeenCalled();
      expect(sessionManager.resizeWorker).not.toHaveBeenCalled();
    });
  });

  describe('getExtensionFromMimeType (via image handling)', () => {
    it('should use correct extension for different mime types', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');
      const { handleWorkerMessage } = await import('../worker-handler.js');

      const testCases = [
        { mimeType: 'image/png', expectedExt: '.png' },
        { mimeType: 'image/jpeg', expectedExt: '.jpg' },
        { mimeType: 'image/gif', expectedExt: '.gif' },
        { mimeType: 'image/webp', expectedExt: '.webp' },
        { mimeType: 'image/bmp', expectedExt: '.bmp' },
      ];

      for (const { mimeType, expectedExt } of testCases) {
        vi.mocked(sessionManager.writeWorkerInput).mockClear();

        const message = JSON.stringify({
          type: 'image',
          data: 'dGVzdA==', // base64 for "test"
          mimeType,
        });
        handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

        const writtenPath = vi.mocked(sessionManager.writeWorkerInput).mock.calls[0][2];
        expect(writtenPath).toContain(expectedExt);
      }
    });

    it('should fallback to png for unknown mime type', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');
      const { handleWorkerMessage } = await import('../worker-handler.js');

      const message = JSON.stringify({
        type: 'image',
        data: 'dGVzdA==',
        mimeType: 'image/unknown',
      });
      handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      const writtenPath = vi.mocked(sessionManager.writeWorkerInput).mock.calls[0][2];
      expect(writtenPath).toContain('.png');
    });
  });
});
