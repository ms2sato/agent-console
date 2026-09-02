import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QuickSessionForm } from '../QuickSessionForm';
import { setSharedAccountsAvailable, _reset as resetAuth } from '../../../lib/auth';

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

// Mock agents response
const mockAgentsResponse = {
  agents: [
    { id: 'claude-code', name: 'Claude Code', isBuiltIn: true },
    { id: 'custom-agent', name: 'Custom Agent', isBuiltIn: false },
  ],
};

const mockEmbeddedAgentsResponse = {
  embeddedAgents: [{ id: 'embedded-1', name: 'Local GPT', engine: 'openai-api' }],
};

function createMockResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function resolveUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (
    input &&
    typeof input === 'object' &&
    'url' in input &&
    typeof (input as { url: unknown }).url === 'string'
  ) {
    return (input as { url: string }).url;
  }
  return '';
}

function mockFetchWithEmbedded() {
  mockFetch.mockImplementation((input: unknown) => {
    const url = resolveUrl(input);
    if (url.includes('embedded-agents')) {
      return Promise.resolve(createMockResponse(mockEmbeddedAgentsResponse));
    }
    return Promise.resolve(createMockResponse(mockAgentsResponse));
  });
}

// Wrapper component with QueryClientProvider
function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderQuickSessionForm(props: Partial<React.ComponentProps<typeof QuickSessionForm>> = {}) {
  const defaultProps = {
    isPending: false,
    onSubmit: mock(() => Promise.resolve()),
    onCancel: mock(() => {}),
  };

  const mergedProps = { ...defaultProps, ...props };

  return {
    ...render(
      <TestWrapper>
        <QuickSessionForm {...mergedProps} />
      </TestWrapper>
    ),
    props: mergedProps,
  };
}

