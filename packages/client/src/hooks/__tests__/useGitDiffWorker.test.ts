import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useGitDiffWorker } from '../useGitDiffWorker';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';
import { _reset } from '../../lib/worker-websocket';
import type { GitDiffData } from '@agent-console/shared';

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

describe('useGitDiffWorker', () => {
  let restoreWebSocket: () => void;

  beforeEach(() => {
    restoreWebSocket = installMockWebSocket();
    _reset();
  });

  afterEach(() => {
    _reset();
    restoreWebSocket();
  });

  it('should connect on mount and disconnect on unmount', async () => {
    const { unmount } = renderHook(() =>
      useGitDiffWorker({ sessionId: 'session1', workerId: 'worker1' })
    );

    const ws = MockWebSocket.getLastInstance();
    expect(ws).toBeDefined();
    expect(ws?.url).toContain('session1');
    expect(ws?.url).toContain('worker1');

    unmount();

    expect(ws?.close).toHaveBeenCalled();
  });

  it('should return initial state correctly', async () => {
    const { result } = renderHook(() =>
      useGitDiffWorker({ sessionId: 'session1', workerId: 'worker1' })
    );

    expect(result.current.connected).toBe(false);
    expect(result.current.loading).toBe(true);
    expect(result.current.diffData).toBe(null);
    expect(result.current.error).toBe(null);
  });

  it('should update connected state when WebSocket opens', async () => {
    const onConnectionChange = mock(() => {});
    const { result } = renderHook(() =>
      useGitDiffWorker({
        sessionId: 'session1',
        workerId: 'worker1',
        onConnectionChange,
      })
    );

    expect(result.current.connected).toBe(false);

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

  it('should handle invalid message type gracefully', async () => {
    const consoleSpy = mock(() => {});
    const originalError = console.error;
    console.error = consoleSpy;

    const { result } = renderHook(() =>
      useGitDiffWorker({ sessionId: 'session1', workerId: 'worker1' })
    );

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'unknown-type', data: {} }));
    });

    expect(consoleSpy).toHaveBeenCalled();
    expect(result.current.error).toBe('Invalid server message');
    expect(result.current.loading).toBe(false);

    console.error = originalError;
  });

  it('should reconnect when sessionId or workerId changes', async () => {
    const { rerender } = renderHook(
      ({ sessionId, workerId }) => useGitDiffWorker({ sessionId, workerId }),
      { initialProps: { sessionId: 'session1', workerId: 'worker1' } }
    );

    const firstWs = MockWebSocket.getLastInstance();
    act(() => {
      firstWs?.simulateOpen();
    });

    // Change workerId
    rerender({ sessionId: 'session1', workerId: 'worker2' });

    expect(firstWs?.close).toHaveBeenCalled();

    const secondWs = MockWebSocket.getLastInstance();
    expect(secondWs).not.toBe(firstWs);
    expect(secondWs?.url).toContain('worker2');
  });

  it('should clear error when receiving new diff data', async () => {
    const { result } = renderHook(() =>
      useGitDiffWorker({ sessionId: 'session1', workerId: 'worker1' })
    );

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
