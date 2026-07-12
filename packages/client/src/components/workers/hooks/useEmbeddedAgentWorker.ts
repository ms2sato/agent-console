import { useEffect, useCallback, useSyncExternalStore } from 'react';
import type { AgentActivityState } from '@agent-console/shared';
import {
  getOrCreateEmbeddedAgentWorker,
  type EmbeddedAgentChatEntry,
  type EmbeddedAgentConnectionStatus,
} from '../embedded-agent-store.js';
import type { WorkerErrorCode } from '@agent-console/shared';

interface UseEmbeddedAgentWorkerOptions {
  sessionId: string;
  workerId: string;
}

interface UseEmbeddedAgentWorkerReturn {
  status: EmbeddedAgentConnectionStatus;
  entries: EmbeddedAgentChatEntry[];
  activityState: AgentActivityState;
  workerError: { message: string; code?: WorkerErrorCode } | null;
  loadingHistory: boolean;
  sendUserMessage: (text: string) => void;
  cancel: () => void;
  restart: () => void;
  retry: () => void;
  dismissError: () => void;
}

/**
 * Subscribes to the module-level embedded-agent store (see
 * `../embedded-agent-store.ts`) for a single `${sessionId}:${workerId}`
 * worker. Mirrors the `useGitDiffWorker` hook shape: a thin
 * useSyncExternalStore subscription plus a handful of stable action
 * callbacks, with the live WebSocket connection owned by the store (not this
 * hook), so it survives across remounts.
 */
export function useEmbeddedAgentWorker(
  options: UseEmbeddedAgentWorkerOptions,
): UseEmbeddedAgentWorkerReturn {
  const { sessionId, workerId } = options;

  const instance = getOrCreateEmbeddedAgentWorker(sessionId, workerId);

  const snapshot = useSyncExternalStore(instance.subscribe, instance.getSnapshot);

  // Acquire/release reference counting for the store's idle-eviction timer.
  useEffect(() => {
    const release = getOrCreateEmbeddedAgentWorker(sessionId, workerId).acquire();
    return release;
  }, [sessionId, workerId]);

  const sendUserMessage = useCallback(
    (text: string) => {
      getOrCreateEmbeddedAgentWorker(sessionId, workerId).sendUserMessage(text);
    },
    [sessionId, workerId],
  );

  const cancel = useCallback(() => {
    getOrCreateEmbeddedAgentWorker(sessionId, workerId).cancel();
  }, [sessionId, workerId]);

  const restart = useCallback(() => {
    getOrCreateEmbeddedAgentWorker(sessionId, workerId).restart();
  }, [sessionId, workerId]);

  const retry = useCallback(() => {
    getOrCreateEmbeddedAgentWorker(sessionId, workerId).retry();
  }, [sessionId, workerId]);

  const dismissError = useCallback(() => {
    getOrCreateEmbeddedAgentWorker(sessionId, workerId).dismissError();
  }, [sessionId, workerId]);

  return {
    status: snapshot.status,
    entries: snapshot.entries,
    activityState: snapshot.activityState,
    workerError: snapshot.workerError,
    loadingHistory: snapshot.loadingHistory,
    sendUserMessage,
    cancel,
    restart,
    retry,
    dismissError,
  };
}
