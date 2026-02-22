import { useState, useEffect, useCallback } from 'react';
import { Link } from '@tanstack/react-router';
import { MemoizedTerminal as Terminal, type ConnectionStatus } from '../Terminal';
import { GitDiffWorkerView } from '../workers/GitDiffWorkerView';
import { SessionSettings } from '../SessionSettings';
import { QuickSessionSettings } from '../QuickSessionSettings';
import { ErrorDialog, useErrorDialog } from '../ui/error-dialog';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { DiffIcon } from '../Icons';
import { getSession, restartAgentWorker, resumeSession, openPath, ServerUnavailableError } from '../../lib/api';
import { formatPath } from '../../lib/path';
import { useAppWsEvent } from '../../hooks/useAppWs';
import { useWorkerRouting } from '../../hooks/useWorkerRouting';
import { useTabManagement } from '../../hooks/useTabManagement';
import { getConnectionStatusColor, getConnectionStatusText } from './sessionStatus';
import type { Session, AgentActivityState, WorkerMessage } from '@agent-console/shared';
import { MessagePanel } from './MessagePanel';

type PageState =
  | { type: 'loading' }
  | { type: 'active'; session: Session }
  | { type: 'disconnected'; session: Session }
  | { type: 'not_found' }
  | { type: 'server_unavailable' }
  | { type: 'restarting' }
  | { type: 'paused'; session: Session };

// Get branch name from session (for worktree sessions)
function getBranchName(session: Session): string {
  return session.type === 'worktree' ? session.worktreeId : '(quick)';
}

// Get repository ID from session (for worktree sessions)
function getRepositoryId(session: Session): string {
  return session.type === 'worktree' ? session.repositoryId : '';
}

// Error fallback UI for worker tabs
interface WorkerErrorFallbackProps {
  error: Error;
  workerType: 'agent' | 'terminal' | 'git-diff';
  workerName: string;
  onRetry: () => void;
}

function WorkerErrorFallback({ error, workerType, workerName, onRetry }: WorkerErrorFallbackProps) {
  const typeLabel = workerType === 'git-diff' ? 'Diff View' :
                    workerType === 'agent' ? 'Agent' :
                    workerType === 'terminal' ? 'Terminal' :
                    (() => { const _exhaustive: never = workerType; return _exhaustive; })();

  return (
    <div className="flex flex-col items-center justify-center h-full p-8 text-center bg-slate-900">
      <div className="text-red-400 text-lg font-medium mb-2">
        {typeLabel} Error: {workerName}
      </div>
      <div className="text-gray-500 text-sm mb-4 max-w-md font-mono bg-slate-800 p-3 rounded overflow-auto max-h-32">
        {error.message}
      </div>
      <button onClick={onRetry} className="btn btn-primary text-sm">
        Retry
      </button>
    </div>
  );
}

export interface SessionPageProps {
  sessionId: string;
  workerId?: string;  // Optional - if not provided, will redirect to default worker
}

