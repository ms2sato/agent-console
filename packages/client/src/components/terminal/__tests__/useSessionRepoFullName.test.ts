import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSessionRepoFullName } from '../useSessionRepoFullName';

// Fetch-level mock (testing.md Anti-Pattern #2), routed by URL.
const originalFetch = globalThis.fetch;
const mockFetch = mock((_input: RequestInfo | URL) => Promise.resolve(new Response()));
globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function prLinkRequests(): string[] {
  return mockFetch.mock.calls.map((call) => urlOf(call[0])).filter((url) => url.includes('/pr-link'));
}

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe('useSessionRepoFullName', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ prUrl: null, branchName: 'feat/x', orgRepo: 'acme/widgets' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
  });

  it('requests the session PR link and resolves the repo full name when enabled', async () => {
    const { result } = renderHook(() => useSessionRepoFullName('session-1', true), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current).toBe('acme/widgets'));
    expect(prLinkRequests()).toHaveLength(1);
    expect(prLinkRequests()[0]).toContain('/api/sessions/session-1/pr-link');
  });

  it('makes no request and resolves null when disabled', async () => {
    const { result } = renderHook(() => useSessionRepoFullName('session-1', false), { wrapper: createWrapper() });

    // Positive control: the same render with `enabled` true does request (above);
    // give the query a tick to start, then assert nothing was sent.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(prLinkRequests()).toHaveLength(0);
    expect(result.current).toBeNull();
  });
});
