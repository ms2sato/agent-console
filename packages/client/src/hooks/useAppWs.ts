import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { AppServerMessage, AgentActivityState, Session, WorkerActivityInfo } from '@agent-console/shared';
import { connect, subscribe, subscribeState, getState, type AppWebSocketState } from '../lib/app-websocket';

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
}

/**
 * Hook for subscribing to app WebSocket events.
 * Connects to WebSocket and registers event callbacks.
 * Use useAppWsState for reading connection state.
 */
export function useAppWsEvent(options: UseAppWsEventOptions = {}): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    // Connect to WebSocket (idempotent - safe to call multiple times)
    connect();

    // Subscribe to messages for callback notifications
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
      }
    });

    return () => {
      unsubscribeMessage();
      // Note: We don't disconnect here because the singleton should persist
    };
  }, []);
}