export function SessionPage({ sessionId, workerId: urlWorkerId }: SessionPageProps) {
  const [state, setState] = useState<PageState>({ type: 'loading' });
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [exitInfo, setExitInfo] = useState<{ code: number; signal: string | null } | undefined>();
  const [activityState, setActivityState] = useState<AgentActivityState>('unknown');
  // Track all worker activity states for the session (for EndSessionDialog warning)
  const [workerActivityStates, setWorkerActivityStates] = useState<Record<string, AgentActivityState>>({});
  const { errorDialogProps, showError } = useErrorDialog();
  const [lastMessage, setLastMessage] = useState<WorkerMessage | null>(null);
  // State for resuming paused session
  const [isResuming, setIsResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const { navigateToWorker, navigateToSession } = useWorkerRouting(sessionId);

  // Derive branchName and sessionTitle from state
  const branchName = (state.type === 'active' || state.type === 'disconnected' || state.type === 'paused')
    ? getBranchName(state.session) : '';
  const sessionTitle = (state.type === 'active' || state.type === 'disconnected' || state.type === 'paused')
    ? (state.session.title ?? '') : '';

  const activeSession = state.type === 'active' ? state.session : null;

  const {
    tabs,
    activeTabId,
    activeTabIdRef,
    addTerminalTab,
    closeTab,
    handleTabClick,
    updateTabsFromSession,
  } = useTabManagement({
    sessionId,
    activeSession,
    urlWorkerId,
    navigateToWorker,
    navigateToSession,
    showError,
    workerActivityStates,
    setActivityState,
    setExitInfo,
  });

  const handleStatusChange = useCallback((status: ConnectionStatus, info?: { code: number; signal: string | null }) => {
    setConnectionStatus(status);
    setExitInfo(info);
  }, []);

  const handleActivityChange = useCallback((newState: AgentActivityState) => {
    setActivityState(newState);
  }, []);

  // Subscribe to app-websocket for real-time activity state updates
  // This ensures favicon updates even when page is backgrounded and worker WebSocket disconnects
  const handleWorkerActivity = useCallback((eventSessionId: string, workerId: string, newState: AgentActivityState) => {
    // Only process activity events for the current session
    if (eventSessionId !== sessionId) return;

    // Update all worker activity states (for EndSessionDialog warning)
    setWorkerActivityStates(prev => ({ ...prev, [workerId]: newState }));

    // Update active tab's activity state (for status bar display)
    if (workerId === activeTabIdRef.current) {
      setActivityState(newState);
    }
  }, [sessionId]);

  const handleSessionUpdated = useCallback((updatedSession: Session) => {
    if (updatedSession.id === sessionId) {
      updateTabsFromSession(updatedSession.workers);

      setState(prev => {
        if (prev.type === 'active' || prev.type === 'disconnected') {
          return {
            ...prev,
            session: updatedSession,
          };
        }
        return prev;
      });
    }
  }, [sessionId, updateTabsFromSession]);

  // Handle session paused (by another client or via settings menu)
  const handleSessionPaused = useCallback((pausedSessionId: string) => {
    if (pausedSessionId === sessionId) {
      setState(prev => {
        if (prev.type === 'active' || prev.type === 'disconnected') {
          return { type: 'paused', session: prev.session };
        }
        return prev;
      });
    }
  }, [sessionId]);

  useAppWsEvent({
    onWorkerActivity: handleWorkerActivity,
    onWorkerMessage: (message) => {
      if (message.sessionId === sessionId) {
        setLastMessage(message);
      }
    },
    onSessionUpdated: handleSessionUpdated,
    onSessionPaused: handleSessionPaused,
  });

  // Update page title based on state
  useEffect(() => {
    if (state.type !== 'active' && state.type !== 'disconnected') return;

    // Use session title if available, otherwise use branch name
    const displayTitle = sessionTitle || branchName;
    document.title = `${displayTitle} - Agent Console`;

    // Cleanup: restore default title on unmount
    return () => {
      document.title = 'Agent Console';
    };
  }, [state.type, sessionTitle, branchName]);

  // Load session data
  useEffect(() => {
    const checkSession = async () => {
      try {
        const session = await getSession(sessionId);
        if (!session) {
          setState({ type: 'not_found' });
          return;
        }

        if (session.status === 'active') {
          setState({ type: 'active', session });
        } else {
          setState({ type: 'disconnected', session });
        }
      } catch (error) {
        console.error('Failed to check session:', error);
        if (error instanceof ServerUnavailableError) {
          setState({ type: 'server_unavailable' });
        } else {
          setState({ type: 'not_found' });
        }
      }
    };

    checkSession();
  }, [sessionId]);

  const handleRestart = async (continueConversation: boolean) => {
    if (state.type !== 'disconnected') return;

    const session = state.session;

    // Find the first agent worker to restart
    const agentWorker = session.workers.find(w => w.type === 'agent');
    if (!agentWorker) {
      console.error('No agent worker found to restart');
      return;
    }

    setState({ type: 'restarting' });
    try {
      await restartAgentWorker(sessionId, agentWorker.id, continueConversation);
      // Reload session to get updated state
      const updatedSession = await getSession(sessionId);
      if (updatedSession && updatedSession.status === 'active') {
        // Reset tabs to pick up new worker state
        updateTabsFromSession([]);
        setState({ type: 'active', session: updatedSession });
      } else {
        setState({ type: 'disconnected', session });
      }
    } catch (error) {
      console.error('Failed to restart session:', error);
      showError('Restart Failed', error instanceof Error ? error.message : 'Failed to restart session');
      setState({ type: 'disconnected', session });
    }
  };

  // Loading state
  if (state.type === 'loading' || state.type === 'restarting') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-gray-400">
          {state.type === 'loading' ? 'Loading...' : 'Restarting session...'}
        </div>
      </div>
    );
  }

  // Server unavailable state
  if (state.type === 'server_unavailable') {
    const handleRetry = () => {
      setState({ type: 'loading' });
      // Re-trigger the effect by changing state
      window.location.reload();
    };

    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="card text-center max-w-md">
          <h2 className="text-xl font-semibold mb-4">Server Unavailable</h2>
          <p className="text-gray-400 mb-6">
            Cannot connect to the server. Please ensure the server is running.
          </p>
          <div className="flex gap-3 justify-center">
            <button onClick={handleRetry} className="btn btn-primary">
              Retry
            </button>
            <Link to="/" className="btn bg-slate-600 hover:bg-slate-500 no-underline">
              Dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Not found state
  if (state.type === 'not_found') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="card text-center max-w-md">
          <h2 className="text-xl font-semibold mb-4">Session Not Found</h2>
          <p className="text-gray-400 mb-6">
            This session no longer exists or has expired.
          </p>
          <Link to="/" className="btn btn-primary no-underline">
            Go to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  // Paused state - session was paused (by this or another client)
  if (state.type === 'paused') {
    const handleResume = async () => {
      setIsResuming(true);
      setResumeError(null);
      try {
        await resumeSession(sessionId);
        // After resume, reload the page to reconnect
        window.location.reload();
      } catch (error) {
        setResumeError(error instanceof Error ? error.message : 'Failed to resume session');
        setIsResuming(false);
      }
    };

    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="card text-center max-w-md">
          <h2 className="text-xl font-semibold mb-4 text-yellow-400">Session Paused</h2>
          <p className="text-gray-400 mb-2">
            This session has been paused. Session data is preserved.
          </p>
          <p className="text-sm text-gray-500 mb-6 font-mono bg-slate-800 p-2 rounded">
            {formatPath(state.session.locationPath)}
          </p>
          {resumeError && (
            <p className="text-xs text-red-400 bg-red-950/50 p-2 rounded mb-4">
              {resumeError}
            </p>
          )}
          <div className="flex gap-3 justify-center">
            <button
              onClick={handleResume}
              disabled={isResuming}
              className="btn btn-primary"
            >
              {isResuming ? 'Resuming...' : 'Resume Session'}
            </button>
            <Link to="/" className="btn bg-slate-600 hover:bg-slate-500 no-underline">
              Dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Disconnected state - show reconnection UI
  if (state.type === 'disconnected') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="card text-center max-w-lg">
          <h2 className="text-xl font-semibold mb-4">Session Disconnected</h2>
          <p className="text-gray-400 mb-2">
            The session has been disconnected (server may have restarted).
          </p>
          <p className="text-sm text-gray-500 mb-6 font-mono bg-slate-800 p-2 rounded">
            {formatPath(state.session.locationPath)}
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => handleRestart(true)}
              className="btn btn-primary"
            >
              Continue (-c)
            </button>
            <button
              onClick={() => handleRestart(false)}
              className="btn bg-slate-600 hover:bg-slate-500"
            >
              New Session
            </button>
            <Link to="/" className="btn btn-danger no-underline">
              Dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Active state - show terminal with status bar at bottom
  const session = state.session;
  const repositoryId = getRepositoryId(session);

  const activeTab = tabs.find(t => t.id === activeTabId);
  const statusWorkerType = activeTab?.workerType ?? 'agent';
  const statusColor = getConnectionStatusColor(connectionStatus, activityState, statusWorkerType);
  const statusText = getConnectionStatusText(connectionStatus, activityState, exitInfo ?? null, statusWorkerType);

  const tabButtons = tabs.map(tab => (
    <button
      key={tab.id}
      onClick={() => handleTabClick(tab.id)}
      className={`px-4 py-2 text-sm flex items-center gap-2 border-r border-slate-600 hover:bg-slate-700 ${
        tab.id === activeTabId
          ? 'bg-slate-700 text-white'
          : 'text-gray-400'
      }`}
    >
      {tab.workerType === 'git-diff' ? (
        <DiffIcon className="w-3.5 h-3.5 text-violet-400" />
      ) : (
        <span className={`inline-block w-2 h-2 rounded-full ${
          tab.workerType === 'agent' ? 'bg-blue-500' : 'bg-green-500'
        }`} />
      )}
      {tab.name}
      {tab.workerType === 'terminal' && (
        <span
          onClick={(e) => {
            e.stopPropagation();
            closeTab(tab.id);
          }}
          className="ml-1 text-gray-500 hover:text-white cursor-pointer"
        >
          x
        </span>
      )}
    </button>
  ));

  // Render only the active tab (conditional rendering)
  // Using key={activeTab.id} ensures Terminal remounts on tab switch
  const activeTabContent = activeTab ? (
    <div
      key={activeTab.id}
      className="absolute inset-0 flex flex-col"
    >
      <ErrorBoundary
        fallback={(error, resetError) => (
          <WorkerErrorFallback
            error={error}
            workerType={activeTab.workerType}
            workerName={activeTab.name}
            onRetry={resetError}
          />
        )}
      >
        {activeTab.workerType === 'git-diff' ? (
          <GitDiffWorkerView
            sessionId={sessionId}
            workerId={activeTab.id}
          />
        ) : (
          <Terminal
            sessionId={sessionId}
            workerId={activeTab.id}
            onStatusChange={handleStatusChange}
            onActivityChange={activeTab.workerType === 'agent' ? handleActivityChange : undefined}
            hideStatusBar
          />
        )}
      </ErrorBoundary>
    </div>
  ) : null;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Tab bar with worker tabs */}
      <div className="bg-slate-800 border-b border-slate-600 flex items-center shrink-0">
        {/* Worker tabs */}
        {tabButtons}
        <button
          onClick={addTerminalTab}
          className="px-3 py-2 text-gray-400 hover:text-white hover:bg-slate-700"
          title="Add shell tab"
        >
          +
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Settings button */}
        <div className="px-2">
          {session.type === 'worktree' ? (
            <SessionSettings
              sessionId={sessionId}
              repositoryId={repositoryId}
              currentBranch={branchName}
              currentTitle={sessionTitle}
              initialPrompt={session.initialPrompt}
              worktreePath={session.locationPath}
              isMainWorktree={session.isMainWorktree}
              session={session}
              workerActivityStates={workerActivityStates}
              onSessionRestart={() => {
                // Reload page to reconnect WebSocket to restarted session
                window.location.reload();
              }}
            />
          ) : (
            <QuickSessionSettings
              sessionId={sessionId}
              sessionTitle={session.title}
              initialPrompt={session.initialPrompt}
              session={session}
              workerActivityStates={workerActivityStates}
            />
          )}
        </div>
      </div>

      {/* Worker panel - render only active tab (conditional rendering) */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
        {activeTabContent}
      </div>

      {/* Message panel - only shown for agent workers */}
      {activeTab?.workerType === 'agent' && activeTabId && (
        <MessagePanel
          sessionId={sessionId}
          targetWorkerId={activeTabId}
          newMessage={lastMessage}
          onError={showError}
        />
      )}

      {/* Status bar at bottom */}
      <div className="bg-slate-800 border-t border-slate-700 px-3 py-1.5 flex items-center gap-4 shrink-0">
        <span className="text-green-400 font-medium text-sm">{branchName}</span>
        <span
          onClick={() => {
            openPath(session.locationPath);
          }}
          className="text-gray-500 text-xs font-mono truncate flex-1 text-left hover:text-blue-400 hover:underline cursor-pointer select-all"
          title={`Open ${session.locationPath} in Finder`}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              openPath(session.locationPath);
            }
          }}
        >
          {formatPath(session.locationPath)}
        </span>
        {/* Activity state indicator (only for agent tab) */}
        {activeTab?.workerType === 'agent' && activityState !== 'unknown' && (
          <span className={`text-xs px-2 py-0.5 rounded font-medium ${
            activityState === 'asking' ? 'bg-yellow-500/20 text-yellow-400' :
            activityState === 'active' ? 'bg-blue-500/20 text-blue-400' :
            'bg-gray-500/20 text-gray-400'
          }`}>
            {activityState === 'asking' ? 'Waiting for input' :
             activityState === 'active' ? 'Working...' :
             'Idle'}
          </span>
        )}
        <span className="flex items-center gap-2 text-gray-400 text-xs shrink-0">
          {statusText}
          <span className={`inline-block w-2 h-2 rounded-full ${statusColor}`} />
        </span>
      </div>
      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}
