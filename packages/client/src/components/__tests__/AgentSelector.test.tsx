import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { render, screen, waitFor, cleanup, renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useResolvedEmbeddedAgentId,
  UnifiedAgentSelector,
} from '../AgentSelector';
import { useEmbeddedAgents } from '../../hooks/useEmbeddedAgents';

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

// Note: useResolvedAgentId (and useAgents / getAgentName) now live in
// hooks/useAgents.ts -- see hooks/__tests__/useAgents.test.tsx for their
// coverage (moved there when the hooks<->component import cycle was fixed,
// Issue #1160 PR-C follow-up).

const mockEmbeddedAgentsResponse = {
  embeddedAgents: [
    { id: 'embedded-1', name: 'Local GPT' },
    { id: 'embedded-2', name: 'Ollama Agent' },
  ],
};

function resolveUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === 'object' && 'url' in input) return (input as Request).url;
  return '';
}

function mockFetchImplementation() {
  mockFetch.mockImplementation((input) => {
    const url = resolveUrl(input);
    if (url.includes('embedded-agents')) {
      return Promise.resolve(createMockResponse(mockEmbeddedAgentsResponse));
    }
    return Promise.resolve(createMockResponse(mockAgentsResponse));
  });
}

describe('useResolvedEmbeddedAgentId', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetchImplementation();
  });

  it('should return the original value while loading', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(
      () => useResolvedEmbeddedAgentId('embedded-1'),
      { wrapper: createTestWrapper() }
    );

    expect(result.current).toBe('embedded-1');
  });

  it('should return undefined while loading when value is undefined', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(
      () => useResolvedEmbeddedAgentId(undefined),
      { wrapper: createTestWrapper() }
    );

    expect(result.current).toBeUndefined();
  });

  it('should return undefined (not the first embedded agent) when value is undefined and embedded agents have loaded', async () => {
    const { result } = renderHook(
      () => {
        const { isLoading } = useEmbeddedAgents();
        return { isLoading, resolved: useResolvedEmbeddedAgentId(undefined) };
      },
      { wrapper: createTestWrapper() }
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.resolved).toBeUndefined();
  });

  it('should return the existing value unchanged when it matches a known embedded agent id', async () => {
    const { result } = renderHook(
      () => useResolvedEmbeddedAgentId('embedded-2'),
      { wrapper: createTestWrapper() }
    );

    await waitFor(() => {
      expect(result.current).toBe('embedded-2');
    });
  });

  it('should return undefined when the value does not match any embedded agent', async () => {
    const { result } = renderHook(
      () => useResolvedEmbeddedAgentId('nonexistent-embedded'),
      { wrapper: createTestWrapper() }
    );

    await waitFor(() => {
      expect(result.current).toBeUndefined();
    });
  });
});

describe('UnifiedAgentSelector', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetchImplementation();
  });

  function renderUnifiedAgentSelector(
    props: Partial<React.ComponentProps<typeof UnifiedAgentSelector>> = {}
  ) {
    const defaultProps = {
      onChange: mock(() => {}),
    };
    const mergedProps = { ...defaultProps, ...props };
    return {
      ...render(<UnifiedAgentSelector {...mergedProps} />, { wrapper: createTestWrapper() }),
      props: mergedProps,
    };
  }

  it('renders terminal and embedded agent groups', async () => {
    const { container } = renderUnifiedAgentSelector();

    await waitFor(() => {
      expect(screen.getByText('Local GPT')).toBeTruthy();
    });

    const optgroups = container.querySelectorAll('optgroup');
    const labels = Array.from(optgroups).map((el) => el.getAttribute('label'));
    expect(labels).toEqual(['Terminal', 'Embedded (Experimental)']);
    expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
    expect(screen.getByText('Custom Agent')).toBeTruthy();
    expect(screen.getByText('Another Agent')).toBeTruthy();
    expect(screen.getByText('Local GPT')).toBeTruthy();
    expect(screen.getByText('Ollama Agent')).toBeTruthy();
  });

  it('defaults selection to the priority terminal agent when neither agentId nor embeddedAgentId is given', async () => {
    renderUnifiedAgentSelector({ priorityAgentId: 'another-agent' });

    await waitFor(() => {
      expect(screen.getByText('Local GPT')).toBeTruthy();
    });

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('terminal:another-agent');
  });

  it('falls back to the terminal default when embeddedAgentId does not match any embedded agent', async () => {
    renderUnifiedAgentSelector({ embeddedAgentId: 'nonexistent-embedded', priorityAgentId: 'another-agent' });

    await waitFor(() => {
      expect(screen.getByText('Local GPT')).toBeTruthy();
    });

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('terminal:another-agent');
  });

  it('calls onChange with a discriminated embedded selection when an embedded option is selected', async () => {
    const user = userEvent.setup();
    const { props } = renderUnifiedAgentSelector();

    await waitFor(() => {
      expect(screen.getByText('Local GPT')).toBeTruthy();
    });

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    await user.selectOptions(select, 'embedded:embedded-2');

    expect(props.onChange).toHaveBeenCalledWith({ kind: 'embedded', embeddedAgentId: 'embedded-2' });
  });

  it('calls onChange with a discriminated terminal selection when a terminal option is selected', async () => {
    const user = userEvent.setup();
    const { props } = renderUnifiedAgentSelector({ embeddedAgentId: 'embedded-1' });

    await waitFor(() => {
      expect(screen.getByText('Local GPT')).toBeTruthy();
    });

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    await user.selectOptions(select, 'terminal:custom-agent');

    expect(props.onChange).toHaveBeenCalledWith({ kind: 'terminal', agentId: 'custom-agent' });
  });

  describe('disabledKinds', () => {
    it('renders embedded options as disabled and shows the restart notice when embedded is disabled', async () => {
      renderUnifiedAgentSelector({
        disabledKinds: [{ kind: 'embedded', context: 'restart' }],
      });

      await waitFor(() => {
        expect(screen.getByText('Local GPT')).toBeTruthy();
      });

      const embeddedOption = screen.getByText('Local GPT').closest('option') as HTMLOptionElement;
      expect(embeddedOption.disabled).toBe(true);

      const terminalOption = screen.getByText('Claude Code (built-in)').closest('option') as HTMLOptionElement;
      expect(terminalOption.disabled).toBe(false);

      expect(screen.getByText(/Restarting into an embedded agent requires cross-type restart support/)).toBeTruthy();
    });

    it('does not render a notice when the disabled kind has no entries', async () => {
      mockFetch.mockImplementation((input) => {
        const url = resolveUrl(input);
        if (url.includes('embedded-agents')) {
          return Promise.resolve(createMockResponse({ embeddedAgents: [] }));
        }
        return Promise.resolve(createMockResponse(mockAgentsResponse));
      });

      renderUnifiedAgentSelector({
        disabledKinds: [{ kind: 'embedded', context: 'restart' }],
      });

      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      expect(screen.queryByText(/Restarting into an embedded agent requires/)).toBeNull();
    });
  });
});
