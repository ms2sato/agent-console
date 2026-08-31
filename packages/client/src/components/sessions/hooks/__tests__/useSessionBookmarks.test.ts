import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSessionBookmarks } from '../useSessionBookmarks';
import { _reset as resetWebSocket } from '../../../../lib/app-websocket';
import { MockWebSocket, installMockWebSocket } from '../../../../test/mock-websocket';

// Fetch-level mock (testing.md Anti-Pattern #2: mock at the fetch boundary,
// not via mock.module() on api.ts, which is imported for real by many other
// test files in this process).
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

function getLastFetchUrl(): string {
  const calls = mockFetch.mock.calls as unknown[][];
  const arg = calls[calls.length - 1]?.[0];
  if (typeof arg === 'string') return arg;
  if (arg instanceof URL) return arg.toString();
  if (arg instanceof Request) return arg.url;
  return String(arg);
}

function fetchUrl(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof URL) return arg.toString();
  if (arg instanceof Request) return arg.url;
  return String(arg);
}

/** Finds a fetch call by HTTP method (the list query's GET shares the same
 * `/api/bookmarks` path prefix, so matching on the URL alone is ambiguous --
 * method + URL together uniquely identify the mutation call). */
function findFetchCallByMethod(method: string): [unknown, { method?: string; body?: string } | undefined] | undefined {
  const calls = mockFetch.mock.calls as unknown[][];
  return calls.find((call) => {
    const init = call[1] as { method?: string } | undefined;
    return init?.method === method;
  }) as [unknown, { method?: string; body?: string } | undefined] | undefined;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * `getLastInstance()` returning `undefined` and then optional-chaining past
 * it (`ws?.simulateMessage(...)`) is safe in a POSITIVE assertion (the
 * expected refetch simply never happens, and the test correctly fails) but
 * turns a NEGATIVE assertion ("no refetch for a different session") into a
 * vacuous truth: no message is delivered, so of course nothing refetched.
 * This throws instead of silently no-op'ing, so a negative test can't pass
 * without the stimulus actually having been sent (CodeRabbit finding on
 * PR #1523). Reach measured directly on the identical helper in
 * `useSessionArtifacts.test.ts` (same mechanism, same fix) -- see that
 * file's doc comment for the literal printed bun:test output.
 */
function requireLastWs(): MockWebSocket {
  const ws = MockWebSocket.getLastInstance();
  if (!ws) throw new Error('Expected a MockWebSocket instance to exist by this point in the test');
  return ws;
}

describe('useSessionBookmarks', () => {
  let restoreWebSocket: () => void;

  beforeEach(() => {
    mockFetch.mockReset();
    restoreWebSocket = installMockWebSocket();
    resetWebSocket();
  });

  afterEach(() => {
    restoreWebSocket();
  });

  it('calls fetchBookmarks with the given sessionId (session-scoped query)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        bookmarks: [
          { id: 'bookmark-1', url: 'https://example.com', title: 'Example', createdAt: '2026-08-20T00:00:00.000Z', origin: 'user' },
        ],
      })
    );

    const { result } = renderHook(() => useSessionBookmarks('session-1'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(getLastFetchUrl()).toContain('/api/bookmarks');
    expect(getLastFetchUrl()).toContain('sessionId=session-1');
    expect(result.current.bookmarks).toEqual([
      { id: 'bookmark-1', url: 'https://example.com', title: 'Example', createdAt: '2026-08-20T00:00:00.000Z', origin: 'user' },
    ]);
  });

  it('resolves an empty list when the session has no bookmarks', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ bookmarks: [] }));

    const { result } = renderHook(() => useSessionBookmarks('session-2'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.bookmarks).toEqual([]);
  });

  it('addBookmark posts the url/title and invalidates the session list', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ bookmarks: [] }));

    const { result } = renderHook(() => useSessionBookmarks('session-3'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    const newBookmark = {
      id: 'bookmark-new',
      url: 'https://example.com',
      title: 'Example',
      createdAt: '2026-08-20T00:00:00.000Z',
      origin: 'user' as const,
    };
    // The POST response and the invalidated query's GET refetch are two
    // distinct calls with different response shapes -- queue them
    // separately so the refetch doesn't receive the POST's `{ bookmark }`
    // shape (which fails BookmarksListResponseSchema parsing).
    mockFetch.mockResolvedValueOnce(jsonResponse({ bookmark: newBookmark }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ bookmarks: [newBookmark] }));

    await act(async () => {
      result.current.addBookmark('https://example.com', 'Example');
      await waitFor(() => expect(findFetchCallByMethod('POST')).toBeTruthy());
    });

    const [, postInit] = findFetchCallByMethod('POST')!;
    expect(JSON.parse(postInit!.body!)).toEqual({ url: 'https://example.com', title: 'Example', sessionId: 'session-3' });

    await waitFor(() => expect(result.current.bookmarks).toEqual([newBookmark]));
  });

  it('deleteBookmark issues a DELETE for the given id and invalidates the session list', async () => {
    const existingBookmark = {
      id: 'bookmark-1',
      url: 'https://example.com',
      title: 'Example',
      createdAt: '2026-08-20T00:00:00.000Z',
      origin: 'user' as const,
    };
    mockFetch.mockResolvedValueOnce(jsonResponse({ bookmarks: [existingBookmark] }));

    const { result } = renderHook(() => useSessionBookmarks('session-4'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.bookmarks).toEqual([existingBookmark]);

    // Same reasoning as the addBookmark test above: queue the DELETE
    // response and the invalidated query's GET refetch separately.
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ bookmarks: [] }));

    await act(async () => {
      result.current.deleteBookmark('bookmark-1');
      await waitFor(() => expect(findFetchCallByMethod('DELETE')).toBeTruthy());
    });

    const [deleteUrl] = findFetchCallByMethod('DELETE')!;
    expect(fetchUrl(deleteUrl)).toContain('/api/bookmarks/bookmark-1');

    await waitFor(() => expect(result.current.bookmarks).toEqual([]));
  });

  // Issue #1520: realtime refresh. The message carries only routing
  // metadata (sessionId + bookmarkId) -- N1 -- so these tests assert
  // invalidate-and-refetch behavior via a real refetch of the REST
  // endpoint, never via binding the payload to rendered data.
  //
  // Each test below is a POSITIVE CONTROL followed by the NEGATIVE
  // assertion, in the SAME test -- see useSessionArtifacts.test.ts's
  // identical describe-block comment for the full rationale (an absence
  // assertion cannot distinguish "correctly ignored" from "never
  // delivered"; Architect ruling on PR #1523).
  describe('realtime refresh (bookmark-created / bookmark-deleted)', () => {
    it('refetches for a SAME-session bookmark-created message, then does NOT refetch for a DIFFERENT session', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ bookmarks: [] }));

      const { result } = renderHook(() => useSessionBookmarks('session-A'), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isPending).toBe(false));
      expect(result.current.bookmarks).toEqual([]);

      const ws = requireLastWs();
      act(() => {
        ws.simulateOpen();
      });

      // Positive control: a SAME-session message actually triggers a
      // refetch in this exact render/connection.
      const newBookmark = {
        id: 'bookmark-new',
        url: 'https://example.com/new',
        title: 'New',
        createdAt: '2026-08-20T00:00:00.000Z',
        origin: 'user' as const,
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ bookmarks: [newBookmark] }));

      await act(async () => {
        ws.simulateMessage(
          JSON.stringify({ type: 'bookmark-created', sessionId: 'session-A', bookmarkId: 'bookmark-new' })
        );
      });

      await waitFor(() => expect(result.current.bookmarks).toEqual([newBookmark]));

      // Negative: a DIFFERENT-session message must not cause another refetch.
      const callsBefore = mockFetch.mock.calls.length;

      await act(async () => {
        ws.simulateMessage(
          JSON.stringify({ type: 'bookmark-created', sessionId: 'session-OTHER', bookmarkId: 'bookmark-x' })
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(mockFetch.mock.calls.length).toBe(callsBefore);
      expect(result.current.bookmarks).toEqual([newBookmark]);
    });

    it('refetches for a SAME-session bookmark-deleted message, then does NOT refetch for a DIFFERENT session', async () => {
      const existing = {
        id: 'bookmark-1',
        url: 'https://example.com',
        title: 'Existing',
        createdAt: '2026-08-20T00:00:00.000Z',
        origin: 'user' as const,
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ bookmarks: [existing] }));

      const { result } = renderHook(() => useSessionBookmarks('session-C'), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isPending).toBe(false));
      expect(result.current.bookmarks).toEqual([existing]);

      const ws = requireLastWs();
      act(() => {
        ws.simulateOpen();
      });

      // Positive control: a SAME-session message actually triggers a
      // refetch in this exact render/connection.
      mockFetch.mockResolvedValueOnce(jsonResponse({ bookmarks: [] }));

      await act(async () => {
        ws.simulateMessage(
          JSON.stringify({ type: 'bookmark-deleted', sessionId: 'session-C', bookmarkId: 'bookmark-1' })
        );
      });

      await waitFor(() => expect(result.current.bookmarks).toEqual([]));

      // Negative: a DIFFERENT-session message must not cause another refetch.
      const emptyCallsBefore = mockFetch.mock.calls.length;

      await act(async () => {
        ws.simulateMessage(
          JSON.stringify({ type: 'bookmark-deleted', sessionId: 'session-OTHER', bookmarkId: 'bookmark-1' })
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(mockFetch.mock.calls.length).toBe(emptyCallsBefore);
      expect(result.current.bookmarks).toEqual([]);
    });
  });
});
