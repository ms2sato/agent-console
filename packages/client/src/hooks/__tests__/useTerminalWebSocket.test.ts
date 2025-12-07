import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTerminalWebSocket } from '../useTerminalWebSocket';

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private static instances: MockWebSocket[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: string) {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }

  simulateError() {
    this.onerror?.(new Event('error'));
  }

  static getLastInstance(): MockWebSocket | undefined {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }

  static clearInstances() {
    MockWebSocket.instances = [];
  }
}

// Setup global WebSocket mock
const originalWebSocket = globalThis.WebSocket;

describe('useTerminalWebSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.clearInstances();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
  });

  const defaultOptions = {
    onOutput: vi.fn(),
    onHistory: vi.fn(),
    onExit: vi.fn(),
    onConnectionChange: vi.fn(),
    onActivity: vi.fn(),
  };

  it('should connect to WebSocket and update connected state', async () => {
    const options = { ...defaultOptions };
    const { result } = renderHook(() =>
      useTerminalWebSocket('ws://localhost/ws/terminal/123', options)
    );

    // Initial state
    expect(result.current.connected).toBe(false);

    // Advance timer to allow connection
    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    const ws = MockWebSocket.getLastInstance();
    expect(ws).toBeDefined();

    // Simulate connection open
    act(() => {
      ws?.simulateOpen();
    });

    expect(result.current.connected).toBe(true);
    expect(options.onConnectionChange).toHaveBeenCalledWith(true);
  });

  it('should handle output messages', async () => {
    const options = { ...defaultOptions };
    renderHook(() =>
      useTerminalWebSocket('ws://localhost/ws/terminal/123', options)
    );

    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    // Simulate output message
    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'output', data: 'Hello World' }));
    });

    expect(options.onOutput).toHaveBeenCalledWith('Hello World');
  });

  it('should handle history messages', async () => {
    const options = { ...defaultOptions };
    renderHook(() => useTerminalWebSocket('ws://localhost/ws/terminal/123', options));

    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'history', data: 'Previous output' }));
    });

    expect(options.onHistory).toHaveBeenCalledWith('Previous output');
  });

  it('should handle exit messages', async () => {
    const options = { ...defaultOptions };
    renderHook(() => useTerminalWebSocket('ws://localhost/ws/terminal/123', options));

    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'exit', exitCode: 0, signal: null }));
    });

    expect(options.onExit).toHaveBeenCalledWith(0, null);
  });

  it('should handle activity messages', async () => {
    const options = { ...defaultOptions };
    renderHook(() => useTerminalWebSocket('ws://localhost/ws/terminal/123', options));

    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'activity', state: 'active' }));
    });

    expect(options.onActivity).toHaveBeenCalledWith('active');
  });

  it('should handle connection close', async () => {
    const options = { ...defaultOptions };
    const { result } = renderHook(() =>
      useTerminalWebSocket('ws://localhost/ws/terminal/123', options)
    );

    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    expect(result.current.connected).toBe(true);

    act(() => {
      ws?.simulateClose();
    });

    expect(result.current.connected).toBe(false);
    expect(options.onConnectionChange).toHaveBeenCalledWith(false);
  });

  it('should send input messages', async () => {
    const { result } = renderHook(() =>
      useTerminalWebSocket('ws://localhost/ws/terminal/123', defaultOptions)
    );

    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    act(() => {
      result.current.sendInput('hello');
    });

    expect(ws?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'input', data: 'hello' }));
  });

  it('should send resize messages', async () => {
    const { result } = renderHook(() =>
      useTerminalWebSocket('ws://localhost/ws/terminal/123', defaultOptions)
    );

    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    act(() => {
      result.current.sendResize(80, 24);
    });

    expect(ws?.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'resize', cols: 80, rows: 24 })
    );
  });

  it('should send image messages', async () => {
    const { result } = renderHook(() =>
      useTerminalWebSocket('ws://localhost/ws/terminal/123', defaultOptions)
    );

    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    act(() => {
      result.current.sendImage('base64data', 'image/png');
    });

    expect(ws?.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'image', data: 'base64data', mimeType: 'image/png' })
    );
  });

  it('should not send when WebSocket is not open', async () => {
    const { result } = renderHook(() =>
      useTerminalWebSocket('ws://localhost/ws/terminal/123', defaultOptions)
    );

    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    const ws = MockWebSocket.getLastInstance();
    // Don't open the connection

    act(() => {
      result.current.sendInput('test');
    });

    expect(ws?.send).not.toHaveBeenCalled();
  });

  it('should handle invalid JSON gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const options = { ...defaultOptions };

    renderHook(() => useTerminalWebSocket('ws://localhost/ws/terminal/123', options));

    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage('not valid json');
    });

    expect(consoleSpy).toHaveBeenCalled();
    expect(options.onOutput).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('should close WebSocket on unmount', async () => {
    const { unmount } = renderHook(() =>
      useTerminalWebSocket('ws://localhost/ws/terminal/123', defaultOptions)
    );

    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    unmount();

    expect(ws?.close).toHaveBeenCalled();
  });

  it('should reconnect when URL changes', async () => {
    const { rerender } = renderHook(
      ({ url }) => useTerminalWebSocket(url, defaultOptions),
      { initialProps: { url: 'ws://localhost/ws/terminal/123' } }
    );

    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    const firstWs = MockWebSocket.getLastInstance();
    act(() => {
      firstWs?.simulateOpen();
    });

    // Change URL
    rerender({ url: 'ws://localhost/ws/terminal/456' });

    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    const secondWs = MockWebSocket.getLastInstance();
    expect(secondWs).not.toBe(firstWs);
    expect(secondWs?.url).toBe('ws://localhost/ws/terminal/456');
  });
});
