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
import { pauseSession } from '../../lib/api';
import { useSessionStopTasksContext } from '../../routes/__root';
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
 *
 * The pending/error state lives in `SessionStopTasksContext` (scoped to the
 * affected session -- dashboard row + session page banner) instead of this
 * modal, so pausing a session no longer freezes the whole app for the
 * server round-trip. See DeleteWorktreeDialog for the sibling pattern.
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
  const { addTask, markAsFailed } = useSessionStopTasksContext();

  // Check if any agent or embedded-agent workers are in 'active' or 'asking' state
  // (embedded-agent workers only ever report 'active'/'idle', never 'asking')
  const hasActiveWorkers = session && workerActivityStates && session.workers.some(
    w => (w.type === 'agent' || w.type === 'embedded-agent') &&
      (workerActivityStates[w.id] === 'active' || workerActivityStates[w.id] === 'asking')
  );

  const handlePause = async () => {
    const added = addTask({ sessionId, action: 'pause', sessionTitle });
    if (!added) return;

    // Close dialog and navigate immediately
    onOpenChange(false);
    navigate({ to: '/' });

    // Session will be updated when WebSocket broadcast arrives from server

    try {
      await pauseSession(sessionId);
      // Success will be handled via WebSocket (session-paused / sessions-sync).
    } catch (err) {
      // If API call fails immediately (network error), mark task as failed
      markAsFailed(sessionId, err instanceof Error ? err.message : 'Failed to pause session');
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
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
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            Cancel
          </AlertDialogCancel>
          <button
            onClick={handlePause}
            className="btn bg-yellow-600 hover:bg-yellow-500 text-white"
          >
            Pause
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
