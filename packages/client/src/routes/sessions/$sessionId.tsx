import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect, useCallback } from 'react';
import { Terminal, type ConnectionStatus } from '../../components/Terminal';
import { getSessionMetadata, restartSession, ServerUnavailableError, type SessionMetadata } from '../../lib/api';
import { formatPath } from '../../lib/path';
import type { ClaudeActivityState } from '@agent-console/shared';

interface TerminalSearchParams {
  cwd?: string;
}

export const Route = createFileRoute('/sessions/$sessionId')({
  component: TerminalPage,
  validateSearch: (search: Record<string, unknown>): TerminalSearchParams => {
    return {
      cwd: typeof search.cwd === 'string' ? search.cwd : undefined,
    };
  },
});

type PageState =
  | { type: 'loading' }
  | { type: 'active'; wsUrl: string; metadata: SessionMetadata }
  | { type: 'disconnected'; metadata: SessionMetadata }
  | { type: 'not_found' }
  | { type: 'server_unavailable' }
  | { type: 'restarting' };

// Tab types
type TabType = 'claude' | 'shell';

interface Tab {
  id: string;
  type: TabType;
  name: string;
  wsUrl: string;
}

function extractBranchName(worktreePath: string): string {
  // Extract last directory name as branch hint
  const parts = worktreePath.split('/');
  return parts[parts.length - 1] || 'unknown';
}

function extractProjectName(worktreePath: string): string {
  // Path format: ~/.agent-console/worktrees/{org}/{repo}/{branch}
  // or: ~/.agent-console/worktrees/{repo}/{branch}
  // Branch is always the last part, repo is second to last
  const parts = worktreePath.split('/').filter(Boolean);
  return parts[parts.length - 2] || 'project';
}

