import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FromIssueTab } from '../FromIssueTab';

// Save original fetch and set up mock
const originalFetch = globalThis.fetch;
const mockFetch = mock((_input: RequestInfo | URL) => Promise.resolve(new Response()));
globalThis.fetch = mockFetch as unknown as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  cleanup();
});

const mockAgentsResponse = {
  agents: [
    { id: 'claude-code', name: 'Claude Code', isBuiltIn: true },
  ],
};

const mockIssueResponse = {
  issue: {
    org: 'owner',
    repo: 'repo',
    number: 42,
    title: 'Fix login bug',
    body: 'The login page crashes when password is empty.',
    url: 'https://github.com/owner/repo/issues/42',
    suggestedBranch: 'fix/login-bug',
  },
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

function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('FromIssueTab', () => {
  const defaultProps = {
    repositoryId: 'repo-1',
    defaultBranch: 'main',
    defaultAgentId: 'claude-code',
    onSubmit: mock(() => Promise.resolve()),
    onCancel: mock(() => {}),
  };

  beforeEach(() => {
    mockFetch.mockReset();
    (defaultProps.onSubmit as ReturnType<typeof mock>).mockReset();
    (defaultProps.onSubmit as ReturnType<typeof mock>).mockResolvedValue(undefined);
    (defaultProps.onCancel as ReturnType<typeof mock>).mockClear();
  });

  describe('Phase 1: before issue is fetched', () => {
    it('should render issue URL input, Fetch button, and Cancel button', () => {
      mockFetch.mockImplementation((input) => {
        const url = resolveUrl(input);
        if (url.includes('/agents')) {
          return Promise.resolve(createMockResponse(mockAgentsResponse));
        }
        return Promise.resolve(createMockResponse({}));
      });

      render(
        <TestWrapper>
          <FromIssueTab {...defaultProps} />
        </TestWrapper>
      );

      expect(screen.getByPlaceholderText('https://github.com/owner/repo/issues/123 or #123')).toBeTruthy();
      expect(screen.getByText('Fetch')).toBeTruthy();
      expect(screen.getByText('Cancel')).toBeTruthy();
      // CreateWorktreeForm fields should NOT be visible
      expect(screen.queryByText('Initial prompt (optional)')).toBeNull();
    });

    it('should show error when fetch fails', async () => {
      const user = userEvent.setup();

      mockFetch.mockImplementation((input) => {
        const url = resolveUrl(input);
        if (url.includes('/agents')) {
          return Promise.resolve(createMockResponse(mockAgentsResponse));
        }
        if (url.includes('/github-issue')) {
          return Promise.resolve({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            json: () => Promise.resolve({ error: 'Issue not found' }),
          } as unknown as Response);
        }
        return Promise.resolve(createMockResponse({}));
      });

      render(
        <TestWrapper>
          <FromIssueTab {...defaultProps} />
        </TestWrapper>
      );

      const input = screen.getByPlaceholderText('https://github.com/owner/repo/issues/123 or #123');
      await user.type(input, '#999');
      fireEvent.click(screen.getByText('Fetch'));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeTruthy();
      });
    });

    it('should call onCancel when Cancel button is clicked', () => {
      mockFetch.mockImplementation((input) => {
        const url = resolveUrl(input);
        if (url.includes('/agents')) {
          return Promise.resolve(createMockResponse(mockAgentsResponse));
        }
        return Promise.resolve(createMockResponse({}));
      });

      render(
        <TestWrapper>
          <FromIssueTab {...defaultProps} />
        </TestWrapper>
      );

      fireEvent.click(screen.getByText('Cancel'));
      expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('Phase 2: after issue is fetched', () => {
    function setupFetchMock() {
      mockFetch.mockImplementation((input) => {
        const url = resolveUrl(input);
        if (url.includes('/agents')) {
          return Promise.resolve(createMockResponse(mockAgentsResponse));
        }
        if (url.includes('/github-issue')) {
          return Promise.resolve(createMockResponse(mockIssueResponse));
        }
        // Remote branch status query
        if (url.includes('/remote-branch-status')) {
          return Promise.resolve(createMockResponse({ behind: 0, ahead: 0 }));
        }
        return Promise.resolve(createMockResponse({}));
      });
    }

    async function fetchIssue(user: ReturnType<typeof userEvent.setup>) {
      const input = screen.getByPlaceholderText('https://github.com/owner/repo/issues/123 or #123');
      await user.type(input, '#42');
      fireEvent.click(screen.getByText('Fetch'));

      // Wait for Phase 2: CreateWorktreeForm fields appear
      await waitFor(() => {
        expect(screen.getByText('Initial prompt (optional)')).toBeTruthy();
      });
    }

    it('should show CreateWorktreeForm after fetching (no preview card)', async () => {
      const user = userEvent.setup();
      setupFetchMock();

      render(
        <TestWrapper>
          <FromIssueTab {...defaultProps} />
        </TestWrapper>
      );

      await fetchIssue(user);

      // CreateWorktreeForm fields should now be visible
      expect(screen.getByText('Initial prompt (optional)')).toBeTruthy();
      expect(screen.getByText('Title (optional)')).toBeTruthy();
      expect(screen.getByText('Branch name:')).toBeTruthy();

      // No separate preview card — content is in the form fields
      expect(screen.queryByText('Open on GitHub')).toBeNull();
    });

    it('should prefill form with issue data including ref URL', async () => {
      const user = userEvent.setup();
      setupFetchMock();

      render(
        <TestWrapper>
          <FromIssueTab {...defaultProps} />
        </TestWrapper>
      );

      await fetchIssue(user);

      // Check that the initial prompt is prefilled with ref URL + issue body
      await waitFor(() => {
        const promptTextarea = screen.getByPlaceholderText(/What do you want to work on/);
        expect((promptTextarea as HTMLTextAreaElement).value).toBe(
          'ref https://github.com/owner/repo/issues/42\n\nThe login page crashes when password is empty.'
        );
      });

      // Check that the session title is prefilled with issue title
      const titleInput = screen.getByPlaceholderText('Session title');
      expect((titleInput as HTMLInputElement).value).toBe('Fix login bug');
    });

    it('should submit worktree creation with form data', async () => {
      const user = userEvent.setup();
      setupFetchMock();

      render(
        <TestWrapper>
          <FromIssueTab {...defaultProps} />
        </TestWrapper>
      );

      await fetchIssue(user);

      // Wait for prefill to be applied before submitting
      await waitFor(() => {
        const promptTextarea = screen.getByPlaceholderText(/What do you want to work on/);
        expect((promptTextarea as HTMLTextAreaElement).value).toContain('ref https://github.com/owner/repo/issues/42');
      });

      // Click Create & Start Session
      fireEvent.click(screen.getByText('Create & Start Session'));

      await waitFor(() => {
        expect(defaultProps.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (defaultProps.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      const request = submitCall[0];
      expect(request.mode).toBe('prompt');
      expect(request.initialPrompt).toBe(
        'ref https://github.com/owner/repo/issues/42\n\nThe login page crashes when password is empty.'
      );
      expect(request.title).toBe('Fix login bug');
      expect(request.autoStartSession).toBe(true);
    });

    it('should show branch name mode options after fetching', async () => {
      const user = userEvent.setup();
      setupFetchMock();

      render(
        <TestWrapper>
          <FromIssueTab {...defaultProps} />
        </TestWrapper>
      );

      await fetchIssue(user);

      // Branch name mode radio buttons should be available
      expect(screen.getByLabelText('Auto-generate')).toBeTruthy();
      expect(screen.getByLabelText('Custom name (new branch)')).toBeTruthy();
      expect(screen.getByLabelText('Use existing branch')).toBeTruthy();

      // Auto-generate should be selected by default (from prefillValues branchNameMode: 'prompt')
      const autoGenerate = screen.getByLabelText('Auto-generate') as HTMLInputElement;
      expect(autoGenerate.checked).toBe(true);
    });

    it('should use issue title as prompt when body is empty', async () => {
      const user = userEvent.setup();

      const issueWithoutBody = {
        issue: {
          ...mockIssueResponse.issue,
          body: '',
        },
      };

      mockFetch.mockImplementation((input) => {
        const url = resolveUrl(input);
        if (url.includes('/agents')) {
          return Promise.resolve(createMockResponse(mockAgentsResponse));
        }
        if (url.includes('/github-issue')) {
          return Promise.resolve(createMockResponse(issueWithoutBody));
        }
        if (url.includes('/remote-branch-status')) {
          return Promise.resolve(createMockResponse({ behind: 0, ahead: 0 }));
        }
        return Promise.resolve(createMockResponse({}));
      });

      render(
        <TestWrapper>
          <FromIssueTab {...defaultProps} />
        </TestWrapper>
      );

      const input = screen.getByPlaceholderText('https://github.com/owner/repo/issues/123 or #123');
      await user.type(input, '#42');
      fireEvent.click(screen.getByText('Fetch'));

      // Wait for Phase 2
      await waitFor(() => {
        expect(screen.getByText('Initial prompt (optional)')).toBeTruthy();
      });

      // The prompt should be prefilled with ref URL + title (since body is empty)
      await waitFor(() => {
        const promptTextarea = screen.getByPlaceholderText(/What do you want to work on/);
        expect((promptTextarea as HTMLTextAreaElement).value).toBe(
          'ref https://github.com/owner/repo/issues/42\n\nFix login bug'
        );
      });
    });
  });
});
