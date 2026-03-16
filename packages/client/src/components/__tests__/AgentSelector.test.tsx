import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { render, screen, waitFor, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentSelector, useResolvedAgentId } from '../AgentSelector';

// Save original fetch and set up mock
const originalFetch = globalThis.fetch;
const mockFetch = mock((_input: RequestInfo | URL) => Promise.resolve(new Response()));
globalThis.fetch = mockFetch as unknown as typeof fetch;

// Restore original fetch after all tests
afterAll(() => {
  globalThis.fetch = originalFetch;
});

// Clean up after each test
afterEach(() => {
  cleanup();
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

function renderAgentSelector(props: Partial<React.ComponentProps<typeof AgentSelector>> = {}) {
  const defaultProps = {
    onChange: mock(() => {}),
  };

  const mergedProps = { ...defaultProps, ...props };

  return {
    ...render(
      <AgentSelector {...mergedProps} />,
      { wrapper: createTestWrapper() }
    ),
    props: mergedProps,
  };
}

describe('AgentSelector', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(createMockResponse(mockAgentsResponse));
  });

  describe('priority sorting', () => {
    it('should render agents in original order without priorityAgentId', async () => {
      renderAgentSelector();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      const options = screen.getAllByRole('option');
      expect(options[0].textContent).toBe('Claude Code (built-in)');
      expect(options[1].textContent).toBe('Custom Agent');
      expect(options[2].textContent).toBe('Another Agent');
    });

    it('should render the priority agent first when priorityAgentId is set', async () => {
      renderAgentSelector({ priorityAgentId: 'another-agent' });

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      const options = screen.getAllByRole('option');
      expect(options[0].textContent).toBe('Another Agent');
      expect(options[1].textContent).toBe('Claude Code (built-in)');
      expect(options[2].textContent).toBe('Custom Agent');
    });

    it('should select the priority agent when priorityAgentId is set and no value is provided', async () => {
      renderAgentSelector({ priorityAgentId: 'another-agent' });

      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      const select = screen.getByRole('combobox') as HTMLSelectElement;
      expect(select.value).toBe('another-agent');
    });

    it('should keep original order when priorityAgentId does not match any agent', async () => {
      renderAgentSelector({ priorityAgentId: 'nonexistent-agent' });

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      const options = screen.getAllByRole('option');
      expect(options[0].textContent).toBe('Claude Code (built-in)');
      expect(options[1].textContent).toBe('Custom Agent');
      expect(options[2].textContent).toBe('Another Agent');
    });
  });

  describe('loading state', () => {
    it('should show loading state while fetching agents', () => {
      // Use a fetch that never resolves to keep loading state
      mockFetch.mockReturnValue(new Promise(() => {}));

      renderAgentSelector({ value: undefined });

      expect(screen.getByText('Loading...')).toBeTruthy();
    });
  });
});

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
