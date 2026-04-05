import { useState, useEffect, useCallback, useMemo } from 'react';
import { createRootRoute, Outlet, Link, useLocation, useNavigate } from '@tanstack/react-router';
import { resumeSession } from '../lib/api';
import { ChevronRightIcon, PlusIcon } from '../components/Icons';
import { QuickWorktreeDialog } from '../components/worktrees';
import { MobileHeaderControls } from '../components/header/MobileHeaderControls';
import { JobsNavLink, AgentsNavLink, RepositoriesNavLink, ReviewNavLink, LogoutButton, ValidationWarningIndicator, RestartAllAgentsButton } from '../components/header/NavLinks';
import { useIsMobile } from '../hooks/useIsMobile';
import { ConnectionBanner } from '../components/ui/ConnectionBanner';
import { WebhookConfigBanner } from '../components/ui/WebhookConfigBanner';
import { ActiveSessionsSidebar } from '../components/sidebar/ActiveSessionsSidebar';
import { useAppWsState } from '../hooks/useAppWs';
import { useSessionState } from '../hooks/useSessionState';
import { useSessionSideEffects } from '../hooks/useSessionSideEffects';
import { useSidebarState } from '../hooks/useSidebarState';
import { useActiveSessionsWithActivity } from '../hooks/useActiveSessionsWithActivity';
import { useWorktreeCreationTasks } from '../hooks/useWorktreeCreationTasks';
import { useWorktreeDeletionTasks } from '../hooks/useWorktreeDeletionTasks';
import { useSessionFilter, matchesUserFilter } from '../hooks/useSessionFilter';
import type { Session } from '@agent-console/shared';
import { useAuth } from '../lib/auth';
import { logger } from '../lib/logger';
import { SessionDataContext, WorktreeCreationTasksContext, WorktreeDeletionTasksContext } from '../contexts/root-contexts';
import type { SessionDataContextValue } from '../contexts/root-contexts';

