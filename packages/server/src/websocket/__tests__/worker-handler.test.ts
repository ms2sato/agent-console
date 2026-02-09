import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { WSContext } from 'hono/ws';
import { createWorkerMessageHandler, type WorkerHandlerDependencies } from '../worker-handler.js';

describe('Worker Handler', () => {
  let mockWs: WSContext;
  let mockSessionManager: WorkerHandlerDependencies['sessionManager'];
  let mockMkdir: ReturnType<typeof mock>;
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
    mockMkdir = mock(() => Promise.resolve(undefined));

    // Create handler with mocked dependencies
    handleWorkerMessage = createWorkerMessageHandler({
      sessionManager: mockSessionManager,
      mkdir: mockMkdir as unknown as WorkerHandlerDependencies['mkdir'],
      tmpdir: () => '/tmp/test',
    });
  });

  describe('handleWorkerMessage', () => {
    it('should handle input message', async () => {
      const message = JSON.stringify({ type: 'input', data: 'hello world' });
      await handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      expect(mockSessionManager.writeWorkerInput).toHaveBeenCalledWith('test-session', 'worker-1', 'hello world');
    });

    it('should handle resize message', async () => {
      const message = JSON.stringify({ type: 'resize', cols: 80, rows: 24 });
      await handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      expect(mockSessionManager.resizeWorker).toHaveBeenCalledWith('test-session', 'worker-1', 80, 24);
    });

    it('should handle image message', async () => {
      // Base64 encoded small PNG
      const base64Image = 'iVBORw0KGgo='; // minimal base64 data
      const message = JSON.stringify({
        type: 'image',
        data: base64Image,
        mimeType: 'image/png',
      });

      await handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      // Should write file path to session
      expect(mockSessionManager.writeWorkerInput).toHaveBeenCalled();
      const writtenPath = (mockSessionManager.writeWorkerInput as ReturnType<typeof mock>).mock.calls[0][2];
      expect(writtenPath).toContain('.png');
    });

    it('should handle ArrayBuffer message', async () => {
      const message = new TextEncoder().encode(
        JSON.stringify({ type: 'input', data: 'test' })
      ).buffer;
      await handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      expect(mockSessionManager.writeWorkerInput).toHaveBeenCalledWith('test-session', 'worker-1', 'test');
    });

    it('should handle invalid JSON gracefully', async () => {
      // Should not throw
      await expect(
        handleWorkerMessage(mockWs, 'test-session', 'worker-1', 'not valid json')
      ).resolves.toBeUndefined();
    });

    it('should handle unknown message type gracefully', async () => {
      const message = JSON.stringify({ type: 'unknown', data: 'test' });
      await handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      // Should not call any methods
      expect(mockSessionManager.writeWorkerInput).not.toHaveBeenCalled();
      expect(mockSessionManager.resizeWorker).not.toHaveBeenCalled();
    });

    it('should handle request-history message', async () => {
      const message = JSON.stringify({ type: 'request-history' });
      await handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      // request-history is handled in routes.ts, not in worker-handler
      // This test verifies that the message passes validation without error
      // Should not call any methods (not processed by worker-handler)
      expect(mockSessionManager.writeWorkerInput).not.toHaveBeenCalled();
      expect(mockSessionManager.resizeWorker).not.toHaveBeenCalled();
    });
  });

  describe('getExtensionFromMimeType (via image handling)', () => {
    it('should use correct extension for different mime types', async () => {
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
        await handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

        const writtenPath = (mockSessionManager.writeWorkerInput as ReturnType<typeof mock>).mock.calls[0][2];
        expect(writtenPath).toContain(expectedExt);
      }
    });

    it('should reject unknown mime type for security', async () => {
      const message = JSON.stringify({
        type: 'image',
        data: 'dGVzdA==',
        mimeType: 'image/unknown',
      });
      await handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      // Unknown mime types should be rejected (no file written, no input sent)
      expect(mockSessionManager.writeWorkerInput).not.toHaveBeenCalled();
    });
  });
});
