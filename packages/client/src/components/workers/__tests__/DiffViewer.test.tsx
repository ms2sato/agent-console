import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { DiffViewer } from '../DiffViewer';
import type { GitDiffFile } from '@agent-console/shared';

// happy-dom does not provide IntersectionObserver, which DiffViewer constructs in an effect.
beforeAll(() => {
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
});

const longPath = `https://example.com/${'a'.repeat(180)}`;

describe('DiffViewer', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the file-header path span with break-all and min-w-0 so long paths wrap', () => {
    const file: GitDiffFile = {
      path: longPath,
      status: 'added',
      stageState: 'unstaged',
      additions: 1,
      deletions: 0,
      isBinary: false,
    };

    render(<DiffViewer rawDiff="" files={[file]} scrollToFile={null} />);

    // The file-header span carries `font-medium` and renders the full path.
    const span = screen.getByText(longPath);
    expect(span.className).toContain('font-medium');
    expect(span.className).toContain('break-all');
    expect(span.className).toContain('min-w-0');
  });

  describe('syntax highlighting by file path', () => {
    function diffFor(path: string): { rawDiff: string; file: GitDiffFile } {
      const rawDiff = [
        `--- a/${path}`,
        `+++ b/${path}`,
        '@@ -0,0 +1,1 @@',
        '+const answer = 42;',
        '',
      ].join('\n');
      const file: GitDiffFile = {
        path,
        status: 'added',
        stageState: 'unstaged',
        additions: 1,
        deletions: 0,
        isBinary: false,
      };
      return { rawDiff, file };
    }

    /** The token spans rendered for the added line's code. */
    function tokenSpans(container: HTMLElement): HTMLElement[] {
      const line = Array.from(container.querySelectorAll('span.select-none'))
        .find((el) => el.textContent === '+');
      const codeCell = line?.parentElement;
      return Array.from(codeCell?.querySelectorAll('span:not(.select-none)') ?? []) as HTMLElement[];
    }

    it('tokenises a TypeScript file: the keyword gets its own colored span', () => {
      const { rawDiff, file } = diffFor('src/a.ts');
      const { container } = render(<DiffViewer rawDiff={rawDiff} files={[file]} scrollToFile={null} />);

      const spans = tokenSpans(container);
      const keyword = spans.find((el) => el.textContent === 'const');
      expect(keyword).toBeDefined();
      expect(keyword?.style.color).not.toBe('');
    });

    it('renders a file with no known language as plain text (no keyword span)', () => {
      const { rawDiff, file } = diffFor('notes.unknownext');
      const { container } = render(<DiffViewer rawDiff={rawDiff} files={[file]} scrollToFile={null} />);

      const spans = tokenSpans(container);
      expect(spans.length).toBeGreaterThan(0);
      expect(spans.find((el) => el.textContent === 'const')).toBeUndefined();
      expect(spans.map((el) => el.textContent).join('')).toBe('const answer = 42;');
    });
  });
});
