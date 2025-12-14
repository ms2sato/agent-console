import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreateWorktreeForm } from '../CreateWorktreeForm';

// Save original fetch and set up mock
const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response()));
globalThis.fetch = mockFetch as unknown as typeof fetch;

// Restore original fetch after all tests
afterAll(() => {
  globalThis.fetch = originalFetch;
});

// Clean up after each test
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

function renderCreateWorktreeForm(props: Partial<React.ComponentProps<typeof CreateWorktreeForm>> = {}) {
  const defaultProps = {
    defaultBranch: 'main',
    isPending: false,
    onSubmit: mock(() => Promise.resolve()),
    onCancel: mock(() => {}),
  };

  const mergedProps = { ...defaultProps, ...props };

  return {
    ...render(
      <TestWrapper>
        <CreateWorktreeForm {...mergedProps} />
      </TestWrapper>
    ),
    props: mergedProps,
  };
}

describe('CreateWorktreeForm', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    // Default: return agents for AgentSelector
    mockFetch.mockResolvedValue(createMockResponse(mockAgentsResponse));
  });

  describe('prompt mode (default)', () => {
    it('should submit successfully with initial prompt', async () => {
      const user = userEvent.setup();
      const { props } = renderCreateWorktreeForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Fill in initial prompt
      const promptInput = screen.getByPlaceholderText(/What do you want to work on/);
      await user.type(promptInput, 'Add dark mode feature');

      // Submit form
      const submitButton = screen.getByText('Create & Start Session');
      await user.click(submitButton);

      // Verify onSubmit was called with correct data
      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0]).toMatchObject({
        mode: 'prompt',
        initialPrompt: 'Add dark mode feature',
        autoStartSession: true,
      });
    });

    it('should show validation error when prompt mode has no initial prompt', async () => {
      const user = userEvent.setup();
      const { props } = renderCreateWorktreeForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Submit without filling anything (prompt mode is default)
      const submitButton = screen.getByText('Create & Start Session');
      await user.click(submitButton);

      // onSubmit should NOT be called
      await waitFor(() => {
        expect(props.onSubmit).not.toHaveBeenCalled();
      });

      // Error should be displayed
      await waitFor(() => {
        expect(screen.getByText(/Initial prompt is required/)).toBeTruthy();
      });
    });
  });

  describe('custom mode', () => {
    it('should submit successfully with custom branch name', async () => {
      const user = userEvent.setup();
      const { props } = renderCreateWorktreeForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Select custom mode
      const customRadio = screen.getByLabelText(/Custom name \(new branch\)/);
      await user.click(customRadio);

      // Fill in branch name
      const branchInput = screen.getByPlaceholderText('New branch name');
      await user.type(branchInput, 'feature/my-feature');

      // Submit form
      const submitButton = screen.getByText('Create & Start Session');
      await user.click(submitButton);

      // Verify onSubmit was called with correct data
      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0]).toMatchObject({
        mode: 'custom',
        branch: 'feature/my-feature',
        autoStartSession: true,
      });
    });

    it('should show validation error when custom mode has no branch name', async () => {
      const user = userEvent.setup();
      const { props } = renderCreateWorktreeForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Select custom mode
      const customRadio = screen.getByLabelText(/Custom name \(new branch\)/);
      await user.click(customRadio);

      // Submit without filling branch name
      const submitButton = screen.getByText('Create & Start Session');
      await user.click(submitButton);

      // onSubmit should NOT be called
      await waitFor(() => {
        expect(props.onSubmit).not.toHaveBeenCalled();
      });

      // Error should be displayed
      await waitFor(() => {
        expect(screen.getByText('Branch name is required')).toBeTruthy();
      });
    });

    it('should show validation error for invalid branch name', async () => {
      const user = userEvent.setup();
      renderCreateWorktreeForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Select custom mode
      const customRadio = screen.getByLabelText(/Custom name \(new branch\)/);
      await user.click(customRadio);

      // Fill in invalid branch name (with space)
      const branchInput = screen.getByPlaceholderText('New branch name');
      await user.type(branchInput, 'invalid branch name');

      // Trigger blur to validate
      await act(async () => {
        branchInput.blur();
      });

      // Error should be displayed
      await waitFor(() => {
        expect(screen.getByText(/Invalid branch name/)).toBeTruthy();
      });
    });
  });

  describe('existing mode', () => {
    it('should submit successfully with existing branch name', async () => {
      const user = userEvent.setup();
      const { props } = renderCreateWorktreeForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Select existing mode
      const existingRadio = screen.getByLabelText(/Use existing branch/);
      await user.click(existingRadio);

      // Fill in existing branch name
      const branchInput = screen.getByPlaceholderText('Existing branch name');
      await user.type(branchInput, 'develop');

      // Submit form
      const submitButton = screen.getByText('Create & Start Session');
      await user.click(submitButton);

      // Verify onSubmit was called with correct data
      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0]).toMatchObject({
        mode: 'existing',
        branch: 'develop',
        autoStartSession: true,
      });
    });

    it('should not show base branch input in existing mode', async () => {
      const user = userEvent.setup();
      renderCreateWorktreeForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Select existing mode
      const existingRadio = screen.getByLabelText(/Use existing branch/);
      await user.click(existingRadio);

      // Base branch input should not be visible
      expect(screen.queryByPlaceholderText(/Base branch/)).toBeNull();
    });
  });

  describe('optional fields', () => {
    it('should include session title when provided', async () => {
      const user = userEvent.setup();
      const { props } = renderCreateWorktreeForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Fill in initial prompt
      const promptInput = screen.getByPlaceholderText(/What do you want to work on/);
      await user.type(promptInput, 'Add feature');

      // Fill in session title
      const titleInput = screen.getByPlaceholderText('Session title');
      await user.type(titleInput, 'My Session');

      // Submit form
      const submitButton = screen.getByText('Create & Start Session');
      await user.click(submitButton);

      // Verify title is included
      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0]).toMatchObject({
        title: 'My Session',
      });
    });

    it('should include base branch when provided', async () => {
      const user = userEvent.setup();
      const { props } = renderCreateWorktreeForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Fill in initial prompt
      const promptInput = screen.getByPlaceholderText(/What do you want to work on/);
      await user.type(promptInput, 'Add feature');

      // Fill in base branch
      const baseBranchInput = screen.getByPlaceholderText(/Base branch/);
      await user.type(baseBranchInput, 'develop');

      // Submit form
      const submitButton = screen.getByText('Create & Start Session');
      await user.click(submitButton);

      // Verify baseBranch is included
      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0]).toMatchObject({
        baseBranch: 'develop',
      });
    });
  });

  describe('UI state', () => {
    it('should disable form when isPending is true', async () => {
      renderCreateWorktreeForm({ isPending: true });

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Form overlay should be visible with loading message
      expect(screen.getByText('Creating worktree...')).toBeTruthy();

      // Form fields should be disabled
      const promptInput = screen.getByPlaceholderText(/What do you want to work on/);
      expect(promptInput.closest('fieldset')?.disabled).toBe(true);
    });

    it('should call onCancel when cancel button is clicked', async () => {
      const user = userEvent.setup();
      const { props } = renderCreateWorktreeForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Click cancel
      const cancelButton = screen.getByText('Cancel');
      await user.click(cancelButton);

      expect(props.onCancel).toHaveBeenCalledTimes(1);
    });

    it('should disable Generate from prompt option when no prompt entered', async () => {
      renderCreateWorktreeForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // "Generate from prompt" radio should be disabled when no prompt
      const promptRadio = screen.getByLabelText(/Generate from prompt.*requires prompt/);
      expect((promptRadio as HTMLInputElement).disabled).toBe(true);
    });
  });
});
