import { useEffect, useRef, useState } from 'react';
import type { DashboardServerMessage, ClaudeActivityState } from '@agents-web-console/shared';

interface UseDashboardWebSocketOptions {
  onSync?: (sessions: Array<{ id: string; activityState: ClaudeActivityState }>) => void;
  onActivity?: (sessionId: string, state: ClaudeActivityState) => void;
}

interface UseDashboardWebSocketReturn {
  connected: boolean;
}

export function useDashboardWebSocket(
  options: UseDashboardWebSocketOptions = {}
): UseDashboardWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const wsUrl = `ws://${window.location.hostname}:3457/ws/dashboard`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
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
          case 'session-activity':
            optionsRef.current.onActivity?.(msg.sessionId, msg.activityState);
            break;
          // Add other message types as needed
        }
      } catch (e) {
        console.error('Failed to parse dashboard WebSocket message:', e);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      console.log('Dashboard WebSocket disconnected');
    };

    ws.onerror = (error) => {
      console.error('Dashboard WebSocket error:', error);
    };

    return () => {
      ws.close();
    };
  }, []);

  return { connected };
}