describe('QuickSessionForm', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    // Default: return agents for AgentSelector
    mockFetch.mockResolvedValue(createMockResponse(mockAgentsResponse));
    resetAuth();
  });

  afterEach(() => {
    resetAuth();
  });

  describe('successful submission', () => {
    it('should submit successfully with valid path', async () => {
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Clear default value and fill in location path
      const pathInput = screen.getByPlaceholderText(/Path.*e\.g\./);
      await user.clear(pathInput);
      await user.type(pathInput, '/path/to/project');

      // Submit form
      const submitButton = screen.getByText('Start');
      await user.click(submitButton);

      // Verify onSubmit was called with correct data
      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0]).toMatchObject({
        type: 'quick',
        locationPath: '/path/to/project',
      });
    });

    it('should include selected agent', async () => {
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Fill in location path
      const pathInput = screen.getByPlaceholderText(/Path.*e\.g\./);
      await user.type(pathInput, '/path/to/project');

      // Select different agent
      const agentSelect = screen.getByRole('combobox');
      await user.selectOptions(agentSelect, 'terminal:custom-agent');

      // Submit form
      const submitButton = screen.getByText('Start');
      await user.click(submitButton);

      // Verify agentId is included
      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0]).toMatchObject({
        agentId: 'custom-agent',
      });
    });
  });

  describe('agent kind selection (Issue #1160 PR-C, polarity pair)', () => {
    beforeEach(() => {
      mockFetch.mockReset();
      mockFetchWithEmbedded();
      resetAuth();
    });

    it('submits { agentId } without embeddedAgentId when no interaction happens (terminal default)', async () => {
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      await user.click(screen.getByText('Start'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0].agentId).toBe('claude-code');
      expect(submitCall[0].embeddedAgentId).toBeUndefined();
    });

    it('submits { embeddedAgentId } WITHOUT agentId when an embedded agent is selected', async () => {
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      await waitFor(() => {
        expect(screen.getByText('Local GPT')).toBeTruthy();
      });

      const agentSelect = screen.getByRole('combobox');
      await user.selectOptions(agentSelect, 'embedded:embedded-1');

      await user.click(screen.getByText('Start'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0].embeddedAgentId).toBe('embedded-1');
      expect(submitCall[0].agentId).toBeUndefined();
    });

    it('submits { agentId } WITHOUT embeddedAgentId when a terminal agent is (re-)selected', async () => {
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      await waitFor(() => {
        expect(screen.getByText('Local GPT')).toBeTruthy();
      });

      const agentSelect = screen.getByRole('combobox');
      // Select embedded first, then switch back to terminal.
      await user.selectOptions(agentSelect, 'embedded:embedded-1');
      await user.selectOptions(agentSelect, 'terminal:custom-agent');

      await user.click(screen.getByText('Start'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0].agentId).toBe('custom-agent');
      expect(submitCall[0].embeddedAgentId).toBeUndefined();
    });
  });

  describe('validation errors', () => {
    it('should show validation error when path is empty', async () => {
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Clear the default value to make path empty
      const pathInput = screen.getByPlaceholderText(/Path.*e\.g\./);
      await user.clear(pathInput);

      // Submit without filling anything
      const submitButton = screen.getByText('Start');
      await user.click(submitButton);

      // onSubmit should NOT be called
      await waitFor(() => {
        expect(props.onSubmit).not.toHaveBeenCalled();
      });

      // Error should be displayed
      await waitFor(() => {
        expect(screen.getByText(/Location path is required/)).toBeTruthy();
      });
    });

    /**
     * This test ensures form submission works correctly with the default
     * locationPath value of '/tmp'.
     * The form uses defaultValues: { locationPath: '/tmp' }
     */
    it('should submit successfully with default locationPath value', async () => {
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Submit immediately - locationPath is '/tmp' from defaultValues
      const submitButton = screen.getByText('Start');
      await user.click(submitButton);

      // onSubmit should be called with default path
      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0]).toMatchObject({
        type: 'quick',
        locationPath: '/tmp',
      });
    });
  });

  describe('error handling', () => {
    it('should display root error when onSubmit throws', async () => {
      const user = userEvent.setup();
      const onSubmit = mock(() => Promise.reject(new Error('Directory not found')));
      renderQuickSessionForm({ onSubmit });

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Fill in location path
      const pathInput = screen.getByPlaceholderText(/Path.*e\.g\./);
      await user.type(pathInput, '/invalid/path');

      // Submit form
      const submitButton = screen.getByText('Start');
      await user.click(submitButton);

      // Error should be displayed
      await waitFor(() => {
        expect(screen.getByText('Directory not found')).toBeTruthy();
      });
    });
  });

  describe('UI state', () => {
    it('should disable form when isPending is true', async () => {
      renderQuickSessionForm({ isPending: true });

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Form overlay should be visible with loading message
      expect(screen.getByText('Starting session...')).toBeTruthy();

      // Form fields should be disabled via fieldset
      const pathInput = screen.getByPlaceholderText(/Path/);
      expect(pathInput.closest('fieldset')?.disabled).toBe(true);
    });

    it('should call onCancel when cancel button is clicked', async () => {
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Click cancel
      const cancelButton = screen.getByText('Cancel');
      await user.click(cancelButton);

      expect(props.onCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('shared session checkbox', () => {
    it('should NOT render the checkbox when sharedAccountsAvailable is false', async () => {
      setSharedAccountsAvailable(false);
      renderQuickSessionForm();

      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      expect(screen.queryByText('Create as shared session')).toBeNull();
    });

    it('should render the checkbox when sharedAccountsAvailable is true', async () => {
      setSharedAccountsAvailable(true);
      renderQuickSessionForm();

      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      expect(screen.getByText('Create as shared session')).toBeTruthy();
    });

    it('should submit shared: true when the checkbox is checked', async () => {
      setSharedAccountsAvailable(true);
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      const checkbox = screen.getByRole('checkbox');
      await user.click(checkbox);

      const pathInput = screen.getByPlaceholderText(/Path.*e\.g\./);
      await user.clear(pathInput);
      await user.type(pathInput, '/path/to/project');

      await user.click(screen.getByText('Start'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0]).toMatchObject({
        type: 'quick',
        locationPath: '/path/to/project',
        shared: true,
      });
    });

    it('should not submit shared: true when the checkbox is left unchecked', async () => {
      setSharedAccountsAvailable(true);
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      const pathInput = screen.getByPlaceholderText(/Path.*e\.g\./);
      await user.clear(pathInput);
      await user.type(pathInput, '/path/to/project');

      await user.click(screen.getByText('Start'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0].shared).not.toBe(true);
    });
  });

  describe('model / reasoningEffort fields (Issue #1541)', () => {
    // Overrides the default mockAgentsResponse (which has no
    // commandTemplate, so ModelEffortFields always renders nothing for it)
    // with agents that vary in capability, per getAgentParameterCapabilities.
    function mockAgentsWithCapabilities() {
      mockFetch.mockResolvedValue(
        createMockResponse({
          agents: [
            { id: 'claude-code', name: 'Claude Code', isBuiltIn: true, commandTemplate: 'claude {{model:+--model}} {{prompt}}' },
            { id: 'plain-agent', name: 'Plain Agent', isBuiltIn: false, commandTemplate: 'plaintool {{prompt}}' },
          ],
        })
      );
    }

    it('shows the Model input for a model-capable agent and omits reasoningEffort input', async () => {
      mockAgentsWithCapabilities();
      renderQuickSessionForm();

      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      expect(screen.getByPlaceholderText('e.g. opus')).toBeTruthy();
      expect(screen.queryByPlaceholderText('e.g. high')).toBeNull();
    });

    it('hides the Model input when a model-incapable agent is selected', async () => {
      mockAgentsWithCapabilities();
      const user = userEvent.setup();
      renderQuickSessionForm();

      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });
      expect(screen.getByPlaceholderText('e.g. opus')).toBeTruthy();

      const agentSelect = screen.getByRole('combobox');
      await user.selectOptions(agentSelect, 'terminal:plain-agent');

      await waitFor(() => {
        expect(screen.queryByPlaceholderText('e.g. opus')).toBeNull();
      });
    });

    it('includes the typed model value in the submitted request', async () => {
      mockAgentsWithCapabilities();
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      const pathInput = screen.getByPlaceholderText(/Path.*e\.g\./);
      await user.clear(pathInput);
      await user.type(pathInput, '/path/to/project');

      const modelInput = screen.getByPlaceholderText('e.g. opus');
      await user.type(modelInput, 'opus');

      await user.click(screen.getByText('Start'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0]).toMatchObject({
        locationPath: '/path/to/project',
        model: 'opus',
      });
    });

    it('omits model from the submitted request when the field is left blank', async () => {
      mockAgentsWithCapabilities();
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      const pathInput = screen.getByPlaceholderText(/Path.*e\.g\./);
      await user.clear(pathInput);
      await user.type(pathInput, '/path/to/project');

      await user.click(screen.getByText('Start'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0].model).toBeUndefined();
      expect(submitCall[0].reasoningEffort).toBeUndefined();
    });

    it('does not block submission after the model field is typed into and then fully cleared', async () => {
      // Regression guard: CreateQuickSessionRequestSchema (used directly as
      // this form's resolver) requires model to be non-empty-after-trim
      // WHEN PRESENT. A naive setValue('model', '') on full-clear would fail
      // that constraint and silently block submission.
      mockAgentsWithCapabilities();
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      const pathInput = screen.getByPlaceholderText(/Path.*e\.g\./);
      await user.clear(pathInput);
      await user.type(pathInput, '/path/to/project');

      const modelInput = screen.getByPlaceholderText('e.g. opus');
      await user.type(modelInput, 'opus');
      await user.clear(modelInput);

      await user.click(screen.getByText('Start'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0].model).toBeUndefined();
    });

    it('omits model from the submitted request when the field contains only whitespace', async () => {
      // Regression guard: CreateQuickSessionRequestSchema trims model before
      // its minLength(1) check, but onModelChange only collapsed a fully
      // empty string to undefined -- a whitespace-only value reached the
      // resolver un-trimmed and failed validation instead of being treated
      // as empty.
      mockAgentsWithCapabilities();
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      const pathInput = screen.getByPlaceholderText(/Path.*e\.g\./);
      await user.clear(pathInput);
      await user.type(pathInput, '/path/to/project');

      const modelInput = screen.getByPlaceholderText('e.g. opus');
      await user.type(modelInput, '   ');

      await user.click(screen.getByText('Start'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0].model).toBeUndefined();
    });

    it('clears a previously-typed model value when the agent selection switches to a model-incapable agent', async () => {
      // Regression guard: ModelEffortFields hides the Model input the
      // moment the newly-selected agent is incapable, but the underlying
      // form value survived the switch and rode along silently in the
      // submitted request for an agent that doesn't support it.
      mockAgentsWithCapabilities();
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      const pathInput = screen.getByPlaceholderText(/Path.*e\.g\./);
      await user.clear(pathInput);
      await user.type(pathInput, '/path/to/project');

      const modelInput = screen.getByPlaceholderText('e.g. opus');
      await user.type(modelInput, 'opus');

      const agentSelect = screen.getByRole('combobox');
      await user.selectOptions(agentSelect, 'terminal:plain-agent');

      await waitFor(() => {
        expect(screen.queryByPlaceholderText('e.g. opus')).toBeNull();
      });

      await user.click(screen.getByText('Start'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0].model).toBeUndefined();
    });
  });

  describe('contextWindowTokens field (Issue #1554, agent-surface.md Ruling 4)', () => {
    function mockDirectoryWithEmbedded() {
      mockFetch.mockImplementation((input: unknown) => {
        const url = resolveUrl(input);
        if (url.includes('embedded-agents')) {
          return Promise.resolve(
            createMockResponse({
              embeddedAgents: [{ id: 'embedded-1', name: 'Local GPT', engine: 'openai-api' }],
            })
          );
        }
        return Promise.resolve(createMockResponse(mockAgentsResponse));
      });
    }

    it('includes the typed contextWindowTokens value in the submitted request when set alongside a model override', async () => {
      mockDirectoryWithEmbedded();
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      await waitFor(() => {
        expect(screen.getByText('Local GPT')).toBeTruthy();
      });

      const agentSelect = screen.getByRole('combobox');
      await user.selectOptions(agentSelect, 'embedded:embedded-1');

      const modelInput = await waitFor(() => screen.getByPlaceholderText('e.g. opus'));
      await user.type(modelInput, 'gpt-4o');

      const windowInput = await waitFor(() => screen.getByPlaceholderText('e.g. 128000'));
      await user.type(windowInput, '128000');

      await user.click(screen.getByText('Start'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0]).toMatchObject({
        embeddedAgentId: 'embedded-1',
        model: 'gpt-4o',
        contextWindowTokens: 128000,
      });
    });

    it('omits contextWindowTokens from the submitted request when never set', async () => {
      mockDirectoryWithEmbedded();
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      await waitFor(() => {
        expect(screen.getByText('Local GPT')).toBeTruthy();
      });

      const agentSelect = screen.getByRole('combobox');
      await user.selectOptions(agentSelect, 'embedded:embedded-1');

      await user.click(screen.getByText('Start'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0].contextWindowTokens).toBeUndefined();
    });

    // Pin (d): clearing model (the CONSUMING form's onModelChange handler,
    // per Task 2's model-cleared -> window-cleared discipline) also clears
    // the already-typed contextWindowTokens form-state value, not merely
    // the DOM input -- a hidden field must not resubmit a stale value.
    it('(d) clears a previously-typed contextWindowTokens value when the model field is fully cleared', async () => {
      mockDirectoryWithEmbedded();
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      await waitFor(() => {
        expect(screen.getByText('Local GPT')).toBeTruthy();
      });

      const agentSelect = screen.getByRole('combobox');
      await user.selectOptions(agentSelect, 'embedded:embedded-1');

      const modelInput = await waitFor(() => screen.getByPlaceholderText('e.g. opus'));
      await user.type(modelInput, 'gpt-4o');

      const windowInput = await waitFor(() => screen.getByPlaceholderText('e.g. 128000'));
      await user.type(windowInput, '128000');

      // Clearing model also hides the window input (AgentParameterFields
      // render-gating) -- confirm that AND that the value left form state.
      await user.clear(modelInput);
      await waitFor(() => {
        expect(screen.queryByPlaceholderText('e.g. 128000')).toBeNull();
      });

      await user.click(screen.getByText('Start'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0].model).toBeUndefined();
      expect(submitCall[0].contextWindowTokens).toBeUndefined();
    });
  });
});
