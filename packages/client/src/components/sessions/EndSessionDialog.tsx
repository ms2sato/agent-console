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
import type { Session, AgentActivityState } from '@agent-console/shared';

export interface EndSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  sessionTitle?: string;
  session?: Session;
  /** Activity states for workers in this session: { workerId: state } */
  workerActivityStates?: Record<string, AgentActivityState>;
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
  session,
  workerActivityStates,
}: EndSessionDialogProps) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  // Check if any agent workers are in 'active' or 'asking' state
  const hasActiveWorkers = session && workerActivityStates && session.workers.some(
    w => w.type === 'agent' &&
      (workerActivityStates[w.id] === 'active' || workerActivityStates[w.id] === 'asking')
  );

  const deleteMutation = useMutation({
    mutationFn: () => deleteSession(sessionId),
    onSuccess: () => {
      // Close dialog and navigate immediately
      onOpenChange(false);
      navigate({ to: '/' });
      // Session will be removed from UI when WebSocket broadcast arrives from server
      // (no optimistic update to avoid race condition/flicker)
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
          <AlertDialogTitle className="text-red-400">End Session</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Are you sure you want to end{' '}
                <span className="font-medium text-gray-300">
                  {sessionTitle || 'this session'}
                </span>
                ?
              </p>
              {hasActiveWorkers && (
                <p className="text-yellow-400 font-semibold">
                  Warning: This session has active workers. Ending will stop all work in progress.
                </p>
              )}
              <p className="text-xs text-gray-500">
                This will terminate all running workers and close their terminals.
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
