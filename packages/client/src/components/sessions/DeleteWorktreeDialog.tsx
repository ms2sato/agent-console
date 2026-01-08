import { useState, useEffect } from 'react';
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
import { deleteWorktree } from '../../lib/api';
import { emitSessionDeleted } from '../../lib/app-websocket';

export interface DeleteWorktreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repositoryId: string;
  worktreePath: string;
  sessionId: string;
}

export function DeleteWorktreeDialog({
  open,
  onOpenChange,
  repositoryId,
  worktreePath,
  sessionId,
}: DeleteWorktreeDialogProps) {
  const navigate = useNavigate();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset error when dialog closes
  useEffect(() => {
    if (!open) {
      setError(null);
    }
  }, [open]);

  const handleDeleteWorktree = async (force: boolean = false) => {
    setIsSubmitting(true);
    setError(null);

    try {
      // Server-side deleteWorktree also terminates any running sessions
      await deleteWorktree(repositoryId, worktreePath, force);
      // Emit session-deleted locally for immediate UI update
      // WebSocket event will arrive later but will be processed idempotently
      emitSessionDeleted(sessionId);
      onOpenChange(false);
      navigate({ to: '/' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete worktree';
      // If deletion failed without force and error mentions untracked files, show retry option
      if (!force && message.includes('untracked')) {
        setError('Worktree has untracked files. Click "Force Delete" to proceed anyway.');
      } else {
        setError(message);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    onOpenChange(false);
  };

  const showForceDelete = error?.includes('untracked');

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
        {error && <p className="text-sm text-red-400">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isSubmitting}>
            Cancel
          </AlertDialogCancel>
          {showForceDelete ? (
            <button
              onClick={() => handleDeleteWorktree(true)}
              className="btn btn-danger"
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Deleting...' : 'Force Delete'}
            </button>
          ) : (
            <button
              onClick={() => handleDeleteWorktree(false)}
              className="btn btn-danger"
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Deleting...' : 'Delete Worktree'}
            </button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
