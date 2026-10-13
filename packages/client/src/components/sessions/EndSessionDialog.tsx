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
import { deleteSession } from '../../lib/api';
import { useSessionStopTasksContext } from '../../contexts/root-contexts';
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
 * Runs the stop request for a session and records a failure on the task.
 * Shared by the confirm dialog and the SessionPage Retry button so both go
 * through one code path. Resolves `true` when the request was accepted by the
 * server and `false` when it failed (the task is then marked failed).
 */
export async function runStopSession(
  sessionId: string,
  markAsFailed: (sessionId: string, error: string) => void
): Promise<boolean> {
  try {
    await deleteSession(sessionId);
    return true;
  } catch (err) {
    markAsFailed(sessionId, err instanceof Error ? err.message : 'Failed to stop session');
    return false;
  }
}

/**
 * Dialog for ending (stopping/deleting) a quick session.
 *
 * The pending/error state lives in `SessionStopTasksContext` (scoped to the
 * affected session -- dashboard row + session page banner) instead of this
 * modal, so stopping a session no longer freezes the whole app for the
 * server round-trip. See DeleteWorktreeDialog for the sibling pattern.
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
  const { addTask, markAsFailed } = useSessionStopTasksContext();

  // Check if any agent or embedded-agent workers are in 'active' or 'asking' state
  // (embedded-agent workers only ever report 'active'/'idle', never 'asking')
  const hasActiveWorkers = session && workerActivityStates && session.workers.some(
    w => (w.type === 'agent' || w.type === 'embedded-agent') &&
      (workerActivityStates[w.id] === 'active' || workerActivityStates[w.id] === 'asking')
  );

  const handleStop = async () => {
    const added = addTask({ sessionId, action: 'stop', sessionTitle });
    if (!added) return;

    // Close the dialog but stay on the session page: the in-flight and
    // failure banners live there. Navigate only once the server accepted the
    // request.
    onOpenChange(false);

    // Completion (success state) is resolved via WebSocket (session-paused / sessions-sync
    // / session-deleted) in useSessionSideEffects.
    const ok = await runStopSession(sessionId, markAsFailed);
    if (ok) {
      await navigate({ to: '/' });
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-red-400">Stop Session</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Are you sure you want to stop{' '}
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
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            Cancel
          </AlertDialogCancel>
          <button
            onClick={handleStop}
            className="btn btn-danger"
          >
            Stop Session
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
