import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect, useCallback } from 'react';
import { Terminal, type ConnectionStatus } from '../../components/Terminal';
import { getSessionMetadata, restartSession, ServerUnavailableError, type SessionMetadata } from '../../lib/api';
import type { ClaudeActivityState } from '@agents-web-console/shared';

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

function extractBranchName(worktreePath: string): string {
  // Extract last directory name as branch hint
  const parts = worktreePath.split('/');
  return parts[parts.length - 1] || 'unknown';
}

function TerminalPage() {
  const { sessionId } = Route.useParams();
  const { cwd } = Route.useSearch();
  const [state, setState] = useState<PageState>({ type: 'loading' });
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [exitInfo, setExitInfo] = useState<{ code: number; signal: string | null } | undefined>();
  const [activityState, setActivityState] = useState<ClaudeActivityState>('unknown');

  const handleStatusChange = useCallback((status: ConnectionStatus, info?: { code: number; signal: string | null }) => {
    setConnectionStatus(status);
    setExitInfo(info);
  }, []);

  const handleActivityChange = useCallback((state: ClaudeActivityState) => {
    setActivityState(state);
  }, []);

  useEffect(() => {
    // For 'new' session, use the /ws/terminal-new endpoint directly
    if (sessionId === 'new') {
      const wsUrl = `ws://${window.location.hostname}:3457/ws/terminal-new${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`;
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
          const wsUrl = `ws://${window.location.hostname}:3457/ws/terminal/${sessionId}`;
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
            {state.metadata.worktreePath}
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
    connectionStatus === 'connected' ? 'bg-green-500' :
    connectionStatus === 'connecting' ? 'bg-yellow-500' :
    connectionStatus === 'exited' ? 'bg-red-500' : 'bg-gray-500';

  const statusText =
    connectionStatus === 'connecting' ? 'Connecting...' :
    connectionStatus === 'connected' ? 'Connected' :
    connectionStatus === 'disconnected' ? 'Disconnected' :
    `Exited (code: ${exitInfo?.code}${exitInfo?.signal ? `, signal: ${exitInfo.signal}` : ''})`;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <Terminal wsUrl={state.wsUrl} onStatusChange={handleStatusChange} onActivityChange={handleActivityChange} hideStatusBar />
      </div>
      {/* Status bar at bottom */}
      <div className="bg-slate-800 border-t border-slate-700 px-3 py-1.5 flex items-center gap-4 shrink-0">
        <span className="text-green-400 font-medium text-sm">{branchName}</span>
        <span className="text-gray-500 text-xs font-mono truncate flex-1">
          {state.metadata.worktreePath}
        </span>
        {/* Activity state indicator */}
        {activityState !== 'unknown' && (
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
          <span className={`inline-block w-2 h-2 rounded-full ${statusColor}`} />
          {statusText}
        </span>
      </div>
    </div>
  );
}
