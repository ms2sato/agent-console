import { useEffect, useCallback, useSyncExternalStore } from 'react';
import type { GitDiffData, GitDiffTarget } from '@agent-console/shared';
import * as workerWs from '../lib/worker-websocket.js';

interface UseGitDiffWorkerOptions {
  sessionId: string;
  workerId: string;
  onConnectionChange?: (connected: boolean) => void;
}

interface UseGitDiffWorkerReturn {
  diffData: GitDiffData | null;
  error: string | null;
  loading: boolean;
  connected: boolean;
  refresh: () => void;
  setBaseCommit: (ref: string) => void;
  setTargetCommit: (ref: GitDiffTarget) => void;
}

export function useGitDiffWorker(options: UseGitDiffWorkerOptions): UseGitDiffWorkerReturn {
  const { sessionId, workerId, onConnectionChange } = options;

  // Subscribe to connection state using useSyncExternalStore
  const state = useSyncExternalStore(
    (callback) => workerWs.subscribeState(callback),
    () => workerWs.getState(sessionId, workerId)
  );

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    workerWs.connect(sessionId, workerId, {
      type: 'git-diff',
    });

    return () => {
      workerWs.disconnect(sessionId, workerId);
    };
  }, [sessionId, workerId]);

  // Notify connection changes
  useEffect(() => {
    onConnectionChange?.(state.connected);
  }, [state.connected, onConnectionChange]);

  const refresh = useCallback(() => {
    workerWs.refreshDiff(sessionId, workerId);
  }, [sessionId, workerId]);

  const setBaseCommit = useCallback((ref: string) => {
    workerWs.setBaseCommit(sessionId, workerId, ref);
  }, [sessionId, workerId]);

  const setTargetCommit = useCallback((ref: GitDiffTarget) => {
    workerWs.setTargetCommit(sessionId, workerId, ref);
  }, [sessionId, workerId]);

  return {
    diffData: state.diffData ?? null,
    error: state.diffError ?? null,
    loading: state.diffLoading ?? false,
    connected: state.connected,
    refresh,
    setBaseCommit,
    setTargetCommit,
  };
}
