import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock useCreateWorktree before importing the component
const mockHandleCreateWorktree = mock(() => Promise.resolve());
const mockClearError = mock(() => {});

mock.module('../../../hooks/useCreateWorktree', () => ({
  useCreateWorktree: () => ({
    handleCreateWorktree: mockHandleCreateWorktree,
    error: null,
    clearError: mockClearError,
  }),
}));

import { QuickWorktreeDialog } from '../QuickWorktreeDialog';

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

const mockRepositoriesResponse = {
  repositories: [
    { id: 'repo-1', name: 'Test Repository', path: '/test/repo', defaultAgentId: 'claude-code' },
  ],
};

const mockRepositoryResponse = {
  repository: {
    id: 'repo-1',
    name: 'Test Repository',
    path: '/test/repo',
    defaultAgentId: 'claude-code',
  },
};

const mockBranchesResponse = {
  branches: ['main', 'develop'],
  defaultBranch: 'main',
};

const mockAgentsResponse = {
  agents: [
    { id: 'claude-code', name: 'Claude Code', isBuiltIn: true },
  ],
};

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

function renderDialog(props: Partial<React.ComponentProps<typeof QuickWorktreeDialog>> = {}) {
  const defaultProps = {
    open: true,
    onOpenChange: mock(() => {}),
    defaultRepositoryId: 'repo-1',
  };

  const mergedProps = { ...defaultProps, ...props };

  return {
    ...render(
      <TestWrapper>
        <QuickWorktreeDialog {...mergedProps} />
      </TestWrapper>
    ),
    props: mergedProps,
  };
}

