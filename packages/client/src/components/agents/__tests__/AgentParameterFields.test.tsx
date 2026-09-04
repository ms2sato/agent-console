import { describe, it, expect, mock, afterEach, afterAll } from 'bun:test';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentParameterCapabilitiesByKind } from '@agent-console/shared';
import { AgentParameterFields } from '../AgentParameterFields';
import { agentKeys, embeddedAgentKeys } from '../../../lib/query-keys';

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
  return new Response(JSON.stringify(body), { status: 200 });
}

function resolveUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === 'object' && 'url' in input) {
    return (input as { url: unknown }).url as string;
  }
  return '';
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

/**
 * Embedded definition. Both engines are `capable: true` for model and
 * reasoningEffort in the real `EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES`
 * table (embedded-agent-parameter-capabilities.ts), so a real (non-injected)
 * lookup always shows both inputs for either engine -- no need to vary the
 * fixture's engine to exercise the render-gating tests below.
 */
const embeddedDefinition = {
  id: 'embedded-1',
  name: 'Local GPT',
  engine: 'openai-api' as const,
};

/** Routes /agents to `agents`, /embedded-agents to `embeddedAgents`. Default: empty lists. */
function mockDirectoryResponses({
  agents = [] as unknown[],
  embeddedAgents = [] as unknown[],
} = {}) {
  mockFetch.mockImplementation((input: unknown) => {
    const url = resolveUrl(input);
    if (url.includes('embedded-agents')) {
      return Promise.resolve(createMockResponse({ embeddedAgents }));
    }
    return Promise.resolve(createMockResponse({ agents }));
  });
}

function TestWrapper({
  children,
  queryClient,
}: {
  children: React.ReactNode;
  queryClient: QueryClient;
}) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/**
 * Waits until BOTH the terminal-agent and embedded-agent list queries have
 * actually settled (success or error), not merely until `fetch` was
 * invoked. This component's `useAgentDirectory()` unconditionally calls both
 * `useAgents()` and `useEmbeddedAgents()` (React hooks cannot be called
 * conditionally), so an absence assertion made before both settle could pass
 * vacuously -- the component may still be mid-flight for the query the
 * assertion actually depends on.
 */
async function waitForDirectoryQueriesSettled(queryClient: QueryClient) {
  await waitFor(() => {
    const agentStatus = queryClient.getQueryState(agentKeys.all())?.status;
    const embeddedStatus = queryClient.getQueryState(embeddedAgentKeys.all())?.status;
    expect(agentStatus === 'success' || agentStatus === 'error').toBe(true);
    expect(embeddedStatus === 'success' || embeddedStatus === 'error').toBe(true);
  });
}

function renderAgentParameterFields(
  props: Partial<React.ComponentProps<typeof AgentParameterFields>> = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const defaultProps: React.ComponentProps<typeof AgentParameterFields> = {
    selection: undefined,
    model: undefined,
    reasoningEffort: undefined,
    contextWindowTokens: undefined,
    onModelChange: mock(() => {}),
    onReasoningEffortChange: mock(() => {}),
    onContextWindowTokensChange: mock(() => {}),
  };
  const mergedProps = { ...defaultProps, ...props };
  return {
    ...render(
      <TestWrapper queryClient={queryClient}>
        <AgentParameterFields {...mergedProps} />
      </TestWrapper>
    ),
    props: mergedProps,
    queryClient,
  };
}

