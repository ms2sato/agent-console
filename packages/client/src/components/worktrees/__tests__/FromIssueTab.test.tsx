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

  it('should render issue URL input and Fetch button', () => {
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
    // Create button should be disabled without a fetched issue
    const createButton = screen.getByText('Create & Start Session');
    expect(createButton.hasAttribute('disabled')).toBe(true);
  });

  it('should fetch and display issue preview', async () => {
    const user = userEvent.setup();

    mockFetch.mockImplementation((input) => {
      const url = resolveUrl(input);
      if (url.includes('/agents')) {
        return Promise.resolve(createMockResponse(mockAgentsResponse));
      }
      if (url.includes('/github-issue')) {
        return Promise.resolve(createMockResponse(mockIssueResponse));
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

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    expect(screen.getByText('The login page crashes when password is empty.')).toBeTruthy();
    expect(screen.getByText('Open on GitHub')).toBeTruthy();
    expect(screen.getByText('Suggested branch: fix/login-bug')).toBeTruthy();

    // Create button should now be enabled
    const createButton = screen.getByText('Create & Start Session');
    expect(createButton.hasAttribute('disabled')).toBe(false);
  });

  it('should submit worktree creation with issue data', async () => {
    const user = userEvent.setup();

    mockFetch.mockImplementation((input) => {
      const url = resolveUrl(input);
      if (url.includes('/agents')) {
        return Promise.resolve(createMockResponse(mockAgentsResponse));
      }
      if (url.includes('/github-issue')) {
        return Promise.resolve(createMockResponse(mockIssueResponse));
      }
      return Promise.resolve(createMockResponse({}));
    });

    render(
      <TestWrapper>
        <FromIssueTab {...defaultProps} />
      </TestWrapper>
    );

    // Fetch the issue
    const input = screen.getByPlaceholderText('https://github.com/owner/repo/issues/123 or #123');
    await user.type(input, '#42');
    fireEvent.click(screen.getByText('Fetch'));

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    // Click Create
    fireEvent.click(screen.getByText('Create & Start Session'));

    await waitFor(() => {
      expect(defaultProps.onSubmit).toHaveBeenCalledTimes(1);
    });

    const submitCall = (defaultProps.onSubmit as ReturnType<typeof mock>).mock.calls[0];
    const request = submitCall[0];
    expect(request.mode).toBe('prompt');
    expect(request.initialPrompt).toBe('The login page crashes when password is empty.');
    expect(request.title).toBe('Fix login bug');
    expect(request.autoStartSession).toBe(true);
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

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Create & Start Session'));

    await waitFor(() => {
      expect(defaultProps.onSubmit).toHaveBeenCalledTimes(1);
    });

    const submitCall = (defaultProps.onSubmit as ReturnType<typeof mock>).mock.calls[0];
    const request = submitCall[0];
    // When body is empty, should use title as initial prompt
    expect(request.initialPrompt).toBe('Fix login bug');
  });
});
