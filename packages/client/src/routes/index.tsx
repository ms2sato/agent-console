import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchRepositories,
  fetchWorktrees,
  fetchBranches,
  registerRepository,
  unregisterRepository,
  createSession,
  deleteSession,
  createWorktreeAsync,
  deleteWorktreeAsync,
  openPath,
  openInVSCode,
} from '../lib/api';
import { useAppWsEvent, useAppWsState } from '../hooks/useAppWs';
import { emitSessionDeleted } from '../lib/app-websocket';
import { disconnectSession as disconnectWorkerWebSockets } from '../lib/worker-websocket.js';
import { formatPath } from '../lib/path';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { ErrorDialog, useErrorDialog } from '../components/ui/error-dialog';
import { GitHubIcon, VSCodeIcon } from '../components/Icons';
import { hasVSCode } from '../lib/capabilities';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
} from '../components/ui/alert-dialog';
import { AddRepositoryForm } from '../components/repositories';
import { CreateWorktreeForm, type CreateWorktreeFormRequest } from '../components/worktrees';
import { QuickSessionForm } from '../components/sessions';
import { useWorktreeCreationTasksContext, useWorktreeDeletionTasksContext } from './__root';
import type { Session, Repository, Worktree, AgentActivityState, CreateQuickSessionRequest, CreateRepositoryRequest, CreateWorktreeSessionRequest, WorkerActivityInfo, BranchNameFallback, AgentDefinition, SetupCommandResult } from '@agent-console/shared';

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
      window.open(`/sessions/${sessionId}`, '_blank', 'noopener,noreferrer');
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
  const [showAddSession, setShowAddSession] = useState(false);
  // Repository to unregister (for confirmation dialog)
  const [repoToUnregister, setRepoToUnregister] = useState<Repository | null>(null);
  // Sessions from WebSocket (source of truth)
  const [wsSessions, setWsSessions] = useState<Session[]>([]);
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

  // Handle WebSocket sync (initializes sessions and activity states)
  const handleSessionsSync = useCallback((sessions: Session[], activityStates: WorkerActivityInfo[]) => {
    console.log(`[Sync] Initializing ${sessions.length} sessions from WebSocket`);

    // Update sessions list
    setWsSessions(sessions);
    sessionsRef.current = sessions;

    // Build the full state first to avoid race condition
    const newActivityStates: Record<string, Record<string, AgentActivityState>> = {};
    const newPrevStates: Record<string, Record<string, AgentActivityState>> = {};

    for (const { sessionId, workerId, activityState } of activityStates) {
      const key = `${sessionId}:${workerId}`;
      console.log(`[Sync] ${key}: ${activityState}`);
      if (!newActivityStates[sessionId]) {
        newActivityStates[sessionId] = {};
        newPrevStates[sessionId] = {};
      }
      newActivityStates[sessionId][workerId] = activityState;
      newPrevStates[sessionId][workerId] = activityState;
    }

    // Update state atomically
    setWorkerActivityStates(newActivityStates);
    prevStatesRef.current = newPrevStates;
  }, []);

  // Handle new session created
  const handleSessionCreated = useCallback((session: Session) => {
    console.log(`[Session] Created: ${session.id}`);
    setWsSessions(prev => [...prev, session]);
    sessionsRef.current = [...sessionsRef.current, session];
  }, []);

  // Handle session updated
  const handleSessionUpdated = useCallback((session: Session) => {
    console.log(`[Session] Updated: ${session.id}`);
    setWsSessions(prev => prev.map(s => s.id === session.id ? session : s));
    sessionsRef.current = sessionsRef.current.map(s => s.id === session.id ? session : s);
  }, []);

  // Handle session deleted
  const handleSessionDeleted = useCallback((sessionId: string) => {
    console.log(`[Session] Deleted: ${sessionId}`);
    setWsSessions(prev => prev.filter(s => s.id !== sessionId));
    sessionsRef.current = sessionsRef.current.filter(s => s.id !== sessionId);
    // Clean up activity states for this session
    setWorkerActivityStates(prev => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    delete prevStatesRef.current[sessionId];
    // Clean up notification tracking refs to prevent memory leak
    Object.keys(activeStartTimeRef.current).forEach(key => {
      if (key.startsWith(`${sessionId}:`)) {
        delete activeStartTimeRef.current[key];
      }
    });
    delete lastNotificationTimeRef.current[sessionId];
    // Disconnect all worker WebSockets for this session
    disconnectWorkerWebSockets(sessionId);
  }, []);

  // Handle initial agent sync from WebSocket
  const handleAgentsSync = useCallback((agents: AgentDefinition[]) => {
    console.log(`[Sync] Initializing ${agents.length} agents from WebSocket`);
    queryClient.setQueryData(['agents'], { agents });
  }, [queryClient]);

  // Handle new agent created
  const handleAgentCreated = useCallback((agent: AgentDefinition) => {
    console.log(`[Agent] Created: ${agent.id}`);
    queryClient.setQueryData<{ agents: AgentDefinition[] } | undefined>(['agents'], (old) => {
      if (!old) return { agents: [agent] };
      return { agents: [...old.agents, agent] };
    });
  }, [queryClient]);

  // Handle agent updated
  const handleAgentUpdated = useCallback((agent: AgentDefinition) => {
    console.log(`[Agent] Updated: ${agent.id}`);
    // Update list cache
    queryClient.setQueryData<{ agents: AgentDefinition[] } | undefined>(['agents'], (old) => {
      if (!old) return { agents: [agent] };
      return { agents: old.agents.map(a => a.id === agent.id ? agent : a) };
    });
    // Update individual agent cache for detail/edit pages
    queryClient.setQueryData(['agent', agent.id], { agent });
  }, [queryClient]);

  // Handle agent deleted
  const handleAgentDeleted = useCallback((agentId: string) => {
    console.log(`[Agent] Deleted: ${agentId}`);
    // Update list cache
    queryClient.setQueryData<{ agents: AgentDefinition[] } | undefined>(['agents'], (old) => {
      if (!old) return old;
      return { agents: old.agents.filter(a => a.id !== agentId) };
    });
    // Invalidate individual agent cache to trigger refetch (will 404)
    queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
  }, [queryClient]);

  // Handle initial repository sync from WebSocket
  const handleRepositoriesSync = useCallback(() => {
    console.log('[Sync] Repositories sync received');
    queryClient.invalidateQueries({ queryKey: ['repositories'] });
  }, [queryClient]);

  // Handle new repository created
  const handleRepositoryCreated = useCallback(() => {
    console.log('[Repository] Created');
    queryClient.invalidateQueries({ queryKey: ['repositories'] });
  }, [queryClient]);

  // Handle repository deleted
  const handleRepositoryDeleted = useCallback(() => {
    console.log('[Repository] Deleted');
    queryClient.invalidateQueries({ queryKey: ['repositories'] });
  }, [queryClient]);

  // Handle repository updated
  const handleRepositoryUpdated = useCallback((repository: Repository) => {
    console.log(`[Repository] Updated: ${repository.id}`);
    queryClient.setQueryData<{ repositories: Repository[] } | undefined>(['repositories'], (old) => {
      if (!old) return old;
      return { repositories: old.repositories.map(r => r.id === repository.id ? repository : r) };
    });
  }, [queryClient]);

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
      if (!session) {
        console.log('[Notification] Skipped: session no longer exists');
        return;
      }
      // Extract project name from path
      const pathParts = session.locationPath.split('/').filter(Boolean);
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

  // Connect to app WebSocket for real-time updates
  useAppWsEvent({
    onSessionsSync: handleSessionsSync,
    onSessionCreated: handleSessionCreated,
    onSessionUpdated: handleSessionUpdated,
    onSessionDeleted: handleSessionDeleted,
    onWorkerActivity: handleWorkerActivityUpdate,
    onAgentsSync: handleAgentsSync,
    onAgentCreated: handleAgentCreated,
    onAgentUpdated: handleAgentUpdated,
    onAgentDeleted: handleAgentDeleted,
    onRepositoriesSync: handleRepositoriesSync,
    onRepositoryCreated: handleRepositoryCreated,
    onRepositoryDeleted: handleRepositoryDeleted,
    onRepositoryUpdated: handleRepositoryUpdated,
  });
  const sessionsSynced = useAppWsState(s => s.sessionsSynced);

  const { data: reposData } = useQuery({
    queryKey: ['repositories'],
    queryFn: fetchRepositories,
  });

  // Add activity state to sessions
  const sessions = wsSessions.map(session => ({
    ...session,
    activityState: getSessionActivityState(session, workerActivityStates),
  }));

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

  const createSessionMutation = useMutation({
    mutationFn: createSession,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setShowAddSession(false);
      window.open(`/sessions/${data.session.id}`, '_blank', 'noopener,noreferrer');
    },
  });

  const handleStartSession = async (data: CreateQuickSessionRequest) => {
    await createSessionMutation.mutateAsync(data);
  };

  // Show loading state until first WebSocket sync
  if (!sessionsSynced) {
    return (
      <div className="py-6 px-6">
        <div className="flex items-center justify-between mb-5">
          <h1 className="text-2xl font-semibold">Dashboard</h1>
        </div>
        <div className="flex items-center justify-center py-20">
          <div className="text-gray-400">Loading sessions...</div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="py-6 px-6">
        <div className="flex items-center justify-between mb-5">
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <div className="flex gap-2">
            <button
              onClick={() => setShowAddSession(true)}
              className="btn text-sm bg-slate-700 hover:bg-slate-600"
            >
              + Quick Start
            </button>
            <button
              onClick={() => setShowAddRepo(true)}
              className="btn btn-primary text-sm"
            >
              + Add Repository
            </button>
          </div>
        </div>

      {showAddRepo && (
        <AddRepositoryForm
          isPending={registerMutation.isPending}
          onSubmit={handleAddRepo}
          onCancel={() => setShowAddRepo(false)}
        />
      )}

      {showAddSession && (
        <QuickSessionForm
          isPending={createSessionMutation.isPending}
          onSubmit={handleStartSession}
          onCancel={() => setShowAddSession(false)}
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
    </>
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
  const [showCreateWorktree, setShowCreateWorktree] = useState(false);
  const [fallbackInfo, setFallbackInfo] = useState<BranchNameFallback | null>(null);
  const [setupCommandFailure, setSetupCommandFailure] = useState<SetupCommandResult | null>(null);
  const { errorDialogProps, showError: showWorktreeError } = useErrorDialog();
  const { addTask, removeTask } = useWorktreeCreationTasksContext();
  const isGitHubRemote = Boolean(
    repository.remoteUrl &&
      (repository.remoteUrl.startsWith('git@github.com:') ||
        repository.remoteUrl.startsWith('https://github.com/') ||
        repository.remoteUrl.startsWith('http://github.com/') ||
        repository.remoteUrl.startsWith('ssh://git@github.com/'))
  );

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

  // Async worktree creation - returns immediately after API accepts the request
  const handleCreateWorktree = async (formRequest: CreateWorktreeFormRequest) => {
    const taskId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    // Build full request with taskId for storage and API
    const request = { ...formRequest, taskId };

    try {
      // Add task to UI immediately
      addTask({
        id: taskId,
        repositoryId: repository.id,
        repositoryName: repository.name,
        request,
      });

      // Call async API (returns { accepted: true })
      await createWorktreeAsync(repository.id, request);

      // Close the form immediately - task shows in sidebar
      setShowCreateWorktree(false);
    } catch (error) {
      // If API call fails immediately (e.g., network error), remove the task and show error dialog
      removeTask(taskId);
      showWorktreeError('Failed to Create Worktree', error instanceof Error ? error.message : 'Unknown error');
    }
  };

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-medium">{repository.name}</h2>
            {isGitHubRemote && (
              <a
                href={`/api/repositories/${repository.id}/github`}
                target="_blank"
                rel="noreferrer"
                className="text-gray-400 hover:text-gray-200"
                aria-label={`${repository.name} on GitHub`}
                title="Open on GitHub"
              >
                <GitHubIcon className="w-4 h-4" />
              </a>
            )}
          </div>
          <PathLink path={repository.path} className="text-xs text-gray-500" />
        </div>
        <div className="flex gap-2">
          {hasVSCode() && (
            <button
              onClick={async () => {
                try {
                  await openInVSCode(repository.path);
                } catch (err) {
                  console.error('Failed to open in VS Code:', err);
                }
              }}
              className="btn text-sm bg-slate-700 hover:bg-slate-600"
              title="Open in VS Code"
            >
              <VSCodeIcon className="w-4 h-4" />
            </button>
          )}
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
          repositoryId={repository.id}
          defaultBranch={defaultBranch}
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

      <BranchNameFallbackDialog
        fallbackInfo={fallbackInfo}
        onClose={() => setFallbackInfo(null)}
      />

      <SetupCommandFailureDialog
        result={setupCommandFailure}
        onClose={() => setSetupCommandFailure(null)}
      />

      <ErrorDialog {...errorDialogProps} />
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
  const navigate = useNavigate();
  // Delete confirmation state: null = closed, 'normal' = regular delete, 'force' = force delete
  const [deleteConfirmType, setDeleteConfirmType] = useState<'normal' | 'force' | null>(null);
  const { errorDialogProps, showError } = useErrorDialog();
  const { addTask, markAsFailed } = useWorktreeDeletionTasksContext();

  const restoreSessionMutation = useMutation({
    mutationFn: (request: CreateWorktreeSessionRequest) => createSession(request),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      navigate({ to: '/sessions/$sessionId', params: { sessionId: data.session.id } });
    },
    onError: (error: Error) => {
      showError('Restore Failed', error.message);
    },
  });

  const handleRestoreSession = () => {
    restoreSessionMutation.mutate({
      type: 'worktree',
      repositoryId: worktree.repositoryId,
      worktreeId: worktree.branch,
      locationPath: worktree.path,
      continueConversation: true,
    });
  };

  const handleDeleteWorktree = () => {
    if (worktree.isMain) {
      showError('Cannot Delete', 'Cannot delete main worktree');
      return;
    }
    setDeleteConfirmType('normal');
  };

  const executeDelete = async (force: boolean) => {
    // Generate task ID
    const taskId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    // Use session ID if available, otherwise generate a synthetic one for the task
    const effectiveSessionId = session?.id ?? `no-session-${taskId}`;
    const sessionTitle = session?.title || worktree.branch;

    // Add task to sidebar
    addTask({
      id: taskId,
      sessionId: effectiveSessionId,
      sessionTitle,
      repositoryId,
      worktreePath: worktree.path,
    });

    // Close the dialog
    setDeleteConfirmType(null);

    // Emit session-deleted locally for immediate UI update if session exists
    if (session) {
      emitSessionDeleted(session.id);
    }

    try {
      // Call async API
      await deleteWorktreeAsync(repositoryId, worktree.path, taskId, force);
      // Success/failure will be handled via WebSocket events
    } catch (err) {
      // If API call fails immediately (network error), mark task as failed
      const message = err instanceof Error ? err.message : 'Failed to delete worktree';
      markAsFailed(taskId, message);
    }
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
          {hasVSCode() && (
            <button
              onClick={async (e) => {
                e.stopPropagation();
                try {
                  await openInVSCode(worktree.path);
                } catch (err) {
                  console.error('Failed to open in VS Code:', err);
                }
              }}
              className="p-1 text-gray-400 hover:text-white hover:bg-slate-700 rounded"
              title="Open in VS Code"
            >
              <VSCodeIcon className="w-4 h-4" />
            </button>
          )}
          {session && <ActivityBadge state={session.activityState} />}
        </div>
        <PathLink path={worktree.path} className="text-xs text-gray-500 truncate" />
      </div>
      <div className="flex gap-2 shrink-0">
        {session ? (
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: session.id }}
            className="btn btn-primary text-xs no-underline"
          >
            Open
          </Link>
        ) : (
          <button
            onClick={handleRestoreSession}
            disabled={restoreSessionMutation.isPending}
            className="btn btn-primary text-xs"
          >
            {restoreSessionMutation.isPending ? 'Restoring...' : 'Restore'}
          </button>
        )}
        {!worktree.isMain && (
          <button
            onClick={handleDeleteWorktree}
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
      />
      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}

interface QuickSessionsSectionProps {
  sessions: SessionWithActivity[];
}

function QuickSessionsSection({ sessions }: QuickSessionsSectionProps) {
  return (
    <div className="mt-8">
      <h2 className="text-lg font-medium text-gray-400 mb-4">Quick Sessions</h2>

      {sessions.length === 0 && (
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
      // Emit session-deleted locally for immediate UI update
      // WebSocket event will arrive later but will be processed idempotently
      emitSessionDeleted(session.id);
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

// =============================================================================
// Branch Name Fallback Dialog
// =============================================================================

interface BranchNameFallbackDialogProps {
  fallbackInfo: BranchNameFallback | null;
  onClose: () => void;
}

function BranchNameFallbackDialog({ fallbackInfo, onClose }: BranchNameFallbackDialogProps) {
  return (
    <AlertDialog open={fallbackInfo !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Branch Name Generation Failed</AlertDialogTitle>
          <AlertDialogDescription className="space-y-3">
            <p>
              AI-based branch name generation failed. A fallback branch name was used instead.
            </p>
            <div className="bg-slate-900 rounded p-3 text-sm">
              <div className="text-gray-300">
                <span className="text-gray-500">Branch: </span>
                <code className="text-amber-400">{fallbackInfo?.usedBranch}</code>
              </div>
              <div className="mt-2 text-gray-300">
                <span className="text-gray-500">Reason: </span>
                <span className="text-red-400">{fallbackInfo?.reason}</span>
              </div>
            </div>
            <p className="text-xs text-gray-500">
              You can rename the branch later from the session settings.
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={onClose}>
            OK
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// =============================================================================
// Setup Command Failure Dialog
// =============================================================================

interface SetupCommandFailureDialogProps {
  result: SetupCommandResult | null;
  onClose: () => void;
}

function SetupCommandFailureDialog({ result, onClose }: SetupCommandFailureDialogProps) {
  return (
    <AlertDialog open={result !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-red-400">Setup Command Failed</AlertDialogTitle>
          <AlertDialogDescription className="space-y-3">
            <p>
              The worktree was created successfully, but the setup command failed to execute.
            </p>
            <div className="bg-slate-900 rounded p-3 text-sm max-h-60 overflow-auto">
              {result?.error && (
                <div className="text-red-400 font-mono whitespace-pre-wrap">
                  {result.error}
                </div>
              )}
              {result?.output && (
                <div className="text-gray-400 font-mono whitespace-pre-wrap mt-2 border-t border-slate-700 pt-2">
                  <span className="text-gray-500 text-xs">Output:</span>
                  <pre className="mt-1">{result.output}</pre>
                </div>
              )}
            </div>
            <p className="text-xs text-gray-500">
              You can run the setup command manually in the terminal, or check the repository settings.
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={onClose}>
            OK
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
