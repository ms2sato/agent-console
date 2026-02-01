import { useState, useEffect, useCallback, useRef, startTransition } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { MemoizedTerminal as Terminal, type ConnectionStatus } from '../Terminal';
import { GitDiffWorkerView } from '../workers/GitDiffWorkerView';
import { SessionSettings } from '../SessionSettings';
import { QuickSessionSettings } from '../QuickSessionSettings';
import { ErrorDialog, useErrorDialog } from '../ui/error-dialog';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { DiffIcon } from '../Icons';
import { getSession, createWorker, deleteWorker, restartAgentWorker, openPath, ServerUnavailableError } from '../../lib/api';
import { formatPath } from '../../lib/path';
import { useAppWsEvent } from '../../hooks/useAppWs';
import { sendInput } from '../../lib/worker-websocket';
import { getConnectionStatusColor, getConnectionStatusText } from './sessionStatus';
import { getDefaultTabId, isWorkerIdReady } from './sessionTabRouting';
import type { Session, Worker, AgentWorker, AgentActivityState, WorkerMessage } from '@agent-console/shared';
import { MessagePanel } from './MessagePanel';
import { useAgents } from '../AgentSelector';

type PageState =
  | { type: 'loading' }
  | { type: 'active'; session: Session }
  | { type: 'disconnected'; session: Session }
  | { type: 'not_found' }
  | { type: 'server_unavailable' }
  | { type: 'restarting' };

// Tab representation - links to workers
interface Tab {
  id: string;           // Worker ID
  workerType: 'agent' | 'terminal' | 'git-diff';
  name: string;
}

// Get branch name from session (for worktree sessions)
function getBranchName(session: Session): string {
  return session.type === 'worktree' ? session.worktreeId : '(quick)';
}

// Get repository ID from session (for worktree sessions)
function getRepositoryId(session: Session): string {
  return session.type === 'worktree' ? session.repositoryId : '';
}

// Convert workers to tabs
function workersToTabs(workers: Worker[]): Tab[] {
  return workers.map(worker => ({
    id: worker.id,
    workerType: worker.type,
    name: worker.name,
  }));
}

