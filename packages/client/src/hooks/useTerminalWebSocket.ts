import { useEffect, useCallback, useSyncExternalStore, useState } from 'react';
import type { AgentActivityState, WorkerErrorCode } from '@agent-console/shared';
import * as workerWs from '../lib/worker-websocket.js';
import { usePersistentWebSocket } from './usePersistentWebSocket';

interface UseTerminalWebSocketOptions {
  onOutput: (data: string, offset: number) => void;
  onHistory: (data: string, offset: number) => void;
  onExit: (exitCode: number, signal: string | null) => void;
  onConnectionChange: (connected: boolean) => void;
  onActivity?: (state: AgentActivityState) => void;
}

export interface WorkerError {
  message: string;
  code?: WorkerErrorCode;
}

interface UseTerminalWebSocketReturn {
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  sendImage: (data: string, mimeType: string) => void;
  connected: boolean;
  error: WorkerError | null;
}

export function useTerminalWebSocket(
  sessionId: string,
  workerId: string,
  options: UseTerminalWebSocketOptions,
  retryCount: number = 0
): UseTerminalWebSocketReturn {
  const { onOutput, onHistory, onExit, onConnectionChange, onActivity } = options;

  // Error state for worker activation failures
  const [error, setError] = useState<WorkerError | null>(null);

  // Error handler callback
  const handleError = useCallback((message: string, code?: WorkerErrorCode) => {
    setError({ message, code });
  }, []);

  // Subscribe to connection state using useSyncExternalStore
  const state = useSyncExternalStore(
    (callback) => workerWs.subscribeState(callback),
    () => workerWs.getState(sessionId, workerId)
  );

  usePersistentWebSocket({
    key: { sessionId, workerId },
    connect: ({ sessionId, workerId }) => {
      // Clear error on new connection attempt (including retry)
      setError(null);
      workerWs.connect(sessionId, workerId, {
        type: 'terminal',
        onOutput,
        onHistory,
        onExit,
        onActivity,
        onError: handleError,
      });
    },
    disconnect: ({ sessionId, workerId }) => {
      workerWs.disconnect(sessionId, workerId);
      // Clear error when switching workers.
      setError(null);
    },
    keyEquals: (a, b) => a.sessionId === b.sessionId && a.workerId === b.workerId,
    deps: [sessionId, workerId, retryCount],
  });

  // Update callbacks without reconnecting when they change
  useEffect(() => {
    workerWs.updateCallbacks(sessionId, workerId, {
      type: 'terminal',
      onOutput,
      onHistory,
      onExit,
      onActivity,
      onError: handleError,
    });
  }, [sessionId, workerId, onOutput, onHistory, onExit, onActivity, handleError]);

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

  return { sendInput, sendResize, sendImage, connected: state.connected, error };
}
