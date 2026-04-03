import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreateWorktreeForm } from '../CreateWorktreeForm';

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

function resolveUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === 'object' && 'url' in input) return (input as Request).url;
  return '';
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
    repositoryId: 'repo-1',
    defaultBranch: 'main',
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

  describe('default agent sorting', () => {
    it('should render the default agent first even when it is not first in the API response', async () => {
      // Override agents response so custom-agent is first in the API response
      mockFetch.mockImplementation((input) => {
        const url = resolveUrl(input);
        if (url.includes('/agents')) {
          return Promise.resolve(createMockResponse({
            agents: [
              { id: 'claude-code', name: 'Claude Code', isBuiltIn: true },
              { id: 'custom-agent', name: 'Custom Agent', isBuiltIn: false },
            ],
          }));
        }
        if (url.includes('/remote-status')) {
          return Promise.resolve(createMockResponse({ behind: 0, ahead: 0 }));
        }
        return Promise.resolve(createMockResponse({}));
      });

      renderCreateWorktreeForm({ defaultAgentId: 'custom-agent' });

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Custom Agent')).toBeTruthy();
      });

      const options = screen.getAllByRole('option');
      expect(options[0].textContent).toBe('Custom Agent');
      expect(options[1].textContent).toBe('Claude Code (built-in)');
    });
  });

  describe('two-column layout', () => {
    it('should render prompt and branch fields side by side in a grid layout', async () => {
      renderCreateWorktreeForm();

      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Prompt and branch fields should both be visible simultaneously
      expect(screen.getByPlaceholderText(/What do you want to work on/)).toBeTruthy();
      expect(screen.getByPlaceholderText('Session title')).toBeTruthy();
      expect(screen.getByText(/Branch name:/)).toBeTruthy();
      expect(screen.getByPlaceholderText(/Base branch/)).toBeTruthy();

      // Submit button should be present and accessible
      expect(screen.getByText('Create & Start Session')).toBeTruthy();
      expect(screen.getByText('Cancel')).toBeTruthy();
    });
  });

  describe('UI state', () => {
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

    it('should disable Auto-generate option when no prompt entered', async () => {
      renderCreateWorktreeForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // "Auto-generate" radio should be disabled when no prompt
      const promptRadio = screen.getByLabelText(/Auto-generate/);
      expect((promptRadio as HTMLInputElement).disabled).toBe(true);
    });
  });

  describe('draft persistence', () => {
    const draftKey = 'test-draft-key';

    beforeEach(() => {
      localStorage.removeItem(draftKey);
    });

    afterEach(() => {
      localStorage.removeItem(draftKey);
    });

    it('should save only dirty fields to localStorage on unmount', async () => {
      const user = userEvent.setup();

      renderCreateWorktreeForm({ draftKey });

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Type a value to change only the sessionTitle field
      const titleInput = screen.getByPlaceholderText('Session title');
      await user.type(titleInput, 'Saved Title');

      // Unmount triggers the cleanup effect which saves current form values
      cleanup();

      // The draft should be saved to localStorage with only the dirty field
      const saved = localStorage.getItem(draftKey);
      expect(saved).not.toBeNull();
      const parsed = JSON.parse(saved!);
      expect(parsed.sessionTitle).toBe('Saved Title');
      // Non-dirty fields should NOT be in the draft
      expect(parsed.agentId).toBeUndefined();
      expect(parsed.branchNameMode).toBeUndefined();
      expect(parsed.initialPrompt).toBeUndefined();
    });

    it('should save only dirty fields on form value changes', async () => {
      const user = userEvent.setup();

      renderCreateWorktreeForm({ draftKey });

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Type into the prompt field only
      const promptInput = screen.getByPlaceholderText(/What do you want to work on/);
      await user.type(promptInput, 'New feature prompt');

      // Wait for debounced save (500ms debounce in implementation)
      await waitFor(() => {
        const saved = localStorage.getItem(draftKey);
        expect(saved).not.toBeNull();
        const parsed = JSON.parse(saved!);
        expect(parsed.initialPrompt).toBe('New feature prompt');
        // Non-dirty fields should NOT be saved
        expect(parsed.agentId).toBeUndefined();
        expect(parsed.sessionTitle).toBeUndefined();
      }, { timeout: 2000 });
    });

    it('should clear draft from localStorage after successful submit', async () => {
      const user = userEvent.setup();

      const { props } = renderCreateWorktreeForm({ draftKey });

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Type a prompt (required for prompt mode validation)
      const promptInput = screen.getByPlaceholderText(/What do you want to work on/);
      await user.type(promptInput, 'Add feature');

      // Submit the form
      const submitButton = screen.getByText('Create & Start Session');
      await user.click(submitButton);

      // Wait for onSubmit to be called
      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      // After successful submit, clearDraft removes the item from localStorage.
      // Note: The cleanup effect on unmount will re-save, but at this point
      // (before unmount) the item should have been removed.
      expect(localStorage.getItem(draftKey)).toBeNull();
    });

    it('should not save to localStorage when draftKey is not provided', async () => {
      const user = userEvent.setup();

      // Clear any stale draft keys before this test
      const noDraftKey = 'no-draft-key-marker';
      localStorage.removeItem(noDraftKey);

      renderCreateWorktreeForm(); // no draftKey

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Type something to trigger potential save
      const promptInput = screen.getByPlaceholderText(/What do you want to work on/);
      await user.type(promptInput, 'Some text');

      // Wait for any debounced save to fire (500ms debounce + margin)
      await new Promise(resolve => setTimeout(resolve, 700));

      // Without a draftKey, the component should not have saved anything.
      // We can't check all keys since other tests may leave data.
      // Instead, verify that the specific localStorage operations weren't called
      // by checking no key with 'undefined' was created (a common mistake when
      // draftKey is falsy and accidentally stringified).
      expect(localStorage.getItem('undefined')).toBeNull();
      expect(localStorage.getItem('null')).toBeNull();
    });
  });

  describe('remote branch status', () => {
    it('should show loading state while checking remote status', async () => {
      // Make the remote status fetch hang to observe loading state
      let resolveRemoteStatus: (value: Response) => void;
      const remoteStatusPromise = new Promise<Response>((resolve) => {
        resolveRemoteStatus = resolve;
      });

      mockFetch.mockImplementation((input) => {
        const url = resolveUrl(input);
        if (url.includes('/remote-status')) {
          return remoteStatusPromise;
        }
        return Promise.resolve(createMockResponse(mockAgentsResponse));
      });

      renderCreateWorktreeForm();

      // Wait for agents to load first
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Loading state should be visible
      expect(screen.getByText('Checking remote status...')).toBeTruthy();

      // Clean up: resolve the pending promise
      resolveRemoteStatus!(createMockResponse({ behind: 0, ahead: 0 }));
    });

    it('should show warning message when base branch is behind remote', async () => {
      mockFetch.mockImplementation((input) => {
        const url = resolveUrl(input);
        if (url.includes('/remote-status')) {
          return Promise.resolve(createMockResponse({ behind: 3, ahead: 0 }));
        }
        return Promise.resolve(createMockResponse(mockAgentsResponse));
      });

      renderCreateWorktreeForm();

      // Wait for warning message to appear
      await waitFor(() => {
        expect(screen.getByText(/⚠️ 3 commits behind origin\/main/)).toBeTruthy();
      });
    });

    it('should not show warning when base branch is up to date', async () => {
      mockFetch.mockImplementation((input) => {
        const url = resolveUrl(input);
        if (url.includes('/remote-status')) {
          return Promise.resolve(createMockResponse({ behind: 0, ahead: 0 }));
        }
        return Promise.resolve(createMockResponse(mockAgentsResponse));
      });

      renderCreateWorktreeForm();

      // Wait for agents to load and remote status check to complete
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Wait for loading to disappear
      await waitFor(() => {
        expect(screen.queryByText('Checking remote status...')).toBeNull();
      });

      // No warning message should be visible
      expect(screen.queryByText(/commits? behind/)).toBeNull();
    });

    it('should show "Fetch & Create" button when behind', async () => {
      mockFetch.mockImplementation((input) => {
        const url = resolveUrl(input);
        if (url.includes('/remote-status')) {
          return Promise.resolve(createMockResponse({ behind: 2, ahead: 0 }));
        }
        return Promise.resolve(createMockResponse(mockAgentsResponse));
      });

      renderCreateWorktreeForm();

      // Wait for "Fetch & Create" button to appear
      await waitFor(() => {
        expect(screen.getByText('Fetch & Create')).toBeTruthy();
      });
    });

    it('should not show "Fetch & Create" button when up to date', async () => {
      mockFetch.mockImplementation((input) => {
        const url = resolveUrl(input);
        if (url.includes('/remote-status')) {
          return Promise.resolve(createMockResponse({ behind: 0, ahead: 0 }));
        }
        return Promise.resolve(createMockResponse(mockAgentsResponse));
      });

      renderCreateWorktreeForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Wait for loading to disappear
      await waitFor(() => {
        expect(screen.queryByText('Checking remote status...')).toBeNull();
      });

      // "Fetch & Create" button should not be visible
      expect(screen.queryByText('Fetch & Create')).toBeNull();
    });

    it('should submit form with useRemote: true when clicking "Fetch & Create"', async () => {
      const user = userEvent.setup();

      mockFetch.mockImplementation((input) => {
        const url = resolveUrl(input);
        if (url.includes('/remote-status')) {
          return Promise.resolve(createMockResponse({ behind: 1, ahead: 0 }));
        }
        return Promise.resolve(createMockResponse(mockAgentsResponse));
      });

      const { props } = renderCreateWorktreeForm();

      // Wait for agents and "Fetch & Create" button to appear
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
        expect(screen.getByText('Fetch & Create')).toBeTruthy();
      });

      // Fill in initial prompt (required for prompt mode)
      const promptInput = screen.getByPlaceholderText(/What do you want to work on/);
      await user.type(promptInput, 'Add feature');

      // Click "Fetch & Create" button
      const fetchAndCreateButton = screen.getByText('Fetch & Create');
      await user.click(fetchAndCreateButton);

      // Verify onSubmit was called with useRemote: true
      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0]).toMatchObject({
        mode: 'prompt',
        initialPrompt: 'Add feature',
        useRemote: true,
      });
    });

    it('should show error message when remote status check fails', async () => {
      mockFetch.mockImplementation((input) => {
        const url = resolveUrl(input);
        if (url.includes('/remote-status')) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ error: 'Network error' }),
          } as Response);
        }
        return Promise.resolve(createMockResponse(mockAgentsResponse));
      });

      renderCreateWorktreeForm();

      // Wait for error message to appear
      await waitFor(() => {
        expect(screen.getByText('Could not check remote status (will use local branch)')).toBeTruthy();
      });
    });

    it('should refetch remote status when base branch changes', async () => {
      const user = userEvent.setup();
      const remoteStatusCalls: string[] = [];

      mockFetch.mockImplementation((input) => {
        const url = resolveUrl(input);
        if (url.includes('/remote-status')) {
          // Track which branch was requested
          remoteStatusCalls.push(url);
          return Promise.resolve(createMockResponse({ behind: 0, ahead: 0 }));
        }
        return Promise.resolve(createMockResponse(mockAgentsResponse));
      });

      renderCreateWorktreeForm();

      // Wait for initial remote status check
      await waitFor(() => {
        expect(remoteStatusCalls.length).toBeGreaterThanOrEqual(1);
      });

      // Initial call should be for 'main' (the default branch)
      expect(remoteStatusCalls.some(url => url.includes('/branches/main/remote-status'))).toBe(true);

      const initialCallCount = remoteStatusCalls.length;

      // Change base branch
      const baseBranchInput = screen.getByPlaceholderText(/Base branch/);
      await user.type(baseBranchInput, 'develop');

      // Blur to trigger the change
      await act(async () => {
        baseBranchInput.blur();
      });

      // Wait for new remote status check
      await waitFor(() => {
        expect(remoteStatusCalls.length).toBeGreaterThan(initialCallCount);
      });

      // Should have called for 'develop' branch
      expect(remoteStatusCalls.some(url => url.includes('/branches/develop/remote-status'))).toBe(true);
    });

    it('should not fetch remote status in existing branch mode', async () => {
      const user = userEvent.setup();
      const remoteStatusCalls: string[] = [];

      mockFetch.mockImplementation((input) => {
        const url = resolveUrl(input);
        if (url.includes('/remote-status')) {
          remoteStatusCalls.push(url);
          return Promise.resolve(createMockResponse({ behind: 0, ahead: 0 }));
        }
        return Promise.resolve(createMockResponse(mockAgentsResponse));
      });

      renderCreateWorktreeForm();

      // Wait for agents to load
      await waitFor(() => {
        expect(screen.getByText('Claude Code (built-in)')).toBeTruthy();
      });

      // Wait for initial check to complete
      await waitFor(() => {
        expect(screen.queryByText('Checking remote status...')).toBeNull();
      });

      const callCountBeforeSwitch = remoteStatusCalls.length;

      // Switch to existing branch mode
      const existingRadio = screen.getByLabelText(/Use existing branch/);
      await user.click(existingRadio);

      // Remote status should not be fetched in existing mode
      // Wait a bit to ensure no new calls are made
      await new Promise(resolve => setTimeout(resolve, 100));

      // No loading indicator should be shown
      expect(screen.queryByText('Checking remote status...')).toBeNull();

      // No new calls should have been made
      expect(remoteStatusCalls.length).toBe(callCountBeforeSwitch);
    });

    it('should use singular form for 1 commit behind', async () => {
      mockFetch.mockImplementation((input) => {
        const url = resolveUrl(input);
        if (url.includes('/remote-status')) {
          return Promise.resolve(createMockResponse({ behind: 1, ahead: 0 }));
        }
        return Promise.resolve(createMockResponse(mockAgentsResponse));
      });

      renderCreateWorktreeForm();

      // Wait for warning message with singular form
      await waitFor(() => {
        expect(screen.getByText(/⚠️ 1 commit behind origin\/main/)).toBeTruthy();
      });
    });
  });
});
