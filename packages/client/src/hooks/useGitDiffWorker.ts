import { useEffect, useRef, useCallback, useState } from 'react';
import type { GitDiffServerMessage, GitDiffClientMessage, GitDiffData } from '@agent-console/shared';

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
}

export function useGitDiffWorker(options: UseGitDiffWorkerOptions): UseGitDiffWorkerReturn {
  const { sessionId, workerId, onConnectionChange } = options;
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [diffData, setDiffData] = useState<GitDiffData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const onConnectionChangeRef = useRef(onConnectionChange);
  onConnectionChangeRef.current = onConnectionChange;

  // Construct WebSocket URL
  const wsUrl = `ws://${window.location.host}/ws/session/${sessionId}/worker/${workerId}`;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let cancelled = false;

    // Small delay to handle React Strict Mode's double-mount behavior
    // This ensures the first mount/unmount cycle completes before connecting
    const timeoutId = setTimeout(() => {
      if (cancelled) return;

      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) {
          ws?.close();
          return;
        }
        setConnected(true);
        setLoading(true);
        onConnectionChangeRef.current?.(true);
      };

      ws.onmessage = (event) => {
        try {
          const msg: GitDiffServerMessage = JSON.parse(event.data);
          switch (msg.type) {
            case 'diff-data':
              setDiffData(msg.data);
              setError(null);
              setLoading(false);
              break;
            case 'diff-error':
              setError(msg.error);
              setDiffData(null);
              setLoading(false);
              break;
          }
        } catch (e) {
          console.error('Failed to parse WebSocket message:', e);
          setError('Failed to parse server message');
          setLoading(false);
        }
      };

      ws.onclose = () => {
        if (!cancelled) {
          setConnected(false);
          onConnectionChangeRef.current?.(false);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setError('WebSocket connection error');
        setLoading(false);
      };
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      if (ws) {
        ws.close();
      }
    };
  }, [wsUrl]);

  const refresh = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg: GitDiffClientMessage = { type: 'refresh' };
      wsRef.current.send(JSON.stringify(msg));
      setLoading(true);
    }
  }, []);

  const setBaseCommit = useCallback((ref: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg: GitDiffClientMessage = { type: 'set-base-commit', ref };
      wsRef.current.send(JSON.stringify(msg));
      setLoading(true);
    }
  }, []);

  return {
    diffData,
    error,
    loading,
    connected,
    refresh,
    setBaseCommit,
  };
}
