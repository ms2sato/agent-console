import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSessionBookmarks } from '../useSessionBookmarks';

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

describe('useSessionBookmarks', () => {
  beforeEach(() => {
    mockFetch.mockReset();
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
});
