import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useEmbeddedAgentWorker } from '../useEmbeddedAgentWorker';
import { MockWebSocket, installMockWebSocket } from '../../../../test/mock-websocket';
import { _resetEmbeddedAgentWorkers, _inspect, getOrCreateEmbeddedAgentWorker } from '../../embedded-agent-store';

describe('useEmbeddedAgentWorker', () => {
  let restoreWebSocket: () => void;
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    _resetEmbeddedAgentWorkers();
    restoreWebSocket = installMockWebSocket();
    originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    _resetEmbeddedAgentWorkers();
    restoreWebSocket();
    if (originalLocation) {
      Object.defineProperty(window, 'location', originalLocation);
    }
  });

  it('returns initial connecting status with no entries', () => {
    const { result } = renderHook(() => useEmbeddedAgentWorker({ sessionId: 's1', workerId: 'w1' }));

    expect(result.current.status).toBe('connecting');
    expect(result.current.entries).toEqual([]);
    expect(result.current.activityState).toBe('unknown');
  });

  it('reflects connected status once the socket opens', () => {
    const { result } = renderHook(() => useEmbeddedAgentWorker({ sessionId: 's2', workerId: 'w2' }));
    const ws = MockWebSocket.getLastInstance();

    act(() => {
      ws?.simulateOpen();
    });

    expect(result.current.status).toBe('connected');
  });

  it('sendUserMessage forwards to the store', () => {
    const { result } = renderHook(() => useEmbeddedAgentWorker({ sessionId: 's3', workerId: 'w3' }));
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    act(() => {
      // Never confirmed within this test -- swallow the eventual dispose-time
      // rejection (afterEach's _resetEmbeddedAgentWorkers) so it doesn't
      // surface as an unhandled rejection.
      result.current.sendUserMessage('hello').catch(() => {});
    });

    const sent = ws!.send.mock.calls.map((c) => JSON.parse(c[0])) as {
      type: string;
      text?: string;
      clientMessageId?: string;
    }[];
    const sentMessage = sent.find((m) => m.type === 'embedded-user-message');
    expect(sentMessage?.text).toBe('hello');
    // Issue #1117: a per-send correlation id, generated client-side.
    expect(sentMessage?.clientMessageId).toBeTruthy();
  });

  it('cancel forwards to the store', () => {
    const { result } = renderHook(() => useEmbeddedAgentWorker({ sessionId: 's4', workerId: 'w4' }));
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    act(() => {
      result.current.cancel();
    });

    const sent = (ws!.send.mock.calls as unknown as string[][]).map((c) => JSON.parse(c[0]));
    expect(sent).toContainEqual({ type: 'embedded-cancel' });
  });

  it('acquire/release keeps the underlying store instance alive across a remount (ref counting)', () => {
    const { unmount } = renderHook(() => useEmbeddedAgentWorker({ sessionId: 's5', workerId: 'w5' }));
    const instance = getOrCreateEmbeddedAgentWorker('s5', 'w5');
    expect(_inspect(instance).refCount).toBe(1);

    unmount();

    expect(_inspect(instance).refCount).toBe(0);
    expect(_inspect(instance).disposed).toBe(false); // idle TTL, not immediate disposal
  });

  it('exposes workerError from the store', () => {
    const { result } = renderHook(() => useEmbeddedAgentWorker({ sessionId: 's6', workerId: 'w6' }));
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });

    act(() => {
      ws?.simulateMessage(JSON.stringify({ type: 'error', message: 'boom', code: 'ACTIVATION_FAILED' }));
    });

    expect(result.current.workerError).toEqual({ message: 'boom', code: 'ACTIVATION_FAILED' });
  });

  it('retry clears the worker error and reconnects', () => {
    const { result } = renderHook(() => useEmbeddedAgentWorker({ sessionId: 's7', workerId: 'w7' }));
    const firstWs = MockWebSocket.getLastInstance();
    act(() => {
      firstWs?.simulateOpen();
      firstWs?.simulateMessage(JSON.stringify({ type: 'error', message: 'boom', code: 'ACTIVATION_FAILED' }));
    });
    expect(result.current.workerError).not.toBeNull();

    act(() => {
      result.current.retry();
    });

    expect(result.current.workerError).toBeNull();
    const secondWs = MockWebSocket.getLastInstance();
    expect(secondWs).not.toBe(firstWs);
  });
});