// Find the first agent worker in the list
function findFirstAgentWorker(workers: Worker[]): AgentWorker | undefined {
  return workers.find((w): w is AgentWorker => w.type === 'agent');
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
    case 'git-diff': typeLabel = 'Diff View'; break;
    case 'agent': typeLabel = 'Agent'; break;
    case 'terminal': typeLabel = 'Terminal'; break;
    default: { const _exhaustive: never = workerType; typeLabel = _exhaustive; }
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
  const navigate = useNavigate();
  const [state, setState] = useState<PageState>({ type: 'loading' });
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [exitInfo, setExitInfo] = useState<{ code: number; signal: string | null } | undefined>();
  const [activityState, setActivityState] = useState<AgentActivityState>('unknown');
  // Track all worker activity states for the session (for EndSessionDialog warning)
  const [workerActivityStates, setWorkerActivityStates] = useState<Record<string, AgentActivityState>>({});
  const { errorDialogProps, showError } = useErrorDialog();
  const [lastMessage, setLastMessage] = useState<WorkerMessage | null>(null);

  // Tab management
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const pendingWorkerIdRef = useRef<string | null>(null);

  // Agent-add dropdown state
  const [showAddMenu, setShowAddMenu] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const { agents } = useAgents();

  // Navigate to specific worker
  const navigateToWorker = useCallback((newWorkerId: string, replace: boolean = false) => {
    navigate({
      to: '/sessions/$sessionId/$workerId',
      params: { sessionId, workerId: newWorkerId },
      replace,
    });
  }, [navigate, sessionId]);

  // Navigate to session base (will redirect to default worker)
  const navigateToSession = useCallback(() => {
    navigate({
      to: '/sessions/$sessionId',
      params: { sessionId },
      replace: true,
    });
  }, [navigate, sessionId]);

  // Local branch name state (can be updated by settings dialog)
  const [branchName, setBranchName] = useState<string>('');
  // Local session title state (can be updated by settings dialog)
  const [sessionTitle, setSessionTitle] = useState<string>('');

  // Sync branch name and title when state changes
  useEffect(() => {
    if (state.type === 'active' || state.type === 'disconnected') {
      setBranchName(getBranchName(state.session));
      setSessionTitle(state.session.title ?? '');
    }
  }, [state]);

  const handleStatusChange = useCallback((status: ConnectionStatus, info?: { code: number; signal: string | null }) => {
    setConnectionStatus(status);
    setExitInfo(info);
  }, []);

  // Track active tab for app-websocket activity filtering
  const activeTabIdRef = useRef<string | null>(null);
  activeTabIdRef.current = activeTabId;

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
      const newTabs = workersToTabs(updatedSession.workers);
      setTabs(newTabs);

      if (state.type === 'active' || state.type === 'disconnected') {
        setState({
          ...state,
          session: updatedSession,
        });
      }
    }
  }, [sessionId, state]);

  useAppWsEvent({
    onWorkerActivity: handleWorkerActivity,
    onWorkerMessage: (message) => {
      if (message.sessionId === sessionId) {
        setLastMessage(message);
      }
    },
    onSessionUpdated: handleSessionUpdated,
  });

  // Update page title and favicon based on state
  useEffect(() => {
    if (state.type !== 'active' && state.type !== 'disconnected') return;

    // Use session title if available, otherwise use branch name
    const displayTitle = sessionTitle || branchName;
    document.title = `${displayTitle} - Agent Console`;

    // Cleanup: restore default title on unmount
    return () => {
      document.title = 'Agent Console';
    };
  }, [state, sessionTitle, branchName]);

  // Reset state and tabs when sessionId changes (navigating to different session)
  useEffect(() => {
    setState({ type: 'loading' });
    setTabs([]);
    setActiveTabId(null);
    pendingWorkerIdRef.current = null;
    setLastMessage(null);
  }, [sessionId]);

  // Initialize tabs when state becomes active
  useEffect(() => {
    if (state.type === 'active' && tabs.length === 0) {
      const workers = state.session.workers;
      const newTabs = workersToTabs(workers);
      setTabs(newTabs);

      // Determine initial active tab:
      // 1. If urlWorkerId is valid (exists in workers), use it
      // 2. Otherwise, redirect to default (first agent or first tab)
      const urlWorkerExists = urlWorkerId && workers.some(w => w.id === urlWorkerId);

      if (urlWorkerExists) {
        setActiveTabId(urlWorkerId);
      } else {
        // Calculate default tab
        const defaultTabId = findFirstAgentWorker(workers)?.id ?? newTabs[0]?.id ?? null;
        setActiveTabId(defaultTabId);

        // Redirect to the default worker URL
        if (defaultTabId) {
          navigateToWorker(defaultTabId, true);
        }
      }
    }
  }, [state, tabs.length, sessionId, urlWorkerId, navigateToWorker]);

  // Handle URL workerId changes (user navigates directly to URL or uses back/forward)
  useEffect(() => {
    // Only handle when tabs are already initialized
    if (tabs.length === 0 || state.type !== 'active') return;

    const defaultTabId = getDefaultTabId(tabs);

    if (urlWorkerId) {
      // Check if the URL workerId is valid
      if (isWorkerIdReady(urlWorkerId, tabs, pendingWorkerIdRef.current)) {
        // Valid workerId - sync activeTabId
        if (activeTabId !== urlWorkerId) {
          setActiveTabId(urlWorkerId);
        }
        if (pendingWorkerIdRef.current === urlWorkerId) {
          pendingWorkerIdRef.current = null;
        }
      } else {
        // Invalid workerId - redirect to session base
        navigateToSession();
      }
    } else {
      // No workerId in URL - redirect to default worker
      if (defaultTabId) {
        navigateToWorker(defaultTabId, true);
      }
    }
  }, [urlWorkerId, tabs, state, activeTabId, navigateToSession, navigateToWorker]);

  // Add a new terminal (shell) tab
  const addTerminalTab = useCallback(async () => {
    if (state.type !== 'active') return;

    try {
      const { worker } = await createWorker(sessionId, {
        type: 'terminal',
        name: `Shell ${tabs.filter(t => t.workerType === 'terminal').length + 1}`,
      });

      const newTab: Tab = {
        id: worker.id,
        workerType: 'terminal',
        name: worker.name,
      };
      pendingWorkerIdRef.current = worker.id;
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(worker.id);
      navigateToWorker(worker.id);

      // Update session.workers after successful creation
      if (state.type === 'active') {
        setState({
          ...state,
          session: {
            ...state.session,
            workers: [...state.session.workers, worker],
          },
        });
      }
    } catch (error) {
      console.error('Failed to create terminal worker:', error);
      showError('Failed to Create Worker', error instanceof Error ? error.message : 'Unknown error');
    }
  }, [state, sessionId, tabs, navigateToWorker, showError]);

  // Add a new agent tab
  const addAgentTab = useCallback(async (agentId: string, agentName: string) => {
    if (state.type !== 'active') return;

    try {
      const { worker } = await createWorker(sessionId, {
        type: 'agent',
        agentId,
        name: `${agentName} ${tabs.filter(t => t.workerType === 'agent').length + 1}`,
      });

      const newTab: Tab = {
        id: worker.id,
        workerType: 'agent',
        name: worker.name,
      };
      pendingWorkerIdRef.current = worker.id;
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(worker.id);
      navigateToWorker(worker.id);

      // Update session.workers after successful creation
      if (state.type === 'active') {
        setState({
          ...state,
          session: {
            ...state.session,
            workers: [...state.session.workers, worker],
          },
        });
      }
    } catch (error) {
      console.error('Failed to create agent worker:', error);
      showError('Failed to Create Worker', error instanceof Error ? error.message : 'Unknown error');
    }
  }, [state, sessionId, tabs, navigateToWorker, showError]);

  // Close a tab (delete worker)
  const closeTab = useCallback(async (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    // Don't allow closing agent or git-diff workers (fixed tabs)
    // Only terminal workers can be closed
    if (tab.workerType === 'agent' || tab.workerType === 'git-diff') return;

    try {
      await deleteWorker(sessionId, tabId);

      // Calculate new tabs and new active tab
      const newTabs = tabs.filter(t => t.id !== tabId);
      let newActiveTabId = activeTabId;

      // If closing the active tab, switch to first agent or first remaining tab
      if (activeTabId === tabId) {
        const firstAgent = newTabs.find(t => t.workerType === 'agent');
        newActiveTabId = firstAgent?.id ?? newTabs[0]?.id ?? null;
      }

      setTabs(newTabs);
      if (activeTabId === tabId && newActiveTabId) {
        setActiveTabId(newActiveTabId);
        navigateToWorker(newActiveTabId);
      }

      // Update session.workers after successful deletion
      if (state.type === 'active') {
        setState({
          ...state,
          session: {
            ...state.session,
            workers: state.session.workers.filter(w => w.id !== tabId),
          },
        });
      }
    } catch (error) {
      console.error('Failed to delete worker:', error);
    }
  }, [sessionId, tabs, activeTabId, navigateToWorker, state]);

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
    const agentWorker = findFirstAgentWorker(session.workers);
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
        setTabs([]);
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

  const injectMessagePrompt = useCallback(() => {
    const currentTab = tabs.find(t => t.id === activeTabId);
    if (!currentTab || currentTab.workerType !== 'agent') return;
    if (state.type !== 'active' && state.type !== 'disconnected') return;

    const otherWorkers = state.session.workers
      .filter(w => w.id !== currentTab.id && w.type !== 'git-diff');

    if (otherWorkers.length === 0) return;

    const baseUrl = window.location.origin;
    const workerList = otherWorkers
      .map(w => `  - "${w.name}" (id: ${w.id})`)
      .join('\n');

    const prompt = `You can communicate with other workers in this session using the following REST API:

**Send a message to another worker:**
\`\`\`
curl -X POST ${baseUrl}/api/sessions/${sessionId}/messages \\
  -H 'Content-Type: application/json' \\
  -d '{"toWorkerId":"<WORKER_ID>","content":"<YOUR_MESSAGE>","fromWorkerId":"${currentTab.id}"}'
\`\`\`

**List all workers in this session (to get updated worker IDs):**
\`\`\`
curl ${baseUrl}/api/sessions/${sessionId}/workers
\`\`\`

Currently available workers in this session:
${workerList}

Messages you send will be injected into the target worker's terminal as: [From ${currentTab.name}]: <your message>
`;

    sendInput(sessionId, currentTab.id, prompt);
  }, [tabs, activeTabId, state, sessionId]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(event.target as Node)) {
        setShowAddMenu(false);
      }
    };

    if (showAddMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showAddMenu]);

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

  const handleTabClick = (tabId: string) => {
    // Use startTransition to mark this update as non-urgent
    // This keeps the UI responsive during the state update
    startTransition(() => {
      setActiveTabId(tabId);
      navigateToWorker(tabId);
    });
  };

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
            onActivityChange={activeTab.workerType === 'agent' ? setActivityState : undefined}
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
        {/* Add worker dropdown */}
        <div className="relative" ref={addMenuRef}>
          <button
            onClick={() => setShowAddMenu(!showAddMenu)}
            className="px-3 py-2 text-gray-400 hover:text-white hover:bg-slate-700"
            title="Add worker"
          >
            +
          </button>
          {showAddMenu && (
            <div className="absolute top-full left-0 mt-1 bg-slate-700 border border-slate-600 rounded shadow-lg z-50 min-w-[150px]">
              <button
                onClick={async () => {
                  setShowAddMenu(false);
                  await addTerminalTab();
                }}
                className="w-full text-left px-4 py-2 text-sm text-white hover:bg-slate-600"
              >
                Shell
              </button>
              {agents.map(agent => (
                <button
                  key={agent.id}
                  onClick={async () => {
                    setShowAddMenu(false);
                    await addAgentTab(agent.id, agent.name);
                  }}
                  className="w-full text-left px-4 py-2 text-sm text-white hover:bg-slate-600"
                >
                  Agent: {agent.name}
                </button>
              ))}
            </div>
          )}
        </div>

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
              onBranchChange={setBranchName}
              onTitleChange={setSessionTitle}
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

      {/* Message panel */}
      <MessagePanel
        sessionId={sessionId}
        workers={session.workers}
        activeWorkerId={activeTabId}
        newMessage={lastMessage}
      />

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
        {/* Inject message communication prompt button (only for agent tab with other workers) */}
        {activeTab?.workerType === 'agent' && session.workers.filter(w => w.id !== activeTab.id && w.type !== 'git-diff').length > 0 && (
          <button
            onClick={injectMessagePrompt}
            className="text-xs px-2 py-0.5 rounded font-medium bg-indigo-500/20 text-indigo-400 hover:bg-indigo-500/30 transition-colors"
            title="Inject inter-worker message API instructions into this agent"
          >
            Msg Prompt
          </button>
        )}
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
