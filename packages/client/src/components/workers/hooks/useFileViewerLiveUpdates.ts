import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as workerWs from '../../../lib/worker-websocket.js';
import { fileViewerKeys } from '../FileViewerTree';

export type WatchUnavailableReason = 'permission-denied' | 'watch-failed';

interface UseFileViewerLiveUpdatesOptions {
  sessionId: string;
  workerId: string;
  /** The file shown in the content pane; its content query is invalidated when it changes. */
  selectedPath: string | null;
}

/** Everything before the last `/`, or '' for a root-level path. */
function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/**
 * Subscribes to the file viewer's worker WebSocket while mounted and turns
 * each `files-changed` batch into query invalidations. Only mounted (active)
 * queries refetch (the default `refetchType: 'active'`); an inactive key is
 * merely marked stale, so a change inside a collapsed directory costs nothing.
 *
 * After a pause and resume the view remounts and this hook does not invalidate
 * the worker prefix (its first open counts as the first open); the queries'
 * `refetchOnMount: 'always'` (FILE_VIEWER_QUERY_OPTIONS) re-reads what was missed.
 */
export function useFileViewerLiveUpdates({ sessionId, workerId, selectedPath }: UseFileViewerLiveUpdatesOptions): {
  watchUnavailable: WatchUnavailableReason | null;
} {
  const queryClient = useQueryClient();
  const [watchUnavailable, setWatchUnavailable] = useState<WatchUnavailableReason | null>(null);

  // The socket callbacks are installed once per (sessionId, workerId); they read the latest selection here.
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;

  const { connected } = useSyncExternalStore(
    (callback) => workerWs.subscribeState(callback),
    () => workerWs.getState(sessionId, workerId),
  );

  useEffect(() => {
    workerWs.connect(sessionId, workerId, {
      type: 'file-viewer',
      onFilesChanged: ({ paths, overflow }) => {
        if (overflow) {
          void queryClient.invalidateQueries({ queryKey: fileViewerKeys.worker(sessionId, workerId) });
          return;
        }
        for (const dir of new Set(paths.map(dirname))) {
          void queryClient.invalidateQueries({ queryKey: fileViewerKeys.tree(sessionId, workerId, dir), exact: true });
        }
        const selected = selectedPathRef.current;
        if (selected !== null && paths.includes(selected)) {
          void queryClient.invalidateQueries({
            queryKey: fileViewerKeys.content(sessionId, workerId, selected),
            exact: true,
          });
        }
      },
      onWatchUnavailable: setWatchUnavailable,
    });
    return () => {
      workerWs.disconnect(sessionId, workerId);
    };
  }, [sessionId, workerId, queryClient]);

  // Changes during a connection gap are lost (messages are not replayed), so every open after the first re-reads everything.
  const opensRef = useRef(0);
  useEffect(() => {
    if (!connected) return;
    opensRef.current++;
    // A fresh connection re-reports an unwatchable directory itself.
    setWatchUnavailable(null);
    if (opensRef.current > 1) {
      void queryClient.invalidateQueries({ queryKey: fileViewerKeys.worker(sessionId, workerId) });
    }
  }, [connected, sessionId, workerId, queryClient]);

  return { watchUnavailable };
}
