/**
 * Integration tests for Terminal component history handling.
 *
 * These tests verify the integration between Terminal component and:
 * - worker-websocket module (lastHistoryData management)
 * - terminal-history-utils (diff calculation)
 *
 * Note: Full component rendering tests are avoided because mocking xterm.js
 * via mock.module() pollutes global state and breaks other tests.
 * The xterm.js integration is verified via manual testing.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as workerWs from '../../lib/worker-websocket';
import { calculateHistoryUpdate } from '../../lib/terminal-history-utils';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';

describe('Terminal history handling integration', () => {
  let restoreWebSocket: () => void;
  let consoleLogSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    restoreWebSocket = installMockWebSocket();
    // Suppress console.log during tests
    consoleLogSpy = spyOn(console, 'log');
    workerWs._reset();
  });

  afterEach(() => {
    workerWs._reset();
    restoreWebSocket();
    consoleLogSpy.mockRestore();
  });

  describe('lastHistoryData persistence in worker-websocket', () => {
    it('should initialize lastHistoryData as empty string for new connections', () => {
      const callbacks: workerWs.TerminalWorkerCallbacks = {
        type: 'terminal',
        onOutput: () => {},
        onHistory: () => {},
        onExit: () => {},
      };

      workerWs.connect('session-1', 'worker-1', callbacks);

      // lastHistoryData should be empty for new connection
      expect(workerWs.getLastHistoryData('session-1', 'worker-1')).toBe('');
    });

    it('should update lastHistoryData via setLastHistoryData', () => {
      const callbacks: workerWs.TerminalWorkerCallbacks = {
        type: 'terminal',
        onOutput: () => {},
        onHistory: () => {},
        onExit: () => {},
      };

      workerWs.connect('session-1', 'worker-1', callbacks);
      workerWs.setLastHistoryData('session-1', 'worker-1', 'history content');

      expect(workerWs.getLastHistoryData('session-1', 'worker-1')).toBe('history content');
    });

    it('should preserve lastHistoryData across reconnections (visibility change)', () => {
      const callbacks: workerWs.TerminalWorkerCallbacks = {
        type: 'terminal',
        onOutput: () => {},
        onHistory: () => {},
        onExit: () => {},
      };

      // Initial connection
      workerWs.connect('session-1', 'worker-1', callbacks);
      const ws1 = MockWebSocket.getLastInstance();
      ws1?.simulateOpen();

      // Set history data
      workerWs.setLastHistoryData('session-1', 'worker-1', 'original history');

      // Simulate visibility change (disconnect and reconnect)
      // The visibility handler in worker-websocket preserves connection info
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));

      // Page becomes visible - reconnect
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));

      // lastHistoryData should be preserved
      expect(workerWs.getLastHistoryData('session-1', 'worker-1')).toBe('original history');
    });

    it('should return empty string for non-existent connections', () => {
      expect(workerWs.getLastHistoryData('non-existent', 'worker')).toBe('');
    });
  });

  describe('calculateHistoryUpdate integration', () => {
    it('should return initial type when lastHistoryData is empty', () => {
      const lastHistoryData = '';
      const newData = 'hello world';

      const update = calculateHistoryUpdate(lastHistoryData, newData);

      expect(update.type).toBe('initial');
      expect(update.newData).toBe('hello world');
      expect(update.shouldScrollToBottom).toBe(true);
    });

    it('should return diff type for append-only updates (tab switch)', () => {
      const lastHistoryData = 'hello\n';
      const newData = 'hello\nworld\n';

      const update = calculateHistoryUpdate(lastHistoryData, newData);

      expect(update.type).toBe('diff');
      expect(update.newData).toBe('world\n');
      expect(update.shouldScrollToBottom).toBe(false);
    });

    it('should return full type when history changed completely', () => {
      const lastHistoryData = 'old content';
      const newData = 'new content';

      const update = calculateHistoryUpdate(lastHistoryData, newData);

      expect(update.type).toBe('full');
      expect(update.newData).toBe('new content');
      expect(update.shouldScrollToBottom).toBe(false);
    });

    it('should return empty diff when no new content', () => {
      const lastHistoryData = 'same content';
      const newData = 'same content';

      const update = calculateHistoryUpdate(lastHistoryData, newData);

      expect(update.type).toBe('diff');
      expect(update.newData).toBe('');
      expect(update.shouldScrollToBottom).toBe(false);
    });
  });

  describe('Terminal handleHistory flow simulation', () => {
    // This simulates what happens in Terminal.handleHistory callback

    it('should use lastHistoryData from worker-websocket for diff calculation', () => {
      const callbacks: workerWs.TerminalWorkerCallbacks = {
        type: 'terminal',
        onOutput: () => {},
        onHistory: () => {},
        onExit: () => {},
      };

      // Setup connection
      workerWs.connect('session-1', 'worker-1', callbacks);

      // Simulate first history (initial load)
      const lastHistoryData1 = workerWs.getLastHistoryData('session-1', 'worker-1');
      const update1 = calculateHistoryUpdate(lastHistoryData1, 'initial content\n');
      workerWs.setLastHistoryData('session-1', 'worker-1', 'initial content\n');

      expect(update1.type).toBe('initial');
      expect(update1.shouldScrollToBottom).toBe(true);

      // Simulate second history (tab switch with new content)
      const lastHistoryData2 = workerWs.getLastHistoryData('session-1', 'worker-1');
      expect(lastHistoryData2).toBe('initial content\n');

      const update2 = calculateHistoryUpdate(lastHistoryData2, 'initial content\nnew line\n');
      workerWs.setLastHistoryData('session-1', 'worker-1', 'initial content\nnew line\n');

      expect(update2.type).toBe('diff');
      expect(update2.newData).toBe('new line\n');
      expect(update2.shouldScrollToBottom).toBe(false);

      // Simulate third history (tab switch with no new content)
      const lastHistoryData3 = workerWs.getLastHistoryData('session-1', 'worker-1');
      const update3 = calculateHistoryUpdate(lastHistoryData3, 'initial content\nnew line\n');

      expect(update3.type).toBe('diff');
      expect(update3.newData).toBe(''); // No new content
    });

    it('should handle history changes across different workers independently', () => {
      const callbacks: workerWs.TerminalWorkerCallbacks = {
        type: 'terminal',
        onOutput: () => {},
        onHistory: () => {},
        onExit: () => {},
      };

      // Setup two connections
      workerWs.connect('session-1', 'worker-1', callbacks);
      workerWs.connect('session-1', 'worker-2', callbacks);

      // Set different history for each worker
      workerWs.setLastHistoryData('session-1', 'worker-1', 'worker 1 content');
      workerWs.setLastHistoryData('session-1', 'worker-2', 'worker 2 content');

      // Verify they are independent
      expect(workerWs.getLastHistoryData('session-1', 'worker-1')).toBe('worker 1 content');
      expect(workerWs.getLastHistoryData('session-1', 'worker-2')).toBe('worker 2 content');

      // Diff calculation should use correct worker's lastHistoryData
      const update1 = calculateHistoryUpdate(
        workerWs.getLastHistoryData('session-1', 'worker-1'),
        'worker 1 content plus more'
      );
      expect(update1.type).toBe('diff');
      expect(update1.newData).toBe(' plus more');
    });
  });

  describe('history request behavior', () => {
    it('should NOT request history on initial connection (server sends automatically)', async () => {
      const callbacks: workerWs.TerminalWorkerCallbacks = {
        type: 'terminal',
        onOutput: () => {},
        onHistory: () => {},
        onExit: () => {},
      };

      workerWs.connect('session-1', 'worker-1', callbacks);
      const ws = MockWebSocket.getLastInstance();

      // Simulate connection open
      ws?.simulateOpen();

      // Wait for potential debounce
      await new Promise((resolve) => setTimeout(resolve, 150));

      // request-history should NOT be sent on initial connection
      // because the server automatically sends history when a client connects
      expect(ws?.send).not.toHaveBeenCalled();
    });

    it('should request history with debounce on tab switch (remount with existing OPEN connection)', async () => {
      const callbacks: workerWs.TerminalWorkerCallbacks = {
        type: 'terminal',
        onOutput: () => {},
        onHistory: () => {},
        onExit: () => {},
      };

      // Initial connection
      workerWs.connect('session-1', 'worker-1', callbacks);
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Wait for initial setup
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Clear mock to track subsequent calls
      ws?.send.mockClear();

      // Simulate tab switch: connect() is called again with existing OPEN connection
      const newCallbacks: workerWs.TerminalWorkerCallbacks = {
        type: 'terminal',
        onOutput: () => {},
        onHistory: () => {},
        onExit: () => {},
      };
      workerWs.connect('session-1', 'worker-1', newCallbacks);

      // History request should not be immediate (debounced)
      expect(ws?.send).not.toHaveBeenCalled();

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Now history should be requested (tab switch case)
      expect(ws?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'request-history' }));
    });

    it('should deduplicate rapid history requests on tab switch', async () => {
      const callbacks: workerWs.TerminalWorkerCallbacks = {
        type: 'terminal',
        onOutput: () => {},
        onHistory: () => {},
        onExit: () => {},
      };

      // Initial connection
      workerWs.connect('session-1', 'worker-1', callbacks);
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Wait for initial setup
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Clear mock to track subsequent calls
      ws?.send.mockClear();

      // Simulate rapid tab switches (like React Strict Mode double render)
      workerWs.connect('session-1', 'worker-1', callbacks);
      workerWs.connect('session-1', 'worker-1', callbacks);
      workerWs.connect('session-1', 'worker-1', callbacks);

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should only have one history request (debounced)
      const sendCalls = (ws?.send as ReturnType<typeof spyOn>).mock.calls as unknown[][];
      const historyRequests = sendCalls.filter(
        (call: unknown[]) => JSON.parse(call[0] as string).type === 'request-history'
      );
      expect(historyRequests.length).toBe(1);
    });
  });
});
