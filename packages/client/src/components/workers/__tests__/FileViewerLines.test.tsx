import { describe, it, expect, afterEach } from 'bun:test';
import { render, cleanup, fireEvent } from '@testing-library/react';
import {
  FileViewerLines,
  FILE_VIEWER_OVERSCAN_ROWS,
  FILE_VIEWER_ROW_HEIGHT_PX,
} from '../FileViewerLines';

afterEach(() => {
  cleanup();
});

// happy-dom has no layout: the component falls back to an 800px viewport.
const FALLBACK_VIEWPORT_ROWS = 800 / FILE_VIEWER_ROW_HEIGHT_PX;

function mountedLines(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll('[data-line]')).map((el) => Number(el.getAttribute('data-line')));
}

describe('FileViewerLines', () => {
  const LINE_COUNT = 30_000;

  it('mounts only the visible rows plus the overscan for a 30k-line file', () => {
    const { container } = render(<FileViewerLines lineCount={LINE_COUNT} renderLine={(i) => `line ${i + 1}`} />);

    const lines = mountedLines(container);
    expect(lines[0]).toBe(1);
    expect(lines.length).toBe(FALLBACK_VIEWPORT_ROWS + FILE_VIEWER_OVERSCAN_ROWS);
    expect(lines.length).toBeLessThan(LINE_COUNT / 100);
    expect(container.querySelector('[data-line="30000"]')).toBeNull();
  });

  it('mounts the window around the scroll position after a scroll', () => {
    const { container, getByTestId } = render(
      <FileViewerLines lineCount={LINE_COUNT} renderLine={(i) => `line ${i + 1}`} />
    );

    fireEvent.scroll(getByTestId('file-viewer-lines'), { target: { scrollTop: 15_000 * FILE_VIEWER_ROW_HEIGHT_PX } });

    const lines = mountedLines(container);
    expect(lines).toContain(15_001);
    expect(lines).not.toContain(1);
    expect(lines.length).toBeLessThan(200);
    expect(lines[0]).toBe(15_001 - FILE_VIEWER_OVERSCAN_ROWS);
  });

  it('keeps the full scroll height with spacing so the scrollbar spans the whole file', () => {
    const { getByTestId } = render(<FileViewerLines lineCount={LINE_COUNT} renderLine={(i) => `line ${i + 1}`} />);

    const spacer = getByTestId('file-viewer-lines').firstElementChild as HTMLElement;
    expect(spacer.style.height).toBe(`${LINE_COUNT * FILE_VIEWER_ROW_HEIGHT_PX}px`);
  });

  it('calls renderLine only for mounted rows', () => {
    const rendered = new Set<number>();
    render(
      <FileViewerLines
        lineCount={LINE_COUNT}
        renderLine={(i) => {
          rendered.add(i);
          return 'x';
        }}
      />
    );

    expect(rendered.size).toBe(FALLBACK_VIEWPORT_ROWS + FILE_VIEWER_OVERSCAN_ROWS);
  });

  it('renders every row of a file shorter than the window, numbered from 1', () => {
    const { container } = render(<FileViewerLines lineCount={3} renderLine={(i) => `l${i}`} />);

    expect(mountedLines(container)).toEqual([1, 2, 3]);
    expect(container.textContent).toContain('l2');
  });
});
