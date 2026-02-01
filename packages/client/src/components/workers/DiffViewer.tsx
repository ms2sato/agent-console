import { useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { parsePatch } from 'diff';
import { Highlight, themes, type Language } from 'prism-react-renderer';
import type { GitDiffFile, ExpandedLineChunk } from '@agent-console/shared';

// Import additional language support (ruby, bash, css, scss, less, typescript, javascript, sql)
import '../../lib/prism-languages';

/**
 * Get Prism language from file path extension
 */
function getLanguageFromPath(filePath: string): Language {
  const extension = filePath.split('.').pop()?.toLowerCase() || '';
  const languageMap: Record<string, Language> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    mjs: 'javascript',
    cjs: 'javascript',
    css: 'css',
    scss: 'scss',
    sass: 'scss',
    less: 'less',
    json: 'json',
    md: 'markdown',
    mdx: 'markdown',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
    py: 'python',
    rs: 'rust',
    go: 'go',
    sql: 'sql',
    rb: 'ruby',
    ruby: 'ruby',
    rake: 'ruby',
    gemspec: 'ruby',
    erb: 'markup',
    rhtml: 'markup',
    html: 'markup',
    htm: 'markup',
    xml: 'markup',
    svg: 'markup',
  };

  // Handle special filenames
  const fileName = filePath.split('/').pop()?.toLowerCase() || '';
  if (fileName === 'dockerfile') return 'bash';
  if (fileName === 'gemfile' || fileName === 'rakefile') return 'ruby';
  if (fileName === '.gitignore' || fileName === '.env') return 'bash';

  return languageMap[extension] || 'plain';
}

interface DiffViewerProps {
  rawDiff: string;
  files: GitDiffFile[];
  scrollToFile: string | null;
  onFileVisible?: (filePath: string) => void;
  expandedLines?: Map<string, ExpandedLineChunk[]>;
  onRequestExpand?: (path: string, startLine: number, endLine: number) => void;
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

export function DiffViewer({ rawDiff, files, scrollToFile, onFileVisible, expandedLines, onRequestExpand }: DiffViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Track scroll position to preserve it across data updates
  const scrollPositionRef = useRef<number>(0);
  const prevRawDiffRef = useRef<string>(rawDiff);
  // Track when we just executed a programmatic scroll (to prevent useLayoutEffect from resetting)
  const justScrolledRef = useRef(false);

  // Memoize parsed diff to avoid re-parsing on every render (expensive for large diffs)
  const parsedFiles = useMemo(() => parsePatch(rawDiff), [rawDiff]);
  const stripPrefix = (name: string | undefined) => name?.replace(/^[ab]\//, '');

  // Sort files to match the left sidebar tree order
  const sortedFiles = useMemo(() => sortFilesAsTree(files), [files]);

  // Track scroll position on scroll events
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      scrollPositionRef.current = container.scrollTop;
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // Restore scroll position after data updates (but not on initial mount or explicit scroll)
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Skip if we just did a programmatic scroll (to prevent resetting to 0)
    if (justScrolledRef.current) {
      prevRawDiffRef.current = rawDiff;
      return;
    }

    // Only restore if rawDiff changed (data update from WebSocket)
    // and not on initial mount (prevRawDiffRef would equal rawDiff)
    const shouldRestore = prevRawDiffRef.current !== rawDiff && prevRawDiffRef.current !== '';
    if (shouldRestore) {
      // Data was updated, restore scroll position
      // But skip if we're trying to scroll to a specific file
      // Also skip if scrollPositionRef is 0 (no meaningful scroll position yet)
      if (!scrollToFile && scrollPositionRef.current > 0) {
        container.scrollTop = scrollPositionRef.current;
      }
    }

    prevRawDiffRef.current = rawDiff;
  }, [rawDiff, scrollToFile]);

  // Scroll to file when scrollToFile changes.
  // Uses rAF retry loop because DOM elements may not be ready immediately after render.
  // The activeScrollRef persists the target even if scrollToFile becomes null quickly
  // (which happens in React StrictMode or when parent clears state).
  const activeScrollRef = useRef<{ targetFile: string; retryCount: number } | null>(null);

