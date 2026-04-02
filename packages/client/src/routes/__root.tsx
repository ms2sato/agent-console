import { useState, useEffect, useCallback, useMemo, createContext, useContext } from 'react';
import { createRootRoute, Outlet, Link, useLocation, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { validateSessions, resumeSession, logout as logoutApi, fetchReviewQueue } from '../lib/api';
import { worktreeKeys, sessionKeys, reviewQueueKeys } from '../lib/query-keys';
import { updateFavicon, hasAnyAskingWorker } from '../lib/favicon-manager';
import { WarningIcon, ChevronRightIcon, PlusIcon } from '../components/Icons';
import { QuickWorktreeDialog } from '../components/worktrees';
import { MobileHeaderControls } from '../components/header/MobileHeaderControls';
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
import { useSessionFilter, clearStoredFilterMode, matchesUserFilter } from '../hooks/useSessionFilter';
import type { Session, AgentActivityState, WorktreeDeletionCompletedPayload } from '@agent-console/shared';
import { clearTerminalState } from '../lib/terminal-state-cache';
import { disconnectSession } from '../lib/worker-websocket';
import { disconnect as disconnectAppWs } from '../lib/app-websocket';
import { useAuth, setCurrentUser } from '../lib/auth';
import { setHomeDir } from '../lib/path';
import { logger } from '../lib/logger';

/**
 * Context for session data managed by the root layout.
 * Provides the single source of truth for session list and worker activity states
 * to all child routes, avoiding duplicate WebSocket subscriptions.
 */
export interface SessionDataContextValue {
  /** All sessions (active and paused) */
  sessions: Session[];
  /** Whether the initial WebSocket sync has been received */
  wsInitialized: boolean;
  /** Worker activity states: { sessionId: { workerId: state } } */
  workerActivityStates: Record<string, Record<string, AgentActivityState>>;
}

export const SessionDataContext = createContext<SessionDataContextValue | null>(null);

/**
 * Hook to access session data from the root layout context.
 * Must be used within a route that is a child of __root.
 */
export function useSessionDataContext(): SessionDataContextValue {
  const context = useContext(SessionDataContext);
  if (!context) {
    throw new Error('useSessionDataContext must be used within SessionDataContext.Provider');
  }
  return context;
}

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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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

  // Invalidate session validation cache so the warning badge stays current
  const invalidateValidation = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: sessionKeys.validation() });
  }, [queryClient]);

  // Wrap session lifecycle handlers to also refresh validation status
  const handleSessionCreatedWithValidation = useCallback((...args: Parameters<typeof handleSessionCreated>) => {
    handleSessionCreated(...args);
    invalidateValidation();
  }, [handleSessionCreated, invalidateValidation]);

  const handleSessionDeletedWithValidation = useCallback((sessionId: string) => {
    // Capture the worker list BEFORE removing the session from state,
    // so we can clean up their IndexedDB terminal state cache entries.
    const session = sessions.find(s => s.id === sessionId);
    if (session) {
      for (const worker of session.workers) {
        clearTerminalState(sessionId, worker.id).catch((e) =>
          logger.warn('[RootLayout] Failed to clear terminal cache on session delete:', e)
        );
      }
    }
    handleSessionDeleted(sessionId);
    invalidateValidation();
  }, [sessions, handleSessionDeleted, invalidateValidation]);

  const handleSessionUpdatedWithValidation = useCallback((...args: Parameters<typeof handleSessionUpdated>) => {
    handleSessionUpdated(...args);
    invalidateValidation();
  }, [handleSessionUpdated, invalidateValidation]);

  const handleSessionsSyncWithValidation = useCallback((...args: Parameters<typeof handleSessionsSync>) => {
    handleSessionsSync(...args);
    invalidateValidation();
  }, [handleSessionsSync, invalidateValidation]);

  // Wrap session paused handler to also disconnect lingering worker WebSocket connections
  const handleSessionPausedWithCleanup = useCallback((sessionId: string, pausedAt: string) => {
    // Disconnect all worker WebSocket connections for the paused session
    // to prevent them from attempting reconnection to a session that
    // no longer exists in server memory.
    disconnectSession(sessionId);
    handleSessionPaused(sessionId, pausedAt);
  }, [handleSessionPaused]);

  // Wrap worktree deletion completed handler to also invalidate worktree queries
  const handleWorktreeDeletionCompleted = useCallback((payload: WorktreeDeletionCompletedPayload) => {
    worktreeDeletionTasks.handleWorktreeDeletionCompleted(payload);
    // Invalidate all worktree queries to refresh dashboard
    queryClient.invalidateQueries({ queryKey: worktreeKeys.root() });
  }, [worktreeDeletionTasks, queryClient]);

  // Clear IndexedDB terminal cache when a worker is restarted.
  // The active (mounted) Terminal component handles its own cache clearing,
  // but unmounted workers on inactive tabs would retain stale cache entries.
  const handleWorkerRestarted = useCallback((sessionId: string, workerId: string) => {
    clearTerminalState(sessionId, workerId).catch((e) =>
      logger.warn('[RootLayout] Failed to clear terminal cache on worker restart:', e)
    );
  }, []);

  // Subscribe to app WebSocket events for real-time session updates
  useAppWsEvent({
    onSessionsSync: handleSessionsSyncWithValidation,
    onSessionCreated: handleSessionCreatedWithValidation,
    onSessionUpdated: handleSessionUpdatedWithValidation,
    onSessionDeleted: handleSessionDeletedWithValidation,
    onSessionPaused: handleSessionPausedWithCleanup,
    onSessionResumed: handleSessionResumed,
    onWorkerActivity: handleWorkerActivity,
    onWorkerRestarted: handleWorkerRestarted,
    onWorktreeCreationCompleted: worktreeCreationTasks.handleWorktreeCreationCompleted,
    onWorktreeCreationFailed: worktreeCreationTasks.handleWorktreeCreationFailed,
    onWorktreeDeletionCompleted: handleWorktreeDeletionCompleted,
    onWorktreeDeletionFailed: worktreeDeletionTasks.handleWorktreeDeletionFailed,
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

  // Update favicon based on worker activity states
  useEffect(() => {
    updateFavicon(hasAnyAskingWorker(workerActivityStates));
  }, [workerActivityStates]);

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

function ReviewNavLink() {
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

function LogoutButton() {
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
