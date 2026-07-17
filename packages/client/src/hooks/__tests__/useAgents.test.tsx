import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';
import { waitFor, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useResolvedAgentId } from '../useAgents';

// Save original fetch and set up mock
const originalFetch = globalThis.fetch;
const mockFetch = mock((_input: RequestInfo | URL) => Promise.resolve(new Response()));
globalThis.fetch = mockFetch as unknown as typeof fetch;

// Restore original fetch after all tests
afterAll(() => {
  globalThis.fetch = originalFetch;
});

// Mock agents response with three agents to better verify ordering
const mockAgentsResponse = {
  agents: [
    { id: 'claude-code', name: 'Claude Code', isBuiltIn: true },
    { id: 'custom-agent', name: 'Custom Agent', isBuiltIn: false },
    { id: 'another-agent', name: 'Another Agent', isBuiltIn: false },
  ],
};

function createMockResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// Wrapper component with QueryClientProvider
function createTestWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return function TestWrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useResolvedAgentId', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(createMockResponse(mockAgentsResponse));
  });

  it('should return the original value while loading', () => {
    // Use a fetch that never resolves to keep loading state
    mockFetch.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(
      () => useResolvedAgentId('some-agent'),
      { wrapper: createTestWrapper() }
    );

    expect(result.current).toBe('some-agent');
  });

  it('should return undefined while loading when value is undefined', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(
      () => useResolvedAgentId(undefined),
      { wrapper: createTestWrapper() }
    );

    expect(result.current).toBeUndefined();
  });

  it('should return first agent when value is undefined and agents are loaded', async () => {
    const { result } = renderHook(
      () => useResolvedAgentId(undefined),
      { wrapper: createTestWrapper() }
    );

    await waitFor(() => {
      expect(result.current).toBe('claude-code');
    });
  });

  it('should return priority agent when value is undefined and priorityAgentId is set', async () => {
    const { result } = renderHook(
      () => useResolvedAgentId(undefined, 'another-agent'),
      { wrapper: createTestWrapper() }
    );

    await waitFor(() => {
      expect(result.current).toBe('another-agent');
    });
  });

  it('should return existing value when it matches an agent', async () => {
    const { result } = renderHook(
      () => useResolvedAgentId('custom-agent'),
      { wrapper: createTestWrapper() }
    );

    await waitFor(() => {
      expect(result.current).toBe('custom-agent');
    });
  });

  it('should return first agent when value does not match any agent', async () => {
    const { result } = renderHook(
      () => useResolvedAgentId('nonexistent-agent'),
      { wrapper: createTestWrapper() }
    );

    await waitFor(() => {
      expect(result.current).toBe('claude-code');
    });
  });

  it('should return priority agent when value does not match and priorityAgentId is set', async () => {
    const { result } = renderHook(
      () => useResolvedAgentId('nonexistent-agent', 'another-agent'),
      { wrapper: createTestWrapper() }
    );

    await waitFor(() => {
      expect(result.current).toBe('another-agent');
    });
  });
});
