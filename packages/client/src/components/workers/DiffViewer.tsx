import { useRef, useEffect, useCallback, useMemo } from 'react';
import { parsePatch } from 'diff';
import type { GitDiffFile } from '@agent-console/shared';

interface DiffViewerProps {
  rawDiff: string;
  files: GitDiffFile[];
  scrollToFile: string | null;
  onFileVisible?: (filePath: string) => void;
}

/**
 * Sort files to match the tree structure display order:
 * - Group by directory
 * - Directories first, then files
 * - Alphabetical order within each group
 */
function sortFilesAsTree(files: GitDiffFile[]): GitDiffFile[] {
  // Build a tree structure
  interface TreeNode {
    name: string;
    path: string;
    file?: GitDiffFile;
    children: Map<string, TreeNode>;
    isDirectory: boolean;
  }

  const root: TreeNode = {
    name: '',
    path: '',
    children: new Map(),
    isDirectory: true,
  };

  // Build tree from files
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

  // Flatten tree in sorted order (directories first, then alphabetical)
  const result: GitDiffFile[] = [];

  function traverse(node: TreeNode) {
    const children = Array.from(node.children.values()).sort((a, b) => {
      // Directories first, then files
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    for (const child of children) {
      if (child.file) {
        result.push(child.file);
      }
      traverse(child);
    }
  }

  traverse(root);
  return result;
}

export function DiffViewer({ rawDiff, files, scrollToFile, onFileVisible }: DiffViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Parse the diff once
  const parsedFiles = parsePatch(rawDiff);
  const stripPrefix = (name: string | undefined) => name?.replace(/^[ab]\//, '');

  // Sort files to match the left sidebar tree order
  const sortedFiles = useMemo(() => sortFilesAsTree(files), [files]);

  // Scroll to file when scrollToFile changes
  useEffect(() => {
    if (scrollToFile && fileRefs.current.has(scrollToFile)) {
      const element = fileRefs.current.get(scrollToFile);
      element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [scrollToFile]);

  // Set up intersection observer for tracking visible files
  useEffect(() => {
    if (!onFileVisible || !containerRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const filePath = entry.target.getAttribute('data-filepath');
            if (filePath) {
              onFileVisible(filePath);
            }
          }
        }
      },
      {
        root: containerRef.current,
        rootMargin: '-10% 0px -80% 0px', // Consider file "visible" when near top of viewport
        threshold: 0,
      }
    );

    // Observe all file sections
    for (const element of fileRefs.current.values()) {
      observer.observe(element);
    }

    return () => observer.disconnect();
  }, [onFileVisible, files]);

  const setFileRef = useCallback((filePath: string, element: HTMLDivElement | null) => {
    if (element) {
      fileRefs.current.set(filePath, element);
    } else {
      fileRefs.current.delete(filePath);
    }
  }, []);

  // Handle empty state
  if (files.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        No changes to display
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full overflow-auto bg-slate-900">
      <div className="font-mono text-sm">
        {sortedFiles.map((file) => {
          // Find parsed diff for this file
          const parsedFile = parsedFiles.find(
            (f) =>
              stripPrefix(f.oldFileName) === file.path ||
              stripPrefix(f.newFileName) === file.path
          );

          return (
            <div
              key={file.path}
              ref={(el) => setFileRef(file.path, el)}
              data-filepath={file.path}
              className="border-b border-gray-700"
            >
              {/* File header */}
              <div className="sticky top-0 z-20 bg-slate-800 px-4 py-2 flex items-center gap-3 border-b border-gray-700">
                <FileStatusBadge status={file.status} />
                <span className="text-gray-200 font-medium">{file.path}</span>
                <div className="flex items-center gap-2 ml-auto text-sm">
                  <span className="text-green-400">+{file.additions}</span>
                  <span className="text-red-400">-{file.deletions}</span>
                </div>
              </div>

              {/* File diff content */}
              {file.isBinary ? (
                <div className="flex items-center justify-center py-8 text-gray-500">
                  Binary file
                </div>
              ) : parsedFile && parsedFile.hunks.length > 0 ? (
                <FileHunks hunks={parsedFile.hunks} />
              ) : (
                <div className="flex items-center justify-center py-8 text-gray-500">
                  {file.status === 'untracked' ? 'New file (untracked)' : 'No diff available'}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface FileStatusBadgeProps {
  status: GitDiffFile['status'];
}

function FileStatusBadge({ status }: FileStatusBadgeProps) {
  const config: Record<GitDiffFile['status'], { label: string; className: string }> = {
    added: { label: 'A', className: 'bg-green-600 text-white' },
    modified: { label: 'M', className: 'bg-yellow-600 text-white' },
    deleted: { label: 'D', className: 'bg-red-600 text-white' },
    renamed: { label: 'R', className: 'bg-blue-600 text-white' },
    copied: { label: 'C', className: 'bg-purple-600 text-white' },
    untracked: { label: 'U', className: 'bg-gray-600 text-white' },
  };

  const { label, className } = config[status] || { label: '?', className: 'bg-gray-600 text-white' };

  return (
    <span className={`px-1.5 py-0.5 text-xs font-bold rounded ${className}`}>
      {label}
    </span>
  );
}

interface FileHunksProps {
  hunks: ReturnType<typeof parsePatch>[0]['hunks'];
}

function FileHunks({ hunks }: FileHunksProps) {
  return (
    <div>
      {hunks.map((hunk, hunkIndex) => (
        <div key={hunkIndex}>
          {/* Hunk header */}
          <div className="bg-blue-900/30 text-blue-300 px-4 py-1">
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
          </div>

          {/* Hunk lines */}
          <div>
            {hunk.lines.map((line, lineIndex) => {
              const lineType = line[0];
              const content = line.slice(1);

              // Calculate line numbers
              let oldLineNum: number | null = null;
              let newLineNum: number | null = null;

              // Track current position in old and new files
              let oldLine = hunk.oldStart;
              let newLine = hunk.newStart;

              // Calculate line numbers by walking through lines up to current position
              for (let i = 0; i <= lineIndex; i++) {
                const currentLineType = hunk.lines[i][0];

                if (i === lineIndex) {
                  if (currentLineType === ' ' || currentLineType === '-') {
                    oldLineNum = oldLine;
                  }
                  if (currentLineType === ' ' || currentLineType === '+') {
                    newLineNum = newLine;
                  }
                }

                // Increment counters for next iteration
                if (currentLineType === ' ') {
                  oldLine++;
                  newLine++;
                } else if (currentLineType === '-') {
                  oldLine++;
                } else if (currentLineType === '+') {
                  newLine++;
                }
              }

              // Determine styling based on line type
              let bgColor = '';
              let textColor = 'text-gray-300';
              let prefix = '';

              if (lineType === '+') {
                bgColor = 'bg-green-900/30';
                textColor = 'text-green-300';
                prefix = '+';
              } else if (lineType === '-') {
                bgColor = 'bg-red-900/30';
                textColor = 'text-red-300';
                prefix = '-';
              } else {
                bgColor = 'bg-slate-900';
                textColor = 'text-gray-400';
                prefix = ' ';
              }

              return (
                <div
                  key={lineIndex}
                  className={`flex ${bgColor} hover:bg-slate-800/50`}
                >
                  {/* Old line number */}
                  <div className="w-12 text-right px-2 text-gray-600 select-none shrink-0 border-r border-gray-800">
                    {oldLineNum !== null ? oldLineNum : ''}
                  </div>

                  {/* New line number */}
                  <div className="w-12 text-right px-2 text-gray-600 select-none shrink-0 border-r border-gray-800">
                    {newLineNum !== null ? newLineNum : ''}
                  </div>

                  {/* Line content */}
                  <div className={`flex-1 px-4 py-0.5 ${textColor} whitespace-pre overflow-x-auto`}>
                    <span className="select-none">{prefix}</span>
                    {content}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
