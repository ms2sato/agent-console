import { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Session, AgentActivityState, WorkerActivityInfo, WorktreeDeletionCompletedPayload } from '@agent-console/shared';
import type { UseWorktreeCreationTasksReturn } from './useWorktreeCreationTasks';
import type { UseWorktreeDeletionTasksReturn } from './useWorktreeDeletionTasks';
import { useAppWsEvent } from './useAppWs';
import { worktreeKeys, sessionKeys } from '../lib/query-keys';
import { disconnectSession } from '../lib/worker-websocket';
import { clearDraftsForSession } from './useDraftMessage';
import { updateFavicon, hasAnyAskingWorker } from '../lib/favicon-manager';

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
  }, [handleSessionCreated, invalidateValidation]);

  const handleSessionDeletedWithValidation = useCallback((sessionId: string) => {
    clearDraftsForSession(sessionId);
    handleSessionDeleted(sessionId);
    invalidateValidation();
  }, [handleSessionDeleted, invalidateValidation]);

  const handleSessionUpdatedWithValidation = useCallback((...args: Parameters<typeof handleSessionUpdated>) => {
    handleSessionUpdated(...args);
    invalidateValidation();
  }, [handleSessionUpdated, invalidateValidation]);

  const handleSessionsSyncWithValidation = useCallback((...args: Parameters<typeof handleSessionsSync>) => {
    handleSessionsSync(...args);
    invalidateValidation();
  }, [handleSessionsSync, invalidateValidation]);

  // Wrap session paused handler to also disconnect lingering worker WebSocket connections
  const handleSessionPausedWithCleanup = useCallback((session: Session) => {
    // Disconnect all worker WebSocket connections for the paused session
    // to prevent them from attempting reconnection to a session that
    // no longer exists in server memory.
    disconnectSession(session.id);
    handleSessionPaused(session);
  }, [handleSessionPaused]);

  // Wrap worktree deletion completed handler to also invalidate worktree queries
  const handleWorktreeDeletionCompleted = useCallback((payload: WorktreeDeletionCompletedPayload) => {
    worktreeDeletionTasks.handleWorktreeDeletionCompleted(payload);
    // Invalidate all worktree queries to refresh dashboard
    queryClient.invalidateQueries({ queryKey: worktreeKeys.root() });
  }, [worktreeDeletionTasks, queryClient]);

  const handleWorkerRestarted = useCallback((sessionId: string, workerId: string, activityState: AgentActivityState) => {
    handleWorkerActivity(sessionId, workerId, activityState);
  }, [handleWorkerActivity]);

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

  // Update favicon based on worker activity states
  useEffect(() => {
    updateFavicon(hasAnyAskingWorker(workerActivityStates));
  }, [workerActivityStates]);
}
