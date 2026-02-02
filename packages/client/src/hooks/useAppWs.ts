import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { AppServerMessage, AgentActivityState, Session, WorkerActivityInfo, AgentDefinition, Repository, WorktreeCreationCompletedPayload, WorktreeCreationFailedPayload, WorktreeDeletionCompletedPayload, WorktreeDeletionFailedPayload, WorkerMessage } from '@agent-console/shared';
import { connect, subscribe, subscribeState, getState, requestSync, type AppWebSocketState } from '../lib/app-websocket';
import { usePersistentWebSocket } from './usePersistentWebSocket';

/**
 * Hook for subscribing to app WebSocket state with a selector.
 * Only re-renders when the selected value changes (using Object.is comparison).
 *
 * Note: For best performance, pass a stable selector (using useCallback) or
 * ensure the selector returns primitive values. Object/array selectors will
 * cause re-renders on every state change unless memoized.
 *
 * @example
 * const connected = useAppWsState(s => s.connected);
 * const sessionsSynced = useAppWsState(s => s.sessionsSynced);
 */
export function useAppWsState<T>(selector: (state: AppWebSocketState) => T): T {
  return useSyncExternalStore(subscribeState, () => selector(getState()));
}

interface UseAppWsEventOptions {
  /** Called when initial session sync is received */
  onSessionsSync?: (sessions: Session[], activityStates: WorkerActivityInfo[]) => void;
  /** Called when a new session is created */
  onSessionCreated?: (session: Session) => void;
  /** Called when a session is updated */
  onSessionUpdated?: (session: Session) => void;
  /** Called when a session is deleted */
  onSessionDeleted?: (sessionId: string) => void;
  /** Called when worker activity state changes */
  onWorkerActivity?: (sessionId: string, workerId: string, state: AgentActivityState) => void;
  /** Called when a worker is activated (PTY started) */
  onWorkerActivated?: (sessionId: string, workerId: string) => void;
  /** Called when initial agent sync is received */
  onAgentsSync?: (agents: AgentDefinition[]) => void;
  /** Called when a new agent is created */
  onAgentCreated?: (agent: AgentDefinition) => void;
  /** Called when an agent is updated */
  onAgentUpdated?: (agent: AgentDefinition) => void;
  /** Called when an agent is deleted */
  onAgentDeleted?: (agentId: string) => void;
  /** Called when initial repository sync is received */
  onRepositoriesSync?: (repositories: Repository[]) => void;
  /** Called when a new repository is created */
  onRepositoryCreated?: (repository: Repository) => void;
  /** Called when a repository is deleted */
  onRepositoryDeleted?: (repositoryId: string) => void;
  /** Called when a repository is updated */
  onRepositoryUpdated?: (repository: Repository) => void;
  /** Called when async worktree creation completes successfully */
  onWorktreeCreationCompleted?: (payload: WorktreeCreationCompletedPayload) => void;
  /** Called when async worktree creation fails */
  onWorktreeCreationFailed?: (payload: WorktreeCreationFailedPayload) => void;
  /** Called when async worktree deletion completes successfully */
  onWorktreeDeletionCompleted?: (payload: WorktreeDeletionCompletedPayload) => void;
  /** Called when async worktree deletion fails */
  onWorktreeDeletionFailed?: (payload: WorktreeDeletionFailedPayload) => void;
  /** Called when a worker message is sent */
  onWorkerMessage?: (message: WorkerMessage) => void;
}

/**
 * Hook for subscribing to app WebSocket events.
 * Connects to WebSocket and registers event callbacks.
 * Use useAppWsState for reading connection state.
 *
 * When the component mounts and the WebSocket is already connected,
 * it requests a fresh sync from the server to ensure state is up-to-date.
 * This handles the case where the user navigates away and returns to the Dashboard.
 */
