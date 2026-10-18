import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { renderHook, act, cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useReconnectInvalidation } from '../useReconnectInvalidation';
import { connect, _reset as resetWebSocket } from '../../lib/app-websocket';
import { registerReconnectInvalidation, _resetReconnectInvalidation } from '../../lib/reconnect-invalidation';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';
import { dropAndReopenAppSocket } from '../../test/app-socket-reconnect';

let restoreWebSocket: () => void;
let queryClient: QueryClient;
let invalidateSpy: ReturnType<typeof spyOn>;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

function invalidatedKeys(): unknown[] {
  return (invalidateSpy.mock.calls as Array<[{ queryKey: unknown }]>).map((call) => call[0].queryKey);
}

function openFirstConnection() {
  act(() => {
    connect();
    MockWebSocket.getLastInstance()?.simulateOpen();
  });
}

beforeEach(() => {
  restoreWebSocket = installMockWebSocket();
  resetWebSocket();
  _resetReconnectInvalidation();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidateSpy = spyOn(queryClient, 'invalidateQueries');
});

afterEach(() => {
  cleanup();
  resetWebSocket();
  restoreWebSocket();
});

/**
 * Mutations (each applied alone to useReconnectInvalidation.ts, this file re-run):
 *   drop the first-open guard (`seenConnectedRef`) -> 'the first connection invalidates nothing'
 *   invalidate on every connected render, not only false -> true -> 'a second drop ...' counts one extra
 */
describe('useReconnectInvalidation', () => {
  it('the first connection invalidates nothing', () => {
    registerReconnectInvalidation([['todos'], ['artifacts']]);
    renderHook(() => useReconnectInvalidation(), { wrapper });

    openFirstConnection();

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('a close followed by a reopen invalidates exactly once per registered key, with the registered key', () => {
    registerReconnectInvalidation([['todos'], ['artifacts']]);
    renderHook(() => useReconnectInvalidation(), { wrapper });
    openFirstConnection();

    dropAndReopenAppSocket();

    expect(invalidateSpy).toHaveBeenCalledTimes(2);
    expect(invalidatedKeys()).toEqual([['todos'], ['artifacts']]);
  });

  it('a reopen with an empty registry invalidates nothing (the vacuous case)', () => {
    renderHook(() => useReconnectInvalidation(), { wrapper });
    openFirstConnection();

    dropAndReopenAppSocket();

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('a second disconnect and reopen invalidates once more per key', () => {
    registerReconnectInvalidation([['todos']]);
    renderHook(() => useReconnectInvalidation(), { wrapper });
    openFirstConnection();

    dropAndReopenAppSocket();
    dropAndReopenAppSocket();

    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });

  it('mounting while the socket is already open, then reconnecting, invalidates (the first-connection rule is per page, not per mount)', () => {
    registerReconnectInvalidation([['todos']]);
    openFirstConnection();
    renderHook(() => useReconnectInvalidation(), { wrapper });
    expect(invalidateSpy).not.toHaveBeenCalled();

    dropAndReopenAppSocket();

    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it('a key registered while disconnected is still invalidated by the next reconnect', () => {
    renderHook(() => useReconnectInvalidation(), { wrapper });
    openFirstConnection();
    act(() => {
      MockWebSocket.getLastInstance()?.simulateClose(1006);
    });
    registerReconnectInvalidation([['bookmarks']]);

    dropAndReopenAppSocket();

    expect(invalidatedKeys()).toEqual([['bookmarks']]);
  });
});
