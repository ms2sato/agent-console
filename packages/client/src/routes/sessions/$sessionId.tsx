import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { Terminal } from '../../components/Terminal';
import { getSessionMetadata, createSession, type SessionMetadata } from '../../lib/api';

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
  | { type: 'active'; wsUrl: string }
  | { type: 'disconnected'; metadata: SessionMetadata }
  | { type: 'not_found' }
  | { type: 'restarting' };

function TerminalPage() {
  const { sessionId } = Route.useParams();
  const { cwd } = Route.useSearch();
  const navigate = useNavigate();
  const [state, setState] = useState<PageState>({ type: 'loading' });

  useEffect(() => {
    // For 'new' session, use the /ws/terminal-new endpoint directly
    if (sessionId === 'new') {
      const wsUrl = `ws://${window.location.hostname}:3457/ws/terminal-new${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`;
      setState({ type: 'active', wsUrl });
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
          setState({ type: 'active', wsUrl });
        } else {
          setState({ type: 'disconnected', metadata });
        }
      } catch (error) {
        console.error('Failed to check session:', error);
        setState({ type: 'not_found' });
      }
    };

    checkSession();
  }, [sessionId, cwd]);

  const handleRestart = async (continueConversation: boolean) => {
    if (state.type !== 'disconnected') return;

    setState({ type: 'restarting' });
    try {
      const { session } = await createSession(
        state.metadata.worktreePath,
        state.metadata.repositoryId,
        continueConversation
      );
      // Navigate to the new session
      navigate({ to: '/sessions/$sessionId', params: { sessionId: session.id } });
    } catch (error) {
      console.error('Failed to restart session:', error);
      alert(error instanceof Error ? error.message : 'Failed to restart session');
      setState({ type: 'disconnected', metadata: state.metadata });
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

  // Active state - show terminal
  return (
    <div className="flex-1 flex flex-col">
      <Terminal wsUrl={state.wsUrl} />
    </div>
  );
}
