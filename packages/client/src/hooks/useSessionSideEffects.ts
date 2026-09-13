import { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Session, AgentActivityState, WorkerActivityInfo, WorktreeDeletionCompletedPayload, Repository } from '@agent-console/shared';
import type { UseWorktreeCreationTasksReturn } from './useWorktreeCreationTasks';
import type { UseWorktreeDeletionTasksReturn } from './useWorktreeDeletionTasks';
import type { UseSessionStopTasksReturn } from './useSessionStopTasks';
import { useAppWsEvent } from './useAppWs';
import { worktreeKeys, sessionKeys, repositoryKeys } from '../lib/query-keys';
import { disconnectSession } from '../lib/worker-websocket';
import { clearDraftsForSession } from './useDraftMessage';
import { updateFavicon, hasAnyAskingWorker } from '../lib/favicon-manager';

/**
 * Query key to invalidate for a session-created event, or null if this
 * session-created event carries no worktree-cache implication (a quick
 * session, or a worktree session that -- despite `repositoryId` being a
 * required field on the wire schema -- was constructed without one).
 */
export function worktreeInvalidationKeyFor(session: Session): ReturnType<typeof worktreeKeys.byRepository> | null {
  if (session.type === 'worktree' && session.repositoryId) {
    return worktreeKeys.byRepository(session.repositoryId);
  }
  return null;
}

interface UseSessionSideEffectsOptions {
  handleSessionsSync: (sessions: Session[], activityStates: WorkerActivityInfo[]) => void;
  handleSessionCreated: (session: Session) => void;
  handleSessionUpdated: (session: Session) => void;
  handleSessionDeleted: (sessionId: string) => void;
  handleSessionPaused: (session: Session) => void;
  handleSessionResumed: (session: Session, activityStates: WorkerActivityInfo[]) => void;
  handleWorkerActivity: (sessionId: string, workerId: string, activityState: AgentActivityState) => void;
  workerActivityStates: Record<string, Record<string, AgentActivityState>>;
  worktreeCreationTasks: UseWorktreeCreationTasksReturn;
  worktreeDeletionTasks: UseWorktreeDeletionTasksReturn;
  sessionStopTasks: UseSessionStopTasksReturn;
}

/**
 * Wires up cross-cutting side effects for session lifecycle events.
 *
 * Responsibilities:
 * - Invalidates session validation cache after session CRUD
 * - Disconnects WebSocket on session pause
 * - Invalidates worktree queries on deletion complete
 * - Subscribes to app WebSocket events
 * - Updates favicon based on worker activity
 */
