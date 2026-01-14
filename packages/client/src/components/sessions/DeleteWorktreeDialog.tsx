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
import { deleteWorktreeAsync } from '../../lib/api';
import { useWorktreeDeletionTasksContext } from '../../routes/__root';

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
  const { addTask, markAsFailed } = useWorktreeDeletionTasksContext();

  const handleDeleteWorktree = async (force: boolean = false) => {
    // Generate task ID
    const taskId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    // Add task to sidebar with retry info
    addTask({
      id: taskId,
      sessionId,
      sessionTitle: sessionTitle || 'Worktree Session',
      repositoryId,
      worktreePath,
    });

    // Close dialog and navigate immediately
    onOpenChange(false);
    navigate({ to: '/' });

    // Session will be removed from UI when WebSocket broadcast arrives from server
    // (no optimistic update to avoid race condition/flicker)

    try {
      // Call async API
      await deleteWorktreeAsync(repositoryId, worktreePath, taskId, force);
      // Success will be handled via WebSocket
    } catch (err) {
      // If API call fails immediately (network error), mark task as failed
      const message = err instanceof Error ? err.message : 'Failed to delete worktree';
      markAsFailed(taskId, message);
    }
  };

  const handleClose = () => {
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={handleClose}>
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
  );
}
