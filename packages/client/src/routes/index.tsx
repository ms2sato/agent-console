import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchSessions,
  fetchRepositories,
  fetchWorktrees,
  fetchBranches,
  registerRepository,
  unregisterRepository,
  createSession,
  deleteSession,
  createWorktree,
  deleteWorktree,
  openPath,
} from '../lib/api';
import { useDashboardWebSocket } from '../hooks/useDashboardWebSocket';
import { formatPath } from '../lib/path';
import { AgentManagement } from '../components/AgentManagement';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { ErrorDialog, useErrorDialog } from '../components/ui/error-dialog';
import { AddRepositoryForm, CreateWorktreeForm, QuickSessionForm } from '../components/forms';
import type { Session, Repository, Worktree, AgentActivityState, CreateWorktreeRequest, CreateQuickSessionRequest, CreateRepositoryRequest } from '@agent-console/shared';

// Request notification permission on load
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// Show browser notification
function showNotification(title: string, body: string, sessionId: string, tag: string) {
  console.log(`[showNotification] permission=${Notification.permission}, title=${title}`);
  if ('Notification' in window && Notification.permission === 'granted') {
    const notification = new Notification(title, {
      body,
      icon: '/favicon.ico',
      tag, // Prevent duplicate notifications
    });
    console.log('[showNotification] Notification created');
    // Click to focus the session
    notification.onclick = () => {
      window.open(`/sessions/${sessionId}`, '_blank');
      notification.close();
    };
  } else {
    console.log('[showNotification] Permission not granted, skipping');
  }
}

