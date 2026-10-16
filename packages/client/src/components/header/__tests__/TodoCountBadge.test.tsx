import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { screen, cleanup, waitFor, act } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { setCurrentUser, _reset as resetAuth } from '../../../lib/auth';
import { _reset as resetWebSocket } from '../../../lib/app-websocket';
import { MockWebSocket, installMockWebSocket } from '../../../test/mock-websocket';
import { makeTodo, jsonResponse, fetchUrl } from '../../../test/todo-fixtures';
import { TodoCountBadge } from '../TodoCountBadge';

const originalFetch = globalThis.fetch;
const mockFetch = mock(async (_input: RequestInfo | URL): Promise<Response> => jsonResponse({ todos: [] }));
const ME = { id: 'user-me', username: 'me', homeDir: '/home/me' };

let restoreWebSocket: () => void;

beforeEach(() => {
  globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => jsonResponse({ todos: [] }));
  resetAuth();
  restoreWebSocket = installMockWebSocket();
  resetWebSocket();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  restoreWebSocket();
});

/** The visually hidden description; its text carries the count for assistive tech. */
function badge() {
  return screen.queryByText(/open to-do items assigned to you/);
}

/**
 * Measured reach, recorded by WHICH test failed (each mutation applied alone,
 * every to-do test file re-run, production file restored after):
 *
 *   count includes non-open items (useMyOpenTodoCount.ts)
 *     -> here: 'counts only open items assigned to the current user'
 *   count includes items assigned to others (useMyOpenTodoCount.ts)
 *     -> here: 'counts only open items assigned to the current user'
 *   session-deleted not wired (useFilteredTodos.ts)
 *     -> here: 'refetches the count on a session-deleted frame'
 *   a todos-updated frame with a null sessionId ignored (useFilteredTodos.ts)
 *     -> here: 'refetches the count on a todos-updated frame with a null sessionId'
 */
describe('TodoCountBadge', () => {
  it('counts only open items assigned to the current user', async () => {
    setCurrentUser(ME);
    mockFetch.mockImplementation(async () =>
      jsonResponse({
        todos: [
          makeTodo({ id: 'a', assigneeUserId: ME.id }),
          makeTodo({ id: 'b', assigneeUserId: ME.id }),
          makeTodo({ id: 'c', assigneeUserId: ME.id, status: 'done', resolutionText: 'ok' }),
          makeTodo({ id: 'd', assigneeUserId: 'other' }),
        ],
      }),
    );

    await renderWithRouter(<TodoCountBadge />);

    await waitFor(() => expect(badge()?.textContent).toBe('2 open to-do items assigned to you'));
    // The visible number is decorative; the description is the accessible text.
    expect(screen.getByText('2').getAttribute('aria-hidden')).toBe('true');
    expect(badge()?.className).toContain('sr-only');
  });

  it('renders nothing at zero', async () => {
    setCurrentUser(ME);
    await renderWithRouter(<TodoCountBadge />);
    await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(badge()).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('renders nothing and fetches nothing without a current user (single-user mode)', async () => {
    await renderWithRouter(<TodoCountBadge />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(badge()).toBeNull();
    expect(mockFetch.mock.calls.length).toBe(0);
  });

  describe('realtime refresh', () => {
    async function mountWithOneItem() {
      setCurrentUser(ME);
      mockFetch.mockImplementationOnce(async () =>
        jsonResponse({ todos: [makeTodo({ id: 'a', assigneeUserId: ME.id })] }),
      );
      await renderWithRouter(<TodoCountBadge />);
      await waitFor(() => expect(badge()?.textContent).toBe('1 open to-do items assigned to you'));
      const ws = MockWebSocket.getLastInstance();
      if (!ws) throw new Error('Expected a MockWebSocket instance to exist by this point in the test');
      act(() => {
        ws.simulateOpen();
      });
      return ws;
    }

    function twoItems() {
      return jsonResponse({
        todos: [
          makeTodo({ id: 'a', assigneeUserId: ME.id }),
          makeTodo({ id: 'b', assigneeUserId: ME.id }),
        ],
      });
    }

    it('refetches the count on a todos-updated frame with a null sessionId', async () => {
      const ws = await mountWithOneItem();
      mockFetch.mockImplementationOnce(async () => twoItems());

      await act(async () => {
        ws.simulateMessage(JSON.stringify({ type: 'todos-updated', sessionId: null }));
      });

      await waitFor(() => expect(badge()?.textContent).toBe('2 open to-do items assigned to you'));
    });

    it('refetches the count on a todos-updated frame naming a session', async () => {
      const ws = await mountWithOneItem();
      mockFetch.mockImplementationOnce(async () => twoItems());

      await act(async () => {
        ws.simulateMessage(JSON.stringify({ type: 'todos-updated', sessionId: 'session-1' }));
      });

      await waitFor(() => expect(badge()?.textContent).toBe('2 open to-do items assigned to you'));
    });

    it('refetches the count on a session-deleted frame', async () => {
      const ws = await mountWithOneItem();
      // The deletion withdrew the only item: the server's refetched answer is empty.
      mockFetch.mockImplementationOnce(async () => jsonResponse({ todos: [] }));

      await act(async () => {
        ws.simulateMessage(JSON.stringify({ type: 'session-deleted', sessionId: 'session-1' }));
      });

      await waitFor(() => expect(badge()).toBeNull());
    });
  });

  it('asks only for the current user\'s open items', async () => {
    setCurrentUser(ME);
    await renderWithRouter(<TodoCountBadge />);
    await waitFor(() => expect(mockFetch.mock.calls.length).toBe(1));

    const url = new URL(fetchUrl((mockFetch.mock.calls as unknown[][])[0]?.[0]), 'http://localhost');
    expect(url.searchParams.get('assignee')).toBe(ME.id);
    expect(url.searchParams.get('status')).toBe('open');
  });
});
