import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect, useCallback, useRef } from 'react';
import { Terminal, type ConnectionStatus } from '../../components/Terminal';
import { GitDiffWorkerView } from '../../components/workers/GitDiffWorkerView';
import { SessionSettings } from '../../components/SessionSettings';
import { ErrorDialog, useErrorDialog } from '../../components/ui/error-dialog';
import { ErrorBoundary } from '../../components/ui/ErrorBoundary';
import { DiffIcon } from '../../components/Icons';
import { getSession, createWorker, deleteWorker, restartAgentWorker, openPath, ServerUnavailableError } from '../../lib/api';
import { formatPath } from '../../lib/path';
import type { Session, Worker, AgentWorker, AgentActivityState } from '@agent-console/shared';

export const Route = createFileRoute('/sessions/$sessionId')({
  component: TerminalPage,
});

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

// Pre-generate favicon frames for animation to avoid expensive canvas.toDataURL() calls
// Cache structure: { state: { frameIndex: dataUrl } }
const faviconCache = new Map<string, string>();

function getFaviconCacheKey(state: AgentActivityState, frameIndex: number): string {
  return `${state}:${frameIndex}`;
}

// Generate favicon based on activity state
function generateFavicon(state: AgentActivityState, bounce: number = 0): string {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  // Color based on state
  const color = state === 'active' ? '#3b82f6' :  // blue
                state === 'asking' ? '#eab308' :   // yellow
                '#6b7280';                         // gray (idle/unknown)

  // Bounce effect: move circle up and down (y: 22 to 10)
  const y = state === 'active' ? 22 - (12 * bounce) : 16;

  // Draw circle
  ctx.beginPath();
  ctx.arc(16, y, 10, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  return canvas.toDataURL('image/png');
}

// Pre-generate animation frames for 'active' state (reduces CPU load during animation)
// 16 frames = 1 full cycle, cached to avoid repeated canvas.toDataURL() calls
const ANIMATION_FRAMES = 16;
const ANIMATION_INTERVAL_MS = 100; // 10fps instead of 25fps

function getOrGenerateFavicon(state: AgentActivityState, frameIndex: number = 0): string {
  const cacheKey = getFaviconCacheKey(state, frameIndex);
  const cached = faviconCache.get(cacheKey);
  if (cached) return cached;

  // Calculate bounce for this frame
  const bounce = state === 'active'
    ? Math.abs(Math.sin((frameIndex / ANIMATION_FRAMES) * Math.PI))
    : 0;

  const dataUrl = generateFavicon(state, bounce);
  faviconCache.set(cacheKey, dataUrl);
  return dataUrl;
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
  const typeLabel = workerType === 'git-diff' ? 'Diff View' :
                    workerType === 'agent' ? 'Agent' : 'Terminal';

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

function TerminalPage() {
  const { sessionId } = Route.useParams();
  const [state, setState] = useState<PageState>({ type: 'loading' });
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [exitInfo, setExitInfo] = useState<{ code: number; signal: string | null } | undefined>();
  const [activityState, setActivityState] = useState<AgentActivityState>('unknown');
  const { errorDialogProps, showError } = useErrorDialog();

  // Tab management
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

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

  const handleActivityChange = useCallback((newState: AgentActivityState) => {
    setActivityState(newState);
  }, []);

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

  // Track animation frame for favicon
  const faviconFrameRef = useRef(0);

  // Update favicon based on activity state (with animation for active)
  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }

    // Animate favicon when active (using cached frames at reduced frame rate)
    if (activityState === 'active') {
      faviconFrameRef.current = 0;
      const interval = setInterval(() => {
        const frameIndex = faviconFrameRef.current % ANIMATION_FRAMES;
        const faviconUrl = getOrGenerateFavicon(activityState, frameIndex);
        if (faviconUrl && link) {
          link.href = faviconUrl;
        }
        faviconFrameRef.current++;
      }, ANIMATION_INTERVAL_MS);

      return () => {
        clearInterval(interval);
        if (link) {
          link.href = '/favicon.ico';
        }
      };
    }

    // Static favicon for non-active states (cached)
    const faviconUrl = getOrGenerateFavicon(activityState, 0);
    if (faviconUrl) {
      link.href = faviconUrl;
    }

    return () => {
      if (link) {
        link.href = '/favicon.ico';
      }
    };
  }, [activityState]);

  // Initialize tabs when state becomes active
  useEffect(() => {
    if (state.type === 'active' && tabs.length === 0) {
      const workers = state.session.workers;
      const newTabs = workersToTabs(workers);
      setTabs(newTabs);
      // Set active tab to first agent worker if exists, otherwise first tab
      const firstAgent = findFirstAgentWorker(workers);
      setActiveTabId(firstAgent?.id ?? newTabs[0]?.id ?? null);
    }
  }, [state, tabs.length, sessionId]);

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
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(worker.id);
    } catch (error) {
      console.error('Failed to create terminal worker:', error);
    }
  }, [state, sessionId, tabs]);

  // Close a tab (delete worker)
  const closeTab = useCallback(async (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    // Don't allow closing agent or git-diff workers (fixed tabs)
    // Only terminal workers can be closed
    if (tab.workerType === 'agent' || tab.workerType === 'git-diff') return;

    try {
      await deleteWorker(sessionId, tabId);
      setTabs(prev => {
        const newTabs = prev.filter(t => t.id !== tabId);
        // If closing the active tab, switch to first agent or first remaining tab
        if (activeTabId === tabId) {
          const firstAgent = newTabs.find(t => t.workerType === 'agent');
          setActiveTabId(firstAgent?.id ?? newTabs[0]?.id ?? null);
        }
        return newTabs;
      });
    } catch (error) {
      console.error('Failed to delete worker:', error);
    }
  }, [sessionId, tabs, activeTabId]);

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

  const statusColor =
    connectionStatus === 'connected' && activityState !== 'unknown' ? 'bg-green-500' :
    connectionStatus === 'connected' || connectionStatus === 'connecting' ? 'bg-yellow-500' :
    connectionStatus === 'exited' ? 'bg-red-500' : 'bg-gray-500';

  const statusText =
    connectionStatus === 'connecting' ? 'Connecting...' :
    connectionStatus === 'connected' && activityState === 'unknown' ? 'Starting Claude...' :
    connectionStatus === 'connected' ? 'Connected' :
    connectionStatus === 'disconnected' ? 'Disconnected' :
    `Exited (code: ${exitInfo?.code}${exitInfo?.signal ? `, signal: ${exitInfo.signal}` : ''})`;

  const activeTab = tabs.find(t => t.id === activeTabId);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Header with tabs */}
      <div className="bg-slate-900 border-b border-slate-700 flex items-center shrink-0">
        {/* Title/Home link */}
        <Link
          to="/"
          className="px-4 py-2 text-white font-bold text-sm hover:bg-slate-800 no-underline border-r border-slate-700"
        >
          Agent Console
        </Link>
        {/* Session title (if set) */}
        {sessionTitle && (
          <div className="px-4 py-2 text-gray-300 text-sm border-r border-slate-700 truncate max-w-xs" title={sessionTitle}>
            {sessionTitle}
          </div>
        )}
        {/* Tabs */}
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTabId(tab.id)}
            className={`px-4 py-2 text-sm flex items-center gap-2 border-r border-slate-700 hover:bg-slate-800 ${
              tab.id === activeTabId
                ? 'bg-slate-800 text-white'
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
        ))}
        <button
          onClick={addTerminalTab}
          className="px-3 py-2 text-gray-400 hover:text-white hover:bg-slate-800"
          title="Add shell tab"
        >
          +
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Settings button (only for worktree sessions) */}
        {session.type === 'worktree' && (
          <div className="px-2">
            <SessionSettings
              sessionId={sessionId}
              repositoryId={repositoryId}
              currentBranch={branchName}
              currentTitle={sessionTitle}
              worktreePath={session.locationPath}
              onBranchChange={setBranchName}
              onTitleChange={setSessionTitle}
              onSessionRestart={() => {
                // Reload page to reconnect WebSocket to restarted session
                window.location.reload();
              }}
            />
          </div>
        )}
      </div>

      {/* Worker panels - render all but only show active */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={`absolute inset-0 flex flex-col ${
              tab.id === activeTabId ? 'z-10' : 'z-0 invisible'
            }`}
          >
            <ErrorBoundary
              fallback={(error, resetError) => (
                <WorkerErrorFallback
                  error={error}
                  workerType={tab.workerType}
                  workerName={tab.name}
                  onRetry={resetError}
                />
              )}
            >
              {tab.workerType === 'git-diff' ? (
                <GitDiffWorkerView
                  sessionId={sessionId}
                  workerId={tab.id}
                />
              ) : (
                <Terminal
                  sessionId={sessionId}
                  workerId={tab.id}
                  onStatusChange={tab.id === activeTabId ? handleStatusChange : undefined}
                  onActivityChange={tab.workerType === 'agent' ? handleActivityChange : undefined}
                  hideStatusBar
                />
              )}
            </ErrorBoundary>
          </div>
        ))}
      </div>

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