  useEffect(() => {
    if (!scrollToFile) return;

    const targetFile = scrollToFile;
    const MAX_SCROLL_RETRIES = 20;
    const PROGRAMMATIC_SCROLL_FLAG_DELAY_MS = 500;

    justScrolledRef.current = true;
    activeScrollRef.current = { targetFile, retryCount: 0 };

    function attemptScroll(): void {
      const active = activeScrollRef.current;
      if (!active || active.targetFile !== targetFile) return;

      const container = containerRef.current;
      const element = fileRefs.current.get(targetFile);

      if (container && element) {
        const scrollOffset =
          element.getBoundingClientRect().top -
          container.getBoundingClientRect().top +
          container.scrollTop;

        container.scrollTop = scrollOffset;
        scrollPositionRef.current = scrollOffset;
        activeScrollRef.current = null;
        return;
      }

      active.retryCount++;
      if (active.retryCount < MAX_SCROLL_RETRIES) {
        requestAnimationFrame(attemptScroll);
      } else {
        activeScrollRef.current = null;
      }
    }

    requestAnimationFrame(attemptScroll);

    // Allow useLayoutEffect to skip restoration during programmatic scroll
    const timeoutId = setTimeout(() => {
      justScrolledRef.current = false;
    }, PROGRAMMATIC_SCROLL_FLAG_DELAY_MS);

    return () => clearTimeout(timeoutId);
  }, [scrollToFile]);

  // Set up intersection observer for tracking visible files
  // Use a ref to store the observer so we can add/remove elements dynamically
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Create the observer once when the component mounts
  useEffect(() => {
    if (!onFileVisible || !containerRef.current) return;

    observerRef.current = new IntersectionObserver(
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

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [onFileVisible]);

  // Observe elements when they're added to the DOM
  // This effect runs after render to ensure refs are populated
  useEffect(() => {
    if (!observerRef.current) return;

    for (const element of fileRefs.current.values()) {
      observerRef.current.observe(element);
    }
  }, [sortedFiles]); // Re-observe when sorted files change (elements might have changed)

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
                <FileHunks
                  hunks={parsedFile.hunks}
                  filePath={file.path}
                  expandedChunks={expandedLines?.get(file.path)}
                  onRequestExpand={onRequestExpand ? (startLine, endLine) => onRequestExpand(file.path, startLine, endLine) : undefined}
                />
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
  filePath: string;
  expandedChunks?: ExpandedLineChunk[];
  onRequestExpand?: (startLine: number, endLine: number) => void;
}

const MAX_EXPAND_LINES = 20;

/**
 * Get expanded lines that fall within a given range (inclusive).
 * Returns lines sorted by startLine.
 */
function getExpandedLinesInRange(
  chunks: ExpandedLineChunk[] | undefined,
  rangeStart: number,
  rangeEnd: number
): { lineNumber: number; content: string }[] {
  if (!chunks || rangeStart > rangeEnd) return [];

  const result: { lineNumber: number; content: string }[] = [];
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.lines.length; i++) {
      const lineNum = chunk.startLine + i;
      if (lineNum >= rangeStart && lineNum <= rangeEnd) {
        result.push({ lineNumber: lineNum, content: chunk.lines[i] });
      }
    }
  }
  result.sort((a, b) => a.lineNumber - b.lineNumber);
  return result;
}

function ExpandButton({ linesAvailable, onClick }: { linesAvailable: number; onClick: () => void }) {
  const linesToShow = Math.min(linesAvailable, MAX_EXPAND_LINES);
  return (
    <div
      className="flex items-center justify-center py-1 bg-slate-800/50 hover:bg-slate-700/50 cursor-pointer border-y border-gray-800"
      onClick={onClick}
    >
      <span className="text-xs text-blue-400">
        Show {linesToShow} more lines
      </span>
    </div>
  );
}

function ExpandedContextLine({ lineNumber, content, language }: { lineNumber: number; content: string; language: Language }) {
  return (
    <div className="flex bg-slate-900 hover:bg-slate-800/50">
      <div className="w-12 text-right px-2 text-gray-600 select-none shrink-0 border-r border-gray-800">
        {lineNumber}
      </div>
      <div className="w-12 text-right px-2 text-gray-600 select-none shrink-0 border-r border-gray-800">
        {lineNumber}
      </div>
      <div className="flex-1 px-4 py-0.5 whitespace-pre-wrap break-all">
        <span className="select-none mr-2 text-gray-400">{' '}</span>
        <HighlightedLine code={content} language={language} />
      </div>
    </div>
  );
}

