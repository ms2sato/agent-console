import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FileTreeEntry } from '@agent-console/shared';
import { ApiError, fetchFileTree } from '../../lib/api';
import { ChevronDownIcon, ChevronRightIcon, DocumentIcon, FolderIcon } from '../Icons';

/** Query keys of one file viewer worker; everything shares the worker prefix so Refresh can invalidate it as a unit. */
export const fileViewerKeys = {
  worker: (sessionId: string, workerId: string) => ['file-viewer', sessionId, workerId] as const,
  tree: (sessionId: string, workerId: string, path: string) =>
    ['file-viewer', sessionId, workerId, 'tree', path] as const,
  content: (sessionId: string, workerId: string, path: string) =>
    ['file-viewer', sessionId, workerId, 'content', path] as const,
};

/**
 * Listings and contents change only when the user asks (Refresh), so they
 * never go stale by themselves. A directory or file that is mounted again
 * (re-expanded, re-selected) still re-reads, showing the cached rows
 * meanwhile. Route errors are deterministic (outside the working directory,
 * not a directory), so there is nothing to retry.
 */
export const FILE_VIEWER_QUERY_OPTIONS = {
  staleTime: Infinity,
  refetchOnMount: 'always',
  refetchOnWindowFocus: false,
  retry: false,
} as const;

function joinPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

interface FileViewerTreeProps {
  sessionId: string;
  workerId: string;
  expanded: ReadonlySet<string>;
  selectedPath: string | null;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  /** A symlink's target kind is unknown: the owner tries to expand it, then to open it. */
  onOpenSymlink: (path: string) => void;
  /** A non-root directory whose listing answered 404 (deleted): the owner drops it from the open set. */
  onDirectoryGone: (path: string) => void;
}

export function FileViewerTree(props: FileViewerTreeProps) {
  return (
    <div role="tree" aria-label="Files" className="text-sm">
      <DirectoryEntries {...props} path="" depth={0} />
    </div>
  );
}

interface DirectoryEntriesProps extends FileViewerTreeProps {
  path: string;
  depth: number;
}

function DirectoryEntries(props: DirectoryEntriesProps) {
  const { sessionId, workerId, path, depth, onDirectoryGone } = props;
  const { data, error, isPending } = useQuery({
    queryKey: fileViewerKeys.tree(sessionId, workerId, path),
    queryFn: () => fetchFileTree(sessionId, workerId, path),
    ...FILE_VIEWER_QUERY_OPTIONS,
  });
  const indent = { paddingLeft: `${depth * 12 + 8}px` };
  // The root keeps its alert: there is nothing above it to collapse.
  const isGone = path !== '' && error instanceof ApiError && error.status === 404;

  useEffect(() => {
    if (isGone) onDirectoryGone(path);
  }, [isGone, path, onDirectoryGone]);

  if (isGone) return null;
  if (isPending) {
    return <div className="py-1 text-gray-500 text-xs" style={indent}>Loading...</div>;
  }
  if (error) {
    return (
      <div role="alert" className="py-1 pr-2 text-red-400 text-xs break-words" style={indent}>
        {error.message}
      </div>
    );
  }
  if (data.entries.length === 0) {
    return <div className="py-1 text-gray-500 text-xs" style={indent}>Empty directory</div>;
  }

  return (
    <ul role="group" className="list-none m-0 p-0">
      {data.entries.map((entry) => (
        <TreeEntry key={entry.name} {...props} entry={entry} childPath={joinPath(path, entry.name)} />
      ))}
    </ul>
  );
}

function KindGlyph({ kind, isOpen }: { kind: FileTreeEntry['kind']; isOpen: boolean }) {
  switch (kind) {
    case 'dir':
      return (
        <>
          {isOpen ? <ChevronDownIcon className="w-3 h-3 shrink-0" /> : <ChevronRightIcon className="w-3 h-3 shrink-0" />}
          <FolderIcon className="w-4 h-4 shrink-0 text-yellow-500" />
        </>
      );
    case 'symlink':
      return (
        <>
          <span className="w-3 shrink-0" aria-hidden="true" />
          <span className="w-4 shrink-0 text-center text-cyan-400" aria-hidden="true">{'↪'}</span>
        </>
      );
    case 'file':
      return (
        <>
          <span className="w-3 shrink-0" aria-hidden="true" />
          <DocumentIcon className="w-4 h-4 shrink-0 text-gray-400" />
        </>
      );
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

interface TreeEntryProps extends DirectoryEntriesProps {
  entry: FileTreeEntry;
  childPath: string;
}

function TreeEntry(props: TreeEntryProps) {
  const { entry, childPath, depth, expanded, selectedPath, onToggleDir, onOpenFile, onOpenSymlink } = props;
  const isOpen = expanded.has(childPath);
  const isSelected = selectedPath === childPath;

  function handleClick() {
    switch (entry.kind) {
      case 'dir':
        onToggleDir(childPath);
        break;
      case 'file':
        onOpenFile(childPath);
        break;
      case 'symlink':
        // Already expanded: collapse it. Otherwise try to expand or open it.
        if (isOpen) onToggleDir(childPath);
        else onOpenSymlink(childPath);
        break;
      default: {
        const _exhaustive: never = entry.kind;
        return _exhaustive;
      }
    }
  }

  return (
    <li role="treeitem" aria-expanded={entry.kind === 'file' ? undefined : isOpen} aria-selected={isSelected}>
      <button
        type="button"
        data-kind={entry.kind}
        aria-label={entry.kind === 'symlink' ? `${entry.name} (symlink)` : entry.name}
        onClick={handleClick}
        className={`w-full flex items-center gap-1.5 py-1 pr-2 text-left hover:bg-slate-700 ${
          isSelected ? 'bg-slate-700 text-white' : 'text-gray-300'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <KindGlyph kind={entry.kind} isOpen={isOpen} />
        <span className="truncate">{entry.name}</span>
      </button>
      {isOpen && entry.kind !== 'file' && <DirectoryEntries {...props} path={childPath} depth={depth + 1} />}
    </li>
  );
}
