import { useEffect, useCallback, useSyncExternalStore } from 'react';
import type { AgentActivityState } from '@agent-console/shared';
import {
  getOrCreateEmbeddedAgentWorker,
  type EmbeddedAgentChatEntry,
  type EmbeddedAgentConnectionStatus,
  type EmbeddedAgentContextUsage,
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
  contextUsage: EmbeddedAgentContextUsage | null;
  /** Transcript Restore (#1123). See `EmbeddedAgentSnapshot.restoring` doc comment. */
  restoring: boolean;
  /** Transcript Restore (#1123). See `EmbeddedAgentSnapshot.restoredMessageCount` doc comment. */
  restoredMessageCount: number | null;
  /** Transcript Restore, R1. THREE-VALUED -- see `EmbeddedAgentSnapshot.sdkResumed`'s
   * doc comment before writing any check against it; `!sdkResumed` is wrong. */
  sdkResumed: boolean | undefined;
  sendUserMessage: (text: string) => Promise<void>;
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
    (text: string): Promise<void> => {
      return getOrCreateEmbeddedAgentWorker(sessionId, workerId).sendUserMessage(text);
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
    contextUsage: snapshot.contextUsage,
    restoring: snapshot.restoring,
    restoredMessageCount: snapshot.restoredMessageCount,
    sdkResumed: snapshot.sdkResumed,
    sendUserMessage,
    cancel,
    restart,
    retry,
    dismissError,
  };
}