// Re-export contexts for backward compatibility
export {
  SessionDataContext,
  useSessionDataContext,
  WorktreeCreationTasksContext,
  useWorktreeCreationTasksContext,
  WorktreeDeletionTasksContext,
  useWorktreeDeletionTasksContext,
} from '../contexts/root-contexts';
export type { SessionDataContextValue } from '../contexts/root-contexts';

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
  const navigate = useNavigate();
  const connected = useAppWsState((s) => s.connected);
  const hasEverConnected = useAppWsState((s) => s.hasEverConnected);
  const isSessionPage = location.pathname.startsWith('/sessions/');

  const { isMultiUser, currentUser } = useAuth();

  // Auth gate: redirect to /login if multi-user mode and not authenticated
  useEffect(() => {
    if (isMultiUser && !currentUser && location.pathname !== '/login') {
      void navigate({ to: '/login' });
    }
  }, [isMultiUser, currentUser, location.pathname, navigate]);

  const currentSessionId = isSessionPage ? extractSessionId(location.pathname) : null;

  // Session state management (single source of truth for all child routes)
  const {
    sessions,
    wsInitialized,
    workerActivityStates,
    handleSessionsSync,
    handleSessionCreated,
    handleSessionUpdated,
    handleSessionDeleted,
    handleSessionPaused,
    handleSessionResumed,
    handleWorkerActivity,
  } = useSessionState();

  // Memoize session data context to avoid unnecessary re-renders in consumers
  const sessionDataContextValue = useMemo<SessionDataContextValue>(() => ({
    sessions,
    wsInitialized,
    workerActivityStates,
  }), [sessions, wsInitialized, workerActivityStates]);

  // Worktree creation task management
  const worktreeCreationTasks = useWorktreeCreationTasks();

  // Worktree deletion task management
  const worktreeDeletionTasks = useWorktreeDeletionTasks();

  // Wire up cross-cutting side effects (validation, cache cleanup, favicon, WebSocket subscription)
  useSessionSideEffects({
    sessions,
    handleSessionsSync,
    handleSessionCreated,
    handleSessionUpdated,
    handleSessionDeleted,
    handleSessionPaused,
    handleSessionResumed,
    handleWorkerActivity,
    workerActivityStates,
    worktreeCreationTasks,
    worktreeDeletionTasks,
  });

  // Sidebar state
  const { collapsed, toggle, width, setWidth } = useSidebarState();
  const allActiveSessions = useActiveSessionsWithActivity(sessions, workerActivityStates);

  // Session filtering for multi-user mode
  const { filterMode, setFilterMode, filterSessions } = useSessionFilter();
  const activeSessions = useMemo(() => {
    if (!isMultiUser || filterMode !== 'mine' || !currentUser) return allActiveSessions;
    return allActiveSessions.filter(s => matchesUserFilter(s.session.createdBy, currentUser.id));
  }, [allActiveSessions, isMultiUser, filterMode, currentUser]);
  const pausedSessions = useMemo(() => filterSessions(sessions.filter(s => s.pausedAt)), [filterSessions, sessions]);

  // Session filter state for sidebar — only provided in multi-user mode
  const sessionFilter = isMultiUser
    ? { mode: filterMode, onChange: setFilterMode }
    : undefined;

  const handleResumeFromSidebar = useCallback(async (sessionId: string) => {
    try {
      // Only trigger the resume request. The state update will arrive
      // via the WebSocket `session-resumed` event, avoiding double-application.
      await resumeSession(sessionId);
    } catch (error) {
      logger.error('Failed to resume session:', error);
      throw error;
    }
  }, []);

  // Find current session for breadcrumb display
  const currentSession: Session | undefined = currentSessionId
    ? sessions.find(s => s.id === currentSessionId)
    : undefined;

  const isMobile = useIsMobile();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [quickWorktreeOpen, setQuickWorktreeOpen] = useState(false);

  // Close mobile drawers on route change
  useEffect(() => {
    setMobileSidebarOpen(false);
    setMobileNavOpen(false);
  }, [location.pathname]);

  const hasAnyAsking = activeSessions.some(s => s.activityState === 'asking');

  // In multi-user mode without authentication:
  // - If on /login, render just the Outlet (login page without app shell)
  // - Otherwise, render nothing while the useEffect navigates to /login
  if (isMultiUser && !currentUser) {
    if (location.pathname === '/login') {
      return <Outlet />;
    }
    return null;
  }

  return (
    <SessionDataContext.Provider value={sessionDataContextValue}>
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

            <nav aria-label="Main navigation" className="ml-auto hidden md:flex items-center gap-3">
              <button
                type="button"
                onClick={() => setQuickWorktreeOpen(true)}
                className="text-slate-400 hover:text-white p-1 rounded hover:bg-white/10 transition-colors"
                title="Create worktree"
              >
                <PlusIcon className="w-4 h-4" />
              </button>
              <RestartAllAgentsButton />
              <ValidationWarningIndicator />
              <ReviewNavLink />
              <JobsNavLink />
              <AgentsNavLink />
              <RepositoriesNavLink />
              {isMultiUser && <LogoutButton />}
            </nav>

            {isMobile && (
              <MobileHeaderControls
                mobileNavOpen={mobileNavOpen}
                mobileSidebarOpen={mobileSidebarOpen}
                hasAnyAsking={hasAnyAsking}
                onOpenSidebar={() => setMobileSidebarOpen(true)}
                onCloseSidebar={() => setMobileSidebarOpen(false)}
                onToggleNav={() => setMobileNavOpen(!mobileNavOpen)}
                onCloseNav={() => setMobileNavOpen(false)}
                sidebarContent={
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
                    sessionFilter={sessionFilter}
                  />
                }
              />
            )}
            <QuickWorktreeDialog
              open={quickWorktreeOpen}
              onOpenChange={setQuickWorktreeOpen}
              defaultRepositoryId={currentSession?.type === 'worktree' ? currentSession.repositoryId : undefined}
            />
          </header>
          <ConnectionBanner connected={connected} hasEverConnected={hasEverConnected} />
          <WebhookConfigBanner />
          <div className="flex-1 flex min-h-0 overflow-hidden">
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
                sessionFilter={sessionFilter}
              />
            )}
            <main className={`flex-1 flex flex-col min-h-0 ${isSessionPage ? 'overflow-hidden' : 'overflow-auto'}`}>
              <Outlet />
            </main>
          </div>
        </div>
      </WorktreeDeletionTasksContext.Provider>
    </WorktreeCreationTasksContext.Provider>
    </SessionDataContext.Provider>
  );
}
