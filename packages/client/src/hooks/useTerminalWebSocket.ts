import { useEffect, useCallback, useSyncExternalStore, useRef } from 'react';
import type { AgentActivityState } from '@agent-console/shared';
import * as workerWs from '../lib/worker-websocket.js';

interface UseTerminalWebSocketOptions {
  onOutput: (data: string) => void;
  onHistory: (data: string) => void;
  onExit: (exitCode: number, signal: string | null) => void;
  onConnectionChange: (connected: boolean) => void;
  onActivity?: (state: AgentActivityState) => void;
}

interface UseTerminalWebSocketReturn {
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  sendImage: (data: string, mimeType: string) => void;
  connected: boolean;
}

export function useTerminalWebSocket(
  sessionId: string,
  workerId: string,
  options: UseTerminalWebSocketOptions
): UseTerminalWebSocketReturn {
  const { onOutput, onHistory, onExit, onConnectionChange, onActivity } = options;

  // Subscribe to connection state using useSyncExternalStore
  const state = useSyncExternalStore(
    (callback) => workerWs.subscribeState(sessionId, workerId, callback),
    () => workerWs.getState(sessionId, workerId)
  );

  // Track previous sessionId/workerId for cleanup on change
  const prevRef = useRef<{ sessionId: string; workerId: string } | null>(null);

  // Connect on mount, disconnect old connection when sessionId/workerId changes
  // Note: We don't disconnect on cleanup (return function) because the singleton
  // should persist (same pattern as useAppWsEvent). This prevents duplicate output
  // in React StrictMode where mount→unmount→mount would cause two connections.
  // Instead, we disconnect the OLD connection in the effect body when deps change.
  useEffect(() => {
    // If sessionId or workerId changed, disconnect the old connection
    const prev = prevRef.current;
    if (prev && (prev.sessionId !== sessionId || prev.workerId !== workerId)) {
      workerWs.disconnect(prev.sessionId, prev.workerId);
    }
    prevRef.current = { sessionId, workerId };

    workerWs.connect(sessionId, workerId, {
      type: 'terminal',
      onOutput,
      onHistory,
      onExit,
      onActivity,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, workerId]);

  // Update callbacks without reconnecting when they change
  useEffect(() => {
    workerWs.updateCallbacks(sessionId, workerId, {
      type: 'terminal',
      onOutput,
      onHistory,
      onExit,
      onActivity,
    });
  }, [sessionId, workerId, onOutput, onHistory, onExit, onActivity]);

  // Notify connection changes
  useEffect(() => {
    onConnectionChange(state.connected);
  }, [state.connected, onConnectionChange]);

  const sendInput = useCallback((data: string) => {
    workerWs.sendInput(sessionId, workerId, data);
  }, [sessionId, workerId]);

  const sendResize = useCallback((cols: number, rows: number) => {
    workerWs.sendResize(sessionId, workerId, cols, rows);
  }, [sessionId, workerId]);

  const sendImage = useCallback((data: string, mimeType: string) => {
    workerWs.sendImage(sessionId, workerId, data, mimeType);
  }, [sessionId, workerId]);

  return { sendInput, sendResize, sendImage, connected: state.connected };
}
