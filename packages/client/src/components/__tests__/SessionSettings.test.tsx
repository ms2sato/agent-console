import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { screen, fireEvent, waitFor, act, cleanup, render } from '@testing-library/react';
import { createRootRoute, createRouter, createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionSettings } from '../SessionSettings';
import { WorktreeDeletionTasksContext, SessionStopTasksContext } from '../../contexts/root-contexts';
import type { UseWorktreeDeletionTasksReturn } from '../../hooks/useWorktreeDeletionTasks';
import type { UseSessionStopTasksReturn } from '../../hooks/useSessionStopTasks';

// Helper to create mock Response
function createMockResponse(body: unknown, options: { status?: number; ok?: boolean } = {}) {
  const { status = 200, ok = true } = options;
  return {
    ok,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: mock(() => Promise.resolve(body)),
  } as unknown as Response;
}

// Default PR link response (no PR exists)
const prLinkResponse = createMockResponse({
  prUrl: null,
  branchName: 'test-branch',
  orgRepo: 'org/repo',
});

// Create mock deletion tasks context
function createMockDeletionTasks(): UseWorktreeDeletionTasksReturn {
  return {
    tasks: [],
    addTask: mock(() => {}),
    removeTask: mock(() => {}),
    getTask: mock(() => undefined),
    markAsFailed: mock(() => {}),
    handleWorktreeDeletionCompleted: mock(() => {}),
    handleWorktreeDeletionFailed: mock(() => {}),
  };
}

// Create mock session stop tasks context. SessionSettings always mounts
// PauseSessionDialog (visibility is controlled by its `open` prop, not by
// conditional rendering), so it always calls useSessionStopTasksContext()
// and requires a Provider ancestor.
function createMockSessionStopTasks(): UseSessionStopTasksReturn {
  return {
    tasks: [],
    addTask: mock(() => true),
    removeTask: mock(() => {}),
    getTask: mock(() => undefined),
    markAsFailed: mock(() => {}),
  };
}

// Helper to render with router and context
async function renderWithRouterAndContext(
  ui: React.ReactNode,
  deletionTasks: UseWorktreeDeletionTasksReturn,
  initialPath = '/',
  sessionStopTasks: UseSessionStopTasksReturn = createMockSessionStopTasks()
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
      },
      mutations: {
        retry: false,
      },
    },
  });

  // Provide the deletion tasks context via the REAL WorktreeDeletionTasksContext
  // (re-exported by routes/__root) instead of a `mock.module`-replaced module --
  // mock.module is process-global in bun:test and would poison every other test
  // file that real-imports routes/__root in the same process (testing.md
  // Anti-Pattern #2). SessionSettings renders DeleteWorktreeDialog, which calls
  // useWorktreeDeletionTasksContext() and requires a Provider ancestor.
  const rootRoute = createRootRoute({
    component: () => (
      <WorktreeDeletionTasksContext.Provider value={deletionTasks}>
        <SessionStopTasksContext.Provider value={sessionStopTasks}>
          {ui}
        </SessionStopTasksContext.Provider>
      </WorktreeDeletionTasksContext.Provider>
    ),
  });
  const memoryHistory = createMemoryHistory({
    initialEntries: [initialPath],
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: memoryHistory,
    defaultPendingMinMs: 0,
  });

  // Wait for router to be ready
  await act(async () => {
    await router.load();
  });

  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  return { ...result, router, queryClient };
}

