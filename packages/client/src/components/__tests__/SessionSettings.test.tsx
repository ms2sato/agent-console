import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SessionSettings } from '../SessionSettings';
import * as api from '../../lib/api';

// Mock react-router
const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

// Mock API module
vi.mock('../../lib/api', () => ({
  renameSessionBranch: vi.fn(),
  restartSession: vi.fn(),
  deleteSession: vi.fn(),
  deleteWorktree: vi.fn(),
  openPath: vi.fn(),
}));

describe('SessionSettings', () => {
  const defaultProps = {
    sessionId: 'test-session-id',
    repositoryId: 'test-repo-id',
    currentBranch: 'test-branch',
    worktreePath: '/path/to/worktree',
    onBranchChange: vi.fn(),
    onSessionRestart: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    it('should delete worktree first, then session on success', async () => {
      vi.mocked(api.deleteWorktree).mockResolvedValue(undefined);
      vi.mocked(api.deleteSession).mockResolvedValue(undefined);

      render(<SessionSettings {...defaultProps} />);

      await openDeleteWorktreeDialogAndConfirm();

      await waitFor(() => {
        expect(api.deleteWorktree).toHaveBeenCalledWith(
          'test-repo-id',
          '/path/to/worktree',
          false
        );
      });

      await waitFor(() => {
        expect(api.deleteSession).toHaveBeenCalledWith('test-session-id');
      });

      // Should navigate to home
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/' });

      // Verify order: deleteWorktree called before deleteSession
      const deleteWorktreeCallOrder = vi.mocked(api.deleteWorktree).mock.invocationCallOrder[0];
      const deleteSessionCallOrder = vi.mocked(api.deleteSession).mock.invocationCallOrder[0];
      expect(deleteWorktreeCallOrder).toBeLessThan(deleteSessionCallOrder);
    });

    it('should NOT call deleteSession when deleteWorktree fails with untracked files error', async () => {
      vi.mocked(api.deleteWorktree).mockRejectedValue(
        new Error('Worktree contains untracked files')
      );

      render(<SessionSettings {...defaultProps} />);

      await openDeleteWorktreeDialogAndConfirm();

      await waitFor(() => {
        expect(api.deleteWorktree).toHaveBeenCalledWith(
          'test-repo-id',
          '/path/to/worktree',
          false
        );
      });

      // deleteSession should NOT be called
      expect(api.deleteSession).not.toHaveBeenCalled();

      // Should show error with Force Delete option
      await waitFor(() => {
        expect(screen.getByText(/untracked files/i)).toBeTruthy();
        expect(screen.getByText('Force Delete')).toBeTruthy();
      });

      // Should NOT navigate
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('should call deleteWorktree with force=true when Force Delete is clicked', async () => {
      // First call fails with untracked files error
      vi.mocked(api.deleteWorktree)
        .mockRejectedValueOnce(new Error('Worktree contains untracked files'))
        .mockResolvedValueOnce(undefined);
      vi.mocked(api.deleteSession).mockResolvedValue(undefined);

      render(<SessionSettings {...defaultProps} />);

      await openDeleteWorktreeDialogAndConfirm();

      // Wait for error and Force Delete button to appear
      await waitFor(() => {
        expect(screen.getByText('Force Delete')).toBeTruthy();
      });

      // Click Force Delete
      await act(async () => {
        fireEvent.click(screen.getByText('Force Delete'));
      });

      // Should call deleteWorktree with force=true
      await waitFor(() => {
        expect(api.deleteWorktree).toHaveBeenLastCalledWith(
          'test-repo-id',
          '/path/to/worktree',
          true
        );
      });

      // After force delete succeeds, deleteSession should be called
      await waitFor(() => {
        expect(api.deleteSession).toHaveBeenCalledWith('test-session-id');
      });

      // Should navigate to home
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/' });
    });

    it('should show generic error when deleteWorktree fails with non-untracked error', async () => {
      vi.mocked(api.deleteWorktree).mockRejectedValue(new Error('Permission denied'));

      render(<SessionSettings {...defaultProps} />);

      await openDeleteWorktreeDialogAndConfirm();

      await waitFor(() => {
        expect(screen.getByText('Permission denied')).toBeTruthy();
      });

      // deleteSession should NOT be called
      expect(api.deleteSession).not.toHaveBeenCalled();

      // Force Delete button should NOT appear (only for untracked files)
      expect(screen.queryByText('Force Delete')).toBeNull();
    });

    it('should succeed even if deleteSession fails after worktree deletion', async () => {
      vi.mocked(api.deleteWorktree).mockResolvedValue(undefined);
      vi.mocked(api.deleteSession).mockRejectedValue(new Error('Session not found'));

      render(<SessionSettings {...defaultProps} />);

      await openDeleteWorktreeDialogAndConfirm();

      await waitFor(() => {
        expect(api.deleteWorktree).toHaveBeenCalled();
      });

      // Even though deleteSession failed, we should still navigate (worktree is deleted)
      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith({ to: '/' });
      });
    });
  });
});
