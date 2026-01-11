import { Link } from '@tanstack/react-router';
import type { WorkerErrorCode } from '@agent-console/shared';
import { AlertCircleIcon, RefreshIcon, TrashIcon } from './Icons';

interface WorkerErrorRecoveryProps {
  errorCode?: WorkerErrorCode;
  errorMessage: string;
  onRetry?: () => void;
  onDeleteSession?: () => void;
}

/**
 * Get error details based on error code.
 */
function getErrorDetails(errorCode?: WorkerErrorCode): {
  title: string;
  description: string;
  primaryAction: 'retry' | 'delete-session';
} {
  switch (errorCode) {
    case 'PATH_NOT_FOUND':
      return {
        title: 'Directory Not Found',
        description: 'The session directory no longer exists. You can delete this session to clean up.',
        primaryAction: 'delete-session',
      };
    case 'AGENT_NOT_FOUND':
      return {
        title: 'Agent Not Available',
        description: 'The agent for this worker is no longer available. You may need to delete this session.',
        primaryAction: 'delete-session',
      };
    case 'ACTIVATION_FAILED':
      return {
        title: 'Failed to Start Worker',
        description: 'The worker process could not be started. Try reconnecting.',
        primaryAction: 'retry',
      };
    case 'WORKER_NOT_FOUND':
      return {
        title: 'Worker Not Found',
        description: 'This worker no longer exists in the session.',
        primaryAction: 'delete-session',
      };
    case 'HISTORY_LOAD_FAILED':
      return {
        title: 'History Load Failed',
        description: 'Failed to load terminal history. Try reconnecting.',
        primaryAction: 'retry',
      };
    default:
      return {
        title: 'Worker Error',
        description: 'An error occurred with this worker.',
        primaryAction: 'retry',
      };
  }
}

export function WorkerErrorRecovery({
  errorCode,
  errorMessage,
  onRetry,
  onDeleteSession,
}: WorkerErrorRecoveryProps) {
  const { title, description, primaryAction } = getErrorDetails(errorCode);
  const showDeleteAsPrimary = primaryAction === 'delete-session';

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-slate-900/95 z-10">
      <div className="bg-red-950/80 border border-red-800 rounded-lg p-6 max-w-md text-center shadow-lg">
        <AlertCircleIcon className="w-12 h-12 text-red-400 mx-auto mb-4" />
        <h3 className="text-red-300 text-lg font-medium mb-2">{title}</h3>
        <p className="text-gray-300 text-sm mb-2">{description}</p>
        <p className="text-gray-500 text-xs mb-6 font-mono">{errorMessage}</p>

        <div className="flex flex-col gap-2">
          {/* Primary action: Delete Session (for path/agent issues) */}
          {showDeleteAsPrimary && onDeleteSession && (
            <button onClick={onDeleteSession} className="btn btn-danger text-sm flex items-center justify-center gap-2">
              <TrashIcon className="w-4 h-4" />
              Delete Session
            </button>
          )}

          {/* Retry button: primary styling when retry is primary action, secondary otherwise */}
          {onRetry && (
            <button
              onClick={onRetry}
              className={`btn text-sm flex items-center justify-center gap-2 ${
                showDeleteAsPrimary ? 'bg-slate-700 hover:bg-slate-600' : 'btn-primary'
              }`}
            >
              <RefreshIcon className="w-4 h-4" />
              Retry Connection
            </button>
          )}

          {/* Always show link to dashboard */}
          <Link
            to="/"
            className="btn bg-slate-700 hover:bg-slate-600 text-sm no-underline text-center"
          >
            Go to Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
