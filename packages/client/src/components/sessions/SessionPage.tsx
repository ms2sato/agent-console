import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { MemoizedTerminal as Terminal, type ConnectionStatus } from '../Terminal';
import { GitDiffWorkerView } from '../workers/GitDiffWorkerView';
import { SessionSettings } from '../SessionSettings';
import { QuickSessionSettings } from '../QuickSessionSettings';
import { ErrorDialog, useErrorDialog } from '../ui/error-dialog';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { DiffIcon, AlertCircleIcon } from '../Icons';
import { getSession, restartAgentWorker, resumeSession, deleteSession, openPath } from '../../lib/api';
import { isSessionOrphanedError } from './resumeErrors';
import { formatPath } from '../../lib/path';
import { useWorkerRouting } from './hooks/useWorkerRouting';
import { useTabManagement } from './hooks/useTabManagement';
import { useSessionPageState, type PageState } from './hooks/useSessionPageState';
import { getConnectionStatusColor, getConnectionStatusText } from './sessionStatus';
import { getNextTabIndex } from './tabKeyboardNavigation';
import { extractRestartableSession, executeWorkerRestart } from './workerRestart';
import type { Session, Worker } from '@agent-console/shared';
import { MessagePanel, type MessagePanelHandle } from './MessagePanel';
import { MemoPanel } from './MemoPanel';
import { useAgents } from '../AgentSelector';
import { logger } from '../../lib/logger';

