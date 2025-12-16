import { useEffect, useRef, useState } from 'react';
import type { AppServerMessage, AgentActivityState, Session, WorkerActivityInfo } from '@agent-console/shared';
import { connect, subscribe, subscribeConnection } from '../lib/app-websocket';

interface UseAppWebSocketOptions {
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

interface UseAppWebSocketReturn {
  connected: boolean;
  /** Whether initial session sync has been received */
  hasReceivedSync: boolean;
}

/**
 * React hook for app WebSocket integration.
 * Uses the singleton WebSocket module internally.
 */
export function useAppWebSocket(
  options: UseAppWebSocketOptions = {}
): UseAppWebSocketReturn {
  const [connected, setConnected] = useState(false);
  const [hasReceivedSync, setHasReceivedSync] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    // Connect to WebSocket (idempotent - safe to call multiple times)
    connect();

    // Subscribe to messages
    const unsubscribeMessage = subscribe((msg: AppServerMessage) => {
      switch (msg.type) {
        case 'sessions-sync':
          console.log(`[WebSocket] sessions-sync received: ${msg.sessions.length} sessions`);
          setHasReceivedSync(true);
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

    // Subscribe to connection state
    const unsubscribeConnection = subscribeConnection(setConnected);

    return () => {
      unsubscribeMessage();
      unsubscribeConnection();
      // Note: We don't disconnect here because the singleton should persist
    };
  }, []);

  return { connected, hasReceivedSync };
}
