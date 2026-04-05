import { useState } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { validateSessions, logout as logoutApi, fetchReviewQueue, restartAllAgentWorkers } from '../../lib/api';
import { sessionKeys, reviewQueueKeys } from '../../lib/query-keys';
import { WarningIcon, RefreshIcon } from '../Icons';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { useAppWsEvent } from '../../hooks/useAppWs';
import { useAuth, setCurrentUser } from '../../lib/auth';
import { disconnect as disconnectAppWs } from '../../lib/app-websocket';
import { clearStoredFilterMode } from '../../hooks/useSessionFilter';
import { setHomeDir } from '../../lib/path';

export function JobsNavLink() {
  const location = useLocation();
  const isActive = location.pathname.startsWith('/jobs');

  return (
    <Link
      to="/jobs"
      className={`text-sm py-1 px-2 rounded no-underline ${
        isActive ? 'text-white bg-white/10' : 'text-slate-400'
      }`}
    >
      Jobs
    </Link>
  );
}

export function AgentsNavLink() {
  const location = useLocation();
  const isActive = location.pathname.startsWith('/agents');

  return (
    <Link
      to="/agents"
      className={`text-sm py-1 px-2 rounded no-underline ${
        isActive ? 'text-white bg-white/10' : 'text-slate-400'
      }`}
    >
      Agents
    </Link>
  );
}

export function RepositoriesNavLink() {
  const location = useLocation();
  const isActive = location.pathname === '/settings/repositories';

  return (
    <Link
      to="/settings/repositories"
      className={`text-sm py-1 px-2 rounded no-underline ${
        isActive ? 'text-white bg-white/10' : 'text-slate-400'
      }`}
    >
      Repositories
    </Link>
  );
}

export function ReviewNavLink() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const isActive = location.pathname.startsWith('/review');

  // Fetch review queue for pending count
  const { data: groups } = useQuery({
    queryKey: reviewQueueKeys.list(),
    queryFn: fetchReviewQueue,
  });

  // Real-time updates via WebSocket
  useAppWsEvent({
    onReviewQueueUpdated: () => {
      queryClient.invalidateQueries({ queryKey: reviewQueueKeys.root() });
    },
  });

  const pendingCount = groups?.reduce((sum, g) => sum + g.items.length, 0) ?? 0;

  return (
    <Link
      to="/review"
      className={`text-sm py-1 px-2 rounded no-underline flex items-center gap-1.5 ${
        isActive ? 'text-white bg-white/10' : 'text-slate-400'
      }`}
    >
      Review
      {pendingCount > 0 && (
        <span className="px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-xs font-medium leading-none">
          {pendingCount}
        </span>
      )}
    </Link>
  );
}

export function LogoutButton() {
  const { currentUser } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  if (!currentUser) return null;

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await logoutApi();
    } catch {
      // Even if the API call fails, clear local state
    }
    // Clear all client-side state to prevent cross-user data leakage
    disconnectAppWs();
    queryClient.clear();
    clearStoredFilterMode();
    setCurrentUser(null);
    setHomeDir('');
    void navigate({ to: '/login' });
  };

  return (
    <button
      onClick={handleLogout}
      disabled={isLoggingOut}
      className="text-sm py-1 px-2 rounded text-slate-400 hover:text-white disabled:opacity-50"
      title={`Logout (${currentUser.username})`}
    >
      {isLoggingOut ? 'Logging out...' : 'Logout'}
    </button>
  );
}

export function RestartAllAgentsButton() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: restartAllAgentWorkers,
    onSuccess: (data) => {
      setConfirmOpen(false);
      if (data.restarted === 0 && data.failed === 0) {
        setResultMessage('No active agent workers found.');
      } else if (data.failed === 0) {
        setResultMessage(`Restarted ${data.restarted} agent${data.restarted > 1 ? 's' : ''}.`);
      } else {
        setResultMessage(`Restarted ${data.restarted}, failed ${data.failed}.`);
      }
      setTimeout(() => setResultMessage(null), 3000);
    },
    onError: () => {
      setConfirmOpen(false);
    },
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        className="text-slate-400 hover:text-white p-1 rounded hover:bg-white/10 transition-colors relative"
        title="Restart all agents"
      >
        <RefreshIcon className="w-4 h-4" />
        {resultMessage && (
          <span className="absolute top-full right-0 mt-1 whitespace-nowrap text-xs bg-slate-800 text-slate-200 px-2 py-1 rounded shadow-lg border border-slate-700 z-50">
            {resultMessage}
          </span>
        )}
      </button>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Restart All Agents"
        description="This will restart all active agent workers across all sessions. Terminal workers will not be affected."
        confirmLabel="Restart All"
        onConfirm={() => mutation.mutate()}
        isLoading={mutation.isPending}
      />
    </>
  );
}

export function ValidationWarningIndicator() {
  const { data } = useQuery({
    queryKey: sessionKeys.validation(),
    queryFn: validateSessions,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    retry: false,
  });

  if (!data?.hasIssues) {
    return null;
  }

  const invalidCount = data.results.filter(r => !r.valid).length;

  return (
    <Link
      to="/maintenance"
      className="flex items-center gap-1.5 py-1 px-2 rounded bg-yellow-500/20 text-yellow-500 text-xs no-underline"
      title={`${invalidCount} invalid session${invalidCount > 1 ? 's' : ''} found`}
    >
      <WarningIcon className="w-3.5 h-3.5" />
      <span>{invalidCount}</span>
    </Link>
  );
}
