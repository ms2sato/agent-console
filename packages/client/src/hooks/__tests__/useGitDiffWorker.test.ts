import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useGitDiffWorker } from '../useGitDiffWorker';
import type { GitDiffData } from '@agent-console/shared';

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

  send = mock(() => {});
  close = mock(() => {
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

// Helper to wait for next tick
const waitForNextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('useGitDiffWorker', () => {
  beforeEach(() => {
    MockWebSocket.clearInstances();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).WebSocket = MockWebSocket;

    // Mock window.location.host
    Object.defineProperty(window, 'location', {
      value: { host: 'localhost:3000' },
      writable: true,
    });
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  const mockDiffData: GitDiffData = {
    summary: {
      baseCommit: 'abc123',
      targetRef: 'working-dir',
      files: [
        {
          path: 'src/test.ts',
          status: 'modified',
          stageState: 'unstaged',
          additions: 5,
          deletions: 2,
          isBinary: false,
        },
      ],
      totalAdditions: 5,
      totalDeletions: 2,
      updatedAt: '2025-12-13T00:00:00Z',
    },
    rawDiff: 'diff --git a/src/test.ts b/src/test.ts...',
  };

  it('should connect to WebSocket with correct URL', async () => {
    const { result } = renderHook(() =>
      useGitDiffWorker({ sessionId: 'session1', workerId: 'worker1' })
    );

    // Initial state
    expect(result.current.connected).toBe(false);
    expect(result.current.loading).toBe(true);
    expect(result.current.diffData).toBe(null);
    expect(result.current.error).toBe(null);

    await act(async () => {
      await waitForNextTick();
    });

    const ws = MockWebSocket.getLastInstance();
    expect(ws).toBeDefined();
    expect(ws?.url).toBe('ws://localhost:3000/ws/session/session1/worker/worker1');
  });

  it('should update connected state on connection', async () => {
    const onConnectionChange = mock(() => {});
    const { result } = renderHook(() =>
      useGitDiffWorker({
        sessionId: 'session1',
        workerId: 'worker1',
        onConnectionChange,
      })
    );

    await act(async () => {
      await waitForNextTick();
    });

    const ws = MockWebSocket.getLastInstance();

    act(() => {
      ws?.simulateOpen();
    });

    expect(result.current.connected).toBe(true);
    expect(onConnectionChange).toHaveBeenCalledWith(true);
  });

  it('should handle diff-data messages', async () => {
    const { result } = renderHook(() =>
      useGitDiffWorker({ sessionId: 'session1', workerId: 'worker1' })
    );

    await act(async () => {
      await waitForNextTick();
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'diff-data', data: mockDiffData }));
    });

    expect(result.current.diffData).toEqual(mockDiffData);
    expect(result.current.error).toBe(null);
    expect(result.current.loading).toBe(false);
  });

  it('should handle diff-error messages', async () => {
    const { result } = renderHook(() =>
      useGitDiffWorker({ sessionId: 'session1', workerId: 'worker1' })
    );

    await act(async () => {
      await waitForNextTick();
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'diff-error', error: 'Git error' }));
    });

    expect(result.current.error).toBe('Git error');
    expect(result.current.diffData).toBe(null);
    expect(result.current.loading).toBe(false);
  });

  it('should send refresh message', async () => {
    const { result } = renderHook(() =>
      useGitDiffWorker({ sessionId: 'session1', workerId: 'worker1' })
    );

    await act(async () => {
      await waitForNextTick();
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    act(() => {
      result.current.refresh();
    });

    expect(ws?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'refresh' }));
    expect(result.current.loading).toBe(true);
  });

  it('should send set-base-commit message', async () => {
    const { result } = renderHook(() =>
      useGitDiffWorker({ sessionId: 'session1', workerId: 'worker1' })
    );

    await act(async () => {
      await waitForNextTick();
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    act(() => {
      result.current.setBaseCommit('main');
    });

    expect(ws?.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'set-base-commit', ref: 'main' })
    );
    expect(result.current.loading).toBe(true);
  });

  it('should send set-target-commit message', async () => {
    const { result } = renderHook(() =>
      useGitDiffWorker({ sessionId: 'session1', workerId: 'worker1' })
    );

    await act(async () => {
      await waitForNextTick();
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    act(() => {
      result.current.setTargetCommit('HEAD');
    });

    expect(ws?.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'set-target-commit', ref: 'HEAD' })
    );
    expect(result.current.loading).toBe(true);
  });

  it('should send set-target-commit message with working-dir', async () => {
    const { result } = renderHook(() =>
      useGitDiffWorker({ sessionId: 'session1', workerId: 'worker1' })
    );

    await act(async () => {
      await waitForNextTick();
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    act(() => {
      result.current.setTargetCommit('working-dir');
    });

    expect(ws?.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'set-target-commit', ref: 'working-dir' })
    );
    expect(result.current.loading).toBe(true);
  });

  it('should not send messages when WebSocket is not open', async () => {
    const { result } = renderHook(() =>
      useGitDiffWorker({ sessionId: 'session1', workerId: 'worker1' })
    );

    await act(async () => {
      await waitForNextTick();
    });

    const ws = MockWebSocket.getLastInstance();
    // Don't open the connection

    act(() => {
      result.current.refresh();
      result.current.setBaseCommit('main');
    });

    expect(ws?.send).not.toHaveBeenCalled();
  });

  it('should handle connection close', async () => {
    const onConnectionChange = mock(() => {});
    const { result } = renderHook(() =>
      useGitDiffWorker({
        sessionId: 'session1',
        workerId: 'worker1',
        onConnectionChange,
      })
    );

    await act(async () => {
      await waitForNextTick();
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
    expect(onConnectionChange).toHaveBeenCalledWith(false);
  });

  it('should handle WebSocket errors', async () => {
    const { result } = renderHook(() =>
      useGitDiffWorker({ sessionId: 'session1', workerId: 'worker1' })
    );

    await act(async () => {
      await waitForNextTick();
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateError();
    });

    expect(result.current.error).toBe('WebSocket connection error');
    expect(result.current.loading).toBe(false);
  });

  it('should handle invalid JSON gracefully', async () => {
    const consoleSpy = mock(() => {});
    const originalError = console.error;
    console.error = consoleSpy;

    const { result } = renderHook(() =>
      useGitDiffWorker({ sessionId: 'session1', workerId: 'worker1' })
    );

    await act(async () => {
      await waitForNextTick();
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage('not valid json');
    });

    expect(consoleSpy).toHaveBeenCalled();
    expect(result.current.error).toBe('Failed to parse server message');
    expect(result.current.loading).toBe(false);

    console.error = originalError;
  });

  it('should close WebSocket on unmount', async () => {
    const { unmount } = renderHook(() =>
      useGitDiffWorker({ sessionId: 'session1', workerId: 'worker1' })
    );

    await act(async () => {
      await waitForNextTick();
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    unmount();

    expect(ws?.close).toHaveBeenCalled();
  });

  it('should reconnect when sessionId or workerId changes', async () => {
    const { rerender } = renderHook(
      ({ sessionId, workerId }) => useGitDiffWorker({ sessionId, workerId }),
      { initialProps: { sessionId: 'session1', workerId: 'worker1' } }
    );

    await act(async () => {
      await waitForNextTick();
    });

    const firstWs = MockWebSocket.getLastInstance();
    act(() => {
      firstWs?.simulateOpen();
    });

    // Change workerId
    rerender({ sessionId: 'session1', workerId: 'worker2' });

    await act(async () => {
      await waitForNextTick();
    });

    const secondWs = MockWebSocket.getLastInstance();
    expect(secondWs).not.toBe(firstWs);
    expect(secondWs?.url).toBe('ws://localhost:3000/ws/session/session1/worker/worker2');
  });

  it('should clear error when receiving new diff data', async () => {
    const { result } = renderHook(() =>
      useGitDiffWorker({ sessionId: 'session1', workerId: 'worker1' })
    );

    await act(async () => {
      await waitForNextTick();
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    // First receive an error
    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'diff-error', error: 'Git error' }));
    });

    expect(result.current.error).toBe('Git error');

    // Then receive valid data
    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'diff-data', data: mockDiffData }));
    });

    expect(result.current.error).toBe(null);
    expect(result.current.diffData).toEqual(mockDiffData);
  });

  it('should clear diffData when receiving error', async () => {
    const { result } = renderHook(() =>
      useGitDiffWorker({ sessionId: 'session1', workerId: 'worker1' })
    );

    await act(async () => {
      await waitForNextTick();
    });

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    // First receive valid data
    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'diff-data', data: mockDiffData }));
    });

    expect(result.current.diffData).toEqual(mockDiffData);

    // Then receive an error
    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'diff-error', error: 'Git error' }));
    });

    expect(result.current.diffData).toBe(null);
    expect(result.current.error).toBe('Git error');
  });
});
