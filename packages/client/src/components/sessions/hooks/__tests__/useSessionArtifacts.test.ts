import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSessionArtifacts } from '../useSessionArtifacts';

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

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('useSessionArtifacts', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('calls fetchArtifacts with the given sessionId (session-scoped query)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        artifacts: [
          { id: 'artifact-1', title: 'My Dashboard', createdAt: '2026-08-16T00:00:00.000Z', sizeBytes: 1234 },
        ],
      })
    );

    const { result } = renderHook(() => useSessionArtifacts('session-1'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(getLastFetchUrl()).toContain('/api/artifacts');
    expect(getLastFetchUrl()).toContain('sessionId=session-1');
    expect(result.current.data).toEqual([
      { id: 'artifact-1', title: 'My Dashboard', createdAt: '2026-08-16T00:00:00.000Z', sizeBytes: 1234 },
    ]);
  });

  it('resolves an empty list when the session has no artifacts', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ artifacts: [] }));

    const { result } = renderHook(() => useSessionArtifacts('session-2'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.data).toEqual([]);
  });
});
