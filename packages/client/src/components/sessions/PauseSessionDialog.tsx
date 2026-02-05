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
import { pauseSession } from '../../lib/api';
import type { Session, AgentActivityState } from '@agent-console/shared';

export interface PauseSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  sessionTitle?: string;
  session?: Session;
  /** Activity states for workers in this session: { workerId: state } */
  workerActivityStates?: Record<string, AgentActivityState>;
}

/**
 * Dialog for pausing a worktree session.
 * Pausing kills PTY processes but preserves session data for later resume.
 */
export function PauseSessionDialog({
  open,
  onOpenChange,
  sessionId,
  sessionTitle,
  session,
  workerActivityStates,
}: PauseSessionDialogProps) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  // Check if any agent workers are in 'active' or 'asking' state
  const hasActiveWorkers = session && workerActivityStates && session.workers.some(
    w => w.type === 'agent' &&
      (workerActivityStates[w.id] === 'active' || workerActivityStates[w.id] === 'asking')
  );

  const pauseMutation = useMutation({
    mutationFn: () => pauseSession(sessionId),
    onSuccess: () => {
      // Close dialog and navigate immediately
      onOpenChange(false);
      navigate({ to: '/' });
      // Session will be updated when WebSocket broadcast arrives from server
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to pause session');
    },
  });

  const handleConfirm = () => {
    setError(null);
    pauseMutation.mutate();
  };

  const handleClose = () => {
    if (!pauseMutation.isPending) {
      setError(null);
      onOpenChange(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-yellow-400">Pause Session</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Are you sure you want to pause{' '}
                <span className="font-medium text-gray-300">
                  {sessionTitle || 'this session'}
                </span>
                ?
              </p>
              {hasActiveWorkers && (
                <p className="text-yellow-400 font-semibold">
                  Warning: This session has active workers. Pausing will stop all work in progress.
                </p>
              )}
              <p className="text-xs text-gray-500">
                Session data will be preserved. You can resume this session later from the dashboard.
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
          <AlertDialogCancel disabled={pauseMutation.isPending}>
            Cancel
          </AlertDialogCancel>
          <button
            onClick={handleConfirm}
            className="btn bg-yellow-600 hover:bg-yellow-500 text-white"
            disabled={pauseMutation.isPending}
          >
            <ButtonSpinner isPending={pauseMutation.isPending} pendingText="Pausing...">
              Pause
            </ButtonSpinner>
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
