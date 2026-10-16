import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMyOpenTodoCount } from '../useMyOpenTodoCount';
import { setCurrentUser, _reset as resetAuth } from '../../lib/auth';
import { _reset as resetWebSocket } from '../../lib/app-websocket';
import { installMockWebSocket } from '../../test/mock-websocket';
import { makeTodo, jsonResponse, fetchUrl } from '../../test/todo-fixtures';

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

const ME = { id: 'user-me', username: 'me', homeDir: '/home/me' };

/**
 * Measured reach, recorded by WHICH test failed (each mutation applied alone to
 * useMyOpenTodoCount.ts, every to-do test file re-run, production file restored after):
 *
 *   the status check dropped from the count
 *     -> here, alone: 'counts only open items'
 *        (also TodoCountBadge.test.tsx 'counts only open items assigned to the current user'
 *        and MobileNavMenu.test.tsx 'shows the count of open items assigned to the current user')
 *   the assignee check dropped from the count
 *     -> here, alone: 'counts only items assigned to the current user'
 *        (also TodoCountBadge.test.tsx 'counts only open items assigned to the current user')
 */
describe('useMyOpenTodoCount', () => {
  let restoreWebSocket: () => void;

  beforeEach(() => {
    mockFetch.mockReset();
    resetAuth();
    restoreWebSocket = installMockWebSocket();
    resetWebSocket();
  });

  afterEach(() => {
    restoreWebSocket();
  });

  it('asks the server for the open items assigned to the current user', async () => {
    setCurrentUser(ME);
    mockFetch.mockResolvedValue(jsonResponse({ todos: [] }));

    renderHook(() => useMyOpenTodoCount(), { wrapper: createWrapper() });
    await waitFor(() => expect(mockFetch.mock.calls.length).toBe(1));

    const url = new URL(fetchUrl((mockFetch.mock.calls as unknown[][])[0]?.[0]), 'http://localhost');
    expect(url.searchParams.get('assignee')).toBe(ME.id);
    expect(url.searchParams.get('status')).toBe('open');
  });

  it('counts only items assigned to the current user', async () => {
    setCurrentUser(ME);
    mockFetch.mockResolvedValue(
      jsonResponse({
        todos: [
          makeTodo({ id: 'a', assigneeUserId: ME.id }),
          makeTodo({ id: 'b', assigneeUserId: ME.id }),
          makeTodo({ id: 'c', assigneeUserId: 'someone-else' }),
          makeTodo({ id: 'd', assigneeUserId: null }),
        ],
      }),
    );

    const { result } = renderHook(() => useMyOpenTodoCount(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current).toBe(2));
  });

  it('counts only open items', async () => {
    setCurrentUser(ME);
    mockFetch.mockResolvedValue(
      jsonResponse({
        todos: [
          makeTodo({ id: 'a', assigneeUserId: ME.id, status: 'open' }),
          makeTodo({ id: 'b', assigneeUserId: ME.id, status: 'done', resolutionText: 'ok' }),
          makeTodo({ id: 'c', assigneeUserId: ME.id, status: 'dismissed' }),
          makeTodo({ id: 'd', assigneeUserId: ME.id, status: 'withdrawn' }),
          makeTodo({ id: 'e', assigneeUserId: ME.id, status: 'superseded' }),
        ],
      }),
    );

    const { result } = renderHook(() => useMyOpenTodoCount(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current).toBe(1));
  });

  it('is zero and fetches nothing without a current user', async () => {
    const { result } = renderHook(() => useMyOpenTodoCount(), { wrapper: createWrapper() });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(result.current).toBe(0);
    expect(mockFetch.mock.calls.length).toBe(0);
  });
});
