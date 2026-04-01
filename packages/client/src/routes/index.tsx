import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchRepositories,
  fetchWorktrees,
  fetchBranches,
  registerRepository,
  unregisterRepository,
  createSession,
  deleteSession,
  resumeSession,
  deleteWorktreeAsync,
  pullWorktreeAsync,
  openPath,
  openInVSCode,
  updateRepository,
  generateRepositoryDescription,
} from '../lib/api';
import { useAppWsEvent } from '../hooks/useAppWs';
import { useCreateWorktree } from '../hooks/useCreateWorktree';
import { emitSessionDeleted } from '../lib/app-websocket';
import { generateTaskId } from '../lib/id';
import { formatPath } from '../lib/path';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { ErrorDialog, useErrorDialog } from '../components/ui/error-dialog';
import { GitHubIcon, VSCodeIcon } from '../components/Icons';
import { Spinner } from '../components/ui/Spinner';
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
import { AddRepositoryForm, type AddRepositoryFormSubmitData } from '../components/repositories';
import { CreateWorktreeForm, type CreateWorktreeFormRequest } from '../components/worktrees';
import { QuickSessionForm } from '../components/sessions';
import { useWorktreeDeletionTasksContext, useSessionDataContext } from './__root';
import { repositoryKeys, agentKeys, sessionKeys, worktreeKeys, branchKeys } from '../lib/query-keys';
import type { Session, Repository, Worktree, AgentActivityState, CreateQuickSessionRequest, CreateWorktreeSessionRequest, BranchNameFallback, AgentDefinition, HookCommandResult, WorktreePullCompletedPayload, WorktreePullFailedPayload } from '@agent-console/shared';
import { logger } from '../lib/logger';

// Timeout (ms) to auto-remove stale pull entries if WebSocket never responds
const PULL_TIMEOUT_MS = 60_000;

// Request notification permission on load
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// Show browser notification
function showNotification(title: string, body: string, sessionId: string, tag: string) {
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  logger.debug(`[showNotification] permission=${permission}, title=${title}`);
  if (permission === 'granted') {
    const notification = new Notification(title, {
      body,
      icon: '/favicon.ico',
      tag, // Prevent duplicate notifications
    });
    logger.debug('[showNotification] Notification created');
    // Click to focus the session
    notification.onclick = () => {
      window.open(`/sessions/${sessionId}`, '_blank', 'noopener,noreferrer');
      notification.close();
    };
  } else {
    logger.debug('[showNotification] Permission not granted, skipping');
  }
}

