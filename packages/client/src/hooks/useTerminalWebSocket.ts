import { useEffect, useCallback, useSyncExternalStore } from 'react';
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

  // Connect on mount, disconnect on unmount
  // Only sessionId and workerId should trigger reconnection
  useEffect(() => {
    workerWs.connect(sessionId, workerId, {
      type: 'terminal',
      onOutput,
      onHistory,
      onExit,
      onActivity,
    });

    return () => {
      workerWs.disconnect(sessionId, workerId);
    };
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
