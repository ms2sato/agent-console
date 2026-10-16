import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { Todo } from '@agent-console/shared';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSessionTodos } from '../useSessionTodos';
import { _reset as resetWebSocket } from '../../../../lib/app-websocket';
import { MockWebSocket, installMockWebSocket } from '../../../../test/mock-websocket';

// Fetch-level mock (testing.md Anti-Pattern #2): api.ts is imported for real
// by many other test files in this process, so it is not mocked via mock.module().
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

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeTodo(overrides: Partial<Todo> = {}): Todo {
  return {
    id: 'todo-1',
    kind: 'action',
    scope: 'session',
    title: 'Run the migration',
    body: '',
    sessionId: 'session-1',
    createdBy: { workerId: 'worker-1' },
    assigneeUserId: null,
    status: 'open',
    resolutionText: null,
    resolvedByUserId: null,
    resolvedByWorkerId: null,
    resolvedAt: null,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

function fetchUrl(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof URL) return arg.toString();
  if (arg instanceof Request) return arg.url;
  return String(arg);
}

/**
 * Throws instead of returning undefined so a NEGATIVE assertion ("no refetch
 * for a different session") cannot pass vacuously because no frame was ever
 * delivered.
 */
function requireLastWs(): MockWebSocket {
  const ws = MockWebSocket.getLastInstance();
  if (!ws) throw new Error('Expected a MockWebSocket instance to exist by this point in the test');
  return ws;
}

/**
 * Measured reach, recorded by WHICH test failed (each mutation applied alone,
 * this file + SessionTodosPanel.test.tsx + useAppWs-wire-consumption.test.ts
 * re-run, production file restored after):
 *
 *   `openCount` counts every item (useSessionTodos.ts)
 *     -> here: 'openCount counts only open items, while todos keeps every item'
 *        (plus four SessionTodosPanel tests)
 *   refetch condition replaced by `true` (useSessionTodos.ts)
 *     -> here, alone: 'refetches for a frame naming this session, then does
 *        NOT refetch for a different session'
 *   the `msgSessionId === null` arm removed (useSessionTodos.ts)
 *     -> here, alone: 'refetches for a frame whose sessionId is null'
 *   `onTodosUpdated` never invoked by useAppWs.ts
 *     -> here: both realtime tests; plus the wire-consumption 'todos-updated'
 *        case and the null-session case
 */
describe('useSessionTodos', () => {
  let restoreWebSocket: () => void;

  beforeEach(() => {
    mockFetch.mockReset();
    restoreWebSocket = installMockWebSocket();
    resetWebSocket();
  });

  afterEach(() => {
    restoreWebSocket();
  });

  it('fetches the items of the given session', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ todos: [makeTodo()] }));

    const { result } = renderHook(() => useSessionTodos('session-1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    const calls = mockFetch.mock.calls as unknown[][];
    expect(fetchUrl(calls[0]?.[0])).toContain('/api/todos');
    expect(fetchUrl(calls[0]?.[0])).toContain('sessionId=session-1');
    expect(result.current.todos).toEqual([makeTodo()]);
  });

  it('openCount counts only open items, while todos keeps every item', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        todos: [
          makeTodo({ id: 'a', status: 'open' }),
          makeTodo({ id: 'b', status: 'done', resolutionText: 'ok' }),
          makeTodo({ id: 'c', status: 'withdrawn' }),
          makeTodo({ id: 'd', status: 'open', scope: 'global' }),
        ],
      })
    );

    const { result } = renderHook(() => useSessionTodos('session-1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.todos).toHaveLength(4);
    expect(result.current.openCount).toBe(2);
  });

  it('resolves an empty list with openCount 0', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ todos: [] }));

    const { result } = renderHook(() => useSessionTodos('session-1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.todos).toEqual([]);
    expect(result.current.openCount).toBe(0);
  });

  it('reports isError on a failed list fetch, with no items', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));

    const { result } = renderHook(() => useSessionTodos('session-1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.todos).toEqual([]);
    expect(result.current.openCount).toBe(0);
    expect(typeof result.current.refetch).toBe('function');
  });

  // Each realtime test is a positive control followed by the negative
  // assertion in the SAME test, so an absence cannot be a never-delivered frame.
  describe('realtime refresh (todos-updated)', () => {
    it('refetches for a frame naming this session, then does NOT refetch for a different session', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ todos: [] }));

      const { result } = renderHook(() => useSessionTodos('session-A'), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isPending).toBe(false));

      const ws = requireLastWs();
      act(() => {
        ws.simulateOpen();
      });

      const added = makeTodo({ id: 'new', sessionId: 'session-A' });
      mockFetch.mockResolvedValueOnce(jsonResponse({ todos: [added] }));
      await act(async () => {
        ws.simulateMessage(JSON.stringify({ type: 'todos-updated', sessionId: 'session-A' }));
      });
      await waitFor(() => expect(result.current.todos).toEqual([added]));

      const callsBefore = mockFetch.mock.calls.length;
      await act(async () => {
        ws.simulateMessage(JSON.stringify({ type: 'todos-updated', sessionId: 'session-OTHER' }));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(mockFetch.mock.calls.length).toBe(callsBefore);
    });

    it('refetches for a frame whose sessionId is null', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ todos: [] }));

      const { result } = renderHook(() => useSessionTodos('session-B'), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isPending).toBe(false));

      const ws = requireLastWs();
      act(() => {
        ws.simulateOpen();
      });

      const added = makeTodo({ id: 'g', sessionId: 'session-B', scope: 'global' });
      mockFetch.mockResolvedValueOnce(jsonResponse({ todos: [added] }));
      await act(async () => {
        ws.simulateMessage(JSON.stringify({ type: 'todos-updated', sessionId: null }));
      });

      await waitFor(() => expect(result.current.todos).toEqual([added]));
    });
  });
});
