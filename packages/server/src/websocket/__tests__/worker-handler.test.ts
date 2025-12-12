import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { WSContext } from 'hono/ws';
import { createWorkerMessageHandler, type WorkerHandlerDependencies } from '../worker-handler.js';

describe('Worker Handler', () => {
  let mockWs: WSContext;
  let mockSessionManager: WorkerHandlerDependencies['sessionManager'];
  let mockWriteFileSync: ReturnType<typeof mock>;
  let mockMkdirSync: ReturnType<typeof mock>;
  let handleWorkerMessage: ReturnType<typeof createWorkerMessageHandler>;

  beforeEach(() => {
    // Create mock WebSocket context
    mockWs = {
      send: mock(),
      close: mock(),
      readyState: 1, // OPEN
    } as unknown as WSContext;

    // Create mock session manager
    mockSessionManager = {
      writeWorkerInput: mock(),
      resizeWorker: mock(),
    };

    // Create mock fs functions
    mockWriteFileSync = mock();
    mockMkdirSync = mock();

    // Create handler with mocked dependencies
    handleWorkerMessage = createWorkerMessageHandler({
      sessionManager: mockSessionManager,
      writeFileSync: mockWriteFileSync as unknown as WorkerHandlerDependencies['writeFileSync'],
      mkdirSync: mockMkdirSync as unknown as WorkerHandlerDependencies['mkdirSync'],
      tmpdir: () => '/tmp/test',
    });
  });

  describe('handleWorkerMessage', () => {
    it('should handle input message', () => {
      const message = JSON.stringify({ type: 'input', data: 'hello world' });
      handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      expect(mockSessionManager.writeWorkerInput).toHaveBeenCalledWith('test-session', 'worker-1', 'hello world');
    });

    it('should handle resize message', () => {
      const message = JSON.stringify({ type: 'resize', cols: 80, rows: 24 });
      handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      expect(mockSessionManager.resizeWorker).toHaveBeenCalledWith('test-session', 'worker-1', 80, 24);
    });

    it('should handle image message', () => {
      // Base64 encoded small PNG
      const base64Image = 'iVBORw0KGgo='; // minimal base64 data
      const message = JSON.stringify({
        type: 'image',
        data: base64Image,
        mimeType: 'image/png',
      });

      handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      // Should write file
      expect(mockWriteFileSync).toHaveBeenCalled();

      // Should write file path to session
      expect(mockSessionManager.writeWorkerInput).toHaveBeenCalled();
      const writtenPath = (mockSessionManager.writeWorkerInput as ReturnType<typeof mock>).mock.calls[0][2];
      expect(writtenPath).toContain('.png');
    });

    it('should handle ArrayBuffer message', () => {
      const message = new TextEncoder().encode(
        JSON.stringify({ type: 'input', data: 'test' })
      ).buffer;
      handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      expect(mockSessionManager.writeWorkerInput).toHaveBeenCalledWith('test-session', 'worker-1', 'test');
    });

    it('should handle invalid JSON gracefully', () => {
      // Should not throw
      expect(() => {
        handleWorkerMessage(mockWs, 'test-session', 'worker-1', 'not valid json');
      }).not.toThrow();
    });

    it('should handle unknown message type gracefully', () => {
      const message = JSON.stringify({ type: 'unknown', data: 'test' });
      handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      // Should not call any methods
      expect(mockSessionManager.writeWorkerInput).not.toHaveBeenCalled();
      expect(mockSessionManager.resizeWorker).not.toHaveBeenCalled();
    });
  });

  describe('getExtensionFromMimeType (via image handling)', () => {
    it('should use correct extension for different mime types', () => {
      const testCases = [
        { mimeType: 'image/png', expectedExt: '.png' },
        { mimeType: 'image/jpeg', expectedExt: '.jpg' },
        { mimeType: 'image/gif', expectedExt: '.gif' },
        { mimeType: 'image/webp', expectedExt: '.webp' },
        { mimeType: 'image/bmp', expectedExt: '.bmp' },
      ];

      for (const { mimeType, expectedExt } of testCases) {
        // Reset mock
        (mockSessionManager.writeWorkerInput as ReturnType<typeof mock>).mockClear();

        const message = JSON.stringify({
          type: 'image',
          data: 'dGVzdA==', // base64 for "test"
          mimeType,
        });
        handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

        const writtenPath = (mockSessionManager.writeWorkerInput as ReturnType<typeof mock>).mock.calls[0][2];
        expect(writtenPath).toContain(expectedExt);
      }
    });

    it('should fallback to png for unknown mime type', () => {
      const message = JSON.stringify({
        type: 'image',
        data: 'dGVzdA==',
        mimeType: 'image/unknown',
      });
      handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      const writtenPath = (mockSessionManager.writeWorkerInput as ReturnType<typeof mock>).mock.calls[0][2];
      expect(writtenPath).toContain('.png');
    });
  });
});
