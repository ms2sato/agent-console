import { useEffect, useRef, useState, useCallback } from 'react';
import type { DashboardServerMessage, AgentActivityState } from '@agent-console/shared';

interface WorkerActivityInfo {
  id: string;
  activityState?: AgentActivityState;
}

interface SessionActivityInfo {
  id: string;
  workers: WorkerActivityInfo[];
}

interface UseDashboardWebSocketOptions {
  onSync?: (sessions: SessionActivityInfo[]) => void;
  onWorkerActivity?: (sessionId: string, workerId: string, state: AgentActivityState) => void;
  /** Custom reconnect delay calculation for testing. Returns delay in ms. */
  getReconnectDelay?: (retryCount: number) => number;
}

interface UseDashboardWebSocketReturn {
  connected: boolean;
}

// Reconnection settings
const INITIAL_RETRY_DELAY = 1000; // 1 second
const MAX_RETRY_DELAY = 30000; // 30 seconds
const JITTER_FACTOR = 0.3; // ±30% randomization

/** Default reconnect delay with exponential backoff and jitter */
function defaultGetReconnectDelay(retryCount: number): number {
  const baseDelay = Math.min(
    INITIAL_RETRY_DELAY * Math.pow(2, retryCount),
    MAX_RETRY_DELAY
  );
  // Add jitter to prevent thundering herd
  const jitter = baseDelay * JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.round(baseDelay + jitter);
}

export function useDashboardWebSocket(
  options: UseDashboardWebSocketOptions = {}
): UseDashboardWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const optionsRef = useRef(options);
  const retryCountRef = useRef(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);

  optionsRef.current = options;

  const connect = useCallback(() => {
    if (unmountedRef.current) return;

    const wsUrl = `ws://${window.location.host}/ws/dashboard`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      retryCountRef.current = 0; // Reset retry count on success
      console.log('Dashboard WebSocket connected');
    };

    ws.onmessage = (event) => {
      try {
        const msg: DashboardServerMessage = JSON.parse(event.data);
        switch (msg.type) {
          case 'sessions-sync':
            console.log(`[WebSocket] sessions-sync received: ${msg.sessions.length} sessions`);
            optionsRef.current.onSync?.(msg.sessions);
            break;
          case 'worker-activity':
            optionsRef.current.onWorkerActivity?.(msg.sessionId, msg.workerId, msg.activityState);
            break;
        }
      } catch (e) {
        console.error('Failed to parse dashboard WebSocket message:', e);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      console.log('Dashboard WebSocket disconnected');

      // Schedule reconnection with exponential backoff
      if (!unmountedRef.current) {
        const getDelay = optionsRef.current.getReconnectDelay ?? defaultGetReconnectDelay;
        const delay = getDelay(retryCountRef.current);

        console.log(`Dashboard WebSocket reconnecting in ${delay}ms (attempt ${retryCountRef.current + 1})`);
        retryTimeoutRef.current = setTimeout(() => {
          retryCountRef.current++;
          connect();
        }, delay);
      }
    };

    ws.onerror = (error) => {
      console.error('Dashboard WebSocket error:', error);
    };
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  return { connected };
}
