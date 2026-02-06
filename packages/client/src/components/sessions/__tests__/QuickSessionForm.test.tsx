import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QuickSessionForm } from '../QuickSessionForm';

// Save original fetch and set up mock
const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response()));
globalThis.fetch = mockFetch as unknown as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  cleanup();
});

// Mock agents response
const mockAgentsResponse = {
  agents: [
    { id: 'claude-code', name: 'Claude Code', isBuiltIn: true, agentType: 'claude-code' },
    { id: 'custom-agent', name: 'Custom Agent', isBuiltIn: false, agentType: 'unknown' },
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
      await user.selectOptions(agentSelect, 'custom-agent');

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

    it('should submit with useSdk: false by default', async () => {
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Submit form without checking SDK mode
      const submitButton = screen.getByText('Start');
      await user.click(submitButton);

      // Verify onSubmit was called with useSdk: false
      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0]).toMatchObject({
        useSdk: false,
      });
    });

    it('should submit with useSdk: true when SDK mode is enabled', async () => {
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Enable SDK mode
      const sdkCheckbox = screen.getByLabelText('Use SDK Mode');
      await user.click(sdkCheckbox);

      // Submit form
      const submitButton = screen.getByText('Start');
      await user.click(submitButton);

      // Verify onSubmit was called with useSdk: true
      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0]).toMatchObject({
        useSdk: true,
      });
    });

    it('should hide SDK checkbox when non-claude-code agent is selected', async () => {
      const user = userEvent.setup();
      const { props } = renderQuickSessionForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // SDK checkbox should be visible for Claude Code
      expect(screen.getByLabelText('Use SDK Mode')).toBeTruthy();

      // Select custom agent (non-claude-code)
      const agentSelect = screen.getByRole('combobox');
      await user.selectOptions(agentSelect, 'custom-agent');

      // SDK checkbox should be hidden
      expect(screen.queryByLabelText('Use SDK Mode')).toBeNull();

      // Submit form
      const submitButton = screen.getByText('Start');
      await user.click(submitButton);

      // Verify onSubmit was called with useSdk: false
      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0]).toMatchObject({
        useSdk: false,
        agentId: 'custom-agent',
      });
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
});