// Generate favicon based on activity state
function generateFavicon(state: ClaudeActivityState, bounce: number = 0): string {
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

function TerminalPage() {
  const { sessionId } = Route.useParams();
  const { cwd } = Route.useSearch();
  const [state, setState] = useState<PageState>({ type: 'loading' });
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [exitInfo, setExitInfo] = useState<{ code: number; signal: string | null } | undefined>();
  const [activityState, setActivityState] = useState<ClaudeActivityState>('unknown');

  // Tab management
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [shellCounter, setShellCounter] = useState(1);

  const handleStatusChange = useCallback((status: ConnectionStatus, info?: { code: number; signal: string | null }) => {
    setConnectionStatus(status);
    setExitInfo(info);
  }, []);

  const handleActivityChange = useCallback((state: ClaudeActivityState) => {
    setActivityState(state);
  }, []);

  // Update page title and favicon based on state
  useEffect(() => {
    if (state.type !== 'active' && state.type !== 'disconnected') return;

    const branchName = extractBranchName(state.metadata.worktreePath);
    const projectName = extractProjectName(state.metadata.worktreePath);
    document.title = `${branchName}@${projectName} - Agent Console`;

    // Cleanup: restore default title on unmount
    return () => {
      document.title = 'Agent Console';
    };
  }, [state]);

  // Update favicon based on activity state (with animation for active)
  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }

    // Animate favicon when active
    if (activityState === 'active') {
      let frame = 0;
      const interval = setInterval(() => {
        // Bouncing ball effect using absolute sine
        const bounce = Math.abs(Math.sin(frame * 0.12));
        const faviconUrl = generateFavicon(activityState, bounce);
        if (faviconUrl && link) {
          link.href = faviconUrl;
        }
        frame++;
      }, 40);

      return () => {
        clearInterval(interval);
        if (link) {
          link.href = '/favicon.ico';
        }
      };
    }

    // Static favicon for non-active states
    const faviconUrl = generateFavicon(activityState);
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
      const claudeTab: Tab = {
        id: 'claude',
        type: 'claude',
        name: 'Claude',
        wsUrl: state.wsUrl,
      };
      setTabs([claudeTab]);
      setActiveTabId('claude');
    }
  }, [state, tabs.length]);

  // Add a new shell tab
  const addShellTab = useCallback(() => {
    if (state.type !== 'active') return;

    const shellId = `shell-${shellCounter}`;
    const shellWsUrl = `ws://${window.location.host}/ws/shell?cwd=${encodeURIComponent(state.metadata.worktreePath)}`;
    const newTab: Tab = {
      id: shellId,
      type: 'shell',
      name: `Shell ${shellCounter}`,
      wsUrl: shellWsUrl,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(shellId);
    setShellCounter(prev => prev + 1);
  }, [state, shellCounter]);

  // Close a tab
  const closeTab = useCallback((tabId: string) => {
    // Don't allow closing the Claude tab
    if (tabId === 'claude') return;

    setTabs(prev => {
      const newTabs = prev.filter(t => t.id !== tabId);
      // If closing the active tab, switch to Claude
      if (activeTabId === tabId) {
        setActiveTabId('claude');
      }
      return newTabs;
    });
  }, [activeTabId]);

  useEffect(() => {
    // For 'new' session, use the /ws/terminal-new endpoint directly
    if (sessionId === 'new') {
      const wsUrl = `ws://${window.location.host}/ws/terminal-new${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`;
      const newMetadata: SessionMetadata = {
        id: 'new',
        worktreePath: cwd || '(server default)',
        repositoryId: 'default',
        isActive: true,
      };
      setState({ type: 'active', wsUrl, metadata: newMetadata });
      return;
    }

    // Check session status
    const checkSession = async () => {
      try {
        const metadata = await getSessionMetadata(sessionId);
        if (!metadata) {
          setState({ type: 'not_found' });
          return;
        }

        if (metadata.isActive) {
          const wsUrl = `ws://${window.location.host}/ws/terminal/${sessionId}`;
          setState({ type: 'active', wsUrl, metadata });
        } else {
          setState({ type: 'disconnected', metadata });
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
  }, [sessionId, cwd]);

  const handleRestart = async (continueConversation: boolean) => {
    if (state.type !== 'disconnected') return;

    const metadata = state.metadata;
    setState({ type: 'restarting' });
    try {
      await restartSession(sessionId, continueConversation);
      // Session restarted with same ID - just switch to active state
      const wsUrl = `ws://${window.location.hostname}:3457/ws/terminal/${sessionId}`;
      setState({ type: 'active', wsUrl, metadata: { ...metadata, isActive: true } });
    } catch (error) {
      console.error('Failed to restart session:', error);
      alert(error instanceof Error ? error.message : 'Failed to restart session');
      setState({ type: 'disconnected', metadata });
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
            {formatPath(state.metadata.worktreePath)}
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
  const branchName = extractBranchName(state.metadata.worktreePath);

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
            <span className={`inline-block w-2 h-2 rounded-full ${
              tab.type === 'claude' ? 'bg-blue-500' : 'bg-green-500'
            }`} />
            {tab.name}
            {tab.type === 'shell' && (
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
          onClick={addShellTab}
          className="px-3 py-2 text-gray-400 hover:text-white hover:bg-slate-800"
          title="Add shell tab"
        >
          +
        </button>
      </div>

      {/* Terminal panels - render all but only show active */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={`absolute inset-0 flex flex-col ${
              tab.id === activeTabId ? 'z-10' : 'z-0 invisible'
            }`}
          >
            <Terminal
              wsUrl={tab.wsUrl}
              onStatusChange={tab.id === activeTabId ? handleStatusChange : undefined}
              onActivityChange={tab.type === 'claude' ? handleActivityChange : undefined}
              hideStatusBar
            />
          </div>
        ))}
      </div>

      {/* Status bar at bottom */}
      <div className="bg-slate-800 border-t border-slate-700 px-3 py-1.5 flex items-center gap-4 shrink-0">
        <span className="text-green-400 font-medium text-sm">{branchName}</span>
        <span className="text-gray-500 text-xs font-mono truncate flex-1">
          {formatPath(state.metadata.worktreePath)}
        </span>
        {/* Activity state indicator (only for Claude tab) */}
        {activeTab?.type === 'claude' && activityState !== 'unknown' && (
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
    </div>
  );
}
