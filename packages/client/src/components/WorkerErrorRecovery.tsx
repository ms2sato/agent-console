import type { WorkerErrorCode } from '@agent-console/shared';
import { AlertCircleIcon, RefreshIcon, TrashIcon } from './Icons';

export interface WorkerErrorRecoveryProps {
  errorCode?: WorkerErrorCode;
  errorMessage: string;
  onRetry?: () => void;
  onDeleteSession?: () => void;
  onGoToDashboard?: () => void;
  onRestart?: (continueConversation: boolean) => void;
}

interface ErrorDetails {
  title: string;
  description: string;
  primaryAction: 'retry' | 'delete-session' | 'go-dashboard' | 'restart';
}

function getErrorDetails(errorCode?: WorkerErrorCode): ErrorDetails {
  switch (errorCode) {
    case 'PATH_NOT_FOUND':
      return {
        title: 'Directory Not Found',
        description: 'The session directory no longer exists.',
        primaryAction: 'delete-session',
      };
    case 'AGENT_NOT_FOUND':
      return {
        title: 'Agent Not Available',
        description: 'The agent is no longer available.',
        primaryAction: 'delete-session',
      };
    case 'ACTIVATION_FAILED':
      return {
        title: 'Failed to Start Worker',
        description: 'Try reconnecting.',
        primaryAction: 'retry',
      };
    case 'WORKER_NOT_FOUND':
      return {
        title: 'Worker Not Found',
        description: 'The worker no longer exists in this session. Restart to recover.',
        primaryAction: 'restart',
      };
    case 'HISTORY_LOAD_FAILED':
      return {
        title: 'History Load Failed',
        description: 'Failed to retrieve terminal history.',
        primaryAction: 'retry',
      };
    case 'SESSION_DELETED':
      return {
        title: 'Session Deleted',
        description: 'This session has been deleted.',
        primaryAction: 'go-dashboard',
      };
    default:
      return {
        title: 'Worker Error',
        description: 'An error occurred.',
        primaryAction: 'retry',
      };
  }
}

function renderActions(
  primaryAction: ErrorDetails['primaryAction'],
  { onRetry, onDeleteSession, onGoToDashboard, onRestart }: Pick<WorkerErrorRecoveryProps, 'onRetry' | 'onDeleteSession' | 'onGoToDashboard' | 'onRestart'>,
) {
  switch (primaryAction) {
    case 'retry':
      return (
        <>
          <button
            onClick={onRetry}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors"
          >
            <RefreshIcon className="w-4 h-4" />
            Reconnect
          </button>
          {onDeleteSession && (
            <button
              onClick={onDeleteSession}
              className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-gray-300 rounded-md transition-colors"
            >
              <TrashIcon className="w-4 h-4" />
              Delete Session
            </button>
          )}
        </>
      );
    case 'delete-session':
      return (
        <>
          <button
            onClick={onDeleteSession}
            className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-md transition-colors"
          >
            <TrashIcon className="w-4 h-4" />
            Delete Session
          </button>
          {onRetry && (
            <button
              onClick={onRetry}
              className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-gray-300 rounded-md transition-colors"
            >
              <RefreshIcon className="w-4 h-4" />
              Reconnect
            </button>
          )}
        </>
      );
    case 'go-dashboard':
      return (
        <button
          onClick={() => onGoToDashboard?.()}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors"
        >
          Go to Dashboard
        </button>
      );
    case 'restart':
      if (!onRestart) {
        // Fallback: restart handler not available, show navigation/reconnect options
        return (
          <>
            {onGoToDashboard && (
              <button
                onClick={() => onGoToDashboard()}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors"
              >
                Dashboard
              </button>
            )}
            {onRetry && (
              <button
                onClick={onRetry}
                className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-gray-300 rounded-md transition-colors"
              >
                <RefreshIcon className="w-4 h-4" />
                Reconnect
              </button>
            )}
          </>
        );
      }
      return (
        <>
          <button
            onClick={() => onRestart(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors"
          >
            Continue (-c)
          </button>
          <button
            onClick={() => onRestart(false)}
            className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-gray-300 rounded-md transition-colors"
          >
            New Session
          </button>
          <button
            onClick={() => onGoToDashboard?.()}
            className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-gray-300 rounded-md transition-colors"
          >
            Dashboard
          </button>
        </>
      );
  }
}

export function WorkerErrorRecovery({
  errorCode,
  errorMessage,
  onRetry,
  onDeleteSession,
  onGoToDashboard,
  onRestart,
}: WorkerErrorRecoveryProps) {
  const { title, description, primaryAction } = getErrorDetails(errorCode);

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-slate-800/95 z-10">
      <div className="bg-slate-900 border border-red-700 rounded-lg p-8 max-w-md text-center shadow-xl">
        <div className="flex justify-center mb-4">
          <AlertCircleIcon className="w-12 h-12 text-red-400" />
        </div>
        <h2 className="text-red-400 text-xl font-semibold mb-2">{title}</h2>
        <p className="text-gray-300 mb-2">{description}</p>
        <p className="text-gray-500 text-sm mb-6">{errorMessage}</p>
        <div className="flex justify-center gap-3">
          {renderActions(primaryAction, { onRetry, onDeleteSession, onGoToDashboard, onRestart })}
        </div>
      </div>
    </div>
  );
}