export { sessionToPageState } from './hooks/useSessionPageState';
export type { PageState } from './hooks/useSessionPageState';

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
  let typeLabel: string;
  switch (workerType) {
    case 'git-diff':
      typeLabel = 'Diff View';
      break;
    case 'agent':
      typeLabel = 'Agent';
      break;
    case 'terminal':
      typeLabel = 'Terminal';
      break;
    default: {
      const _exhaustive: never = workerType;
      typeLabel = _exhaustive;
    }
  }

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
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [exitInfo, setExitInfo] = useState<{ code: number; signal: string | null } | undefined>();
  const { errorDialogProps, showError } = useErrorDialog();
  const { agents } = useAgents();
  const messagePanelRef = useRef<MessagePanelHandle>(null);
  const navigate = useNavigate();
  // State for resuming paused session
  const [isResuming, setIsResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  // State for deleting orphaned session
  const [isDeletingOrphan, setIsDeletingOrphan] = useState(false);
  const [orphanDeleteError, setOrphanDeleteError] = useState<string | null>(null);

  const { navigateToWorker, navigateToSession } = useWorkerRouting(sessionId);

  // Refs to break circular dependency between useSessionPageState and useTabManagement
  const updateTabsFromSessionRef = useRef<(w: Worker[]) => void>(() => {});
  const sessionActiveTabIdRef = useRef<string | null>(null);

  const { state, setState, workerActivityStates, activityState, setActivityState, lastMessage, resumeKey, retryLoadSession } = useSessionPageState({
    sessionId,
    updateTabsFromSessionRef,
    activeTabIdRef: sessionActiveTabIdRef,
  });

  // Derive branchName and sessionTitle from state
  const branchName = (state.type === 'active' || state.type === 'disconnected' || state.type === 'paused' || state.type === 'orphaned')
    ? getBranchName(state.session) : '';
  const sessionTitle = (state.type === 'active' || state.type === 'disconnected' || state.type === 'paused' || state.type === 'orphaned')
    ? (state.session.title ?? '') : '';

  const activeSession = state.type === 'active' ? state.session : null;

  const {
    tabs,
    activeTabId,
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

  // Sync refs that break the circular dependency between useSessionPageState and useTabManagement.
  // These refs are only read inside WS callbacks (after render), so the initial no-op is safe.
  sessionActiveTabIdRef.current = activeTabId;
  updateTabsFromSessionRef.current = updateTabsFromSession;

  const handleStatusChange = useCallback((status: ConnectionStatus, info?: { code: number; signal: string | null }) => {
    setConnectionStatus(status);
    setExitInfo(info);
  }, []);

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

  const handleTabKeyDown = useCallback((e: React.KeyboardEvent) => {
    const currentIndex = activeTabId ? tabs.findIndex(t => t.id === activeTabId) : 0;
    const newIndex = getNextTabIndex(e.key, currentIndex, tabs.length);
    if (newIndex === null) return;

    e.preventDefault();
    const newTabId = tabs[newIndex].id;
    handleTabClick(newTabId);
    document.getElementById(`worker-tab-${newTabId}`)?.focus();
  }, [activeTabId, tabs, handleTabClick]);

  // Resume handler for paused session recovery.
  // Used by the worker error recovery overlay in Terminal when SESSION_PAUSED is received.
  const handleResumeSession = useCallback(async () => {
    if (isResuming) return;
    setIsResuming(true);
    try {
      await resumeSession(sessionId);
      // State transition handled by session-resumed WS event via handleSessionResumed.
      // Terminal remounts via resumeKey change.
    } catch (error) {
      logger.error('Failed to resume session:', error);
      if (isSessionOrphanedError(error)) {
        showError(
          'Cannot Resume',
          'This session is unrecoverable. Please delete it and create a new one.',
        );
      } else {
        showError('Resume Failed', error instanceof Error ? error.message : 'Failed to resume session');
      }
      setIsResuming(false);
    }
  }, [sessionId, isResuming, showError]);

  // Restart handler: works from both active and disconnected states.
  const handleWorkerRestart = useCallback(async (continueConversation: boolean) => {
    const session = extractRestartableSession(state.type, 'session' in state ? state.session : undefined);
    if (!session) return;

    // Capture fallback state before transitioning to 'restarting', so we can
    // restore correctly if the restart is skipped or fails early.
    const fallbackState: PageState = state.type === 'disconnected'
      ? { type: 'disconnected', session }
      : { type: 'active', session };

    setState({ type: 'restarting' });

    const result = await executeWorkerRestart({
      session,
      sessionId,
      continueConversation,
      deps: { restartAgentWorker, getSession },
      updateTabsFromSession,
    });

    switch (result.outcome) {
      case 'skipped':
        setState(fallbackState);
        return;
      case 'no_agent_worker':
        showError(result.errorTitle, result.errorMessage);
        setState(fallbackState);
        return;
      case 'success':
      case 'session_gone':
        setState(result.newState);
        return;
      case 'error':
        logger.error('Failed to restart session:', result.errorMessage);
        showError(result.errorTitle, result.errorMessage);
        setState(result.fallbackState);
        return;
    }
  }, [sessionId, state, updateTabsFromSession, showError]);

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
      retryLoadSession();
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

  // Orphaned state - session data path metadata is invalid; can only be deleted
  if (state.type === 'orphaned') {
    const handleDeleteOrphan = async () => {
      if (isDeletingOrphan) return;
      setIsDeletingOrphan(true);
      setOrphanDeleteError(null);
      try {
        await deleteSession(sessionId);
        // session-deleted WS event will transition state to 'not_found',
        // but navigate away immediately for better UX.
        await navigate({ to: '/' });
      } catch (error) {
        logger.error('Failed to delete orphaned session:', error);
        setOrphanDeleteError(error instanceof Error ? error.message : 'Failed to delete session');
        setIsDeletingOrphan(false);
      }
    };

    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="card text-center max-w-md">
          <h2 className="text-xl font-semibold mb-4 text-red-400 flex items-center justify-center gap-2">
            <AlertCircleIcon className="w-5 h-5" />
            Session Unrecoverable
          </h2>
          <p className="text-gray-400 mb-2">
            This session&apos;s data path metadata is invalid and it cannot be used.
            Please delete it and create a new session.
          </p>
          <p className="text-sm text-gray-500 mb-6 font-mono bg-slate-800 p-2 rounded">
            {formatPath(state.session.locationPath)}
          </p>
          {orphanDeleteError && (
            <p className="text-xs text-red-400 bg-red-950/50 p-2 rounded mb-4">
              {orphanDeleteError}
            </p>
          )}
          <div className="flex gap-3 justify-center">
            <button
              onClick={handleDeleteOrphan}
              disabled={isDeletingOrphan}
              className="btn btn-danger"
            >
              {isDeletingOrphan ? 'Deleting...' : 'Delete Session'}
            </button>
            <Link to="/" className="btn bg-slate-600 hover:bg-slate-500 no-underline">
              Dashboard
            </Link>
          </div>
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
        // State transition handled by session-resumed WS event via handleSessionResumed.
      } catch (error) {
        if (isSessionOrphanedError(error)) {
          setResumeError('This session is unrecoverable. Please delete it and create a new one.');
        } else {
          setResumeError(error instanceof Error ? error.message : 'Failed to resume session');
        }
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
              onClick={() => handleWorkerRestart(true)}
              className="btn btn-primary"
            >
              Continue (-c)
            </button>
            <button
              onClick={() => handleWorkerRestart(false)}
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

  // Determine if active worker's agent has stripScrollbackClear enabled
  const activeWorker = session.workers.find(w => w.id === activeTabId);
  const activeAgentId = activeWorker?.type === 'agent' ? activeWorker.agentId : undefined;
  const activeAgent = activeAgentId ? agents.find(a => a.id === activeAgentId) : undefined;
  const shouldStripScrollback = activeAgent?.stripScrollbackClear ?? false;
  const statusWorkerType = activeTab?.workerType ?? 'agent';
  const statusColor = getConnectionStatusColor(connectionStatus, activityState, statusWorkerType);
  const statusText = getConnectionStatusText(connectionStatus, activityState, exitInfo ?? null, statusWorkerType);

  const tabButtons = tabs.map(tab => (
    <button
      key={tab.id}
      role="tab"
      id={`worker-tab-${tab.id}`}
      aria-selected={tab.id === activeTabId}
      aria-controls={`worker-tabpanel-${tab.id}`}
      tabIndex={tab.id === activeTabId ? 0 : -1}
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
        }`} aria-hidden="true" />
      )}
      {tab.name}
      {tab.workerType === 'terminal' && (
        <button
          type="button"
          aria-label="Close tab"
          onClick={(e) => {
            e.stopPropagation();
            closeTab(tab.id);
          }}
          className="ml-1 text-gray-500 hover:text-white cursor-pointer bg-transparent border-none p-0 text-sm leading-none"
        >
          x
        </button>
      )}
    </button>
  ));

  // Render only the active tab (conditional rendering)
  // Using key={activeTab.id} ensures Terminal remounts on tab switch
  const activeTabContent = activeTab ? (
    <div
      key={`${activeTab.id}-${resumeKey}`}
      role="tabpanel"
      id={`worker-tabpanel-${activeTab.id}`}
      aria-labelledby={`worker-tab-${activeTab.id}`}
      tabIndex={0}
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
            onActivityChange={activeTab.workerType === 'agent' ? setActivityState : undefined}
            onRequestRestart={activeTab.workerType === 'agent' ? handleWorkerRestart : undefined}
            onResumeSession={handleResumeSession}
            onFilesReceived={(files) => messagePanelRef.current?.addFiles(files)}
            hideStatusBar
            stripScrollbackClear={shouldStripScrollback}
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
        <div role="tablist" aria-label="Worker tabs" className="flex items-center overflow-x-auto scrollbar-hide" onKeyDown={handleTabKeyDown}>
          {tabButtons}
        </div>
        <button
          onClick={addTerminalTab}
          className="px-3 py-2 text-gray-400 hover:text-white hover:bg-slate-700"
          title="Add shell tab"
          aria-label="Add shell tab"
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

      {/* Worker panel + Memo sidebar */}
      <div className="flex-1 min-h-0 flex flex-row overflow-hidden">
        {/* Worker content */}
        <div className="flex-1 min-w-0 relative">
          {activeTabContent}
        </div>
        {/* Memo sidebar */}
        <MemoPanel sessionId={sessionId} />
      </div>

      {/* Message panel - only shown for agent workers */}
      {activeTab?.workerType === 'agent' && activeTabId && (
        <MessagePanel
          ref={messagePanelRef}
          sessionId={sessionId}
          targetWorkerId={activeTabId}
          newMessage={lastMessage}
          onError={showError}
        />
      )}

      {/* Status bar at bottom */}
      <div className="bg-slate-800 border-t border-slate-700 px-3 py-1.5 flex flex-wrap items-center gap-2 md:gap-4 shrink-0">
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
          <span className={`inline-block w-2 h-2 rounded-full ${statusColor}`} aria-hidden="true" />
        </span>
      </div>
      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}
