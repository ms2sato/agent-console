import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFilteredTodos } from '../useFilteredTodos';
import { listReconnectInvalidationKeys, _resetReconnectInvalidation } from '../../lib/reconnect-invalidation';
import { todoKeys } from '../../lib/query-keys';
import { _reset as resetWebSocket } from '../../lib/app-websocket';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';
import { makeTodo, jsonResponse, fetchUrl } from '../../test/todo-fixtures';

// Fetch-level mock: api.ts is imported for real by many other test files in
// this process, so it is not mocked via mock.module().
const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response()));
globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

/** Throws instead of returning undefined so an absence cannot pass because no socket existed. */
function requireLastWs(): MockWebSocket {
  const ws = MockWebSocket.getLastInstance();
  if (!ws) throw new Error('Expected a MockWebSocket instance to exist by this point in the test');
  return ws;
}

/**
 * Measured reach, recorded by WHICH test failed (each mutation applied alone to
 * useFilteredTodos.ts, every to-do test file re-run, production file restored after):
 *
 *   `onSessionDeleted` handler removed
 *     -> here, alone: 'refetches on a session-deleted frame (the server emits no todos-updated for it)'
 *        (also TodoCountBadge.test.tsx and TodosPage.test.tsx, one realtime test each)
 *   the todos-updated handler ignores a null sessionId
 *     -> here, alone: 'refetches on a todos-updated frame whose sessionId is null'
 *        (also TodoCountBadge.test.tsx and TodosPage.test.tsx, one realtime test each)
 */
describe('useFilteredTodos', () => {
  let restoreWebSocket: () => void;

  beforeEach(() => {
    mockFetch.mockReset();
    restoreWebSocket = installMockWebSocket();
    resetWebSocket();
  });

  afterEach(() => {
    restoreWebSocket();
  });

  it('sends the filters as query parameters and returns the list', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ todos: [makeTodo()] }));

    const { result } = renderHook(() => useFilteredTodos({ status: 'open', assignee: 'user-1' }), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.data).toEqual([makeTodo()]));

    const url = new URL(fetchUrl((mockFetch.mock.calls as unknown[][])[0]?.[0]), 'http://localhost');
    expect(url.pathname).toBe('/api/todos');
    expect(url.searchParams.get('status')).toBe('open');
    expect(url.searchParams.get('assignee')).toBe('user-1');
  });

  it('does not fetch while disabled', async () => {
    renderHook(() => useFilteredTodos({ assignee: undefined, status: 'open' }, { enabled: false }), {
      wrapper: createWrapper(),
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(mockFetch.mock.calls.length).toBe(0);
  });

  describe('realtime refresh', () => {
    async function mountAndOpen() {
      mockFetch.mockResolvedValueOnce(jsonResponse({ todos: [] }));
      const rendered = renderHook(() => useFilteredTodos({ status: 'open' }), { wrapper: createWrapper() });
      await waitFor(() => expect(rendered.result.current.data).toEqual([]));
      const ws = requireLastWs();
      act(() => {
        ws.simulateOpen();
      });
      return { ...rendered, ws };
    }

    it('refetches on a todos-updated frame naming a session', async () => {
      const { result, ws } = await mountAndOpen();

      const added = makeTodo({ id: 'new' });
      mockFetch.mockResolvedValueOnce(jsonResponse({ todos: [added] }));
      await act(async () => {
        ws.simulateMessage(JSON.stringify({ type: 'todos-updated', sessionId: 'session-ANY' }));
      });

      await waitFor(() => expect(result.current.data).toEqual([added]));
    });

    it('refetches on a todos-updated frame whose sessionId is null', async () => {
      const { result, ws } = await mountAndOpen();

      const added = makeTodo({ id: 'global', scope: 'global', sessionId: null });
      mockFetch.mockResolvedValueOnce(jsonResponse({ todos: [added] }));
      await act(async () => {
        ws.simulateMessage(JSON.stringify({ type: 'todos-updated', sessionId: null }));
      });

      await waitFor(() => expect(result.current.data).toEqual([added]));
    });

    it('refetches on a session-deleted frame (the server emits no todos-updated for it)', async () => {
      const { result, ws } = await mountAndOpen();

      // What a deletion leaves behind is decided by the server: the frame
      // only triggers the refetch, the list shown is the refetched one.
      const withdrawn = makeTodo({ id: 'w', status: 'withdrawn' });
      mockFetch.mockResolvedValueOnce(jsonResponse({ todos: [withdrawn] }));
      await act(async () => {
        ws.simulateMessage(JSON.stringify({ type: 'session-deleted', sessionId: 'session-1' }));
      });

      await waitFor(() => expect(result.current.data).toEqual([withdrawn]));
    });
  });
});

describe('useFilteredTodos reconnect registration', () => {
  let restoreWebSocket: () => void;

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(jsonResponse({}));
    restoreWebSocket = installMockWebSocket();
    resetWebSocket();
    _resetReconnectInvalidation();
  });

  afterEach(() => {
    restoreWebSocket();
    _resetReconnectInvalidation();
  });

  // Mutation: drop `invalidateOnReconnect` from the hook's useAppWsEvent -> a `tsc` error at the hook,
  // and (type bypassed) this test fails because the family root is not registered.
  it('registers its family root for the reconnect invalidation', () => {
    renderHook(() => useFilteredTodos({}), { wrapper: createWrapper() });

    expect(listReconnectInvalidationKeys()).toContainEqual(todoKeys.root());
  });
});
