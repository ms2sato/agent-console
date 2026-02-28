import { useState, useEffect, useCallback, useMemo } from 'react';
import { createRootRoute, Outlet, Link, useLocation } from '@tanstack/react-router';
import { createContext, useContext } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { validateSessions, resumeSession } from '../lib/api';
import { worktreeKeys, sessionKeys } from '../lib/query-keys';
import { updateFavicon, hasAnyAskingWorker } from '../lib/favicon-manager';
import { WarningIcon, ChevronRightIcon, MenuIcon, LayoutListIcon } from '../components/Icons';
import { MobileSidebarDrawer } from '../components/sidebar/MobileSidebarDrawer';
import { MobileNavMenu } from '../components/header/MobileNavMenu';
import { useIsMobile } from '../hooks/useIsMobile';
import { ConnectionBanner } from '../components/ui/ConnectionBanner';
import { WebhookConfigBanner } from '../components/ui/WebhookConfigBanner';
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
    handleSessionPaused,
    handleSessionResumed,
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
    queryClient.invalidateQueries({ queryKey: worktreeKeys.root() });
  }, [worktreeDeletionTasks, queryClient]);

  // Subscribe to app WebSocket events for real-time session updates
  useAppWsEvent({
    onSessionsSync: handleSessionsSync,
    onSessionCreated: handleSessionCreated,
    onSessionUpdated: handleSessionUpdated,
    onSessionDeleted: handleSessionDeleted,
    onSessionPaused: handleSessionPaused,
    onSessionResumed: handleSessionResumed,
    onWorkerActivity: handleWorkerActivity,
    onWorktreeCreationCompleted: worktreeCreationTasks.handleWorktreeCreationCompleted,
    onWorktreeCreationFailed: worktreeCreationTasks.handleWorktreeCreationFailed,
    onWorktreeDeletionCompleted: handleWorktreeDeletionCompleted,
    onWorktreeDeletionFailed: worktreeDeletionTasks.handleWorktreeDeletionFailed,
  });

  // Sidebar state
  const { collapsed, toggle, width, setWidth } = useSidebarState();
  const activeSessions = useActiveSessionsWithActivity(sessions, workerActivityStates);
  const pausedSessions = useMemo(() => sessions.filter(s => s.pausedAt), [sessions]);

  const handleResumeFromSidebar = useCallback(async (sessionId: string) => {
    try {
      const resumed = await resumeSession(sessionId);
      handleSessionResumed(resumed);
    } catch (error) {
      console.error('Failed to resume session:', error);
    }
  }, [handleSessionResumed]);

  // Update favicon based on worker activity states
  useEffect(() => {
    updateFavicon(hasAnyAskingWorker(workerActivityStates));
  }, [workerActivityStates]);

  // Find current session for breadcrumb display
  const currentSession: Session | undefined = currentSessionId
    ? sessions.find(s => s.id === currentSessionId)
    : undefined;

  // Mobile responsive state
  const isMobile = useIsMobile();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Close mobile drawers on navigation
  useEffect(() => {
    setMobileSidebarOpen(false);
    setMobileNavOpen(false);
  }, [location.pathname]);

  // Check if any session has 'asking' activity (for mobile badge indicator)
  const hasAnyAsking = activeSessions.some(s => s.activityState === 'asking');

  return (
    <WorktreeCreationTasksContext.Provider value={worktreeCreationTasks}>
      <WorktreeDeletionTasksContext.Provider value={worktreeDeletionTasks}>
      <div className="h-dvh flex flex-col">
        <header className="px-4 py-2 border-b border-slate-700 bg-[#0f172a] flex items-center shrink-0 relative">
          <div className="flex items-center gap-1.5">
            <Link
              to="/"
              className="text-white no-underline text-sm font-bold"
            >
              Agent Console
            </Link>
            {isSessionPage && currentSession && (
              <span className="hidden md:contents">
                {currentSession.type === 'worktree' && (
                  <>
                    <ChevronRightIcon className="w-3.5 h-3.5 text-slate-500" />
                    <span className="text-slate-400 text-[0.8125rem]">
                      {currentSession.repositoryName}
                    </span>
                  </>
                )}
                {currentSession.title && (
                  <>
                    <ChevronRightIcon className="w-3.5 h-3.5 text-slate-500" />
                    <span className="text-slate-200 text-[0.8125rem]">
                      {currentSession.title}
                    </span>
                  </>
                )}
              </span>
            )}
          </div>

          {/* Desktop navigation - hidden on mobile */}
          <nav aria-label="Main navigation" className="ml-auto hidden md:flex items-center gap-3">
            <ValidationWarningIndicator />
            <JobsNavLink />
            <AgentsNavLink />
            <RepositoriesNavLink />
          </nav>

          {/* Mobile header controls - hidden on desktop */}
          <div className="ml-auto flex items-center gap-1 md:hidden">
            <button
              onClick={() => setMobileSidebarOpen(true)}
              className="relative p-2 text-gray-400 hover:text-white min-w-[44px] min-h-[44px] flex items-center justify-center"
              aria-label="Open sessions"
            >
              <LayoutListIcon className="w-5 h-5" />
              {hasAnyAsking && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-yellow-400 rounded-full" aria-hidden="true" />
              )}
            </button>
            <button
              onClick={() => setMobileNavOpen(!mobileNavOpen)}
              className="p-2 text-gray-400 hover:text-white min-w-[44px] min-h-[44px] flex items-center justify-center"
              aria-label={mobileNavOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={mobileNavOpen}
            >
              <MenuIcon className="w-5 h-5" />
            </button>
          </div>

          {/* Mobile navigation dropdown */}
          <MobileNavMenu open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
        </header>
        <ConnectionBanner connected={connected} />
        <WebhookConfigBanner />
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* Desktop sidebar - hidden on mobile */}
          {!isMobile && (
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
              pausedSessions={pausedSessions}
              onResumeSession={handleResumeFromSidebar}
            />
          )}
          <main className={`flex-1 flex flex-col min-h-0 ${isSessionPage ? 'overflow-hidden' : 'overflow-auto'}`}>
            <Outlet />
          </main>
        </div>

        {/* Mobile sidebar drawer */}
        {isMobile && (
          <MobileSidebarDrawer open={mobileSidebarOpen} onClose={() => setMobileSidebarOpen(false)}>
            <ActiveSessionsSidebar
              collapsed={false}
              onToggle={() => setMobileSidebarOpen(false)}
              sessions={activeSessions}
              width={288}
              onWidthChange={() => {}}
              creationTasks={worktreeCreationTasks.tasks}
              onRemoveCreationTask={worktreeCreationTasks.removeTask}
              worktreeDeletionTasks={worktreeDeletionTasks.tasks}
              onRemoveWorktreeDeletionTask={worktreeDeletionTasks.removeTask}
              pausedSessions={pausedSessions}
              onResumeSession={handleResumeFromSidebar}
              hideResizeHandle
            />
          </MobileSidebarDrawer>
        )}
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
      className={`text-sm py-1 px-2 rounded no-underline ${
        isActive ? 'text-white bg-white/10' : 'text-slate-400'
      }`}
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
      className={`text-sm py-1 px-2 rounded no-underline ${
        isActive ? 'text-white bg-white/10' : 'text-slate-400'
      }`}
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
      className={`text-sm py-1 px-2 rounded no-underline ${
        isActive ? 'text-white bg-white/10' : 'text-slate-400'
      }`}
    >
      Repositories
    </Link>
  );
}

function ValidationWarningIndicator() {
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
