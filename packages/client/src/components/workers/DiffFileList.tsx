import { useMemo } from 'react';
import type { GitDiffFile, GitFileStatus, GitStageState } from '@agent-console/shared';
import { FolderIcon } from '../Icons';

/**
 * DiffFileList - Displays a tree-structured list of changed files from git diff
 *
 * Features:
 * - Groups files by directory in a collapsible tree structure
 * - Shows file status with colored icons ([A] Added, [M] Modified, [D] Deleted, [R] Renamed, [?] Untracked)
 * - Displays staged state with asterisk (e.g., [M*] for staged modifications)
 * - Shows additions/deletions count per file (+N / -N)
 * - Highlights the currently selected file
 * - Indicates binary files
 *
 * @example
 * ```tsx
 * <DiffFileList
 *   files={gitDiffFiles}
 *   selectedPath={currentPath}
 *   onSelectFile={(path) => setCurrentPath(path)}
 * />
 * ```
 */
interface DiffFileListProps {
  files: GitDiffFile[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
}

interface FileTreeNode {
  name: string;
  path: string;
  file?: GitDiffFile;
  children: Map<string, FileTreeNode>;
  isDirectory: boolean;
}

/**
 * Build a tree structure from flat file list
 */
function buildFileTree(files: GitDiffFile[]): FileTreeNode {
  const root: FileTreeNode = {
    name: '',
    path: '',
    children: new Map(),
    isDirectory: true,
  };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const pathSoFar = parts.slice(0, i + 1).join('/');

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          path: pathSoFar,
          children: new Map(),
          isDirectory: !isLast,
          file: isLast ? file : undefined,
        });
      }

      current = current.children.get(part)!;
    }
  }

  return root;
}

/**
 * Get status icon/label for a file
 */
function getStatusLabel(status: GitFileStatus, stageState: GitStageState): string {
  const staged = stageState === 'staged' || stageState === 'partial';
  const suffix = staged ? '*' : '';

  switch (status) {
    case 'added':
      return `A${suffix}`;
    case 'modified':
      return `M${suffix}`;
    case 'deleted':
      return `D${suffix}`;
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    case 'untracked':
      return '?';
    default:
      return '?';
  }
}

/**
 * Get color class for status
 */
function getStatusColor(status: GitFileStatus): string {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'text-green-400';
    case 'modified':
      return 'text-yellow-400';
    case 'deleted':
      return 'text-red-400';
    case 'renamed':
    case 'copied':
      return 'text-blue-400';
    default:
      return 'text-gray-400';
  }
}

interface FileTreeItemProps {
  node: FileTreeNode;
  level: number;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
}

function FileTreeItem({ node, level, selectedPath, onSelectFile }: FileTreeItemProps) {
  const indentPx = level * 12;

  // If this is a file node (has file data)
  if (node.file) {
    const file = node.file;
    const isSelected = selectedPath === file.path;
    const statusLabel = getStatusLabel(file.status, file.stageState);
    const statusColor = getStatusColor(file.status);

    return (
      <div
        className={`
          flex items-center gap-2 px-2 py-1.5 cursor-pointer
          hover:bg-slate-700/50 transition-colors
          ${isSelected ? 'bg-slate-700' : ''}
        `}
        style={{ paddingLeft: `${indentPx + 8}px` }}
        onClick={() => onSelectFile(file.path)}
      >
        {/* Status icon */}
        <span className={`font-mono text-xs font-semibold w-6 text-center ${statusColor}`}>
          [{statusLabel}]
        </span>

        {/* File name */}
        <span className="text-sm text-gray-200 flex-1 truncate">
          {node.name}
          {file.status === 'renamed' && file.oldPath && (
            <span className="text-gray-500 text-xs ml-2">
              (from {file.oldPath.split('/').pop()})
            </span>
          )}
        </span>

        {/* Stats */}
        {!file.isBinary && (
          <span className="text-xs font-mono whitespace-nowrap">
            {file.additions > 0 && (
              <span className="text-green-400">+{file.additions}</span>
            )}
            {file.additions > 0 && file.deletions > 0 && (
              <span className="text-gray-500 mx-1">/</span>
            )}
            {file.deletions > 0 && (
              <span className="text-red-400">-{file.deletions}</span>
            )}
          </span>
        )}

        {file.isBinary && (
          <span className="text-xs text-gray-500 italic">binary</span>
        )}
      </div>
    );
  }

  // Directory node - render directory and its children
  const children = Array.from(node.children.values()).sort((a, b) => {
    // Directories first, then files
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      {/* Directory header (only if not root) */}
      {node.name && (
        <div
          className="flex items-center gap-2 px-2 py-1 text-gray-400"
          style={{ paddingLeft: `${indentPx + 8}px` }}
        >
          <FolderIcon className="w-4 h-4" />
          <span className="text-sm font-medium">{node.name}</span>
        </div>
      )}

      {/* Children */}
      {children.map((child) => (
        <FileTreeItem
          key={child.path}
          node={child}
          level={node.name ? level + 1 : level}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
        />
      ))}
    </>
  );
}

export function DiffFileList({ files, selectedPath, onSelectFile }: DiffFileListProps) {
  const fileTree = useMemo(() => buildFileTree(files), [files]);

  if (files.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        No changed files
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-slate-800 border-r border-gray-700">
      <div className="py-2">
        <FileTreeItem
          node={fileTree}
          level={0}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
        />
      </div>
    </div>
  );
}