// Activity state badge component
function ActivityBadge({ state }: { state?: AgentActivityState }) {
  if (!state || state === 'unknown') return null;

  const styles = {
    asking: 'bg-yellow-500/20 text-yellow-400',
    active: 'bg-blue-500/20 text-blue-400',
    idle: 'bg-gray-500/20 text-gray-400',
    unknown: '',
  } satisfies Record<AgentActivityState, string>;

  const labels = {
    asking: 'Waiting',
    active: 'Working',
    idle: 'Idle',
    unknown: '',
  } satisfies Record<AgentActivityState, string>;

  return (
    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${styles[state]}`}>
      {labels[state] || state}
    </span>
  );
}

// Clickable path link component that opens the path in Finder/Explorer
function PathLink({ path, className = '' }: { path: string; className?: string }) {
  const handleClick = async () => {
    try {
      await openPath(path);
    } catch (err) {
      logger.error('Failed to open path:', err);
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
  const navigate = useNavigate();
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [showAddSession, setShowAddSession] = useState(false);
  // Repository to unregister (for confirmation dialog)
  const [repoToUnregister, setRepoToUnregister] = useState<Repository | null>(null);

  // Session data from root layout (single source of truth)
  const { sessions: allSessions, wsInitialized, workerActivityStates } = useSessionDataContext();

  // Derive active sessions (not paused) from root context
  const activeSessions = useMemo(() => allSessions.filter(s => !s.pausedAt), [allSessions]);

  // Derive paused sessions keyed by worktree path (for "Resume" button on worktree cards)
  const pausedSessions = useMemo(() => {
    const result: Record<string, Session> = {};
    for (const session of allSessions) {
      if (session.pausedAt && session.type === 'worktree') {
        result[session.locationPath] = session;
      }
    }
    return result;
  }, [allSessions]);

  // Track previous activity states for detecting completion (active -> idle) for notifications
  const prevStatesRef = useRef<Record<string, Record<string, AgentActivityState>>>({});
  // Track when each worker entered 'active' state (for minimum working time check)
  const activeStartTimeRef = useRef<Record<string, number>>({});
  // Track last notification time per session (for cooldown)
  const lastNotificationTimeRef = useRef<Record<string, number>>({});
  // Track active pull operations: worktreePath -> { taskId, timeoutId }
  const [activePulls, setActivePulls] = useState<Map<string, { taskId: string; timeoutId: ReturnType<typeof setTimeout> }>>(new Map());
  const activePullsRef = useRef(activePulls);
  activePullsRef.current = activePulls;
  const [pullSuccessMessage, setPullSuccessMessage] = useState<string | null>(null);
  const { errorDialogProps: pullErrorDialogProps, showError: showPullError } = useErrorDialog();

  // Track component mount state for guarding async state updates
  const isMountedRef = useRef(true);

  // Remove a pull entry from activePulls, clearing its timeout
  const removePull = useCallback((worktreePath: string) => {
    setActivePulls(prev => {
      const entry = prev.get(worktreePath);
      if (entry) clearTimeout(entry.timeoutId);
      const next = new Map(prev);
      next.delete(worktreePath);
      return next;
    });
  }, []);

  // Cleanup all pull timeouts on unmount and mark as unmounted
  // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup on unmount only
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      activePullsRef.current.forEach(entry => clearTimeout(entry.timeoutId));
    };
  }, []);

  // Notification thresholds
  const MIN_WORKING_TIME_MS = 5000; // 5 seconds minimum working time
  const NOTIFICATION_COOLDOWN_MS = 30000; // 30 seconds between notifications

  // Keep active sessions in ref for notification context (finding session info during callbacks)
  const sessionsRef = useRef<Session[]>([]);
  sessionsRef.current = activeSessions;

  // Request notification permission on component mount
  useEffect(() => {
    requestNotificationPermission();
  }, []);

  // Handle initial agent sync from WebSocket
  const handleAgentsSync = useCallback((agents: AgentDefinition[]) => {
    logger.debug(`[Sync] Initializing ${agents.length} agents from WebSocket`);
    queryClient.setQueryData(agentKeys.all(), { agents });
  }, [queryClient]);

  // Handle new agent created
  const handleAgentCreated = useCallback((agent: AgentDefinition) => {
    logger.debug(`[Agent] Created: ${agent.id}`);
    queryClient.setQueryData<{ agents: AgentDefinition[] } | undefined>(agentKeys.all(), (old) => {
      if (!old) return { agents: [agent] };
      return { agents: [...old.agents, agent] };
    });
  }, [queryClient]);

  // Handle agent updated
  const handleAgentUpdated = useCallback((agent: AgentDefinition) => {
    logger.debug(`[Agent] Updated: ${agent.id}`);
    // Update list cache
    queryClient.setQueryData<{ agents: AgentDefinition[] } | undefined>(agentKeys.all(), (old) => {
      if (!old) return { agents: [agent] };
      return { agents: old.agents.map(a => a.id === agent.id ? agent : a) };
    });
    // Update individual agent cache for detail/edit pages
    queryClient.setQueryData(agentKeys.detail(agent.id), { agent });
  }, [queryClient]);

  // Handle agent deleted
  const handleAgentDeleted = useCallback((agentId: string) => {
    logger.debug(`[Agent] Deleted: ${agentId}`);
    // Update list cache
    queryClient.setQueryData<{ agents: AgentDefinition[] } | undefined>(agentKeys.all(), (old) => {
      if (!old) return old;
      return { agents: old.agents.filter(a => a.id !== agentId) };
    });
    // Invalidate individual agent cache to trigger refetch (will 404)
    queryClient.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
  }, [queryClient]);

  // Handle initial repository sync from WebSocket
  const handleRepositoriesSync = useCallback(() => {
    logger.debug('[Sync] Repositories sync received');
    queryClient.invalidateQueries({ queryKey: repositoryKeys.all() });
  }, [queryClient]);

  // Handle new repository created
  const handleRepositoryCreated = useCallback(() => {
    logger.debug('[Repository] Created');
    queryClient.invalidateQueries({ queryKey: repositoryKeys.all() });
  }, [queryClient]);

  // Handle repository deleted
  const handleRepositoryDeleted = useCallback((repositoryId: string) => {
    logger.debug(`[Repository] Deleted: ${repositoryId}`);
    queryClient.invalidateQueries({ queryKey: repositoryKeys.all() });
    queryClient.invalidateQueries({ queryKey: repositoryKeys.detail(repositoryId) });
  }, [queryClient]);

  // Handle repository updated
  const handleRepositoryUpdated = useCallback((repository: Repository) => {
    logger.debug(`[Repository] Updated: ${repository.id}`);
    queryClient.setQueryData<{ repositories: Repository[] } | undefined>(repositoryKeys.all(), (old) => {
      if (!old) return old;
      return { repositories: old.repositories.map(r => r.id === repository.id ? repository : r) };
    });
    // Invalidate detail cache to refetch with full server-shaped response (includes remoteUrl)
    queryClient.invalidateQueries({ queryKey: repositoryKeys.detail(repository.id) });
  }, [queryClient]);

  // Handle worktree pull completed
  const handleWorktreePullCompleted = useCallback((payload: WorktreePullCompletedPayload) => {
    logger.debug(`[Pull] Completed: ${payload.worktreePath} (${payload.commitsPulled} commits)`);
    const active = activePullsRef.current.get(payload.worktreePath);
    if (!active || active.taskId !== payload.taskId) return;
    removePull(payload.worktreePath);
    // Show success notification
    const message = payload.commitsPulled === 0
      ? 'Already up to date.'
      : `Pulled ${payload.commitsPulled} commit${payload.commitsPulled === 1 ? '' : 's'} on ${payload.branch}.`;
    setPullSuccessMessage(message);
    // Refresh worktree data to reflect pulled changes
    queryClient.invalidateQueries({ queryKey: worktreeKeys.root() });
  }, [queryClient, removePull]);

  // Handle worktree pull failed
  const handleWorktreePullFailed = useCallback((payload: WorktreePullFailedPayload) => {
    logger.debug(`[Pull] Failed: ${payload.worktreePath} - ${payload.error}`);
    const active = activePullsRef.current.get(payload.worktreePath);
    if (!active || active.taskId !== payload.taskId) return;
    removePull(payload.worktreePath);
    showPullError('Pull Failed', payload.error);
  }, [removePull, showPullError]);

  // Handle pull worktree request from WorktreeRow
  const handlePullWorktree = useCallback(async (repositoryId: string, worktreePath: string) => {
    const taskId = generateTaskId();
    // Set a timeout to auto-remove the entry if WebSocket never responds
    const timeoutId = setTimeout(() => {
      logger.warn(`[Pull] Timeout: ${worktreePath} (${PULL_TIMEOUT_MS}ms elapsed)`);
      removePull(worktreePath);
    }, PULL_TIMEOUT_MS);
    setActivePulls(prev => {
      const next = new Map(prev);
      next.set(worktreePath, { taskId, timeoutId });
      return next;
    });
    try {
      await pullWorktreeAsync(repositoryId, worktreePath, taskId);
    } catch (error) {
      removePull(worktreePath);
      showPullError('Pull Failed', error instanceof Error ? error.message : 'Unknown error');
    }
  }, [removePull, showPullError]);

  // Handle real-time activity updates for notification tracking only.
  // Activity state is managed by the root layout via SessionDataContext;
  // this handler only tracks previous states for detecting work completion transitions.
  const handleWorkerActivityForNotification = useCallback((sessionId: string, workerId: string, state: AgentActivityState) => {
    const key = `${sessionId}:${workerId}`;
    const prevState = prevStatesRef.current[sessionId]?.[workerId];
    const now = Date.now();

    logger.debug(`[Activity] ${key}: ${prevState} → ${state}`);

    // Update prev state tracking (for notification transition detection)
    if (!prevStatesRef.current[sessionId]) {
      prevStatesRef.current[sessionId] = {};
    }
    prevStatesRef.current[sessionId][workerId] = state;

    // Track when worker enters 'active' state
    if (state === 'active' && prevState !== 'active') {
      activeStartTimeRef.current[key] = now;
      logger.debug(`[Activity] ${key}: Started working at ${now}`);
    }

    // Skip notifications if this is the first state update (session just started)
    if (!prevState) {
      logger.debug('[Notification] Skipped: initial state');
      return;
    }

    // Only notify when page is hidden (user is not looking)
    if (document.visibilityState !== 'hidden') {
      logger.debug('[Notification] Skipped: page is visible');
      return;
    }

    // Check cooldown (don't notify same session too frequently)
    const lastNotification = lastNotificationTimeRef.current[sessionId] || 0;
    if (now - lastNotification < NOTIFICATION_COOLDOWN_MS) {
      logger.debug(`[Notification] Skipped: cooldown (${now - lastNotification}ms < ${NOTIFICATION_COOLDOWN_MS}ms)`);
      return;
    }

    // Check if worker was working long enough
    const activeStartTime = activeStartTimeRef.current[key] || 0;
    const workingTime = now - activeStartTime;
    const wasWorkingLongEnough = prevState === 'active' && workingTime >= MIN_WORKING_TIME_MS;

    // Send notification for work completion (active -> idle or active -> asking)
    if (prevState === 'active' && (state === 'idle' || state === 'asking')) {
      if (!wasWorkingLongEnough) {
        logger.debug(`[Notification] Skipped: working time too short (${workingTime}ms < ${MIN_WORKING_TIME_MS}ms)`);
        return;
      }

      lastNotificationTimeRef.current[sessionId] = now;

      // Get session info for notification body
      const session = sessionsRef.current.find(s => s.id === sessionId);
      if (!session) {
        logger.debug('[Notification] Skipped: session no longer exists');
        return;
      }
      // Extract project name from path
      const pathParts = session.locationPath.split('/').filter(Boolean);
      const projectName = pathParts[pathParts.length - 1] || 'Unknown';

      if (state === 'idle') {
        logger.debug('[Notification] Triggering: work completed');
        showNotification(
          'Claude completed work',
          `${projectName} - Work completed`,
          sessionId,
          `completed-${sessionId}-${now}`
        );
      } else if (state === 'asking') {
        logger.debug('[Notification] Triggering: waiting for input');
        showNotification(
          'Claude needs your input',
          `${projectName} - Waiting for input`,
          sessionId,
          `asking-${sessionId}-${now}`
        );
      }
    }
  }, []);

  // Subscribe to WebSocket events for dashboard-specific concerns only.
  // Session lifecycle events (created, updated, deleted, paused, resumed) and
  // activity state updates are handled by the root layout via SessionDataContext.
  useAppWsEvent({
    onWorkerActivity: handleWorkerActivityForNotification,
    onAgentsSync: handleAgentsSync,
    onAgentCreated: handleAgentCreated,
    onAgentUpdated: handleAgentUpdated,
    onAgentDeleted: handleAgentDeleted,
    onRepositoriesSync: handleRepositoriesSync,
    onRepositoryCreated: handleRepositoryCreated,
    onRepositoryDeleted: handleRepositoryDeleted,
    onRepositoryUpdated: handleRepositoryUpdated,
    onWorktreePullCompleted: handleWorktreePullCompleted,
    onWorktreePullFailed: handleWorktreePullFailed,
  });
  const { data: reposData } = useQuery({
    queryKey: repositoryKeys.all(),
    queryFn: fetchRepositories,
  });

  // Add activity state to active sessions for display
  const sessions = activeSessions.map(session => ({
    ...session,
    activityState: getSessionActivityState(session, workerActivityStates),
  }));

  const registerMutation = useMutation({
    mutationFn: registerRepository,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: repositoryKeys.all() });
      setShowAddRepo(false);
    },
  });

  const unregisterMutation = useMutation({
    mutationFn: unregisterRepository,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: repositoryKeys.all() });
    },
  });

  const repositories = reposData?.repositories ?? [];

  const [descriptionGenerationError, setDescriptionGenerationError] = useState<string | null>(null);
  const [generatingDescriptionForRepo, setGeneratingDescriptionForRepo] = useState<string | null>(null);

  const handleAddRepo = async (data: AddRepositoryFormSubmitData) => {
    setDescriptionGenerationError(null);
    const result = await registerMutation.mutateAsync({
      path: data.path,
      description: data.description,
    });
    // After successful registration, auto-generate description if requested
    if (data.autoGenerateDescription && result.repository?.id) {
      const repoId = result.repository.id;
      setGeneratingDescriptionForRepo(repoId);
      // Generate description and persist it
      generateRepositoryDescription(repoId)
        .then((genResult) =>
          updateRepository(repoId, { description: genResult.description })
        )
        .then(() => {
          queryClient.invalidateQueries({ queryKey: repositoryKeys.all() });
        })
        .catch((err) => {
          if (!isMountedRef.current) return;
          const message = err instanceof Error ? err.message : 'Unknown error';
          setDescriptionGenerationError(message);
        })
        .finally(() => {
          if (!isMountedRef.current) return;
          setGeneratingDescriptionForRepo(null);
        });
    }
  };

  const createSessionMutation = useMutation({
    mutationFn: createSession,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.root() });
      setShowAddSession(false);
      navigate({ to: `/sessions/${data.session.id}` });
    },
  });

  const handleStartSession = async (data: CreateQuickSessionRequest) => {
    await createSessionMutation.mutateAsync(data);
  };

  // Show loading state only on initial load before first sync.
  // After the first sync, keep showing previous data (stale-while-revalidate)
  // even during WebSocket reconnection or re-sync to avoid jarring UI flashes.
  if (!wsInitialized) {
    return (
      <div className="py-4 px-4 md:py-6 md:px-6">
        <div className="flex flex-col gap-3 mb-5 md:flex-row md:items-center md:justify-between">
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
      <div className="py-4 px-4 md:py-6 md:px-6">
        <div className="flex flex-col gap-3 mb-5 md:flex-row md:items-center md:justify-between">
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

      {descriptionGenerationError && (
        <div className="card mb-5 bg-yellow-900/30 border border-yellow-600">
          <p className="text-sm text-yellow-200">
            <strong>Description generation failed:</strong> {descriptionGenerationError}
          </p>
          <p className="text-xs text-yellow-300 mt-1">
            You can set the description manually from the Settings page.
          </p>
          <button
            onClick={() => setDescriptionGenerationError(null)}
            className="btn bg-yellow-700 hover:bg-yellow-600 text-sm mt-2"
          >
            Dismiss
          </button>
        </div>
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
              pausedSessions={pausedSessions}
              activePulls={activePulls}
              onPullWorktree={handlePullWorktree}
              onUnregister={() => setRepoToUnregister(repo)}
              generatingDescription={generatingDescriptionForRepo === repo.id}
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
      <ErrorDialog {...pullErrorDialogProps} />
      <AlertDialog open={pullSuccessMessage !== null} onOpenChange={(open) => { if (!open) setPullSuccessMessage(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pull Completed</AlertDialogTitle>
            <AlertDialogDescription>{pullSuccessMessage}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setPullSuccessMessage(null)}>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </div>
    </>
  );
}

export type SessionWithActivity = Session & {
  activityState?: AgentActivityState;
};

interface RepositoryCardProps {
  repository: Repository;
  sessions: SessionWithActivity[];
  /** Map of worktree path to paused session object */
  pausedSessions: Record<string, Session>;
  /** Map of worktree path to pull tracking info for active pull operations */
  activePulls: Map<string, { taskId: string; timeoutId: ReturnType<typeof setTimeout> }>;
  /** Callback to initiate a pull for a worktree */
  onPullWorktree: (repositoryId: string, worktreePath: string) => void;
  onUnregister: () => void;
  /** Whether a description is currently being generated for this repository */
  generatingDescription?: boolean;
}

function RepositoryCard({ repository, sessions, pausedSessions, activePulls, onPullWorktree, onUnregister, generatingDescription }: RepositoryCardProps) {
  const [showCreateWorktree, setShowCreateWorktree] = useState(false);
  const [fallbackInfo, setFallbackInfo] = useState<BranchNameFallback | null>(null);
  const [setupCommandFailure, setSetupCommandFailure] = useState<HookCommandResult | null>(null);
  const { errorDialogProps, showError: showWorktreeError } = useErrorDialog();
  const { handleCreateWorktree: createWorktree } = useCreateWorktree({
    repositoryId: repository.id,
    repositoryName: repository.name,
  });
  const isGitHubRemote = Boolean(
    repository.remoteUrl &&
      (repository.remoteUrl.startsWith('git@github.com:') ||
        repository.remoteUrl.startsWith('https://github.com/') ||
        repository.remoteUrl.startsWith('http://github.com/') ||
        repository.remoteUrl.startsWith('ssh://git@github.com/'))
  );

  const { data: worktreesData } = useQuery({
    queryKey: worktreeKeys.byRepository(repository.id),
    queryFn: () => fetchWorktrees(repository.id),
  });

  const worktrees = worktreesData?.worktrees ?? [];

  const { data: branchesData } = useQuery({
    queryKey: branchKeys.byRepository(repository.id),
    queryFn: () => fetchBranches(repository.id),
    enabled: showCreateWorktree, // Only fetch when modal is open
  });

  const defaultBranch = branchesData?.defaultBranch || 'main';

  // Async worktree creation - returns immediately after API accepts the request
  const handleCreateWorktree = async (formRequest: CreateWorktreeFormRequest) => {
    try {
      await createWorktree(formRequest);
      // Close the form immediately - task shows in sidebar
      setShowCreateWorktree(false);
    } catch (error) {
      showWorktreeError('Failed to Create Worktree', error instanceof Error ? error.message : 'Unknown error');
    }
  };

  return (
    <div className="card">
      <div className="flex flex-col gap-3 mb-4 md:flex-row md:items-center md:justify-between">
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
          {repository.description && (
            <p className="text-sm text-gray-400 mt-1">{repository.description}</p>
          )}
          {generatingDescription && (
            <p className="text-sm text-gray-400 mt-1 flex items-center gap-2">
              <Spinner size="sm" /> Generating description...
            </p>
          )}
        </div>
        <div className="flex gap-2">
          {hasVSCode() && (
            <button
              onClick={async () => {
                try {
                  await openInVSCode(repository.path);
                } catch (err) {
                  logger.error('Failed to open in VS Code:', err);
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
          defaultAgentId={repository.defaultAgentId}
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
              pausedSession={pausedSessions[worktree.path]}
              repositoryId={repository.id}
              isPulling={activePulls.has(worktree.path)}
              onPull={() => onPullWorktree(repository.id, worktree.path)}
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

export interface WorktreeRowProps {
  worktree: Worktree;
  session?: SessionWithActivity;
  /** Full session object if this worktree has a paused session */
  pausedSession?: Session;
  repositoryId: string;
  /** Whether a pull operation is in progress for this worktree */
  isPulling: boolean;
  /** Callback to initiate a pull */
  onPull: () => void;
}

export function WorktreeRow({ worktree, session, pausedSession, repositoryId, isPulling, onPull }: WorktreeRowProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Delete confirmation state: null = closed, 'normal' = regular delete, 'force' = force delete
  const [deleteConfirmType, setDeleteConfirmType] = useState<'normal' | 'force' | null>(null);
  const { errorDialogProps, showError } = useErrorDialog();
  const { tasks: deletionTasks, addTask, markAsFailed } = useWorktreeDeletionTasksContext();
  const isDeleting = deletionTasks.some(
    (t) => t.worktreePath === worktree.path && t.status === 'deleting'
  );

  const restoreSessionMutation = useMutation({
    mutationFn: (request: CreateWorktreeSessionRequest) => createSession(request),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.root() });
      navigate({ to: '/sessions/$sessionId', params: { sessionId: data.session.id } });
    },
    onError: (error: Error) => {
      showError('Restore Failed', error.message);
    },
  });

  const resumeSessionMutation = useMutation({
    mutationFn: (sessionId: string) => resumeSession(sessionId),
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.root() });
      navigate({ to: '/sessions/$sessionId', params: { sessionId: session.id } });
    },
    onError: (error: Error) => {
      showError('Resume Failed', error.message);
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

  const handleResumeSession = () => {
    if (pausedSession) {
      resumeSessionMutation.mutate(pausedSession.id);
    }
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
    const taskId = generateTaskId();

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

    try {
      // Call async API
      await deleteWorktreeAsync(repositoryId, worktree.path, taskId, force);
      // Emit session-deleted locally for immediate UI update only after API succeeds
      if (session) {
        emitSessionDeleted(session.id);
      }
      // Further success/failure of the async operation will be handled via WebSocket events
    } catch (err) {
      // If API call fails immediately (network error), mark task as failed
      // Session remains visible in the UI since we did not emit session-deleted
      const message = err instanceof Error ? err.message : 'Failed to delete worktree';
      markAsFailed(taskId, message);
    }
  };

  const statusColor = session
    ? session.status === 'active'
      ? 'bg-green-500'
      : 'bg-gray-500'
    : pausedSession
      ? 'bg-yellow-500'    // Paused session
      : 'bg-gray-600';     // No session

  return (
    <div className="flex flex-col gap-2 p-2 bg-slate-800 rounded md:flex-row md:items-center md:gap-3">
      {/* Info section: index, status dot, and content - always horizontal */}
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <span className="w-6 text-center text-sm font-mono text-gray-500 shrink-0">
          {worktree.index !== undefined ? worktree.index : '0'}
        </span>
        <span className={`inline-block w-2 h-2 rounded-full ${statusColor} shrink-0`} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium flex items-center gap-2">
            {/* Show title from active session or paused session */}
            {(session?.title || pausedSession?.title) && (
              <>
                <span className="truncate" title={session?.title || pausedSession?.title}>{session?.title || pausedSession?.title}</span>
                <span className="text-gray-500">-</span>
              </>
            )}
            <span className={(session?.title || pausedSession?.title) ? 'text-gray-400' : ''}>{worktree.branch}</span>
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
                    logger.error('Failed to open in VS Code:', err);
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
      </div>
      <div className="flex gap-2 shrink-0 pl-11 md:pl-0">
        {session ? (
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: session.id }}
            className="btn btn-primary text-xs no-underline"
          >
            Open
          </Link>
        ) : pausedSession ? (
          <button
            onClick={handleResumeSession}
            disabled={resumeSessionMutation.isPending}
            className="btn btn-primary text-xs"
          >
            {resumeSessionMutation.isPending ? 'Resuming...' : 'Resume'}
          </button>
        ) : (
          <button
            onClick={handleRestoreSession}
            disabled={restoreSessionMutation.isPending}
            className="btn btn-primary text-xs"
          >
            {restoreSessionMutation.isPending ? 'Restoring...' : 'Restore'}
          </button>
        )}
        <button
          onClick={onPull}
          disabled={isPulling}
          className="btn text-xs bg-slate-700 hover:bg-slate-600"
        >
          {isPulling ? 'Pulling...' : 'Pull'}
        </button>
        {!worktree.isMain && (
          <button
            onClick={handleDeleteWorktree}
            disabled={isDeleting}
            className="btn btn-danger text-xs"
          >
            {isDeleting ? 'Deleting...' : 'Delete'}
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
      queryClient.invalidateQueries({ queryKey: sessionKeys.root() });
      setShowStopConfirm(false);
    },
  });

  const statusColor =
    session.status === 'active'
      ? 'bg-green-500'
      : 'bg-gray-500';

  return (
    <>
      <div className="card flex flex-col gap-3 md:flex-row md:items-center md:gap-4">
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
  result: HookCommandResult | null;
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
