import { useCallback, useRef, useState } from 'react';
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, fetchFileContent, fetchFileTree } from '../../lib/api';
import { useIsMobile } from '../../hooks/useIsMobile';
import { RefreshIcon } from '../Icons';
import { FileViewerContent } from './FileViewerContent';
import { useFileViewerLiveUpdates, type WatchUnavailableReason } from './hooks/useFileViewerLiveUpdates';
import { FILE_VIEWER_QUERY_OPTIONS, FileViewerTree, fileViewerKeys } from './FileViewerTree';

interface FileViewerWorkerViewProps {
  sessionId: string;
  workerId: string;
}

const WATCH_UNAVAILABLE_LABEL = {
  'permission-denied': 'permission denied',
  'watch-failed': 'watch failed',
} as const satisfies Record<WatchUnavailableReason, string>;

/** A symlink that could not be expanded as a directory, kept so its error shows beside the open attempt's. */
interface SymlinkTreeFailure {
  path: string;
  message: string;
}

/**
 * Read-only browser of the session's working directory: a lazily expanded
 * tree on the left, the selected file on the right. Which directories are
 * open and which file is selected is component state only; the server owns
 * everything else, and nothing is cached beyond what Refresh re-reads.
 */
export function FileViewerWorkerView({ sessionId, workerId }: FileViewerWorkerViewProps) {
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [symlinkFailure, setSymlinkFailure] = useState<SymlinkTreeFailure | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Advances on every selection-changing action. A symlink probe is async; it
  // applies its outcome only if no later action has happened since it started.
  const selectionRequestRef = useRef(0);

  const { watchUnavailable } = useFileViewerLiveUpdates({ sessionId, workerId, selectedPath });

  const isFetching = useIsFetching({ queryKey: fileViewerKeys.worker(sessionId, workerId) }) > 0;
  const content = useQuery({
    queryKey: fileViewerKeys.content(sessionId, workerId, selectedPath ?? ''),
    queryFn: () => fetchFileContent(sessionId, workerId, selectedPath ?? ''),
    enabled: selectedPath !== null,
    ...FILE_VIEWER_QUERY_OPTIONS,
  });

  function toggleDir(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }

  const dropDirectory = useCallback((path: string) => {
    setExpanded((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, []);

  function openFile(path: string) {
    selectionRequestRef.current++;
    setSymlinkFailure(null);
    setSelectedPath(path);
    setDrawerOpen(false);
  }

  async function openSymlink(path: string) {
    const request = ++selectionRequestRef.current;
    const isLatest = () => request === selectionRequestRef.current;
    setSymlinkFailure(null);
    try {
      await queryClient.fetchQuery({
        queryKey: fileViewerKeys.tree(sessionId, workerId, path),
        queryFn: () => fetchFileTree(sessionId, workerId, path),
        staleTime: 0,
        retry: false,
      });
      if (!isLatest()) return;
      setExpanded((prev) => new Set(prev).add(path));
    } catch (error) {
      if (!isLatest()) return;
      // Not a directory the viewer may list: try it as a file. If that fails
      // too, the content pane shows both routes' messages.
      setSymlinkFailure({ path, message: error instanceof Error ? error.message : 'Unknown error' });
      setSelectedPath(path);
      setDrawerOpen(false);
    }
  }

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: fileViewerKeys.worker(sessionId, workerId) });
  }

  const tree = (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 bg-slate-800 border-b border-gray-700 shrink-0 flex items-center justify-between">
        <span className="text-sm text-gray-400">Files</span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={isFetching}
          className="btn btn-primary text-xs flex items-center gap-1.5"
          title="Refresh the open directories and the selected file"
        >
          <RefreshIcon className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>
      {watchUnavailable !== null && (
        <p role="status" className="px-3 py-1 text-xs text-yellow-400 bg-slate-800 border-b border-gray-700 shrink-0">
          Live updates unavailable ({WATCH_UNAVAILABLE_LABEL[watchUnavailable]})
        </p>
      )}
      <div className="flex-1 min-h-0 overflow-auto py-1">
        <FileViewerTree
          sessionId={sessionId}
          workerId={workerId}
          expanded={expanded}
          selectedPath={selectedPath}
          onToggleDir={toggleDir}
          onOpenFile={openFile}
          onOpenSymlink={(path) => void openSymlink(path)}
          onDirectoryGone={dropDirectory}
        />
      </div>
    </div>
  );

  const pane = (() => {
    if (selectedPath === null) {
      return <Placeholder>Select a file to view it.</Placeholder>;
    }
    if (content.isPending) {
      return <Placeholder>Loading...</Placeholder>;
    }
    if (content.error instanceof ApiError && content.error.status === 404) {
      // The file was deleted or renamed away: not a failure. The selection is kept so a re-created file shows again.
      return (
        <div className="flex-1 p-4 text-sm text-gray-400 break-words">
          <p className="font-mono text-gray-300 break-all">{selectedPath}</p>
          <p className="mt-1">File removed</p>
        </div>
      );
    }
    if (content.error) {
      const treeMessage = symlinkFailure?.path === selectedPath ? symlinkFailure.message : null;
      return (
        <div role="alert" className="flex-1 p-4 text-sm text-red-400 break-words">
          <p className="font-mono text-gray-300 break-all">{selectedPath}</p>
          <p className="mt-1">{content.error.message}</p>
          {treeMessage && treeMessage !== content.error.message && (
            <p className="mt-1 text-gray-500">Also tried as a directory: {treeMessage}</p>
          )}
        </div>
      );
    }
    return <FileViewerContent key={content.data.path} file={content.data} />;
  })();

  if (isMobile) {
    return (
      <div className="relative flex flex-col flex-1 min-h-0 bg-slate-900">
        <div className="px-2 py-1 bg-slate-800 border-b border-gray-700 shrink-0">
          <button
            type="button"
            onClick={() => setDrawerOpen((open) => !open)}
            aria-expanded={drawerOpen}
            aria-label="Toggle file tree"
            className="px-2 py-1 text-sm text-gray-300 hover:text-white min-h-[44px]"
          >
            Files
          </button>
        </div>
        {pane}
        {drawerOpen && (
          <div className="absolute inset-0 z-20 flex">
            <div role="dialog" aria-modal="true" aria-label="File tree" className="w-72 max-w-[85%] bg-slate-800 border-r border-gray-700">
              {tree}
            </div>
            <button
              type="button"
              aria-label="Close file tree"
              className="flex-1 bg-black/50 border-none cursor-default"
              onClick={() => setDrawerOpen(false)}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 bg-slate-900">
      <div className="w-72 shrink-0 border-r border-gray-700 bg-slate-800">{tree}</div>
      <div className="flex flex-col flex-1 min-w-0 min-h-0">{pane}</div>
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-center flex-1 text-gray-500 text-sm">{children}</div>;
}
