import { createRootRoute, Outlet, Link, useLocation } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { validateSessions } from '../lib/api';
import { WarningIcon } from '../components/Icons';
import { ConnectionBanner } from '../components/ui/ConnectionBanner';
import { useAppWsState } from '../hooks/useAppWs';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const location = useLocation();
  const connected = useAppWsState((s) => s.connected);
  const isSessionPage = location.pathname.startsWith('/sessions/');

  // Session pages have their own header with tabs
  if (isSessionPage) {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <Outlet />
        </main>
      </div>
    );
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{
        padding: '8px 16px',
        borderBottom: '1px solid #334155',
        backgroundColor: '#0f172a',
        display: 'flex',
        alignItems: 'center',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <Link
            to="/"
            style={{
              color: '#fff',
              textDecoration: 'none',
              fontSize: '0.875rem',
              fontWeight: 'bold',
            }}
          >
            Agent Console
          </Link>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <ValidationWarningIndicator />
          <JobsNavLink />
          <AgentsNavLink />
          <RepositoriesNavLink />
        </div>
      </header>
      <ConnectionBanner connected={connected} />
      <main style={{ flex: 1, overflow: 'auto' }}>
        <Outlet />
      </main>
    </div>
  );
}

function JobsNavLink() {
  const location = useLocation();
  const isActive = location.pathname.startsWith('/jobs');

  return (
    <Link
      to="/jobs"
      style={{
        color: isActive ? '#fff' : '#94a3b8',
        textDecoration: 'none',
        fontSize: '0.875rem',
        padding: '4px 8px',
        borderRadius: '4px',
        backgroundColor: isActive ? 'rgba(255, 255, 255, 0.1)' : 'transparent',
      }}
    >
      Jobs
    </Link>
  );
}

function AgentsNavLink() {
  const location = useLocation();
  const isActive = location.pathname.startsWith('/agents');

  return (
    <Link
      to="/agents"
      style={{
        color: isActive ? '#fff' : '#94a3b8',
        textDecoration: 'none',
        fontSize: '0.875rem',
        padding: '4px 8px',
        borderRadius: '4px',
        backgroundColor: isActive ? 'rgba(255, 255, 255, 0.1)' : 'transparent',
      }}
    >
      Agents
    </Link>
  );
}

function RepositoriesNavLink() {
  const location = useLocation();
  const isActive = location.pathname === '/settings/repositories';

  return (
    <Link
      to="/settings/repositories"
      style={{
        color: isActive ? '#fff' : '#94a3b8',
        textDecoration: 'none',
        fontSize: '0.875rem',
        padding: '4px 8px',
        borderRadius: '4px',
        backgroundColor: isActive ? 'rgba(255, 255, 255, 0.1)' : 'transparent',
      }}
    >
      Repositories
    </Link>
  );
}

function ValidationWarningIndicator() {
  const { data } = useQuery({
    queryKey: ['session-validation'],
    queryFn: validateSessions,
    // Only check once on initial load, don't refetch automatically
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
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 8px',
        borderRadius: '4px',
        backgroundColor: 'rgba(234, 179, 8, 0.2)',
        color: '#eab308',
        fontSize: '0.75rem',
        textDecoration: 'none',
      }}
      title={`${invalidCount} invalid session${invalidCount > 1 ? 's' : ''} found`}
    >
      <WarningIcon className="w-3.5 h-3.5" />
      <span>{invalidCount}</span>
    </Link>
  );
}
