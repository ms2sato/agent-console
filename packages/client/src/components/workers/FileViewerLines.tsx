import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { computeRowWindow } from '../../lib/windowed-rows';

/** Fixed monospaced row height; windowing arithmetic depends on it, so rows never wrap. */
export const FILE_VIEWER_ROW_HEIGHT_PX = 20;
/** Rows mounted above and below the visible range. */
export const FILE_VIEWER_OVERSCAN_ROWS = 20;
/** Used until the scroll container has a measured height (and where there is no layout). */
const FALLBACK_VIEWPORT_HEIGHT_PX = 800;

interface FileViewerLinesProps {
  lineCount: number;
  /** Content of line `index` (0-based); called only for mounted rows. */
  renderLine: (index: number) => ReactNode;
}

/**
 * Line-numbered rows of a whole file, windowed by scroll position: only the
 * rows in (and just around) the viewport are mounted, so a file of tens of
 * thousands of lines costs the same DOM as a short one. Scroll state lives
 * here, not in the parent, so scrolling re-renders the window only and never
 * re-runs the parent's tokenisation.
 */
export function FileViewerLines({ lineCount, renderLine }: FileViewerLinesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(FALLBACK_VIEWPORT_HEIGHT_PX);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setViewportHeight(el.clientHeight || FALLBACK_VIEWPORT_HEIGHT_PX);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { start, end } = computeRowWindow({
    scrollTop,
    viewportHeight,
    rowCount: lineCount,
    rowHeight: FILE_VIEWER_ROW_HEIGHT_PX,
    overscan: FILE_VIEWER_OVERSCAN_ROWS,
  });
  const gutterChars = String(lineCount).length;

  const rows: ReactNode[] = [];
  for (let index = start; index < end; index++) {
    rows.push(
      <div
        key={index}
        data-line={index + 1}
        className="flex whitespace-pre"
        style={{ height: FILE_VIEWER_ROW_HEIGHT_PX, lineHeight: `${FILE_VIEWER_ROW_HEIGHT_PX}px` }}
      >
        <span
          aria-hidden="true"
          className="select-none text-right pr-3 pl-2 text-gray-500 bg-slate-900 sticky left-0 shrink-0"
          style={{ minWidth: `${gutterChars + 2}ch` }}
        >
          {index + 1}
        </span>
        <span>{renderLine(index)}</span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid="file-viewer-lines"
      className="flex-1 min-h-0 overflow-auto font-mono text-xs text-gray-200 bg-slate-900"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div
        className="min-w-full w-max"
        style={{
          height: lineCount * FILE_VIEWER_ROW_HEIGHT_PX,
          paddingTop: start * FILE_VIEWER_ROW_HEIGHT_PX,
          boxSizing: 'border-box',
        }}
      >
        {rows}
      </div>
    </div>
  );
}