describe('QuickWorktreeDialog', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockHandleCreateWorktree.mockReset();
    mockHandleCreateWorktree.mockResolvedValue(undefined);
    mockClearError.mockClear();
  });

  it('should show loading spinner while fetching data', async () => {
    // Make fetch hang so we can observe loading state
    let resolveRepository: (value: Response) => void;
    const repositoryPromise = new Promise<Response>((resolve) => {
      resolveRepository = resolve;
    });

    mockFetch.mockImplementation((input) => {
      const url = resolveUrl(input);
      if (url.endsWith('/repositories')) {
        return repositoryPromise;
      }
      if (url.includes('/repositories/') && !url.includes('/branches') && !url.includes('/agents')) {
        return Promise.resolve(createMockResponse(mockRepositoryResponse));
      }
      if (url.includes('/branches')) {
        return Promise.resolve(createMockResponse(mockBranchesResponse));
      }
      return Promise.resolve(createMockResponse(mockAgentsResponse));
    });

    renderDialog();

    // Should show a loading spinner
    expect(screen.getByRole('status', { name: 'Loading' })).toBeTruthy();

    // Should NOT show the form yet
    expect(screen.queryByText('Create & Start Session')).toBeNull();

    // Clean up
    resolveRepository!(createMockResponse(mockRepositoriesResponse));
  });

  it('should render CreateWorktreeForm when data is loaded', async () => {
    mockFetch.mockImplementation((input) => {
      const url = resolveUrl(input);
      if (url.endsWith('/repositories')) {
        return Promise.resolve(createMockResponse(mockRepositoriesResponse));
      }
      if (url.includes('/repositories/') && !url.includes('/branches') && !url.includes('/agents') && !url.includes('/remote-status')) {
        return Promise.resolve(createMockResponse(mockRepositoryResponse));
      }
      if (url.includes('/branches') && !url.includes('/remote-status')) {
        return Promise.resolve(createMockResponse(mockBranchesResponse));
      }
      if (url.includes('/remote-status')) {
        return Promise.resolve(createMockResponse({ behind: 0, ahead: 0 }));
      }
      return Promise.resolve(createMockResponse(mockAgentsResponse));
    });

    renderDialog();

    // Wait for the form to appear (the submit button indicates the form is loaded)
    await waitFor(() => {
      expect(screen.getByText('Create & Start Session')).toBeTruthy();
    });

    // Dialog title should be visible
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Create Worktree')).toBeTruthy();
  });

  it('should close dialog on successful worktree creation', async () => {
    mockFetch.mockImplementation((input) => {
      const url = resolveUrl(input);
      if (url.endsWith('/repositories')) {
        return Promise.resolve(createMockResponse(mockRepositoriesResponse));
      }
      if (url.includes('/repositories/') && !url.includes('/branches') && !url.includes('/agents') && !url.includes('/remote-status')) {
        return Promise.resolve(createMockResponse(mockRepositoryResponse));
      }
      if (url.includes('/branches') && !url.includes('/remote-status')) {
        return Promise.resolve(createMockResponse(mockBranchesResponse));
      }
      if (url.includes('/remote-status')) {
        return Promise.resolve(createMockResponse({ behind: 0, ahead: 0 }));
      }
      return Promise.resolve(createMockResponse(mockAgentsResponse));
    });

    const { props } = renderDialog();

    // Wait for the form to appear
    await waitFor(() => {
      expect(screen.getByText('Create & Start Session')).toBeTruthy();
    });

    // Use custom mode instead of prompt mode to avoid prompt validation issues.
    // Select the "Custom name" radio button and fill in a branch name.
    const customRadio = screen.getByLabelText(/Custom name \(new branch\)/);
    fireEvent.click(customRadio);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('New branch name')).toBeTruthy();
    });

    const branchInput = screen.getByPlaceholderText('New branch name');
    fireEvent.input(branchInput, { target: { value: 'feat/test' } });
    fireEvent.change(branchInput, { target: { value: 'feat/test' } });

    // Submit form
    const form = branchInput.closest('form')!;
    fireEvent.submit(form);

    // handleCreateWorktree should be called
    await waitFor(() => {
      expect(mockHandleCreateWorktree).toHaveBeenCalledTimes(1);
    });

    // onOpenChange should be called with false to close the dialog
    await waitFor(() => {
      expect(props.onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('should render dialog with scrollable content area', async () => {
    mockFetch.mockImplementation((input) => {
      const url = resolveUrl(input);
      if (url.endsWith('/repositories')) {
        return Promise.resolve(createMockResponse(mockRepositoriesResponse));
      }
      if (url.includes('/repositories/') && !url.includes('/branches') && !url.includes('/agents') && !url.includes('/remote-status')) {
        return Promise.resolve(createMockResponse(mockRepositoryResponse));
      }
      if (url.includes('/branches') && !url.includes('/remote-status')) {
        return Promise.resolve(createMockResponse(mockBranchesResponse));
      }
      if (url.includes('/remote-status')) {
        return Promise.resolve(createMockResponse({ behind: 0, ahead: 0 }));
      }
      return Promise.resolve(createMockResponse(mockAgentsResponse));
    });

    renderDialog();

    await waitFor(() => {
      expect(screen.getByText('Create & Start Session')).toBeTruthy();
    });

    // The dialog content should have overflow-y-auto for scrollability on small viewports
    const dialogEl = screen.getByRole('dialog');
    expect(dialogEl.className).toContain('overflow-y-auto');
    expect(dialogEl.className).toContain('max-w-3xl');
  });

  it('should pass correct draftKey to CreateWorktreeForm', async () => {
    const user = userEvent.setup();

    mockFetch.mockImplementation((input) => {
      const url = resolveUrl(input);
      if (url.endsWith('/repositories')) {
        return Promise.resolve(createMockResponse(mockRepositoriesResponse));
      }
      if (url.includes('/repositories/') && !url.includes('/branches') && !url.includes('/agents') && !url.includes('/remote-status')) {
        return Promise.resolve(createMockResponse(mockRepositoryResponse));
      }
      if (url.includes('/branches') && !url.includes('/remote-status')) {
        return Promise.resolve(createMockResponse(mockBranchesResponse));
      }
      if (url.includes('/remote-status')) {
        return Promise.resolve(createMockResponse({ behind: 0, ahead: 0 }));
      }
      return Promise.resolve(createMockResponse(mockAgentsResponse));
    });

    const expectedDraftKey = 'worktree-draft:repo-1';
    localStorage.removeItem(expectedDraftKey);

    try {
      renderDialog();

      // Wait for the form to load
      await waitFor(() => {
        expect(screen.getByText('Create & Start Session')).toBeTruthy();
      });

      // Type a value to trigger the debounced draft save
      const titleInput = screen.getByPlaceholderText('Session title');
      await user.type(titleInput, 'Test Title');

      // Wait for the debounced save to localStorage
      await waitFor(() => {
        const saved = localStorage.getItem(expectedDraftKey);
        expect(saved).not.toBeNull();
        const parsed = JSON.parse(saved!);
        expect(parsed.sessionTitle).toBe('Test Title');
      }, { timeout: 2000 });
    } finally {
      localStorage.removeItem(expectedDraftKey);
    }
  });
});