export function useAppWsEvent(options: UseAppWsEventOptions = {}): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  usePersistentWebSocket({
    key: 'app',
    connect: () => {
      // If already connected, request a fresh sync (handles navigation case)
      // Otherwise, connect() will trigger initial sync via onOpen.
      if (getState().connected) {
        requestSync();
      } else {
        // Connect to WebSocket (idempotent - safe to call multiple times).
        connect();
      }
    },
    disconnect: () => undefined,
  });

  useEffect(() => {
    // Subscribe to messages for callback notifications.
    const unsubscribeMessage = subscribe((msg: AppServerMessage) => {
      switch (msg.type) {
        case 'sessions-sync':
          console.log(`[WebSocket] sessions-sync received: ${msg.sessions.length} sessions`);
          optionsRef.current.onSessionsSync?.(msg.sessions, msg.activityStates);
          break;
        case 'session-created':
          console.log(`[WebSocket] session-created: ${msg.session.id}`);
          optionsRef.current.onSessionCreated?.(msg.session);
          break;
        case 'session-updated':
          console.log(`[WebSocket] session-updated: ${msg.session.id}`);
          optionsRef.current.onSessionUpdated?.(msg.session);
          break;
        case 'session-deleted':
          console.log(`[WebSocket] session-deleted: ${msg.sessionId}`);
          optionsRef.current.onSessionDeleted?.(msg.sessionId);
          break;
        case 'worker-activity':
          optionsRef.current.onWorkerActivity?.(msg.sessionId, msg.workerId, msg.activityState);
          break;
        case 'worker-activated':
          console.log(`[WebSocket] worker-activated: ${msg.sessionId}/${msg.workerId}`);
          optionsRef.current.onWorkerActivated?.(msg.sessionId, msg.workerId);
          break;
        case 'agents-sync':
          console.log(`[WebSocket] agents-sync received: ${msg.agents.length} agents`);
          optionsRef.current.onAgentsSync?.(msg.agents);
          break;
        case 'agent-created':
          console.log(`[WebSocket] agent-created: ${msg.agent.id}`);
          optionsRef.current.onAgentCreated?.(msg.agent);
          break;
        case 'agent-updated':
          console.log(`[WebSocket] agent-updated: ${msg.agent.id}`);
          optionsRef.current.onAgentUpdated?.(msg.agent);
          break;
        case 'agent-deleted':
          console.log(`[WebSocket] agent-deleted: ${msg.agentId}`);
          optionsRef.current.onAgentDeleted?.(msg.agentId);
          break;
        case 'repositories-sync':
          console.log(`[WebSocket] repositories-sync received: ${msg.repositories.length} repositories`);
          optionsRef.current.onRepositoriesSync?.(msg.repositories);
          break;
        case 'repository-created':
          console.log(`[WebSocket] repository-created: ${msg.repository.id}`);
          optionsRef.current.onRepositoryCreated?.(msg.repository);
          break;
        case 'repository-deleted':
          console.log(`[WebSocket] repository-deleted: ${msg.repositoryId}`);
          optionsRef.current.onRepositoryDeleted?.(msg.repositoryId);
          break;
        case 'repository-updated':
          console.log(`[WebSocket] repository-updated: ${msg.repository.id}`);
          optionsRef.current.onRepositoryUpdated?.(msg.repository);
          break;
        case 'worktree-creation-completed':
          console.log(`[WebSocket] worktree-creation-completed: taskId=${msg.taskId}`);
          optionsRef.current.onWorktreeCreationCompleted?.(msg);
          break;
        case 'worktree-creation-failed':
          console.log(`[WebSocket] worktree-creation-failed: taskId=${msg.taskId}`);
          optionsRef.current.onWorktreeCreationFailed?.(msg);
          break;
        case 'worktree-deletion-completed':
          console.log(`[WebSocket] worktree-deletion-completed: taskId=${msg.taskId}`);
          optionsRef.current.onWorktreeDeletionCompleted?.(msg);
          break;
        case 'worktree-deletion-failed':
          console.log(`[WebSocket] worktree-deletion-failed: taskId=${msg.taskId}`);
          optionsRef.current.onWorktreeDeletionFailed?.(msg);
          break;
        case 'worker-message':
          console.log(`[WebSocket] worker-message: ${msg.message.fromWorkerName} -> ${msg.message.toWorkerName}`);
          optionsRef.current.onWorkerMessage?.(msg.message);
          break;
        default: {
          const _exhaustive: never = msg;
          console.warn('Unknown message type received:', _exhaustive);
        }
      }
    });

    return () => {
      unsubscribeMessage();
      // Note: We don't disconnect here because the singleton should persist.
    };
  }, []);
}
