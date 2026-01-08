import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Repository } from '@agent-console/shared';
import { EditRepositoryForm } from '../EditRepositoryForm';

// Save original fetch and set up mock
const originalFetch = globalThis.fetch;
const mockFetch = mock((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(new Response()));
globalThis.fetch = mockFetch as unknown as typeof fetch;

// Helper to get request body from mockFetch calls
function getRequestBody(callIndex: number): Record<string, unknown> {
  const calls = mockFetch.mock.calls as Array<[RequestInfo | URL, RequestInit | undefined]>;
  const init = calls[callIndex]?.[1];
  return JSON.parse(init?.body as string);
}

// Restore original fetch after all tests
afterAll(() => {
  globalThis.fetch = originalFetch;
});

// Clean up after each test
afterEach(() => {
  cleanup();
});

function createMockResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function createTestRepository(overrides: Partial<Repository & { setupCommand?: string | null }> = {}): Repository & { setupCommand?: string | null } {
  return {
    id: 'repo-1',
    name: 'test-repo',
    path: '/path/to/test-repo',
    createdAt: new Date().toISOString(),
    remoteUrl: 'https://github.com/test/test-repo.git',
    setupCommand: null,
    ...overrides,
  };
}

// Wrapper component with QueryClientProvider
function TestWrapper({ children, queryClient }: { children: React.ReactNode; queryClient: QueryClient }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderEditRepositoryForm(
  props: Partial<React.ComponentProps<typeof EditRepositoryForm>> = {},
  options: { queryClient?: QueryClient } = {}
) {
  const queryClient = options.queryClient ?? new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  const defaultProps = {
    repository: createTestRepository(),
    onSuccess: mock(() => {}),
    onCancel: mock(() => {}),
  };

  const mergedProps = { ...defaultProps, ...props };

  return {
    ...render(
      <TestWrapper queryClient={queryClient}>
        <EditRepositoryForm {...mergedProps} />
      </TestWrapper>
    ),
    props: mergedProps,
    queryClient,
  };
}

describe('EditRepositoryForm', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('form submission', () => {
    it('should submit with valid setup command', async () => {
      const user = userEvent.setup();
      const repository = createTestRepository();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ repository: { ...repository, setupCommand: 'bun install' } })
      );

      const { props } = renderEditRepositoryForm({ repository });

      // Fill in setup command
      const commandInput = screen.getByPlaceholderText(/bun install/);
      await user.type(commandInput, 'bun install');

      // Submit form
      const submitButton = screen.getByText('Save Changes');
      await user.click(submitButton);

      // Wait for mutation to complete
      await waitFor(() => {
        expect(props.onSuccess).toHaveBeenCalledTimes(1);
      });

      // Verify API was called with correct data
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const requestBody = getRequestBody(0);
      expect(requestBody).toEqual({ setupCommand: 'bun install', envVars: '' });
    });

    it('should submit with empty string (clears command)', async () => {
      const user = userEvent.setup();
      const repository = createTestRepository({ setupCommand: 'bun install' });
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ repository: { ...repository, setupCommand: null } })
      );

      const { props } = renderEditRepositoryForm({ repository });

      // Clear the setup command
      const commandInput = screen.getByPlaceholderText(/bun install/) as HTMLTextAreaElement;
      expect(commandInput.value).toBe('bun install');
      await user.clear(commandInput);

      // Submit form
      const submitButton = screen.getByText('Save Changes');
      await user.click(submitButton);

      // Wait for mutation to complete
      await waitFor(() => {
        expect(props.onSuccess).toHaveBeenCalledTimes(1);
      });

      // Verify API was called with empty string (server will convert to null)
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const requestBody = getRequestBody(0);
      expect(requestBody).toEqual({ setupCommand: '', envVars: '' });
    });

    it('should trim whitespace from setupCommand', async () => {
      const user = userEvent.setup();
      const repository = createTestRepository();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ repository: { ...repository, setupCommand: 'bun install' } })
      );

      const { props } = renderEditRepositoryForm({ repository });

      // Fill in setup command with whitespace
      const commandInput = screen.getByPlaceholderText(/bun install/);
      await user.type(commandInput, '  bun install  ');

      // Submit form
      const submitButton = screen.getByText('Save Changes');
      await user.click(submitButton);

      // Wait for mutation to complete
      await waitFor(() => {
        expect(props.onSuccess).toHaveBeenCalledTimes(1);
      });

      // Verify API was called with trimmed value
      const requestBody = getRequestBody(0);
      expect(requestBody).toEqual({ setupCommand: 'bun install', envVars: '' });
    });
  });

  describe('optimistic updates', () => {
    it('should optimistically update repository in cache', async () => {
      const user = userEvent.setup();
      const repository = createTestRepository();

      // Set up query client with initial data
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      queryClient.setQueryData(['repositories'], {
        repositories: [repository],
      });

      // Make fetch hang to observe optimistic state
      let resolveFetch: (value: Response) => void;
      mockFetch.mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
      );

      renderEditRepositoryForm({ repository }, { queryClient });

      // Fill in setup command
      const commandInput = screen.getByPlaceholderText(/bun install/);
      await user.type(commandInput, 'npm install');

      // Submit form
      const submitButton = screen.getByText('Save Changes');
      await user.click(submitButton);

      // Check optimistic update was applied immediately
      await waitFor(() => {
        const cached = queryClient.getQueryData<{ repositories: Repository[] }>(['repositories']);
        expect(cached?.repositories[0].setupCommand).toBe('npm install');
      });

      // Resolve the fetch
      resolveFetch!(createMockResponse({ repository: { ...repository, setupCommand: 'npm install' } }));
    });

    it('should rollback cache on mutation error', async () => {
      const user = userEvent.setup();
      const repository = createTestRepository({ setupCommand: 'original command' });

      // Set up query client with initial data
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      queryClient.setQueryData(['repositories'], {
        repositories: [repository],
      });

      // Mock fetch to fail
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ error: 'Server error' }, false)
      );

      renderEditRepositoryForm({ repository }, { queryClient });

      // Modify setup command
      const commandInput = screen.getByPlaceholderText(/bun install/) as HTMLTextAreaElement;
      await user.clear(commandInput);
      await user.type(commandInput, 'new command');

      // Submit form
      const submitButton = screen.getByText('Save Changes');
      await user.click(submitButton);

      // Wait for error to appear
      await waitFor(() => {
        expect(screen.getByText(/Server error|Failed to update/)).toBeTruthy();
      });

      // Cache should be rolled back to original value
      const cached = queryClient.getQueryData<{ repositories: Repository[] }>(['repositories']);
      expect(cached?.repositories[0].setupCommand).toBe('original command');
    });

    it('should cancel in-flight queries before optimistic update', async () => {
      const user = userEvent.setup();
      const repository = createTestRepository();

      // Set up query client with initial data
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      queryClient.setQueryData(['repositories'], {
        repositories: [repository],
      });

      // Spy on cancelQueries
      const cancelQueriesSpy = mock(() => Promise.resolve());
      const originalCancelQueries = queryClient.cancelQueries.bind(queryClient);
      queryClient.cancelQueries = cancelQueriesSpy as typeof queryClient.cancelQueries;

      mockFetch.mockResolvedValueOnce(
        createMockResponse({ repository: { ...repository, setupCommand: 'bun install' } })
      );

      renderEditRepositoryForm({ repository }, { queryClient });

      // Fill in setup command
      const commandInput = screen.getByPlaceholderText(/bun install/);
      await user.type(commandInput, 'bun install');

      // Submit form
      const submitButton = screen.getByText('Save Changes');
      await user.click(submitButton);

      // Verify cancelQueries was called
      await waitFor(() => {
        expect(cancelQueriesSpy).toHaveBeenCalled();
      });

      // Verify it was called with the correct query key
      type CancelQueriesCall = Parameters<typeof queryClient.cancelQueries>;
      const cancelCalls = cancelQueriesSpy.mock.calls as CancelQueriesCall[];
      expect(cancelCalls[0][0]).toEqual({ queryKey: ['repositories'] });

      // Restore original cancelQueries
      queryClient.cancelQueries = originalCancelQueries;
    });
  });

  describe('validation', () => {
    it('should accept multi-line commands', async () => {
      const user = userEvent.setup();
      const repository = createTestRepository();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ repository: { ...repository, setupCommand: 'bun install\nbun run build' } })
      );

      const { props } = renderEditRepositoryForm({ repository });

      // Fill in multi-line setup command
      const commandInput = screen.getByPlaceholderText(/bun install/);
      await user.type(commandInput, 'bun install{enter}bun run build');

      // Submit form
      const submitButton = screen.getByText('Save Changes');
      await user.click(submitButton);

      // Wait for mutation to complete
      await waitFor(() => {
        expect(props.onSuccess).toHaveBeenCalledTimes(1);
      });

      // Verify API was called with multi-line command
      const requestBody = getRequestBody(0);
      expect(requestBody.setupCommand).toContain('\n');
    });

    it('should accept template variables', async () => {
      const user = userEvent.setup();
      const commandWithTemplate = 'cd {{WORKTREE_PATH}} && bun install';
      // Pre-populate the repository with the template command to avoid userEvent escaping issues
      const repository = createTestRepository({ setupCommand: commandWithTemplate });
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ repository: { ...repository, setupCommand: commandWithTemplate } })
      );

      const { props } = renderEditRepositoryForm({ repository });

      // Verify the template variable is displayed correctly
      const commandInput = screen.getByPlaceholderText(/bun install/) as HTMLTextAreaElement;
      expect(commandInput.value).toBe(commandWithTemplate);

      // Submit form without modifying
      const submitButton = screen.getByText('Save Changes');
      await user.click(submitButton);

      // Wait for mutation to complete
      await waitFor(() => {
        expect(props.onSuccess).toHaveBeenCalledTimes(1);
      });

      // Verify API was called with template variable preserved
      const requestBody = getRequestBody(0);
      expect(requestBody.setupCommand).toBe(commandWithTemplate);
    });
  });

  describe('UI state', () => {
    it('should show FormOverlay when mutation is pending', async () => {
      const user = userEvent.setup();
      const repository = createTestRepository();

      // Make fetch hang indefinitely
      mockFetch.mockReturnValueOnce(new Promise(() => {}));

      renderEditRepositoryForm({ repository });

      // Fill in setup command
      const commandInput = screen.getByPlaceholderText(/bun install/);
      await user.type(commandInput, 'bun install');

      // Submit form
      const submitButton = screen.getByText('Save Changes');
      await user.click(submitButton);

      // Form overlay should be visible with loading message
      await waitFor(() => {
        expect(screen.getByText('Saving changes...')).toBeTruthy();
      });

      // Form fields should be disabled via fieldset
      expect(commandInput.closest('fieldset')?.disabled).toBe(true);
    });

    it('should call onSuccess after successful mutation', async () => {
      const user = userEvent.setup();
      const repository = createTestRepository();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ repository: { ...repository, setupCommand: 'bun install' } })
      );

      const { props } = renderEditRepositoryForm({ repository });

      // Fill in setup command
      const commandInput = screen.getByPlaceholderText(/bun install/);
      await user.type(commandInput, 'bun install');

      // Submit form
      const submitButton = screen.getByText('Save Changes');
      await user.click(submitButton);

      // Wait for mutation to complete
      await waitFor(() => {
        expect(props.onSuccess).toHaveBeenCalledTimes(1);
      });
    });

    it('should call onCancel when cancel button is clicked', async () => {
      const user = userEvent.setup();
      const { props } = renderEditRepositoryForm();

      // Click cancel button
      const cancelButton = screen.getByText('Cancel');
      await user.click(cancelButton);

      expect(props.onCancel).toHaveBeenCalledTimes(1);
    });

    it('should display error message on mutation failure', async () => {
      const user = userEvent.setup();
      const repository = createTestRepository();

      // Mock fetch to fail with specific error
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ error: 'Invalid setup command' }, false)
      );

      const { props } = renderEditRepositoryForm({ repository });

      // Fill in setup command
      const commandInput = screen.getByPlaceholderText(/bun install/);
      await user.type(commandInput, 'invalid command');

      // Submit form
      const submitButton = screen.getByText('Save Changes');
      await user.click(submitButton);

      // Error should be displayed
      await waitFor(() => {
        expect(screen.getByText('Invalid setup command')).toBeTruthy();
      });

      // onSuccess should NOT be called
      expect(props.onSuccess).not.toHaveBeenCalled();
    });

    it('should display default error message when error response has no error field', async () => {
      const user = userEvent.setup();
      const repository = createTestRepository();

      // Mock fetch to fail without error field
      mockFetch.mockResolvedValueOnce(
        createMockResponse({}, false)
      );

      renderEditRepositoryForm({ repository });

      // Fill in setup command
      const commandInput = screen.getByPlaceholderText(/bun install/);
      await user.type(commandInput, 'some command');

      // Submit form
      const submitButton = screen.getByText('Save Changes');
      await user.click(submitButton);

      // Default error message should be displayed
      await waitFor(() => {
        expect(screen.getByText('Failed to update repository')).toBeTruthy();
      });
    });
  });

  describe('initial state', () => {
    it('should display repository name and path', () => {
      const repository = createTestRepository({
        name: 'my-repo',
        path: '/home/user/projects/my-repo',
      });

      renderEditRepositoryForm({ repository });

      expect(screen.getByText('my-repo')).toBeTruthy();
      expect(screen.getByText('/home/user/projects/my-repo')).toBeTruthy();
    });

    it('should pre-populate setupCommand from repository', () => {
      const repository = createTestRepository({ setupCommand: 'npm install && npm run build' });

      renderEditRepositoryForm({ repository });

      const commandInput = screen.getByPlaceholderText(/bun install/) as HTMLTextAreaElement;
      expect(commandInput.value).toBe('npm install && npm run build');
    });

    it('should handle null setupCommand gracefully', () => {
      const repository = createTestRepository({ setupCommand: null });

      renderEditRepositoryForm({ repository });

      const commandInput = screen.getByPlaceholderText(/bun install/) as HTMLTextAreaElement;
      expect(commandInput.value).toBe('');
    });

    it('should handle undefined setupCommand gracefully', () => {
      const repository = createTestRepository();
      // Explicitly set to undefined instead of null
      delete (repository as { setupCommand?: string | null }).setupCommand;

      renderEditRepositoryForm({ repository });

      const commandInput = screen.getByPlaceholderText(/bun install/) as HTMLTextAreaElement;
      expect(commandInput.value).toBe('');
    });
  });
});