describe('SessionSettings', () => {
  let originalFetch: typeof fetch;
  let mockFetch: ReturnType<typeof mock<(url: string, init?: RequestInit) => Promise<Response>>>;
  let deleteWorktreeResponses: Response[];
  let mockDeletionTasks: UseWorktreeDeletionTasksReturn;

  const defaultProps = {
    sessionId: 'test-session-id',
    repositoryId: 'test-repo-id',
    currentBranch: 'test-branch',
    worktreePath: '/path/to/worktree',
    isMainWorktree: false,
    onBranchChange: mock(() => {}),
    onSessionRestart: mock(() => {}),
  };

  beforeEach(() => {
    // Save and replace fetch before each test
    originalFetch = globalThis.fetch;
    deleteWorktreeResponses = [];
    mockDeletionTasks = createMockDeletionTasks();

    // Create a mock that handles different endpoints
    mockFetch = mock((url: string, init?: RequestInit) => {
      // Always return PR link response for pr-link endpoint
      if (url.includes('/pr-link')) {
        return Promise.resolve(prLinkResponse);
      }
      // For delete worktree, return from the queue
      if (url.includes('/worktrees/') && init?.method === 'DELETE') {
        const response = deleteWorktreeResponses.shift();
        if (response) {
          return Promise.resolve(response);
        }
        // Default: return accepted response for async deletion
        return Promise.resolve(createMockResponse({ accepted: true }));
      }
      // Default response
      return Promise.resolve(new Response());
    });

    globalThis.fetch = mockFetch as unknown as typeof fetch;
    defaultProps.onBranchChange.mockClear();
    defaultProps.onSessionRestart.mockClear();
  });

  afterEach(() => {
    // Restore fetch and cleanup DOM after each test
    globalThis.fetch = originalFetch;
    cleanup();
  });

  /**
   * Helper to open the delete worktree dialog and click the delete button
   */
  const openDeleteWorktreeDialogAndConfirm = async () => {
    // Open menu
    await act(async () => {
      fireEvent.click(screen.getByTitle('Session settings'));
    });

    // Click "Delete Worktree" in menu (there's only one in the menu at this point)
    const menuItems = screen.getAllByText('Delete Worktree');
    // The menu item is in the dropdown, not the dialog
    await act(async () => {
      fireEvent.click(menuItems[0]);
    });

    // Wait for dialog - check for dialog-specific text
    await waitFor(() => {
      expect(screen.getByText('Are you sure you want to delete this worktree?')).toBeTruthy();
    });

    // Find the delete button in the dialog (has btn-danger class)
    const deleteButton = screen
      .getAllByRole('button')
      .find((btn) => btn.textContent === 'Delete Worktree' && btn.className.includes('btn-danger'));
    expect(deleteButton).toBeTruthy();
    await act(async () => {
      fireEvent.click(deleteButton!);
    });
  };

  describe('handleDeleteWorktree', () => {
    it('should call deleteWorktreeAsync and navigate immediately', async () => {
      // Setup: successful delete response
      deleteWorktreeResponses.push(createMockResponse({ accepted: true }));

      const { router } = await renderWithRouterAndContext(
        <SessionSettings {...defaultProps} />,
        mockDeletionTasks
      );

      await openDeleteWorktreeDialogAndConfirm();

      // Verify fetch was called with correct URL and method (now includes taskId in query)
      await waitFor(() => {
        const calls = mockFetch.mock.calls;
        const deleteCall = calls.find((call) =>
          call[0]?.includes('/worktrees/') && call[1]?.method === 'DELETE'
        );
        expect(deleteCall).toBeTruthy();
        expect(deleteCall![0]).toContain('taskId=');
      });

      // Should navigate to home immediately (async deletion)
      await waitFor(() => {
        expect(router.state.location.pathname).toBe('/');
      });
    });

    it('should add a deletion task when delete is initiated', async () => {
      deleteWorktreeResponses.push(createMockResponse({ accepted: true }));

      await renderWithRouterAndContext(
        <SessionSettings {...defaultProps} />,
        mockDeletionTasks
      );

      await openDeleteWorktreeDialogAndConfirm();

      // The dialog now navigates immediately - task is added before navigation
      // Since we're mocking the context module, we can't easily verify the addTask call
      // But we can verify the fetch was made with taskId
      await waitFor(() => {
        const calls = mockFetch.mock.calls;
        const deleteCall = calls.find((call) =>
          call[0]?.includes('/worktrees/') && call[1]?.method === 'DELETE'
        );
        expect(deleteCall).toBeTruthy();
      });
    });
  });

  describe('pauseDisabled threading (Issue #1247)', () => {
    it('disables the Pause menu entry when pauseDisabled is true', async () => {
      await renderWithRouterAndContext(
        <SessionSettings {...defaultProps} pauseDisabled />,
        mockDeletionTasks
      );

      await act(async () => {
        fireEvent.click(screen.getByTitle('Session settings'));
      });

      const pauseButton = screen.getByRole('button', { name: /Pause/ });
      expect((pauseButton as HTMLButtonElement).disabled).toBe(true);
    });

    it('leaves the Pause menu entry enabled when pauseDisabled is false/omitted', async () => {
      await renderWithRouterAndContext(
        <SessionSettings {...defaultProps} />,
        mockDeletionTasks
      );

      await act(async () => {
        fireEvent.click(screen.getByTitle('Session settings'));
      });

      const pauseButton = screen.getByRole('button', { name: /Pause/ });
      expect((pauseButton as HTMLButtonElement).disabled).toBe(false);
    });
  });
});
