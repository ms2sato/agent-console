import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useTodoDetail } from '../useTodoDetail';
import { listReconnectInvalidationKeys, _resetReconnectInvalidation } from '../../lib/reconnect-invalidation';
import { todoKeys } from '../../lib/query-keys';
import { _reset as resetWebSocket } from '../../lib/app-websocket';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';
import { fetchUrl, jsonResponse, makeTodo, makeTodoComment, makeTodoMove } from '../../test/todo-fixtures';

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

/** Throws so a negative or refetch assertion cannot pass because no socket ever existed. */
function requireLastWs(): MockWebSocket {
  const ws = MockWebSocket.getLastInstance();
  if (!ws) throw new Error('Expected a MockWebSocket instance to exist by this point in the test');
  return ws;
}

/**
 * Mutations noted per test (each applied alone to useTodoDetail.ts):
 *   - the invalidation gated on a session id (`sessionId === todo.sessionId`) ->
 *     'refetches for a frame naming any session' fails.
 *   - the invalidation gated on a non-null session id ->
 *     'refetches for a frame whose sessionId is null' fails.
 *   - `onTodosUpdated` never registered -> both refetch tests fail.
 *   - the query error swallowed -> 'surfaces the 404 as error' fails.
 */
describe('useTodoDetail', () => {
  let restoreWebSocket: () => void;

  beforeEach(() => {
    mockFetch.mockReset();
    restoreWebSocket = installMockWebSocket();
    resetWebSocket();
  });

  afterEach(() => {
    restoreWebSocket();
  });

  it('fetches the item by id', async () => {
    const todo = makeTodo({ id: 'todo-7' });
    mockFetch.mockResolvedValue(jsonResponse({ todo, activities: [] }));

    const { result } = renderHook(() => useTodoDetail('todo-7'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data).toEqual({ todo, activities: [] }));

    const calls = mockFetch.mock.calls as unknown[][];
    expect(fetchUrl(calls[0]?.[0])).toContain('/api/todos/todo-7');
  });

  it('returns the item together with its activities, in the order the server sent them', async () => {
    const todo = makeTodo({ id: 'todo-7', commentCount: 1 });
    // The move is older than the comment on purpose: the hook must not re-sort by kind or id.
    const activities = [makeTodoMove({ id: 'z-move' }), makeTodoComment({ id: 'a-comment' })];
    mockFetch.mockResolvedValue(jsonResponse({ todo, activities }));

    const { result } = renderHook(() => useTodoDetail('todo-7'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(result.current.data?.todo).toEqual(todo);
    expect(result.current.data?.activities.map((a) => a.id)).toEqual(['z-move', 'a-comment']);
  });

  it('refetches for a frame naming any session, including one other than the item\'s own', async () => {
    const before = makeTodo({ id: 'todo-1', sessionId: 'session-A', title: 'Before' });
    mockFetch.mockResolvedValueOnce(jsonResponse({ todo: before, activities: [] }));

    const { result } = renderHook(() => useTodoDetail('todo-1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data?.todo).toEqual(before));

    const ws = requireLastWs();
    act(() => {
      ws.simulateOpen();
    });

    const after = makeTodo({ id: 'todo-1', sessionId: 'session-B', title: 'After' });
    mockFetch.mockResolvedValueOnce(jsonResponse({ todo: after, activities: [] }));
    await act(async () => {
      ws.simulateMessage(JSON.stringify({ type: 'todos-updated', sessionId: 'session-OTHER' }));
    });

    await waitFor(() => expect(result.current.data?.todo).toEqual(after));
  });

  it('refetches for a frame whose sessionId is null', async () => {
    const before = makeTodo({ id: 'todo-1', title: 'Before' });
    mockFetch.mockResolvedValueOnce(jsonResponse({ todo: before, activities: [] }));

    const { result } = renderHook(() => useTodoDetail('todo-1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data?.todo).toEqual(before));

    const ws = requireLastWs();
    act(() => {
      ws.simulateOpen();
    });

    const after = makeTodo({ id: 'todo-1', title: 'After' });
    mockFetch.mockResolvedValueOnce(jsonResponse({ todo: after, activities: [] }));
    await act(async () => {
      ws.simulateMessage(JSON.stringify({ type: 'todos-updated', sessionId: null }));
    });

    await waitFor(() => expect(result.current.data?.todo).toEqual(after));
  });

  it('surfaces the 404 as error so the caller can render the deleted state', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'Todo not found' }, 404));

    const { result } = renderHook(() => useTodoDetail('gone'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.error).not.toBeNull());

    expect(result.current.error?.message).toBe('Todo not found');
    expect(result.current.data).toBeUndefined();
  });
});

describe('useTodoDetail reconnect registration', () => {
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
    renderHook(() => useTodoDetail('todo-1'), { wrapper: createWrapper() });

    expect(listReconnectInvalidationKeys()).toContainEqual(todoKeys.root());
  });
});
