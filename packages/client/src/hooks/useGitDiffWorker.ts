import { useEffect, useCallback, useSyncExternalStore } from 'react';
import type { GitDiffData, GitDiffTarget } from '@agent-console/shared';
import * as workerWs from '../lib/worker-websocket.js';

// Stable empty Map to avoid infinite re-renders with useSyncExternalStore
const EMPTY_EXPANDED_LINES = new Map<string, { startLine: number; lines: string[] }[]>();

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
  expandedLines: Map<string, { startLine: number; lines: string[] }[]>;
  requestFileLines: (path: string, startLine: number, endLine: number) => void;
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

  const requestFileLines = useCallback((path: string, startLine: number, endLine: number) => {
    const ref = state.diffData?.summary.targetRef ?? 'working-dir';
    workerWs.requestFileLines(sessionId, workerId, path, startLine, endLine, ref);
  }, [sessionId, workerId, state.diffData?.summary.targetRef]);

  return {
    diffData: state.diffData ?? null,
    error: state.diffError ?? null,
    loading: state.diffLoading ?? false,
    connected: state.connected,
    refresh,
    setBaseCommit,
    setTargetCommit,
    expandedLines: state.expandedLines ?? EMPTY_EXPANDED_LINES,
    requestFileLines,
  };
}