function FileHunks({ hunks, filePath, expandedChunks, onRequestExpand }: FileHunksProps) {
  const language = getLanguageFromPath(filePath);

  const elements: React.ReactNode[] = [];

  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex++) {
    const hunk = hunks[hunkIndex];

    // Calculate gap before this hunk
    let gapStart: number;
    let gapEnd: number;

    if (hunkIndex === 0) {
      gapStart = 1;
      gapEnd = hunk.oldStart - 1;
    } else {
      const prevHunk = hunks[hunkIndex - 1];
      gapStart = prevHunk.oldStart + prevHunk.oldLines;
      gapEnd = hunk.oldStart - 1;
    }

    if (gapStart <= gapEnd && onRequestExpand) {
      // Render any already-expanded lines in this gap
      const expandedInGap = getExpandedLinesInRange(expandedChunks, gapStart, gapEnd);

      if (expandedInGap.length > 0) {
        elements.push(
          <div key={`expanded-${hunkIndex}`}>
            {expandedInGap.map((line) => (
              <ExpandedContextLine
                key={`exp-${line.lineNumber}`}
                lineNumber={line.lineNumber}
                content={line.content}
                language={language}
              />
            ))}
          </div>
        );

        // Check if there are still unexpanded lines in the gap
        const lastExpandedLine = expandedInGap[expandedInGap.length - 1].lineNumber;
        const firstExpandedLine = expandedInGap[0].lineNumber;

        // Lines remaining before expanded chunk (for top-of-file gaps)
        if (hunkIndex === 0 && firstExpandedLine > gapStart) {
          const remainingBefore = firstExpandedLine - gapStart;
          const requestStart = Math.max(gapStart, firstExpandedLine - MAX_EXPAND_LINES);
          elements.splice(elements.length - 1, 0,
            <ExpandButton
              key={`expand-before-${hunkIndex}`}
              linesAvailable={remainingBefore}
              onClick={() => onRequestExpand(requestStart, firstExpandedLine - 1)}
            />
          );
        }

        // Lines remaining after expanded chunk
        if (lastExpandedLine < gapEnd) {
          const remaining = gapEnd - lastExpandedLine;
          const requestEnd = Math.min(gapEnd, lastExpandedLine + MAX_EXPAND_LINES);
          elements.push(
            <ExpandButton
              key={`expand-after-${hunkIndex}`}
              linesAvailable={remaining}
              onClick={() => onRequestExpand(lastExpandedLine + 1, requestEnd)}
            />
          );
        }
      } else {
        // No expanded lines yet - show expand button
        const totalGap = gapEnd - gapStart + 1;
        if (hunkIndex === 0) {
          // Top of file: expand upward (lines just before the first hunk)
          const requestStart = Math.max(1, gapEnd - MAX_EXPAND_LINES + 1);
          elements.push(
            <ExpandButton
              key={`expand-${hunkIndex}`}
              linesAvailable={totalGap}
              onClick={() => onRequestExpand(requestStart, gapEnd)}
            />
          );
        } else {
          // Between hunks: expand downward from previous hunk's end
          const requestEnd = Math.min(gapEnd, gapStart + MAX_EXPAND_LINES - 1);
          elements.push(
            <ExpandButton
              key={`expand-${hunkIndex}`}
              linesAvailable={totalGap}
              onClick={() => onRequestExpand(gapStart, requestEnd)}
            />
          );
        }
      }
    }

    // Render the hunk itself
    elements.push(
      <div key={`hunk-${hunkIndex}`}>
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

            let oldLine = hunk.oldStart;
            let newLine = hunk.newStart;

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

              if (currentLineType === ' ') {
                oldLine++;
                newLine++;
              } else if (currentLineType === '-') {
                oldLine++;
              } else if (currentLineType === '+') {
                newLine++;
              }
            }

            let bgColor = '';
            let prefixColor = 'text-gray-400';
            let prefix = '';

            if (lineType === '+') {
              bgColor = 'bg-green-900/30';
              prefixColor = 'text-green-300';
              prefix = '+';
            } else if (lineType === '-') {
              bgColor = 'bg-red-900/30';
              prefixColor = 'text-red-300';
              prefix = '-';
            } else {
              bgColor = 'bg-slate-900';
              prefixColor = 'text-gray-400';
              prefix = ' ';
            }

            return (
              <div
                key={lineIndex}
                className={`flex ${bgColor} hover:bg-slate-800/50`}
              >
                <div className="w-12 text-right px-2 text-gray-600 select-none shrink-0 border-r border-gray-800">
                  {oldLineNum !== null ? oldLineNum : ''}
                </div>
                <div className="w-12 text-right px-2 text-gray-600 select-none shrink-0 border-r border-gray-800">
                  {newLineNum !== null ? newLineNum : ''}
                </div>
                <div className="flex-1 px-4 py-0.5 whitespace-pre-wrap break-all">
                  <span className={`select-none mr-2 ${prefixColor}`}>{prefix}</span>
                  <HighlightedLine code={content} language={language} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return <div>{elements}</div>;
}

interface HighlightedLineProps {
  code: string;
  language: Language;
}

function HighlightedLine({ code, language }: HighlightedLineProps) {
  if (!code) {
    return null;
  }

  return (
    <Highlight theme={themes.vsDark} code={code} language={language}>
      {({ tokens, getTokenProps }) => (
        <>
          {tokens[0]?.map((token, key) => (
            <span key={key} {...getTokenProps({ token })} />
          ))}
        </>
      )}
    </Highlight>
  );
}