export function useSessionSideEffects({
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
  sessionStopTasks,
}: UseSessionSideEffectsOptions): void {
  const queryClient = useQueryClient();

  // Invalidate session validation cache so the warning badge stays current
  const invalidateValidation = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: sessionKeys.validation() });
  }, [queryClient]);

  // Wrap session lifecycle handlers to also refresh validation status
  const handleSessionCreatedWithValidation = useCallback((...args: Parameters<typeof handleSessionCreated>) => {
    handleSessionCreated(...args);
    invalidateValidation();
    // A worktree-type session may have been created outside the REST form flow
    // (e.g. MCP delegate_to_worktree), which never fires worktree-creation-completed.
    // React to the authoritative session-created fact instead of relying on that
    // task event, so the dashboard repository card sees the new worktree row.
    const queryKey = worktreeInvalidationKeyFor(args[0]);
    if (queryKey) {
      queryClient.invalidateQueries({ queryKey });
    }
  }, [handleSessionCreated, invalidateValidation, queryClient]);

  const handleSessionDeletedWithValidation = useCallback((sessionId: string) => {
    clearDraftsForSession(sessionId);
    handleSessionDeleted(sessionId);
    invalidateValidation();
    // A stop/pause task's target session is gone -- remove it unconditionally
    // (harmless no-op if no task exists for this session).
    sessionStopTasks.removeTask(sessionId);
  }, [handleSessionDeleted, invalidateValidation, sessionStopTasks]);

  const handleSessionUpdatedWithValidation = useCallback((...args: Parameters<typeof handleSessionUpdated>) => {
    handleSessionUpdated(...args);
    invalidateValidation();
  }, [handleSessionUpdated, invalidateValidation]);

  // Removes stop/pause tasks whose session-side truth (from the sessions-sync
  // snapshot) indicates the task is complete: a `stop` task's session left the
  // list entirely, or a `pause` task's session is present but now `inactive`.
  // This makes WS-reconnect self-healing -- the task-removal side effect does
  // not depend on the `session-deleted`/`session-paused` events having been
  // observed by this client.
  const handleSessionsSyncWithValidation = useCallback((sessions: Session[], activityStates: WorkerActivityInfo[]) => {
    handleSessionsSync(sessions, activityStates);
    invalidateValidation();
    for (const task of sessionStopTasks.tasks) {
      const session = sessions.find((s) => s.id === task.sessionId);
      if (!session) {
        sessionStopTasks.removeTask(task.sessionId);
      } else if (task.action === 'pause' && session.status === 'inactive') {
        sessionStopTasks.removeTask(task.sessionId);
      }
    }
  }, [handleSessionsSync, invalidateValidation, sessionStopTasks]);

  // Wrap session paused handler to also disconnect lingering worker WebSocket connections
  const handleSessionPausedWithCleanup = useCallback((session: Session) => {
    // Disconnect all worker WebSocket connections for the paused session
    // to prevent them from attempting reconnection to a session that
    // no longer exists in server memory.
    disconnectSession(session.id);
    handleSessionPaused(session);
    sessionStopTasks.removeTask(session.id);
  }, [handleSessionPaused, sessionStopTasks]);

  // Wrap worktree deletion completed handler to also invalidate worktree queries
  const handleWorktreeDeletionCompleted = useCallback((payload: WorktreeDeletionCompletedPayload) => {
    worktreeDeletionTasks.handleWorktreeDeletionCompleted(payload);
    // Invalidate all worktree queries to refresh dashboard
    queryClient.invalidateQueries({ queryKey: worktreeKeys.root() });
  }, [worktreeDeletionTasks, queryClient]);

  const handleWorkerRestarted = useCallback((sessionId: string, workerId: string, activityState: AgentActivityState) => {
    handleWorkerActivity(sessionId, workerId, activityState);
  }, [handleWorkerActivity]);

  // Targeted, immediate cache patch for a repository's designated-Orchestrator
  // session change. This is a second, independent, always-mounted listener --
  // separate from routes/index.tsx's onRepositoryUpdated handler, which is
  // only mounted on the dashboard route. ActiveSessionsSidebar (which reads
  // Repository.orchestratorSessionId to render the flag control) is mounted
  // unconditionally from __root.tsx alongside this hook, so this listener
  // must not depend on which route is currently active. It is fine and
  // harmless for both broadcasts to patch the same cache key on the same
  // change -- setQueryData is idempotent per-call.
  const handleOrchestratorDesignationChanged = useCallback((repositoryId: string, sessionId: string | null) => {
    const queryKey = repositoryKeys.all();
    // No cached data to patch yet -- most likely an in-flight fetch that has
    // not resolved. A single `invalidateQueries` (or `refetchQueries`) call
    // is not enough here: TanStack Query's `Query.fetch()` dedupes by
    // reusing the ALREADY-IN-FLIGHT request's promise whenever
    // `state.data === undefined` (this only changes once data has been
    // fetched at least once), regardless of which QueryClient method
    // triggered it or its `cancelRefetch` option. So one call just attaches
    // to that same in-flight request and can still resolve with its
    // pre-update snapshot, leaving the cache stale for up to the query's
    // staleTime with no further signal to correct it.
    // Invalidate first (awaiting that in-flight request, if any), then
    // explicitly refetch once it has settled -- by then `fetchStatus` is
    // back to idle, so this second call is a genuinely fresh request that
    // reflects the change.
    if (!queryClient.getQueryData<{ repositories: Repository[] }>(queryKey)) {
      void queryClient.invalidateQueries({ queryKey }).then(() =>
        queryClient.refetchQueries({ queryKey, type: 'all' })
      );
      return;
    }
    queryClient.setQueryData<{ repositories: Repository[] } | undefined>(queryKey, (old) => {
      if (!old) return old;
      return {
        repositories: old.repositories.map((r) =>
          r.id === repositoryId ? { ...r, orchestratorSessionId: sessionId } : r
        ),
      };
    });
  }, [queryClient]);

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
    onOrchestratorDesignationChanged: handleOrchestratorDesignationChanged,
  });

  // Update favicon based on worker activity states
  useEffect(() => {
    updateFavicon(hasAnyAskingWorker(workerActivityStates));
  }, [workerActivityStates]);
}
