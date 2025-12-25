import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useTerminalWebSocket } from '../useTerminalWebSocket';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';
import { _reset } from '../../lib/worker-websocket';

describe('useTerminalWebSocket', () => {
  let restoreWebSocket: () => void;

  beforeEach(() => {
    restoreWebSocket = installMockWebSocket();
    _reset();
  });

  afterEach(() => {
    _reset();
    restoreWebSocket();
  });

  const createDefaultOptions = () => ({
    onOutput: mock(() => {}),
    onHistory: mock(() => {}),
    onExit: mock(() => {}),
    onConnectionChange: mock(() => {}),
    onActivity: mock(() => {}),
  });

  it('should connect on mount and keep connection on unmount (singleton pattern)', async () => {
    // Note: We don't disconnect on unmount to prevent duplicate output in React StrictMode.
    // This follows the same pattern as useAppWsEvent.
    const options = createDefaultOptions();
    const { unmount } = renderHook(() =>
      useTerminalWebSocket('session-1', 'worker-1', options)
    );

    const ws = MockWebSocket.getLastInstance();
    expect(ws).toBeDefined();
    expect(ws?.url).toContain('session-1');
    expect(ws?.url).toContain('worker-1');

    unmount();

    // Connection should persist (singleton pattern) - close is NOT called on unmount
    expect(ws?.close).not.toHaveBeenCalled();
  });

  it('should update connected state when WebSocket opens', async () => {
    const options = createDefaultOptions();
    const { result } = renderHook(() =>
      useTerminalWebSocket('session-1', 'worker-1', options)
    );

    expect(result.current.connected).toBe(false);

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    expect(result.current.connected).toBe(true);
  });

  it('should call onConnectionChange when connection state changes', async () => {
    const options = createDefaultOptions();
    renderHook(() =>
      useTerminalWebSocket('session-1', 'worker-1', options)
    );

    const ws = MockWebSocket.getLastInstance();

    act(() => {
      ws?.simulateOpen();
    });

    expect(options.onConnectionChange).toHaveBeenCalledWith(true);

    act(() => {
      ws?.simulateClose();
    });

    expect(options.onConnectionChange).toHaveBeenCalledWith(false);
  });

  it('should call onOutput when receiving output message', async () => {
    const options = createDefaultOptions();
    renderHook(() =>
      useTerminalWebSocket('session-1', 'worker-1', options)
    );

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'output', data: 'hello' }));
    });

    expect(options.onOutput).toHaveBeenCalledWith('hello');
  });

  it('should call onHistory when receiving history message', async () => {
    const options = createDefaultOptions();
    renderHook(() =>
      useTerminalWebSocket('session-1', 'worker-1', options)
    );

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'history', data: 'history data' }));
    });

    // onHistory is called with just data (offset was removed in simplification)
    expect(options.onHistory).toHaveBeenCalledWith('history data');
  });

  it('should call onExit when receiving exit message', async () => {
    const options = createDefaultOptions();
    renderHook(() =>
      useTerminalWebSocket('session-1', 'worker-1', options)
    );

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'exit', exitCode: 0, signal: null }));
    });

    expect(options.onExit).toHaveBeenCalledWith(0, null);
  });

  it('should call onActivity when receiving activity message', async () => {
    const options = createDefaultOptions();
    renderHook(() =>
      useTerminalWebSocket('session-1', 'worker-1', options)
    );

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'activity', state: 'active' }));
    });

    expect(options.onActivity).toHaveBeenCalledWith('active');
  });

  it('should send input messages via WebSocket', async () => {
    const options = createDefaultOptions();
    const { result } = renderHook(() =>
      useTerminalWebSocket('session-1', 'worker-1', options)
    );

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    act(() => {
      result.current.sendInput('hello');
    });

    expect(ws?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'input', data: 'hello' }));
  });

  it('should send resize messages via WebSocket', async () => {
    const options = createDefaultOptions();
    const { result } = renderHook(() =>
      useTerminalWebSocket('session-1', 'worker-1', options)
    );

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    act(() => {
      result.current.sendResize(80, 24);
    });

    expect(ws?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  });

  it('should send image messages via WebSocket', async () => {
    const options = createDefaultOptions();
    const { result } = renderHook(() =>
      useTerminalWebSocket('session-1', 'worker-1', options)
    );

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    act(() => {
      result.current.sendImage('base64data', 'image/png');
    });

    expect(ws?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'image', data: 'base64data', mimeType: 'image/png' }));
  });

  it('should reconnect when sessionId or workerId changes', async () => {
    const options = createDefaultOptions();
    const { rerender } = renderHook(
      ({ sessionId, workerId }) => useTerminalWebSocket(sessionId, workerId, options),
      { initialProps: { sessionId: 'session-1', workerId: 'worker-1' } }
    );

    const firstWs = MockWebSocket.getLastInstance();
    expect(firstWs?.url).toContain('session-1');
    expect(firstWs?.url).toContain('worker-1');

    // Change workerId
    rerender({ sessionId: 'session-1', workerId: 'worker-2' });

    // Should disconnect old and connect new
    expect(firstWs?.close).toHaveBeenCalled();

    const secondWs = MockWebSocket.getLastInstance();
    expect(secondWs).not.toBe(firstWs);
    expect(secondWs?.url).toContain('worker-2');
  });

  it('should not send messages when not connected', async () => {
    const options = createDefaultOptions();
    const { result } = renderHook(() =>
      useTerminalWebSocket('session-1', 'worker-1', options)
    );

    const ws = MockWebSocket.getLastInstance();
    // Don't open the connection

    act(() => {
      result.current.sendInput('hello');
    });

    expect(ws?.send).not.toHaveBeenCalled();
  });

  it('should ignore invalid message types', async () => {
    const consoleSpy = mock(() => {});
    const originalError = console.error;
    console.error = consoleSpy;

    const options = createDefaultOptions();
    renderHook(() =>
      useTerminalWebSocket('session-1', 'worker-1', options)
    );

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'unknown-type', data: 'test' }));
    });

    // Should log error but not call any callbacks
    expect(consoleSpy).toHaveBeenCalled();
    expect(options.onOutput).not.toHaveBeenCalled();
    expect(options.onHistory).not.toHaveBeenCalled();
    expect(options.onExit).not.toHaveBeenCalled();

    console.error = originalError;
  });

  it('should update callbacks without reconnecting', async () => {
    const options1 = createDefaultOptions();
    const options2 = createDefaultOptions();

    const { rerender } = renderHook(
      ({ options }) => useTerminalWebSocket('session-1', 'worker-1', options),
      { initialProps: { options: options1 } }
    );

    const firstWs = MockWebSocket.getLastInstance();
    act(() => {
      firstWs?.simulateOpen();
    });

    // Change callbacks
    rerender({ options: options2 });

    // Should NOT create a new WebSocket
    const secondWs = MockWebSocket.getLastInstance();
    expect(secondWs).toBe(firstWs);

    // New callback should be called
    act(() => {
      firstWs?.simulateMessage(JSON.stringify({ type: 'output', data: 'test' }));
    });

    expect(options1.onOutput).not.toHaveBeenCalled();
    expect(options2.onOutput).toHaveBeenCalledWith('test');
  });
});
