import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { renderWithRouter } from '../../test/renderWithRouter';
import { SessionSettings } from '../SessionSettings';

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

// Helper to create error Response
function createErrorResponse(errorMessage: string, status = 400) {
  return {
    ok: false,
    status,
    statusText: 'Error',
    json: mock(() => Promise.resolve({ error: errorMessage })),
  } as unknown as Response;
}

describe('SessionSettings', () => {
  let originalFetch: typeof fetch;
  let mockFetch: ReturnType<typeof mock<() => Promise<Response>>>;

  const defaultProps = {
    sessionId: 'test-session-id',
    repositoryId: 'test-repo-id',
    currentBranch: 'test-branch',
    worktreePath: '/path/to/worktree',
    onBranchChange: mock(() => {}),
    onSessionRestart: mock(() => {}),
  };

  beforeEach(() => {
    // Save and replace fetch before each test
    originalFetch = globalThis.fetch;
    mockFetch = mock(() => Promise.resolve(new Response()));
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
    it('should call deleteWorktree and navigate on success', async () => {
      // Mock successful delete
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      const { router } = await renderWithRouter(<SessionSettings {...defaultProps} />);

      await openDeleteWorktreeDialogAndConfirm();

      // Verify fetch was called with correct URL and method
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/repositories/test-repo-id/worktrees/%2Fpath%2Fto%2Fworktree',
          { method: 'DELETE' }
        );
      });

      // Should navigate to home
      await waitFor(() => {
        expect(router.state.location.pathname).toBe('/');
      });
    });

    it('should show Force Delete option when deleteWorktree fails with untracked files error', async () => {
      mockFetch.mockResolvedValue(
        createErrorResponse('Worktree contains untracked files')
      );

      const { router } = await renderWithRouter(<SessionSettings {...defaultProps} />);

      await openDeleteWorktreeDialogAndConfirm();

      // Should show error with Force Delete option
      await waitFor(() => {
        expect(screen.getByText(/untracked files/i)).toBeTruthy();
        expect(screen.getByText('Force Delete')).toBeTruthy();
      });

      // Should NOT navigate (still on initial route)
      expect(router.state.location.pathname).toBe('/');
    });

    it('should call deleteWorktree with force=true when Force Delete is clicked', async () => {
      // First call fails with untracked files error, second succeeds
      mockFetch
        .mockResolvedValueOnce(createErrorResponse('Worktree contains untracked files'))
        .mockResolvedValueOnce(createMockResponse({ success: true }));

      const { router } = await renderWithRouter(<SessionSettings {...defaultProps} />);

      await openDeleteWorktreeDialogAndConfirm();

      // Wait for error and Force Delete button to appear
      await waitFor(() => {
        expect(screen.getByText('Force Delete')).toBeTruthy();
      });

      // Click Force Delete
      await act(async () => {
        fireEvent.click(screen.getByText('Force Delete'));
      });

      // Should call deleteWorktree with force=true query param
      await waitFor(() => {
        expect(mockFetch).toHaveBeenLastCalledWith(
          '/api/repositories/test-repo-id/worktrees/%2Fpath%2Fto%2Fworktree?force=true',
          { method: 'DELETE' }
        );
      });

      // Should navigate to home
      await waitFor(() => {
        expect(router.state.location.pathname).toBe('/');
      });
    });

    it('should show generic error when deleteWorktree fails with non-untracked error', async () => {
      mockFetch.mockResolvedValue(createErrorResponse('Permission denied'));

      await renderWithRouter(<SessionSettings {...defaultProps} />);

      await openDeleteWorktreeDialogAndConfirm();

      await waitFor(() => {
        expect(screen.getByText('Permission denied')).toBeTruthy();
      });

      // Force Delete button should NOT appear (only for untracked files)
      expect(screen.queryByText('Force Delete')).toBeNull();
    });
  });
});
