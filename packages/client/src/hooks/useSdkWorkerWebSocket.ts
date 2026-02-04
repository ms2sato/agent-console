import { useEffect, useCallback, useSyncExternalStore, useState } from 'react';
import type { AgentActivityState, SDKMessage, WorkerErrorCode } from '@agent-console/shared';
import * as workerWs from '../lib/worker-websocket.js';
import { usePersistentWebSocket } from './usePersistentWebSocket';

interface UseSdkWorkerWebSocketOptions {
  onMessage: (message: SDKMessage) => void;
  onMessageHistory: (messages: SDKMessage[], lastUuid: string | null) => void;
  onActivity?: (state: AgentActivityState) => void;
  onExit?: (exitCode: number, signal: string | null) => void;
  onConnectionChange: (connected: boolean) => void;
  onServerRestarted?: (serverPid: number) => void;
}

export interface SdkWorkerError {
  message: string;
  code?: WorkerErrorCode;
}

interface UseSdkWorkerWebSocketReturn {
  sendUserMessage: (content: string) => void;
  cancelQuery: () => void;
  requestHistory: (lastUuid?: string) => void;
  connected: boolean;
  error: SdkWorkerError | null;
}

export function useSdkWorkerWebSocket(
  sessionId: string,
  workerId: string,
  options: UseSdkWorkerWebSocketOptions,
  retryCount: number = 0
): UseSdkWorkerWebSocketReturn {
  const { onMessage, onMessageHistory, onActivity, onExit, onConnectionChange, onServerRestarted } = options;

  // Error state for worker activation failures
  const [error, setError] = useState<SdkWorkerError | null>(null);

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
      // Clear error on retry
      setError(null);
      workerWs.connect(sessionId, workerId, {
        type: 'sdk',
        onMessage,
        onActivity,
        onExit,
        onError: handleError,
        onMessageHistory,
        onServerRestarted,
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
      type: 'sdk',
      onMessage,
      onActivity,
      onExit,
      onError: handleError,
      onMessageHistory,
      onServerRestarted,
    });
  }, [sessionId, workerId, onMessage, onActivity, onExit, handleError, onMessageHistory, onServerRestarted]);

  // Notify connection changes
  useEffect(() => {
    onConnectionChange(state.connected);
  }, [state.connected, onConnectionChange]);

  const sendUserMessage = useCallback((content: string) => {
    workerWs.sendUserMessage(sessionId, workerId, content);
  }, [sessionId, workerId]);

  const cancelQuery = useCallback(() => {
    workerWs.cancelQuery(sessionId, workerId);
  }, [sessionId, workerId]);

  const requestHistory = useCallback((lastUuid?: string) => {
    workerWs.requestSdkHistory(sessionId, workerId, lastUuid);
  }, [sessionId, workerId]);

  return { sendUserMessage, cancelQuery, requestHistory, connected: state.connected, error };
}