// Activity state badge component
function ActivityBadge({ state }: { state?: AgentActivityState }) {
  if (!state || state === 'unknown') return null;

  const styles: Record<string, string> = {
    asking: 'bg-yellow-500/20 text-yellow-400',
    active: 'bg-blue-500/20 text-blue-400',
    idle: 'bg-gray-500/20 text-gray-400',
  };

  const labels: Record<string, string> = {
    asking: 'Waiting',
    active: 'Working',
    idle: 'Idle',
  };

  return (
    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${styles[state] ?? ''}`}>
      {labels[state] ?? state}
    </span>
  );
}

// Clickable path link component that opens the path in Finder/Explorer
function PathLink({ path, className = '' }: { path: string; className?: string }) {
  const handleClick = async () => {
    try {
      await openPath(path);
    } catch (err) {
      console.error('Failed to open path:', err);
    }
  };

  return (
    <span
      onClick={handleClick}
      className={`hover:text-blue-400 hover:underline cursor-pointer select-all ${className}`}
      title={`Open ${path} in Finder`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && handleClick()}
    >
      {formatPath(path)}
    </span>
  );
}

export const Route = createFileRoute('/')({
  component: DashboardPage,
});

// Helper to get primary agent worker's activity state
function getSessionActivityState(session: Session, workerActivityStates: Record<string, Record<string, AgentActivityState>>): AgentActivityState | undefined {
  const sessionWorkerStates = workerActivityStates[session.id];
  if (!sessionWorkerStates) return undefined;

  // Find the first agent worker
  const agentWorker = session.workers.find(w => w.type === 'agent');
  if (!agentWorker) return undefined;

  return sessionWorkerStates[agentWorker.id];
}

function DashboardPage() {
  const queryClient = useQueryClient();
  const [showAddRepo, setShowAddRepo] = useState(false);
  // Repository to unregister (for confirmation dialog)
  const [repoToUnregister, setRepoToUnregister] = useState<Repository | null>(null);
  // Track activity states locally for real-time updates: { sessionId: { workerId: state } }
  const [workerActivityStates, setWorkerActivityStates] = useState<Record<string, Record<string, AgentActivityState>>>({});
  // Track previous states for detecting completion (active → idle)
  const prevStatesRef = useRef<Record<string, Record<string, AgentActivityState>>>({});
  // Track when each worker entered 'active' state (for minimum working time check)
  const activeStartTimeRef = useRef<Record<string, number>>({});
  // Track last notification time per session (for cooldown)
  const lastNotificationTimeRef = useRef<Record<string, number>>({});

  // Notification thresholds
  const MIN_WORKING_TIME_MS = 5000; // 5 seconds minimum working time
  const NOTIFICATION_COOLDOWN_MS = 30000; // 30 seconds between notifications

  // Keep sessions data in ref for notification context
  const sessionsRef = useRef<Session[]>([]);

  // Request notification permission on component mount
  useEffect(() => {
    requestNotificationPermission();
  }, []);

  // Handle WebSocket sync (initializes prevStatesRef from server state)
  const handleSessionsSync = useCallback((sessions: Array<{ id: string; workers: Array<{ id: string; activityState?: AgentActivityState }> }>) => {
    console.log(`[Sync] Initializing ${sessions.length} sessions from WebSocket`);
    for (const session of sessions) {
      for (const worker of session.workers) {
        if (worker.activityState) {
          const key = `${session.id}:${worker.id}`;
          console.log(`[Sync] ${key}: ${worker.activityState}`);
          if (!prevStatesRef.current[session.id]) {
            prevStatesRef.current[session.id] = {};
          }
          prevStatesRef.current[session.id][worker.id] = worker.activityState;
          setWorkerActivityStates(prev => ({
            ...prev,
            [session.id]: { ...(prev[session.id] ?? {}), [worker.id]: worker.activityState! },
          }));
        }
      }
    }
  }, []);

  // Handle real-time activity updates via WebSocket
  // Note: ActivityDetector handles debouncing and sticky state transitions server-side
  const handleWorkerActivityUpdate = useCallback((sessionId: string, workerId: string, state: AgentActivityState) => {
    const key = `${sessionId}:${workerId}`;
    const prevState = prevStatesRef.current[sessionId]?.[workerId];
    const now = Date.now();

    console.log(`[Activity] ${key}: ${prevState} → ${state}`);

    // Update local state
    setWorkerActivityStates(prev => ({
      ...prev,
      [sessionId]: { ...(prev[sessionId] ?? {}), [workerId]: state },
    }));
    if (!prevStatesRef.current[sessionId]) {
      prevStatesRef.current[sessionId] = {};
    }
    prevStatesRef.current[sessionId][workerId] = state;

    // Track when worker enters 'active' state
    if (state === 'active' && prevState !== 'active') {
      activeStartTimeRef.current[key] = now;
      console.log(`[Activity] ${key}: Started working at ${now}`);
    }

    // Skip notifications if this is the first state update (session just started)
    if (!prevState) {
      console.log('[Notification] Skipped: initial state');
      return;
    }

    // Only notify when page is hidden (user is not looking)
    if (document.visibilityState !== 'hidden') {
      console.log('[Notification] Skipped: page is visible');
      return;
    }

    // Check cooldown (don't notify same session too frequently)
    const lastNotification = lastNotificationTimeRef.current[sessionId] || 0;
    if (now - lastNotification < NOTIFICATION_COOLDOWN_MS) {
      console.log(`[Notification] Skipped: cooldown (${now - lastNotification}ms < ${NOTIFICATION_COOLDOWN_MS}ms)`);
      return;
    }

    // Check if worker was working long enough
    const activeStartTime = activeStartTimeRef.current[key] || 0;
    const workingTime = now - activeStartTime;
    const wasWorkingLongEnough = prevState === 'active' && workingTime >= MIN_WORKING_TIME_MS;

    // Send notification for work completion (active → idle or active → asking)
    if (prevState === 'active' && (state === 'idle' || state === 'asking')) {
      if (!wasWorkingLongEnough) {
        console.log(`[Notification] Skipped: working time too short (${workingTime}ms < ${MIN_WORKING_TIME_MS}ms)`);
        return;
      }

      lastNotificationTimeRef.current[sessionId] = now;

      // Get session info for notification body
      const session = sessionsRef.current.find(s => s.id === sessionId);
      const locationPath = session?.locationPath || '';
      // Extract project name from path
      const pathParts = locationPath.split('/').filter(Boolean);
      const projectName = pathParts[pathParts.length - 1] || 'Unknown';

      if (state === 'idle') {
        console.log('[Notification] Triggering: work completed');
        showNotification(
          'Claude completed work',
          `${projectName} - Work completed`,
          sessionId,
          `completed-${sessionId}-${now}`
        );
      } else if (state === 'asking') {
        console.log('[Notification] Triggering: waiting for input');
        showNotification(
          'Claude needs your input',
          `${projectName} - Waiting for input`,
          sessionId,
          `asking-${sessionId}-${now}`
        );
      }
    }
  }, []);

  // Connect to dashboard WebSocket for real-time updates
  useDashboardWebSocket({
    onSync: handleSessionsSync,
    onWorkerActivity: handleWorkerActivityUpdate,
  });

  const { data: reposData } = useQuery({
    queryKey: ['repositories'],
    queryFn: fetchRepositories,
  });

  const { data: sessionsData } = useQuery({
    queryKey: ['sessions'],
    queryFn: fetchSessions,
    refetchInterval: 5000,
  });

  // Add activity state to sessions
  const sessions = (sessionsData?.sessions ?? []).map(session => ({
    ...session,
    activityState: getSessionActivityState(session, workerActivityStates),
  }));

  // Keep sessionsRef in sync for notification context
  useEffect(() => {
    sessionsRef.current = sessionsData?.sessions ?? [];
  }, [sessionsData]);

  const registerMutation = useMutation({
    mutationFn: registerRepository,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['repositories'] });
      setShowAddRepo(false);
    },
  });

  const unregisterMutation = useMutation({
    mutationFn: unregisterRepository,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['repositories'] });
    },
  });

  const repositories = reposData?.repositories ?? [];

  const handleAddRepo = async (data: CreateRepositoryRequest) => {
    await registerMutation.mutateAsync(data.path);
  };

  return (
    <div className="py-6 px-6">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <button
          onClick={() => setShowAddRepo(true)}
          className="btn btn-primary text-sm"
        >
          + Add Repository
        </button>
      </div>

      {showAddRepo && (
        <AddRepositoryForm
          isPending={registerMutation.isPending}
          onSubmit={handleAddRepo}
          onCancel={() => setShowAddRepo(false)}
        />
      )}

      {repositories.length === 0 ? (
        <div className="card text-center py-10">
          <p className="text-gray-500 mb-4">No repositories registered</p>
          <button
            onClick={() => setShowAddRepo(true)}
            className="btn btn-primary"
          >
            Add your first repository
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {repositories.map((repo) => (
            <RepositoryCard
              key={repo.id}
              repository={repo}
              sessions={sessions.filter((s) => s.type === 'worktree' && s.repositoryId === repo.id)}
              onUnregister={() => setRepoToUnregister(repo)}
            />
          ))}
        </div>
      )}

      {/* Quick Sessions (sessions without a registered repository) */}
      <QuickSessionsSection sessions={sessions.filter((s) => s.type === 'quick')} />

      {/* Settings Section */}
      <div className="mt-8">
        <h2 className="text-lg font-medium text-gray-400 mb-4">Settings</h2>
        <AgentManagement />
      </div>

      {/* Unregister Repository Confirmation */}
      <ConfirmDialog
        open={repoToUnregister !== null}
        onOpenChange={(open) => !open && setRepoToUnregister(null)}
        title="Unregister Repository"
        description={`Are you sure you want to unregister "${repoToUnregister?.name}"?`}
        confirmLabel="Unregister"
        onConfirm={() => {
          if (repoToUnregister) {
            unregisterMutation.mutate(repoToUnregister.id);
            setRepoToUnregister(null);
          }
        }}
      />
    </div>
  );
}

type SessionWithActivity = Session & {
  activityState?: AgentActivityState;
};

interface RepositoryCardProps {
  repository: Repository;
  sessions: SessionWithActivity[];
  onUnregister: () => void;
}

function RepositoryCard({ repository, sessions, onUnregister }: RepositoryCardProps) {
  const queryClient = useQueryClient();
  const [showCreateWorktree, setShowCreateWorktree] = useState(false);

  const { data: worktreesData } = useQuery({
    queryKey: ['worktrees', repository.id],
    queryFn: () => fetchWorktrees(repository.id),
  });

  const worktrees = worktreesData?.worktrees ?? [];

  const { data: branchesData } = useQuery({
    queryKey: ['branches', repository.id],
    queryFn: () => fetchBranches(repository.id),
    enabled: showCreateWorktree, // Only fetch when modal is open
  });

  const defaultBranch = branchesData?.defaultBranch || 'main';

  const createWorktreeMutation = useMutation({
    mutationFn: (params: CreateWorktreeRequest) =>
      createWorktree(repository.id, params),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['worktrees', repository.id] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setShowCreateWorktree(false);
      if (data.session) {
        window.open(`/sessions/${data.session.id}`, '_blank');
      }
    },
  });

  const handleCreateWorktree = async (request: CreateWorktreeRequest) => {
    await createWorktreeMutation.mutateAsync(request);
  };

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-medium">{repository.name}</h2>
          <PathLink path={repository.path} className="text-xs text-gray-500" />
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowCreateWorktree(true)}
            className="btn btn-primary text-sm"
          >
            + Worktree
          </button>
          <button onClick={onUnregister} className="btn btn-danger text-sm">
            Remove
          </button>
        </div>
      </div>

      {showCreateWorktree && (
        <CreateWorktreeForm
          defaultBranch={defaultBranch}
          isPending={createWorktreeMutation.isPending}
          onSubmit={handleCreateWorktree}
          onCancel={() => setShowCreateWorktree(false)}
        />
      )}

      {worktrees.length === 0 ? (
        <p className="text-sm text-gray-500">No worktrees</p>
      ) : (
        <div className="flex flex-col gap-2">
          {[...worktrees].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((worktree) => (
            <WorktreeRow
              key={worktree.path}
              worktree={worktree}
              session={sessions.find((s) => s.locationPath === worktree.path)}
              repositoryId={repository.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface WorktreeRowProps {
  worktree: Worktree;
  session?: SessionWithActivity;
  repositoryId: string;
}

function WorktreeRow({ worktree, session, repositoryId }: WorktreeRowProps) {
  const queryClient = useQueryClient();
  // Delete confirmation state: null = closed, 'normal' = regular delete, 'force' = force delete
  const [deleteConfirmType, setDeleteConfirmType] = useState<'normal' | 'force' | null>(null);
  const { errorDialogProps, showError } = useErrorDialog();

  const deleteWorktreeMutation = useMutation({
    mutationFn: (force: boolean) => deleteWorktree(repositoryId, worktree.path, force),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['worktrees', repositoryId] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setDeleteConfirmType(null);
    },
    onError: (error: Error, force: boolean) => {
      // If deletion failed without force and error mentions untracked/modified files, offer force delete
      if (!force && error.message.includes('untracked')) {
        setDeleteConfirmType('force');
      } else {
        setDeleteConfirmType(null);
        showError('Delete Failed', error.message);
      }
    },
  });

  const handleDeleteWorktree = () => {
    if (worktree.isMain) {
      showError('Cannot Delete', 'Cannot delete main worktree');
      return;
    }
    setDeleteConfirmType('normal');
  };

  const executeDelete = (force: boolean) => {
    deleteWorktreeMutation.mutate(force);
  };

  const statusColor = session
    ? session.status === 'active'
      ? 'bg-green-500'
      : 'bg-gray-500'
    : 'bg-gray-600';

  return (
    <div className="flex items-center gap-3 p-2 bg-slate-800 rounded">
      {/* Index number - 0 for main, 1+ for worktrees */}
      <span className="w-6 text-center text-sm font-mono text-gray-500 shrink-0">
        {worktree.index !== undefined ? worktree.index : '0'}
      </span>
      <span className={`inline-block w-2 h-2 rounded-full ${statusColor} shrink-0`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium flex items-center gap-2">
          {session?.title && (
            <>
              <span className="truncate" title={session.title}>{session.title}</span>
              <span className="text-gray-500">-</span>
            </>
          )}
          <span className={session?.title ? 'text-gray-400' : ''}>{worktree.branch}</span>
          {worktree.isMain && (
            <span className="text-xs text-gray-500">(primary)</span>
          )}
          {session && <ActivityBadge state={session.activityState} />}
        </div>
        <PathLink path={worktree.path} className="text-xs text-gray-500 truncate" />
      </div>
      <div className="flex gap-2 shrink-0">
        {session && (
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: session.id }}
            className="btn btn-primary text-xs no-underline"
          >
            Open
          </Link>
        )}
        {!worktree.isMain && (
          <button
            onClick={handleDeleteWorktree}
            disabled={deleteWorktreeMutation.isPending}
            className="btn btn-danger text-xs"
          >
            Delete
          </button>
        )}
      </div>

      {/* Delete Worktree Confirmation */}
      <ConfirmDialog
        open={deleteConfirmType !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteConfirmType(null);
          }
        }}
        title={deleteConfirmType === 'force' ? 'Force Delete Worktree' : 'Delete Worktree'}
        description={
          deleteConfirmType === 'force'
            ? `Worktree has untracked files. Force delete "${worktree.branch}"?`
            : session
              ? `Delete worktree "${worktree.branch}"? This will also terminate the running session.`
              : `Delete worktree "${worktree.branch}"?`
        }
        confirmLabel={deleteConfirmType === 'force' ? 'Force Delete' : 'Delete'}
        variant="danger"
        onConfirm={() => executeDelete(deleteConfirmType === 'force' || session !== undefined)}
        isLoading={deleteWorktreeMutation.isPending}
      />
      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}

interface QuickSessionsSectionProps {
  sessions: SessionWithActivity[];
}

function QuickSessionsSection({ sessions }: QuickSessionsSectionProps) {
  const queryClient = useQueryClient();
  const [showAddSession, setShowAddSession] = useState(false);

  const createSessionMutation = useMutation({
    mutationFn: createSession,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setShowAddSession(false);
      window.open(`/sessions/${data.session.id}`, '_blank');
    },
  });

  const handleStartSession = async (data: CreateQuickSessionRequest) => {
    await createSessionMutation.mutateAsync(data);
  };

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-medium text-gray-400">Quick Sessions</h2>
        <button
          onClick={() => setShowAddSession(true)}
          className="btn text-sm bg-slate-700 hover:bg-slate-600"
        >
          + Quick Start
        </button>
      </div>

      {showAddSession && (
        <QuickSessionForm
          isPending={createSessionMutation.isPending}
          onSubmit={handleStartSession}
          onCancel={() => setShowAddSession(false)}
        />
      )}

      {sessions.length === 0 && !showAddSession && (
        <p className="text-sm text-gray-500">
          Start a Claude session in any directory without setting up a worktree.
        </p>
      )}

      {sessions.length > 0 && (
        <div className="flex flex-col gap-3">
          {sessions.map((session) => (
            <SessionCard key={session.id} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}

interface SessionCardProps {
  session: SessionWithActivity;
}

function SessionCard({ session }: SessionCardProps) {
  const queryClient = useQueryClient();
  const [showStopConfirm, setShowStopConfirm] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: deleteSession,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setShowStopConfirm(false);
    },
  });

  const statusColor =
    session.status === 'active'
      ? 'bg-green-500'
      : 'bg-gray-500';

  return (
    <>
      <div className="card flex items-center gap-4">
        <span className={`inline-block w-2.5 h-2.5 rounded-full ${statusColor} shrink-0`} />
        <div className="flex-1 min-w-0">
          {session.title && (
            <div className="text-sm font-medium text-gray-200 truncate" title={session.title}>
              {session.title}
            </div>
          )}
          <div className="text-sm text-gray-200 overflow-hidden text-ellipsis whitespace-nowrap flex items-center gap-2">
            <PathLink path={session.locationPath} className="truncate" />
            <ActivityBadge state={session.activityState} />
          </div>
          <div className="text-xs text-gray-500 mt-1">
            Workers: {session.workers.length} | Started: {new Date(session.createdAt).toLocaleString()}
          </div>
        </div>
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: session.id }}
          className="btn btn-primary text-sm no-underline"
        >
          Open
        </Link>
        <button
          onClick={() => setShowStopConfirm(true)}
          className="btn btn-danger text-sm"
        >
          Stop
        </button>
      </div>

      <ConfirmDialog
        open={showStopConfirm}
        onOpenChange={setShowStopConfirm}
        title="Stop Session"
        description="Are you sure you want to stop this session?"
        confirmLabel="Stop"
        variant="danger"
        onConfirm={() => deleteMutation.mutate(session.id)}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
}
