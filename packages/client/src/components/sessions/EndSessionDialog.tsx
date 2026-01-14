import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '../ui/alert-dialog';
import { ButtonSpinner } from '../ui/Spinner';
import { deleteSession } from '../../lib/api';
import { emitSessionDeleted } from '../../lib/app-websocket';

export interface EndSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  sessionTitle?: string;
}

/**
 * Dialog for ending (deleting) a quick session.
 * Quick sessions are deleted synchronously without task management.
 */
export function EndSessionDialog({
  open,
  onOpenChange,
  sessionId,
  sessionTitle,
}: EndSessionDialogProps) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: () => deleteSession(sessionId),
    onSuccess: () => {
      // Close dialog and navigate immediately
      onOpenChange(false);
      navigate({ to: '/' });
      // Emit session-deleted locally for immediate UI update
      emitSessionDeleted(sessionId);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to end session');
    },
  });

  const handleConfirm = () => {
    setError(null);
    deleteMutation.mutate();
  };

  const handleClose = () => {
    if (!deleteMutation.isPending) {
      setError(null);
      onOpenChange(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>End Session</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Are you sure you want to end{' '}
                <span className="font-medium text-gray-300">
                  {sessionTitle || 'this session'}
                </span>
                ?
              </p>
              <p className="text-xs text-gray-500">
                This will stop all workers and cannot be undone.
              </p>
              {error && (
                <p className="text-xs text-red-400 bg-red-950/50 p-2 rounded">
                  {error}
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteMutation.isPending}>
            Cancel
          </AlertDialogCancel>
          <button
            onClick={handleConfirm}
            className="btn btn-danger"
            disabled={deleteMutation.isPending}
          >
            <ButtonSpinner isPending={deleteMutation.isPending} pendingText="Ending...">
              End Session
            </ButtonSpinner>
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
