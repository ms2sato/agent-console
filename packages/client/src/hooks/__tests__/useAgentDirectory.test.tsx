import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useAgentDirectory } from '../useAgentDirectory';

const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number, error: string): Response {
  return jsonResponse({ error }, status);
}

let agentsResponse: unknown = { agents: [] };
let embeddedAgentsResponse: unknown = { embeddedAgents: [] };
let agentsStatus = 200;
let embeddedAgentsStatus = 200;

const mockFetch = Object.assign(
  mock(async (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/embedded-agents')) {
      return embeddedAgentsStatus === 200
        ? jsonResponse(embeddedAgentsResponse)
        : errorResponse(embeddedAgentsStatus, 'embedded agents fetch failed');
    }
    if (url.includes('/agents')) {
      return agentsStatus === 200
        ? jsonResponse(agentsResponse)
        : errorResponse(agentsStatus, 'agents fetch failed');
    }
    return jsonResponse({});
  }),
  { preconnect: originalFetch.preconnect },
);

beforeEach(() => {
  globalThis.fetch = mockFetch;
  agentsResponse = { agents: [] };
  embeddedAgentsResponse = { embeddedAgents: [] };
  agentsStatus = 200;
  embeddedAgentsStatus = 200;
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

describe('useAgentDirectory', () => {
  it('orders terminal entries before embedded entries', async () => {
    agentsResponse = {
      agents: [
        { id: 'claude-code', name: 'Claude Code', isBuiltIn: true },
        { id: 'custom-agent', name: 'Custom Agent', isBuiltIn: false },
      ],
    };
    embeddedAgentsResponse = {
      embeddedAgents: [
        { id: 'embedded-1', name: 'Local GPT' },
        { id: 'embedded-2', name: 'Ollama Agent' },
      ],
    };

    const { result } = renderHook(() => useAgentDirectory(), { wrapper });

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(4);
    });

    expect(result.current.entries.map((e) => e.kind)).toEqual([
      'terminal',
      'terminal',
      'embedded',
      'embedded',
    ]);
    expect(result.current.entries.map((e) => e.agent.id)).toEqual([
      'claude-code',
      'custom-agent',
      'embedded-1',
      'embedded-2',
    ]);
  });

  it('reports isLoading true while either registry is still loading', () => {
    globalThis.fetch = Object.assign(
      mock(() => new Promise<Response>(() => {})),
      { preconnect: originalFetch.preconnect },
    );

    const { result } = renderHook(() => useAgentDirectory(), { wrapper });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.entries).toEqual([]);
  });

  it('reports isLoading false and both errors surfaced (first non-null) when a registry fetch fails', async () => {
    agentsStatus = 500;

    const { result } = renderHook(() => useAgentDirectory(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.error).not.toBeNull();
  });

  it('returns an empty entries array when both registries are empty (boundary)', async () => {
    const { result } = renderHook(() => useAgentDirectory(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.entries).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('returns only embedded entries when the terminal registry is empty', async () => {
    agentsResponse = { agents: [] };
    embeddedAgentsResponse = {
      embeddedAgents: [{ id: 'embedded-1', name: 'Local GPT' }],
    };

    const { result } = renderHook(() => useAgentDirectory(), { wrapper });

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });
    expect(result.current.entries[0]).toEqual({
      kind: 'embedded',
      agent: expect.objectContaining({ id: 'embedded-1' }),
    });
  });

  it('returns only terminal entries when the embedded registry is empty', async () => {
    agentsResponse = {
      agents: [{ id: 'claude-code', name: 'Claude Code', isBuiltIn: true }],
    };
    embeddedAgentsResponse = { embeddedAgents: [] };

    const { result } = renderHook(() => useAgentDirectory(), { wrapper });

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });
    expect(result.current.entries[0]).toEqual({
      kind: 'terminal',
      agent: expect.objectContaining({ id: 'claude-code' }),
    });
  });

  it('refetch triggers both underlying registry refetches', async () => {
    const { result } = renderHook(() => useAgentDirectory(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    mockFetch.mockClear();
    result.current.refetch();

    await waitFor(() => {
      const urls = mockFetch.mock.calls.map(([input]) =>
        input instanceof Request ? input.url : String(input),
      );
      expect(urls.some((u) => u.includes('/agents') && !u.includes('embedded'))).toBe(true);
      expect(urls.some((u) => u.includes('/embedded-agents'))).toBe(true);
    });
  });
});