describe('AgentParameterFields', () => {
  describe('terminal selection', () => {
    it('renders the Model input for a model-capable agent', async () => {
      mockDirectoryResponses({ agents: [modelCapableAgent] });
      renderAgentParameterFields({ selection: { kind: 'terminal', agentId: 'model-agent' } });

      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g. opus')).toBeTruthy();
      });
      expect(screen.queryByPlaceholderText('e.g. high')).toBeNull();
    });

    it('does not render the Model input for a model-incapable agent', async () => {
      mockDirectoryResponses({ agents: [incapableAgent] });
      const { queryClient } = renderAgentParameterFields({
        selection: { kind: 'terminal', agentId: 'plain-agent' },
      });

      await waitForDirectoryQueriesSettled(queryClient);
      expect(screen.queryByPlaceholderText('e.g. opus')).toBeNull();
      expect(screen.queryByPlaceholderText('e.g. high')).toBeNull();
    });

    it('renders the Reasoning effort input for a reasoningEffort-capable agent', async () => {
      mockDirectoryResponses({ agents: [effortCapableAgent] });
      renderAgentParameterFields({ selection: { kind: 'terminal', agentId: 'effort-agent' } });

      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g. high')).toBeTruthy();
      });
      expect(screen.queryByPlaceholderText('e.g. opus')).toBeNull();
    });

    it('renders neither input when selection is undefined', async () => {
      mockDirectoryResponses({ agents: [modelCapableAgent, effortCapableAgent] });
      const { queryClient } = renderAgentParameterFields({ selection: undefined });

      await waitForDirectoryQueriesSettled(queryClient);
      expect(screen.queryByPlaceholderText('e.g. opus')).toBeNull();
      expect(screen.queryByPlaceholderText('e.g. high')).toBeNull();
    });

    it('renders neither input when the resolved terminal agent is not found in the loaded list', async () => {
      mockDirectoryResponses({ agents: [modelCapableAgent] });
      const { queryClient } = renderAgentParameterFields({
        selection: { kind: 'terminal', agentId: 'not-in-list' },
      });

      await waitForDirectoryQueriesSettled(queryClient);
      expect(screen.queryByPlaceholderText('e.g. opus')).toBeNull();
      expect(screen.queryByPlaceholderText('e.g. high')).toBeNull();
    });

    it('calls onModelChange with the typed value', async () => {
      mockDirectoryResponses({ agents: [modelCapableAgent] });
      const onModelChange = mock(() => {});
      renderAgentParameterFields({
        selection: { kind: 'terminal', agentId: 'model-agent' },
        onModelChange,
      });

      const input = await waitFor(() => screen.getByPlaceholderText('e.g. opus'));
      fireEvent.change(input, { target: { value: 'opus' } });

      expect(onModelChange).toHaveBeenCalledWith('opus');
    });
  });

  describe('embedded selection', () => {
    it('renders neither input when the resolved embedded definition is not found in the loaded list', async () => {
      mockDirectoryResponses({ embeddedAgents: [] });
      const { queryClient } = renderAgentParameterFields({
        selection: { kind: 'embedded', embeddedAgentId: 'embedded-1' },
      });

      await waitForDirectoryQueriesSettled(queryClient);
      expect(screen.queryByPlaceholderText('e.g. opus')).toBeNull();
      expect(screen.queryByPlaceholderText('e.g. high')).toBeNull();
    });

    it('renders Model and Reasoning effort inputs for a resolved embedded definition', async () => {
      mockDirectoryResponses({ embeddedAgents: [embeddedDefinition] });
      renderAgentParameterFields({
        selection: { kind: 'embedded', embeddedAgentId: 'embedded-1' },
      });

      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g. opus')).toBeTruthy();
      });
      expect(screen.getByPlaceholderText('e.g. high')).toBeTruthy();
    });
  });

  describe('contextWindowTokens render-gating (agent-surface.md Ruling 4)', () => {
    // Pin (a): a terminal selection never renders the field, regardless of
    // model. This does not depend on the (async) embedded-agents fetch --
    // getAgentParameterCapabilitiesFor's terminal branch always returns
    // contextWindowTokens: false -- but the query is still awaited for
    // consistent discipline with the embedded-branch pins below, and to
    // prove this isn't merely "nothing has resolved yet".
    it('(a) does NOT render for a terminal selection even with a non-empty model', async () => {
      mockDirectoryResponses({ agents: [modelCapableAgent] });
      const { queryClient } = renderAgentParameterFields({
        selection: { kind: 'terminal', agentId: 'model-agent' },
        model: 'opus',
      });

      // Positive control: the Model input itself must be present, proving
      // the terminal agent actually resolved and capability was evaluated --
      // otherwise "the window field is absent" could vacuously be "nothing
      // rendered at all".
      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g. opus')).toBeTruthy();
      });
      await waitForDirectoryQueriesSettled(queryClient);
      expect(screen.queryByPlaceholderText('e.g. 128000')).toBeNull();
    });

    // Pin (b): an embedded selection with an empty model does not render
    // the field. `useAgentDirectory()` composes TanStack Query hooks
    // (async), so the resolution of `embeddedDefinition` from the fetched
    // list is itself async -- the absence must be checked only after that
    // settles, paired with a positive control (the Model input rendering)
    // proving resolution actually happened rather than the component merely
    // being mid-flight.
    //
    // Reach measured (2026-09-02): mutating AgentParameterFields.tsx's
    // `showContextWindowTokens` from
    // `capabilities.contextWindowTokens && !!model?.trim()` to
    // `capabilities.contextWindowTokens` (dropping the model-non-empty
    // check) turns THIS test and its whitespace-only sibling below from
    // pass to fail, plus the (e-inverse) seam test below (whose terminal
    // arm injects `contextWindowTokens: true` via the seam with no model
    // set -- the mutation lets that leak through too). All 3 failures
    // restored to pass after reverting the mutation; the other 16 tests in
    // this file were unaffected by either state.
    it('(b) does NOT render for an embedded selection with an empty model', async () => {
      mockDirectoryResponses({ embeddedAgents: [embeddedDefinition] });
      const { queryClient } = renderAgentParameterFields({
        selection: { kind: 'embedded', embeddedAgentId: 'embedded-1' },
        model: undefined,
      });

      // Positive control: proves the embedded definition resolved (the
      // async useAgentDirectory() queries settled and found the entry)
      // before the absence assertion below is trusted.
      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g. opus')).toBeTruthy();
      });
      await waitForDirectoryQueriesSettled(queryClient);
      expect(screen.queryByPlaceholderText('e.g. 128000')).toBeNull();
    });

    it('(b-whitespace) does NOT render for an embedded selection with a whitespace-only model', async () => {
      mockDirectoryResponses({ embeddedAgents: [embeddedDefinition] });
      const { queryClient } = renderAgentParameterFields({
        selection: { kind: 'embedded', embeddedAgentId: 'embedded-1' },
        model: '   ',
      });

      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g. opus')).toBeTruthy();
      });
      await waitForDirectoryQueriesSettled(queryClient);
      expect(screen.queryByPlaceholderText('e.g. 128000')).toBeNull();
    });

    // Pin (c): an embedded selection with a non-empty model DOES render the
    // field.
    it('(c) DOES render for an embedded selection with a non-empty model', async () => {
      mockDirectoryResponses({ embeddedAgents: [embeddedDefinition] });
      renderAgentParameterFields({
        selection: { kind: 'embedded', embeddedAgentId: 'embedded-1' },
        model: 'gpt-4o',
      });

      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g. 128000')).toBeTruthy();
      });
    });

    it('calls onContextWindowTokensChange with a parsed number when typed', async () => {
      mockDirectoryResponses({ embeddedAgents: [embeddedDefinition] });
      const onContextWindowTokensChange = mock(() => {});
      renderAgentParameterFields({
        selection: { kind: 'embedded', embeddedAgentId: 'embedded-1' },
        model: 'gpt-4o',
        onContextWindowTokensChange,
      });

      const input = await waitFor(() => screen.getByPlaceholderText('e.g. 128000'));
      fireEvent.change(input, { target: { value: '128000' } });
      expect(onContextWindowTokensChange).toHaveBeenCalledWith(128000);
    });

    it('renders the contextWindowTokensError message (Issue #1554 CodeRabbit Finding 2 -- otherwise an invalid value fails validation with no visible feedback)', async () => {
      mockDirectoryResponses({ embeddedAgents: [embeddedDefinition] });
      renderAgentParameterFields({
        selection: { kind: 'embedded', embeddedAgentId: 'embedded-1' },
        model: 'gpt-4o',
        contextWindowTokensError: { type: 'custom', message: 'Must be a whole number' },
      });

      await waitFor(() => {
        expect(screen.getByText('Must be a whole number')).toBeTruthy();
      });
      const input = screen.getByPlaceholderText('e.g. 128000');
      expect(input.getAttribute('aria-invalid')).toBe('true');
    });

    it('does NOT render an error message when contextWindowTokensError is absent (regression guard)', async () => {
      mockDirectoryResponses({ embeddedAgents: [embeddedDefinition] });
      renderAgentParameterFields({
        selection: { kind: 'embedded', embeddedAgentId: 'embedded-1' },
        model: 'gpt-4o',
      });

      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g. 128000')).toBeTruthy();
      });
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('calls onContextWindowTokensChange with undefined when the field is cleared', async () => {
      // Distinct render from the "parsed number" test above rather than a
      // second fireEvent on the same input: this component doesn't own
      // `contextWindowTokens` state, so the input stays controlled by the
      // static test prop between events -- reusing one render across two
      // sequential `fireEvent.change` calls does not model a real
      // parent-controlled round trip (parent updates the prop after
      // `onChange`, which this static test setup does not do).
      mockDirectoryResponses({ embeddedAgents: [embeddedDefinition] });
      const onContextWindowTokensChange = mock(() => {});
      renderAgentParameterFields({
        selection: { kind: 'embedded', embeddedAgentId: 'embedded-1' },
        model: 'gpt-4o',
        contextWindowTokens: 128000,
        onContextWindowTokensChange,
      });

      const input = (await waitFor(() =>
        screen.getByPlaceholderText('e.g. 128000')
      )) as HTMLInputElement;
      expect(input.value).toBe('128000');

      fireEvent.change(input, { target: { value: '' } });
      expect(onContextWindowTokensChange).toHaveBeenCalledWith(undefined);
    });
  });

  describe('getCapabilitiesImpl seam (single seam, both kinds -- behavioral pin, not re-derivation)', () => {
    it('follows an injected capabilities function rather than re-deriving from the entry itself (terminal side)', async () => {
      // Agent's real commandTemplate is INCAPABLE of both -- if the
      // component re-derived capability itself (bypassing the injected
      // function), neither input would render regardless of what the seam
      // returns. Asserting both DO render proves the component actually
      // calls and follows getCapabilitiesImpl's return value.
      mockDirectoryResponses({ agents: [incapableAgent] });
      const alwaysCapable = (): AgentParameterCapabilitiesByKind => ({
        model: true,
        reasoningEffort: true,
        contextWindowTokens: false,
      });

      renderAgentParameterFields({
        selection: { kind: 'terminal', agentId: 'plain-agent' },
        getCapabilitiesImpl: alwaysCapable,
      });

      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g. opus')).toBeTruthy();
      });
      expect(screen.getByPlaceholderText('e.g. high')).toBeTruthy();
    });

    // Pin (e): swapping getCapabilitiesImpl changes what renders for BOTH
    // kinds through the SAME seam -- this component resolves `selection` to
    // an AgentDirectoryEntry and hands the whole entry to ONE injected
    // function; it never branches on entry.kind to pick between two
    // separate accessors. A stub that disagrees with the REAL capability in
    // both directions (all-false against really-capable entries) proves
    // the seam, not entry.kind or a hardcoded per-kind accessor, is what
    // decided the render for both kinds.
    it('(e) follows an injected capabilities function for BOTH kinds through the same seam', async () => {
      const disagreeAllFalse = (): AgentParameterCapabilitiesByKind => ({
        model: false,
        reasoningEffort: false,
        contextWindowTokens: false,
      });

      // Terminal side: modelCapableAgent's real commandTemplate IS capable
      // of model.
      mockDirectoryResponses({ agents: [modelCapableAgent] });
      const { queryClient: terminalQueryClient } = renderAgentParameterFields({
        selection: { kind: 'terminal', agentId: 'model-agent' },
        getCapabilitiesImpl: disagreeAllFalse,
      });
      await waitForDirectoryQueriesSettled(terminalQueryClient);
      expect(screen.queryByPlaceholderText('e.g. opus')).toBeNull();
      expect(screen.queryByPlaceholderText('e.g. high')).toBeNull();
      cleanup();

      // Embedded side: embeddedDefinition's real capability table row IS
      // capable of both model and reasoningEffort (and therefore
      // contextWindowTokens, given a non-empty model). Same stub function,
      // same assertion shape -- proving ONE seam governs both kinds.
      mockDirectoryResponses({ embeddedAgents: [embeddedDefinition] });
      const { queryClient: embeddedQueryClient } = renderAgentParameterFields({
        selection: { kind: 'embedded', embeddedAgentId: 'embedded-1' },
        model: 'gpt-4o',
        getCapabilitiesImpl: disagreeAllFalse,
      });
      await waitForDirectoryQueriesSettled(embeddedQueryClient);
      expect(screen.queryByPlaceholderText('e.g. opus')).toBeNull();
      expect(screen.queryByPlaceholderText('e.g. high')).toBeNull();
      expect(screen.queryByPlaceholderText('e.g. 128000')).toBeNull();
    });

    it('(e-inverse) follows an injected capabilities function turning capability ON for BOTH kinds through the same seam', async () => {
      // Inverse polarity of pin (e): both entries' REAL capability is
      // incapable-of-everything (incapableAgent's commandTemplate consumes
      // neither placeholder; a definition with no capability table entry
      // would throw, so this side reuses incapableAgent on the terminal arm
      // and asserts the seam alone decides -- not entry.kind, not the real
      // table).
      const alwaysCapableWithWindow = (): AgentParameterCapabilitiesByKind => ({
        model: true,
        reasoningEffort: true,
        contextWindowTokens: true,
      });

      mockDirectoryResponses({ agents: [incapableAgent] });
      renderAgentParameterFields({
        selection: { kind: 'terminal', agentId: 'plain-agent' },
        getCapabilitiesImpl: alwaysCapableWithWindow,
      });
      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g. opus')).toBeTruthy();
      });
      expect(screen.getByPlaceholderText('e.g. high')).toBeTruthy();
      // Terminal entries never show the window field regardless of what the
      // seam returns for contextWindowTokens -- that would be a real
      // capability-table inconsistency (agent-surface.md Ruling 4 states
      // terminal has NO context-window meaning at all), so this asserts the
      // seam's contextWindowTokens: true is exercised faithfully only when
      // paired with a non-empty model; here model is unset, so it's absent
      // regardless.
      expect(screen.queryByPlaceholderText('e.g. 128000')).toBeNull();
      cleanup();

      mockDirectoryResponses({ embeddedAgents: [embeddedDefinition] });
      renderAgentParameterFields({
        selection: { kind: 'embedded', embeddedAgentId: 'embedded-1' },
        model: 'gpt-4o',
        getCapabilitiesImpl: alwaysCapableWithWindow,
      });
      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g. opus')).toBeTruthy();
      });
      expect(screen.getByPlaceholderText('e.g. high')).toBeTruthy();
      expect(screen.getByPlaceholderText('e.g. 128000')).toBeTruthy();
    });
  });

  describe('entry resolution is keyed by kind AND id, not id alone', () => {
    // Regression guard for the internal findEntry helper: a terminal agent
    // and an embedded definition sharing the SAME id string must resolve to
    // the entry matching the SELECTED kind, not whichever entry happens to
    // have a matching id first. If kind were dropped from the match
    // condition, an 'embedded' selection could resolve to the terminal
    // entry's capabilities (or vice versa) whenever ids collide across the
    // two registries -- id namespaces are documented as non-overlapping by
    // convention, but this component must not silently rely on that
    // invariant holding.
    const sharedId = 'shared-id';
    const terminalWithSharedId = {
      id: sharedId,
      name: 'Terminal (shared id)',
      isBuiltIn: false,
      commandTemplate: 'mytool {{prompt}}', // incapable of both
    };
    const embeddedWithSharedId = {
      id: sharedId,
      name: 'Embedded (shared id)',
      engine: 'openai-api' as const, // capable of both in the real table
    };

    it('resolves the embedded entry (not the terminal one) when selection.kind is "embedded" despite an id collision', async () => {
      mockDirectoryResponses({
        agents: [terminalWithSharedId],
        embeddedAgents: [embeddedWithSharedId],
      });
      renderAgentParameterFields({
        selection: { kind: 'embedded', embeddedAgentId: sharedId },
      });

      // If the terminal entry (incapable of both) had been resolved instead,
      // neither input would render. The embedded entry IS capable, so both
      // must render.
      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g. opus')).toBeTruthy();
      });
      expect(screen.getByPlaceholderText('e.g. high')).toBeTruthy();
    });

    it('resolves the terminal entry (not the embedded one) when selection.kind is "terminal" despite an id collision', async () => {
      mockDirectoryResponses({
        agents: [terminalWithSharedId],
        embeddedAgents: [embeddedWithSharedId],
      });
      const { queryClient } = renderAgentParameterFields({
        selection: { kind: 'terminal', agentId: sharedId },
      });

      // If the embedded entry (capable of both) had been resolved instead,
      // both inputs would render. The terminal entry is INCAPABLE, so
      // neither must render.
      await waitForDirectoryQueriesSettled(queryClient);
      expect(screen.queryByPlaceholderText('e.g. opus')).toBeNull();
      expect(screen.queryByPlaceholderText('e.g. high')).toBeNull();
    });
  });

  describe('disabled prop', () => {
    it('forwards disabled to every rendered input', async () => {
      mockDirectoryResponses({ agents: [modelCapableAgent, effortCapableAgent] });
      renderAgentParameterFields({
        selection: { kind: 'terminal', agentId: 'model-agent' },
        disabled: true,
      });

      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g. opus')).toBeTruthy();
      });
      expect((screen.getByPlaceholderText('e.g. opus') as HTMLInputElement).disabled).toBe(true);
    });

    it('leaves inputs enabled when disabled is omitted (default false)', async () => {
      mockDirectoryResponses({ agents: [modelCapableAgent] });
      renderAgentParameterFields({ selection: { kind: 'terminal', agentId: 'model-agent' } });

      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g. opus')).toBeTruthy();
      });
      expect((screen.getByPlaceholderText('e.g. opus') as HTMLInputElement).disabled).toBe(false);
    });
  });
});
