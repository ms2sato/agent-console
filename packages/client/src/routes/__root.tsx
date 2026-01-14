import { useEffect, useCallback } from 'react';
import { createRootRoute, Outlet, Link, useLocation } from '@tanstack/react-router';
import { createContext, useContext } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { validateSessions } from '../lib/api';
import { updateFavicon, hasAnyAskingWorker } from '../lib/favicon-manager';
import { WarningIcon, ChevronRightIcon } from '../components/Icons';
import { ConnectionBanner } from '../components/ui/ConnectionBanner';
import { ActiveSessionsSidebar } from '../components/sidebar/ActiveSessionsSidebar';
import { useAppWsState, useAppWsEvent } from '../hooks/useAppWs';
import { useSessionState } from '../hooks/useSessionState';
import { useSidebarState } from '../hooks/useSidebarState';
import { useActiveSessionsWithActivity } from '../hooks/useActiveSessionsWithActivity';
import { useWorktreeCreationTasks, type UseWorktreeCreationTasksReturn } from '../hooks/useWorktreeCreationTasks';
import { useWorktreeDeletionTasks, type UseWorktreeDeletionTasksReturn } from '../hooks/useWorktreeDeletionTasks';
import type { Session, WorktreeDeletionCompletedPayload } from '@agent-console/shared';

/**
 * Context for worktree creation tasks.
 * This allows child routes (like Dashboard) to add tasks and the sidebar to display them.
 */
export const WorktreeCreationTasksContext = createContext<UseWorktreeCreationTasksReturn | null>(null);

/**
 * Hook to access worktree creation tasks context.
 * Must be used within a route that is a child of __root.
 */
export function useWorktreeCreationTasksContext(): UseWorktreeCreationTasksReturn {
  const context = useContext(WorktreeCreationTasksContext);
  if (!context) {
    throw new Error('useWorktreeCreationTasksContext must be used within WorktreeCreationTasksContext.Provider');
  }
  return context;
}

/**
 * Context for worktree deletion tasks.
 * This allows child routes (like SessionPage) to add tasks and the sidebar to display them.
 */
export const WorktreeDeletionTasksContext = createContext<UseWorktreeDeletionTasksReturn | null>(null);

/**
 * Hook to access worktree deletion tasks context.
 * Must be used within a route that is a child of __root.
 */
export function useWorktreeDeletionTasksContext(): UseWorktreeDeletionTasksReturn {
  const context = useContext(WorktreeDeletionTasksContext);
  if (!context) {
    throw new Error('useWorktreeDeletionTasksContext must be used within WorktreeDeletionTasksContext.Provider');
  }
  return context;
}

export const Route = createRootRoute({
  component: RootLayout,
});

// Extract sessionId from URL path
function extractSessionId(pathname: string): string | null {
  const match = pathname.match(/^\/sessions\/([^/]+)/);
  return match ? match[1] : null;
}

function RootLayout() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const connected = useAppWsState((s) => s.connected);
  const isSessionPage = location.pathname.startsWith('/sessions/');
  const currentSessionId = isSessionPage ? extractSessionId(location.pathname) : null;

  // Session state management for sidebar
  const {
    sessions,
    workerActivityStates,
    handleSessionsSync,
    handleSessionCreated,
    handleSessionUpdated,
    handleSessionDeleted,
    handleWorkerActivity,
  } = useSessionState();

  // Worktree creation task management
  const worktreeCreationTasks = useWorktreeCreationTasks();

  // Worktree deletion task management
  const worktreeDeletionTasks = useWorktreeDeletionTasks();

  // Wrap worktree deletion completed handler to also invalidate worktree queries
  const handleWorktreeDeletionCompleted = useCallback((payload: WorktreeDeletionCompletedPayload) => {
    worktreeDeletionTasks.handleWorktreeDeletionCompleted(payload);
    // Invalidate all worktree queries to refresh dashboard
    queryClient.invalidateQueries({ queryKey: ['worktrees'] });
  }, [worktreeDeletionTasks, queryClient]);

  // Subscribe to app WebSocket events for real-time session updates
  useAppWsEvent({
    onSessionsSync: handleSessionsSync,
    onSessionCreated: handleSessionCreated,
    onSessionUpdated: handleSessionUpdated,
    onSessionDeleted: handleSessionDeleted,
    onWorkerActivity: handleWorkerActivity,
    onWorktreeCreationCompleted: worktreeCreationTasks.handleWorktreeCreationCompleted,
    onWorktreeCreationFailed: worktreeCreationTasks.handleWorktreeCreationFailed,
    onWorktreeDeletionCompleted: handleWorktreeDeletionCompleted,
    onWorktreeDeletionFailed: worktreeDeletionTasks.handleWorktreeDeletionFailed,
  });

  // Sidebar state
  const { collapsed, toggle, width, setWidth } = useSidebarState();
  const activeSessions = useActiveSessionsWithActivity(sessions, workerActivityStates);

  // Update favicon based on worker activity states
  useEffect(() => {
    updateFavicon(hasAnyAskingWorker(workerActivityStates));
  }, [workerActivityStates]);

  // Find current session for breadcrumb display
  const currentSession: Session | undefined = currentSessionId
    ? sessions.find(s => s.id === currentSessionId)
    : undefined;

  return (
    <WorktreeCreationTasksContext.Provider value={worktreeCreationTasks}>
      <WorktreeDeletionTasksContext.Provider value={worktreeDeletionTasks}>
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <header style={{
          padding: '8px 16px',
          borderBottom: '1px solid #334155',
          backgroundColor: '#0f172a',
          display: 'flex',
          alignItems: 'center',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
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
            {isSessionPage && currentSession && (
              <>
                {currentSession.type === 'worktree' && (
                  <>
                    <ChevronRightIcon className="w-3.5 h-3.5 text-slate-500" />
                    <span style={{ color: '#94a3b8', fontSize: '0.8125rem' }}>
                      {currentSession.repositoryName}
                    </span>
                  </>
                )}
                {currentSession.title && (
                  <>
                    <ChevronRightIcon className="w-3.5 h-3.5 text-slate-500" />
                    <span style={{ color: '#e2e8f0', fontSize: '0.8125rem' }}>
                      {currentSession.title}
                    </span>
                  </>
                )}
              </>
            )}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <ValidationWarningIndicator />
            <JobsNavLink />
            <AgentsNavLink />
            <RepositoriesNavLink />
          </div>
        </header>
        <ConnectionBanner connected={connected} />
        <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
          <ActiveSessionsSidebar
            collapsed={collapsed}
            onToggle={toggle}
            sessions={activeSessions}
            width={width}
            onWidthChange={setWidth}
            creationTasks={worktreeCreationTasks.tasks}
            onRemoveCreationTask={worktreeCreationTasks.removeTask}
            worktreeDeletionTasks={worktreeDeletionTasks.tasks}
            onRemoveWorktreeDeletionTask={worktreeDeletionTasks.removeTask}
          />
          <main style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            overflow: isSessionPage ? 'hidden' : 'auto',
          }}>
            <Outlet />
          </main>
        </div>
      </div>
      </WorktreeDeletionTasksContext.Provider>
    </WorktreeCreationTasksContext.Provider>
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
