import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEmbeddedAgents } from '../useEmbeddedAgents';

const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let embeddedAgentsResponse: unknown = { embeddedAgents: [] };

const mockFetch = mock(async (): Promise<Response> => jsonResponse(embeddedAgentsResponse));

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  embeddedAgentsResponse = { embeddedAgents: [] };
  mockFetch.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useEmbeddedAgents', () => {
  it('returns an empty list while loading, then the fetched embedded agents', async () => {
    embeddedAgentsResponse = {
      embeddedAgents: [
        {
          id: 'e1',
          name: 'Local GPT',
          provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
          createdBy: 'user-1',
          createdAt: '',
          updatedAt: '',
        },
      ],
    };

    const { result } = renderHook(() => useEmbeddedAgents(), { wrapper });

    expect(result.current.embeddedAgents).toEqual([]);

    await waitFor(() => {
      expect(result.current.embeddedAgents).toHaveLength(1);
    });
    expect(result.current.embeddedAgents[0].name).toBe('Local GPT');
  });
});
