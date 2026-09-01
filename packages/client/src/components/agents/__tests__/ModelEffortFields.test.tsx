import { describe, it, expect, mock, afterEach, afterAll } from 'bun:test';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentDefinition, AgentParameterCapabilities } from '@agent-console/shared';
import { ModelEffortFields } from '../ModelEffortFields';

// Save original fetch and set up mock
const originalFetch = globalThis.fetch;
const mockFetch = mock((_input: RequestInfo | URL) => Promise.resolve(new Response()));
globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  cleanup();
});

function createMockResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Agent whose commandTemplate consumes {{model...}} but not {{effort...}}. */
const modelCapableAgent = {
  id: 'model-agent',
  name: 'Model Capable Agent',
  isBuiltIn: false,
  commandTemplate: 'mytool {{model:+--model}} {{prompt}}',
};

/** Agent whose commandTemplate consumes {{effort...}} but not {{model...}}. */
const effortCapableAgent = {
  id: 'effort-agent',
  name: 'Effort Capable Agent',
  isBuiltIn: false,
  commandTemplate: 'mytool {{effort:+--effort}} {{prompt}}',
};

/** Agent whose commandTemplate consumes neither. */
const incapableAgent = {
  id: 'plain-agent',
  name: 'Plain Agent',
  isBuiltIn: false,
  commandTemplate: 'mytool {{prompt}}',
};

function mockAgentsResponse(agents: unknown[]) {
  mockFetch.mockResolvedValue(createMockResponse({ agents }));
}

function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderModelEffortFields(props: Partial<React.ComponentProps<typeof ModelEffortFields>> = {}) {
  const defaultProps: React.ComponentProps<typeof ModelEffortFields> = {
    agentId: undefined,
    model: undefined,
    reasoningEffort: undefined,
    onModelChange: mock(() => {}),
    onReasoningEffortChange: mock(() => {}),
  };
  const mergedProps = { ...defaultProps, ...props };
  return {
    ...render(
      <TestWrapper>
        <ModelEffortFields {...mergedProps} />
      </TestWrapper>
    ),
    props: mergedProps,
  };
}

describe('ModelEffortFields', () => {
  it('renders the Model input for a model-capable agent', async () => {
    mockAgentsResponse([modelCapableAgent]);
    renderModelEffortFields({ agentId: 'model-agent' });

    await waitFor(() => {
      expect(screen.getByPlaceholderText('e.g. opus')).toBeTruthy();
    });
    expect(screen.queryByPlaceholderText('e.g. high')).toBeNull();
  });

  it('does not render the Model input for a model-incapable agent', async () => {
    mockAgentsResponse([incapableAgent]);
    renderModelEffortFields({ agentId: 'plain-agent' });

    // Wait for the agent list fetch to resolve, then confirm nothing renders.
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });
    expect(screen.queryByPlaceholderText('e.g. opus')).toBeNull();
    expect(screen.queryByPlaceholderText('e.g. high')).toBeNull();
  });

  it('renders the Reasoning effort input for a reasoningEffort-capable agent', async () => {
    mockAgentsResponse([effortCapableAgent]);
    renderModelEffortFields({ agentId: 'effort-agent' });

    await waitFor(() => {
      expect(screen.getByPlaceholderText('e.g. high')).toBeTruthy();
    });
    expect(screen.queryByPlaceholderText('e.g. opus')).toBeNull();
  });

  it('does not render the Reasoning effort input for a reasoningEffort-incapable agent', async () => {
    mockAgentsResponse([modelCapableAgent]);
    renderModelEffortFields({ agentId: 'model-agent' });

    await waitFor(() => {
      expect(screen.getByPlaceholderText('e.g. opus')).toBeTruthy();
    });
    expect(screen.queryByPlaceholderText('e.g. high')).toBeNull();
  });

  it('renders neither input when agentId is undefined (embedded agent selected)', async () => {
    mockAgentsResponse([modelCapableAgent, effortCapableAgent]);
    renderModelEffortFields({ agentId: undefined });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });
    expect(screen.queryByPlaceholderText('e.g. opus')).toBeNull();
    expect(screen.queryByPlaceholderText('e.g. high')).toBeNull();
  });

  it('renders neither input when the resolved agent is not found in the loaded list (still loading / unknown)', async () => {
    mockAgentsResponse([modelCapableAgent]);
    renderModelEffortFields({ agentId: 'not-in-list' });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });
    expect(screen.queryByPlaceholderText('e.g. opus')).toBeNull();
    expect(screen.queryByPlaceholderText('e.g. high')).toBeNull();
  });

  describe('getCapabilitiesImpl seam (behavioral pin, not re-derivation)', () => {
    it('follows an injected capabilities function rather than re-deriving from commandTemplate itself', async () => {
      // Agent's real commandTemplate is INCAPABLE of both -- if the
      // component re-derived capability itself (bypassing the injected
      // function), neither input would render regardless of what the seam
      // returns. Asserting both DO render proves the component actually
      // calls and follows getCapabilitiesImpl's return value.
      mockAgentsResponse([incapableAgent]);
      const alwaysCapable: (agent: AgentDefinition) => AgentParameterCapabilities = () => ({
        model: true,
        reasoningEffort: true,
      });

      renderModelEffortFields({ agentId: 'plain-agent', getCapabilitiesImpl: alwaysCapable });

      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g. opus')).toBeTruthy();
      });
      expect(screen.getByPlaceholderText('e.g. high')).toBeTruthy();
    });

    it('hides both inputs when the injected capabilities function returns all-false, even for a really-capable agent', async () => {
      // Inverse polarity: agent's real commandTemplate IS capable of both --
      // if the component re-derived capability itself, both inputs would
      // render regardless of the seam. Asserting neither renders proves the
      // component follows the injected function, not agent.commandTemplate.
      mockAgentsResponse([modelCapableAgent]);
      const neverCapable: (agent: AgentDefinition) => AgentParameterCapabilities = () => ({
        model: false,
        reasoningEffort: false,
      });

      renderModelEffortFields({ agentId: 'model-agent', getCapabilitiesImpl: neverCapable });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });
      expect(screen.queryByPlaceholderText('e.g. opus')).toBeNull();
      expect(screen.queryByPlaceholderText('e.g. high')).toBeNull();
    });
  });

  it('calls onModelChange with the typed value', async () => {
    mockAgentsResponse([modelCapableAgent]);
    const onModelChange = mock(() => {});
    renderModelEffortFields({ agentId: 'model-agent', onModelChange });

    const input = await waitFor(() => screen.getByPlaceholderText('e.g. opus'));
    fireEvent.change(input, { target: { value: 'opus' } });

    expect(onModelChange).toHaveBeenCalledWith('opus');
  });
});
