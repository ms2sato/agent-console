import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { WSContext } from 'hono/ws';
import { createWorkerMessageHandler, type WorkerHandlerDependencies } from '../worker-handler.js';

describe('Worker Handler', () => {
  let mockWs: WSContext;
  let mockSessionManager: WorkerHandlerDependencies['sessionManager'];
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

    // Create handler with mocked dependencies
    handleWorkerMessage = createWorkerMessageHandler({
      sessionManager: mockSessionManager,
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

    it('should reject array payloads that pass typeof object check', async () => {
      // Arrays have typeof 'object' but should not be treated as valid message objects
      const message = JSON.stringify([{ type: 'input', data: 'sneaky' }]);
      await handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

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

  describe('validateWorkerMessage', () => {
    it('should reject input message with missing data', async () => {
      const message = JSON.stringify({ type: 'input' });
      await handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      expect(mockSessionManager.writeWorkerInput).not.toHaveBeenCalled();
    });

    it('should reject resize message with missing cols', async () => {
      const message = JSON.stringify({ type: 'resize', rows: 24 });
      await handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      expect(mockSessionManager.resizeWorker).not.toHaveBeenCalled();
    });

    it('should reject resize message with out-of-range dimensions', async () => {
      const message = JSON.stringify({ type: 'resize', cols: 0, rows: 24 });
      await handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      expect(mockSessionManager.resizeWorker).not.toHaveBeenCalled();
    });

    it('should reject resize message with dimensions exceeding maximum', async () => {
      const message = JSON.stringify({ type: 'resize', cols: 1001, rows: 24 });
      await handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      expect(mockSessionManager.resizeWorker).not.toHaveBeenCalled();
    });

    it('should reject null payload', async () => {
      const message = JSON.stringify(null);
      await handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      expect(mockSessionManager.writeWorkerInput).not.toHaveBeenCalled();
      expect(mockSessionManager.resizeWorker).not.toHaveBeenCalled();
    });

    it('should reject message without type field', async () => {
      const message = JSON.stringify({ data: 'hello' });
      await handleWorkerMessage(mockWs, 'test-session', 'worker-1', message);

      expect(mockSessionManager.writeWorkerInput).not.toHaveBeenCalled();
      expect(mockSessionManager.resizeWorker).not.toHaveBeenCalled();
    });
  });
});
