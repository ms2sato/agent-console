import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { WSContext } from 'hono/ws';
import type pino from 'pino';
import { WS_READY_STATE } from '@agent-console/shared';
import { BufferedWebSocketSender } from '../buffered-ws-sender.js';

// Use short flush interval for tests to avoid slow waits
const TEST_FLUSH_INTERVAL = 10; // ms
const TEST_FLUSH_THRESHOLD = 100; // bytes

function createMockWs() {
  return {
    send: mock(),
    close: mock(),
    readyState: WS_READY_STATE.OPEN,
  // WSContext has many required properties (binaryType, url, protocol);
  // mock only provides the subset used by BufferedWebSocketSender
  } as unknown as WSContext & { send: ReturnType<typeof mock>; readyState: number };
}

function createMockLogger() {
  return {
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  };
}

/** Wait for the flush timer to fire */
function waitForFlush(ms = TEST_FLUSH_INTERVAL + 10): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('BufferedWebSocketSender', () => {
  let mockWs: ReturnType<typeof createMockWs>;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let sender: BufferedWebSocketSender;
  let readyState: number | undefined;

  beforeEach(() => {
    mockWs = createMockWs();
    mockLogger = createMockLogger();
    readyState = WS_READY_STATE.OPEN;

    sender = new BufferedWebSocketSender(
      mockWs,
      () => readyState,
      // pino.Logger has many required properties (level, fatal, trace, etc.);
      // mock only provides the subset used by BufferedWebSocketSender
      mockLogger as unknown as pino.Logger,
      'test-worker',
      TEST_FLUSH_INTERVAL,
      TEST_FLUSH_THRESHOLD,
    );
  });

  afterEach(() => {
    sender.dispose();
  });

  describe('output buffering', () => {
    it('should buffer output messages and flush after interval', async () => {
      sender.send({ type: 'output', data: 'hello', offset: 5 });
      sender.send({ type: 'output', data: ' world', offset: 11 });

      // Not yet flushed
      expect(mockWs.send).not.toHaveBeenCalled();

      // Wait for flush timer
      await waitForFlush();

      expect(mockWs.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(mockWs.send.mock.calls[0][0] as string);
      expect(sent).toEqual({ type: 'output', data: 'hello world', offset: 11 });
    });

    it('should flush immediately when buffer exceeds threshold', () => {
      const largeData = 'x'.repeat(TEST_FLUSH_THRESHOLD);
      sender.send({ type: 'output', data: largeData, offset: TEST_FLUSH_THRESHOLD });

      // Should have flushed immediately without waiting for timer
      expect(mockWs.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(mockWs.send.mock.calls[0][0] as string);
      expect(sent.type).toBe('output');
      expect(sent.data.length).toBe(TEST_FLUSH_THRESHOLD);
    });
  });

  describe('send failure handling', () => {
    it('should discard buffer on send failure (data preserved server-side)', async () => {
      mockWs.send.mockImplementation(() => {
        throw new Error('WebSocket send failed');
      });

      sender.send({ type: 'output', data: 'important data', offset: 14 });

      await waitForFlush();

      // send was attempted
      expect(mockWs.send).toHaveBeenCalledTimes(1);

      // Buffer should be cleared (not retried) - data preserved server-side
      // Send new data to verify buffer was cleared
      mockWs.send.mockImplementation(() => {}); // restore
      sender.send({ type: 'output', data: 'new data', offset: 22 });

      await waitForFlush();

      expect(mockWs.send).toHaveBeenCalledTimes(2);
      const sent = JSON.parse(mockWs.send.mock.calls[1][0] as string);
      expect(sent.data).toBe('new data'); // Only new data, not "important data" + "new data"
    });

    it('should not throw when non-output message send fails', () => {
      mockWs.send.mockImplementation(() => {
        throw new Error('WebSocket send failed');
      });

      // Should not propagate the error
      expect(() => {
        sender.send({ type: 'exit', exitCode: 0, signal: null });
      }).not.toThrow();

      // Should have attempted to send
      expect(mockWs.send).toHaveBeenCalledTimes(1);
    });

    it('should discard buffer on threshold-triggered flush failure', () => {
      mockWs.send.mockImplementation(() => {
        throw new Error('WebSocket send failed');
      });

      const largeData = 'x'.repeat(TEST_FLUSH_THRESHOLD);
      sender.send({ type: 'output', data: largeData, offset: TEST_FLUSH_THRESHOLD });

      // Send was attempted (threshold flush)
      expect(mockWs.send).toHaveBeenCalledTimes(1);

      // Buffer should be cleared despite failure
      mockWs.send.mockImplementation(() => {});
      sender.send({ type: 'output', data: 'new', offset: TEST_FLUSH_THRESHOLD + 3 });
      sender.flush();

      expect(mockWs.send).toHaveBeenCalledTimes(2);
      const sent = JSON.parse(mockWs.send.mock.calls[1][0] as string);
      expect(sent.data).toBe('new');
    });
  });

  describe('readyState checks', () => {
    it('should skip send if readyState is not OPEN', async () => {
      sender.send({ type: 'output', data: 'hello', offset: 5 });

      // Transition to CLOSING before flush
      readyState = WS_READY_STATE.CLOSING;

      await waitForFlush();

      // Should not have called ws.send
      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('should skip send for non-output messages if readyState is not OPEN', () => {
      readyState = WS_READY_STATE.CLOSED;

      sender.send({ type: 'exit', exitCode: 0, signal: null });

      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('should check readyState at flush time, not at buffer time', () => {
      // Output messages go through buffering path, so readyState is
      // checked at flush time, not at buffer time.
      readyState = WS_READY_STATE.CLOSING;

      // Output messages are buffered regardless of readyState
      // (readyState is checked at flush time)
      sender.send({ type: 'output', data: 'hello', offset: 5 });

      // Force flush - should skip due to readyState
      sender.flush();

      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('should allow send when readyState is undefined (adapter does not expose it)', async () => {
      readyState = undefined;

      sender.send({ type: 'output', data: 'hello', offset: 5 });
      await waitForFlush();

      // Should have sent (undefined falls through the guard)
      expect(mockWs.send).toHaveBeenCalledTimes(1);
    });

    it('should skip send when readyState is CONNECTING', async () => {
      sender.send({ type: 'output', data: 'hello', offset: 5 });
      readyState = 0; // CONNECTING

      await waitForFlush();

      expect(mockWs.send).not.toHaveBeenCalled();
    });
  });

  describe('message ordering', () => {
    it('should flush pending output before non-output messages', () => {
      // Buffer some output
      sender.send({ type: 'output', data: 'output data', offset: 11 });

      // Send a non-output message - should flush output first
      sender.send({ type: 'exit', exitCode: 0, signal: null });

      expect(mockWs.send).toHaveBeenCalledTimes(2);

      const firstMsg = JSON.parse(mockWs.send.mock.calls[0][0] as string);
      const secondMsg = JSON.parse(mockWs.send.mock.calls[1][0] as string);

      expect(firstMsg.type).toBe('output');
      expect(firstMsg.data).toBe('output data');
      expect(secondMsg.type).toBe('exit');
    });

    it('should flush pending output before activity messages', () => {
      sender.send({ type: 'output', data: 'some output', offset: 11 });
      sender.send({ type: 'activity', state: 'idle' });

      expect(mockWs.send).toHaveBeenCalledTimes(2);

      const firstMsg = JSON.parse(mockWs.send.mock.calls[0][0] as string);
      const secondMsg = JSON.parse(mockWs.send.mock.calls[1][0] as string);

      expect(firstMsg.type).toBe('output');
      expect(secondMsg.type).toBe('activity');
    });

    it('should flush pending output before server-restarted messages', () => {
      sender.send({ type: 'output', data: 'pre-restart output', offset: 18 });
      sender.send({ type: 'server-restarted', serverPid: 12345 });

      expect(mockWs.send).toHaveBeenCalledTimes(2);

      const firstMsg = JSON.parse(mockWs.send.mock.calls[0][0] as string);
      const secondMsg = JSON.parse(mockWs.send.mock.calls[1][0] as string);

      expect(firstMsg.type).toBe('output');
      expect(secondMsg.type).toBe('server-restarted');
    });
  });

  describe('non-output messages', () => {
    it('should send non-output messages immediately without buffering', () => {
      sender.send({ type: 'exit', exitCode: 0, signal: null });

      expect(mockWs.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(mockWs.send.mock.calls[0][0] as string);
      expect(sent).toEqual({ type: 'exit', exitCode: 0, signal: null });
    });

    it('should send activity messages immediately', () => {
      sender.send({ type: 'activity', state: 'active' });

      expect(mockWs.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(mockWs.send.mock.calls[0][0] as string);
      expect(sent).toEqual({ type: 'activity', state: 'active' });
    });
  });

  describe('dispose', () => {
    it('should clear timer and prevent further sends', async () => {
      sender.send({ type: 'output', data: 'buffered', offset: 8 });

      // Dispose before timer fires
      sender.dispose();

      await waitForFlush();

      // Timer should have been cleared; no send should have happened
      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('should become a no-op after dispose', () => {
      sender.dispose();

      // All operations should be no-ops
      sender.send({ type: 'output', data: 'ignored', offset: 7 });
      sender.send({ type: 'exit', exitCode: 0, signal: null });
      sender.flush();

      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('should report isDisposed correctly', () => {
      expect(sender.isDisposed).toBe(false);
      sender.dispose();
      expect(sender.isDisposed).toBe(true);
    });

    it('should be safe to call dispose multiple times', () => {
      sender.dispose();
      sender.dispose(); // Should not throw
      expect(sender.isDisposed).toBe(true);
    });
  });

  describe('flush', () => {
    it('should be a no-op when buffer is empty', () => {
      sender.flush();
      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('should clear the flush timer on manual flush', async () => {
      sender.send({ type: 'output', data: 'data', offset: 4 });

      // Manual flush
      sender.flush();
      expect(mockWs.send).toHaveBeenCalledTimes(1);

      // Wait for what would be the timer interval
      await waitForFlush();

      // Should not have flushed again (timer was cleared)
      expect(mockWs.send).toHaveBeenCalledTimes(1);
    });
  });
});
