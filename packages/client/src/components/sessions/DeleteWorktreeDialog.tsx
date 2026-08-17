import { useNavigate } from '@tanstack/react-router';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '../ui/alert-dialog';
import { ErrorDialog, useErrorDialog } from '../ui/error-dialog';
import { deleteWorktreeAsync } from '../../lib/api';
import { useWorktreeDeletionTasksContext } from '../../routes/__root';
import { logger } from '../../lib/logger';

export interface DeleteWorktreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repositoryId: string;
  worktreePath: string;
  sessionId: string;
  sessionTitle?: string;
}

export function DeleteWorktreeDialog({
  open,
  onOpenChange,
  repositoryId,
  worktreePath,
  sessionId,
  sessionTitle,
}: DeleteWorktreeDialogProps) {
  const navigate = useNavigate();
  const { addTask } = useWorktreeDeletionTasksContext();
  const { errorDialogProps, showError } = useErrorDialog();

  const handleDeleteWorktree = async (force: boolean = false) => {
    // Close dialog and navigate immediately -- UX stays snappy, not blocked
    // on the network round trip. Session removal from the UI is handled by
    // the WebSocket broadcast from the server (no optimistic update, to
    // avoid a race condition / flicker).
    onOpenChange(false);
    navigate({ to: '/' });

    try {
      // Call async API. The server generates and owns the job id -- task
      // creation is keyed off the id it returns, not a client-generated one.
      const { jobId } = await deleteWorktreeAsync(repositoryId, worktreePath, force);
      addTask({
        id: jobId,
        sessionId,
        sessionTitle: sessionTitle || 'Worktree Session',
        repositoryId,
        worktreePath,
      });
      // Further progress is handled via WebSocket (or the recovery-read
      // path on the task detail page).
    } catch (err) {
      // No task was ever created, so there's nothing to mark as failed.
      // This component navigates away immediately above, so a local error
      // dialog may already be unmounted by the time this resolves; log as
      // a fallback so the failure is never silently dropped.
      const message = err instanceof Error ? err.message : 'Failed to delete worktree';
      logger.error('Failed to delete worktree:', err);
      showError('Failed to Delete Worktree', message);
    }
  };

  return (
    <>
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-red-400">Delete Worktree</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>Are you sure you want to delete this worktree?</p>
                <p className="text-xs text-gray-500">
                  This will permanently delete the worktree directory and all its contents.
                </p>
                <p className="text-xs text-red-400">
                  This action cannot be undone.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              Cancel
            </AlertDialogCancel>
            <button
              onClick={() => handleDeleteWorktree(false)}
              className="btn btn-danger"
            >
              Delete Worktree
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ErrorDialog {...errorDialogProps} />
    </>
  );
}
