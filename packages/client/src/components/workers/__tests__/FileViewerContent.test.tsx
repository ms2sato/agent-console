// NOTE: These tests hand the component a ready-made FileContentResponse, so
// they DO NOT exercise the fetch / valibot parse path. Wire-level parsing of
// the content route lives in lib/__tests__/api.test.ts (fetchFileContent) and
// packages/integration/src/file-viewer-boundary.test.ts.
import { describe, it, expect, afterEach } from 'bun:test';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { FileContentResponse } from '@agent-console/shared';
import { FileViewerContent, FILE_VIEWER_HIGHLIGHT_MAX_BYTES, getHighlightPlan } from '../FileViewerContent';
import { FILE_VIEWER_ROW_HEIGHT_PX } from '../FileViewerLines';
import { textFile } from '../../../test/file-viewer-fetch';

afterEach(() => {
  cleanup();
});

/** A TypeScript file of exactly `length` characters: a `const` line plus a comment filler. */
function typescriptOfLength(length: number): string {
  const head = 'const answer = 42;\n// ';
  return head + 'x'.repeat(length - head.length);
}

function spanWithText(container: HTMLElement, text: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll('[data-line] span')).find(
    (el) => el.textContent === text
  ) as HTMLElement | undefined;
}

function mountedLineCount(container: HTMLElement): number {
  return container.querySelectorAll('[data-line]').length;
}

describe('FileViewerContent', () => {
  it('shows the path header, the size and numbered lines of a text file', () => {
    const file = textFile('src/a.ts', 'one\ntwo\nthree\n', { language: 'typescript' });
    const { container, getByText } = render(<FileViewerContent file={file} />);

    expect(getByText('src/a.ts')).toBeTruthy();
    expect(getByText('14 B')).toBeTruthy();
    expect(Array.from(container.querySelectorAll('[data-line]')).map((el) => el.getAttribute('data-line'))).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(container.querySelector('[data-line="2"]')?.textContent).toBe('2two');
  });

  it('does not count the newline that terminates the last line as another line', () => {
    const { container } = render(<FileViewerContent file={textFile('a.txt', 'a\nb\n')} />);
    expect(mountedLineCount(container)).toBe(2);
  });

  it('keeps an empty line in the middle of the file', () => {
    const { container } = render(<FileViewerContent file={textFile('a.txt', 'a\n\nb')} />);
    expect(mountedLineCount(container)).toBe(3);
  });

  it('shows a notice and no lines for an empty file', () => {
    const { container, getByText } = render(<FileViewerContent file={textFile('empty.txt', '')} />);

    expect(getByText('Empty file.')).toBeTruthy();
    expect(mountedLineCount(container)).toBe(0);
  });

  it('shows the binary notice with the size and no lines for a binary file', () => {
    const file: FileContentResponse = {
      path: 'logo.png',
      kind: 'binary',
      size: 2048,
      truncated: false,
      language: 'text',
    };
    const { container, getByText } = render(<FileViewerContent file={file} />);

    expect(getByText('Binary file (2.0 KB), content not shown.')).toBeTruthy();
    expect(mountedLineCount(container)).toBe(0);
  });

  it('shows the truncation notice with the shown and total sizes for a truncated file', () => {
    const shown = 'a'.repeat(1_048_576);
    const file = textFile('big.log', shown, { truncated: true, size: 5_000_000 });
    const { getByText } = render(<FileViewerContent file={file} />);

    expect(getByText('Showing the first 1.0 MB of 4.8 MB.')).toBeTruthy();
  });

  it('shows no truncation notice for a file that was not truncated', () => {
    const { queryByText } = render(<FileViewerContent file={textFile('a.txt', 'a')} />);
    expect(queryByText(/Showing the first/)).toBeNull();
  });

  describe('highlighting threshold', () => {
    it('exports the threshold the specification names (256 KiB)', () => {
      expect(FILE_VIEWER_HIGHLIGHT_MAX_BYTES).toBe(262144);
    });

    // The boundary is decided by a pure function and pinned here with literals
    // (the specified 256 KiB), not derived from the constant: tokenising a
    // file of this size inside a render test is slow on a loaded CI runner.
    describe('getHighlightPlan', () => {
      it('highlights a file of exactly 262144 characters, with no notice', () => {
        expect(getHighlightPlan(262144, 'typescript')).toEqual({ highlight: true, showHighlightOffNotice: false });
      });

      it('renders a file of 262145 characters as plain text with the notice when it has a grammar', () => {
        expect(getHighlightPlan(262145, 'typescript')).toEqual({ highlight: false, showHighlightOffNotice: true });
      });

      it('gives an over-threshold file with no grammar (text) no notice', () => {
        expect(getHighlightPlan(262145, 'text')).toEqual({ highlight: false, showHighlightOffNotice: false });
        expect(getHighlightPlan(262144, 'text')).toEqual({ highlight: true, showHighlightOffNotice: false });
      });

      it('honours an injected threshold with the same inclusive boundary', () => {
        expect(getHighlightPlan(40, 'typescript', 40).highlight).toBe(true);
        expect(getHighlightPlan(41, 'typescript', 40).highlight).toBe(false);
      });
    });

    describe('rendered with a small injected threshold (40 characters)', () => {
      it('highlights a file of exactly the threshold length (keyword in its own colored span, no notice)', () => {
        const content = typescriptOfLength(40);
        const { container, queryByText } = render(
          <FileViewerContent file={textFile('a.ts', content, { language: 'typescript' })} highlightMaxLength={40} />
        );

        const keyword = spanWithText(container, 'const');
        expect(keyword).toBeDefined();
        expect(keyword?.style.color).not.toBe('');
        expect(queryByText(/highlighting off/)).toBeNull();
      });

      it('renders one character over the threshold as plain text with the one-line notice', () => {
        const content = typescriptOfLength(41);
        const { container, getByText } = render(
          <FileViewerContent file={textFile('a.ts', content, { language: 'typescript' })} highlightMaxLength={40} />
        );

        expect(getByText('highlighting off for files over 256 KiB')).toBeTruthy();
        expect(spanWithText(container, 'const')).toBeUndefined();
        expect(container.querySelector('[data-line="1"]')?.textContent).toContain('const answer = 42;');
      });

      it('shows no notice for an over-threshold file that has no grammar (text), and still renders it plain', () => {
        const content = 'plain words '.repeat(10);
        const { container, queryByText } = render(
          <FileViewerContent file={textFile('big.txt', content, { language: 'text' })} highlightMaxLength={40} />
        );

        expect(queryByText(/highlighting off/)).toBeNull();
        expect(container.querySelector('[data-line="1"]')).not.toBeNull();
      });
    });

    describe('with the default threshold', () => {
      it('highlights a small file', () => {
        const { container } = render(
          <FileViewerContent file={textFile('a.ts', 'const a = 1;', { language: 'typescript' })} />
        );
        expect(spanWithText(container, 'const')).toBeDefined();
      });

      it('passes the default constant through: a 262145-character single line renders plain with the notice (cheap: nothing is tokenised)', () => {
        const file = textFile('wide.ts', 'x'.repeat(262145), { language: 'typescript' });
        const { getByText, container } = render(<FileViewerContent file={file} />);

        expect(getByText('highlighting off for files over 256 KiB')).toBeTruthy();
        expect(container.querySelectorAll('[data-line]').length).toBe(1);
      });
    });

    it('does not tokenise a file whose wire language is text', () => {
      const { container } = render(
        <FileViewerContent file={textFile('notes.txt', 'const answer = 42;', { language: 'text' })} />
      );
      expect(spanWithText(container, 'const')).toBeUndefined();
      expect(container.querySelector('[data-line="1"]')?.textContent).toContain('const answer = 42;');
    });
  });

  describe('windowed rendering of a long file', () => {
    // Highlighted path: 3000 short lines (6000 characters, tokenised for real)
    // is far more rows than the window; a bigger fixture only slows CI.
    const HIGHLIGHTED_LINES = 3_000;
    const highlighted = textFile('many.ts', 'a\n'.repeat(HIGHLIGHTED_LINES), { language: 'typescript' });
    // Plain path: 30k lines, forced plain by a tiny injected threshold so that
    // nothing is tokenised.
    const PLAIN_LINES = 30_000;
    const plain = textFile('many-long.ts', 'a line of plain text\n'.repeat(PLAIN_LINES), { language: 'typescript' });

    const cases = [
      { label: 'highlighted', file: highlighted, lines: HIGHLIGHTED_LINES, scrollLine: 2_000, max: undefined },
      { label: 'plain', file: plain, lines: PLAIN_LINES, scrollLine: 20_000, max: 100 },
    ] as const;

    for (const { label, file, lines, scrollLine, max } of cases) {
      it(`mounts only the viewport rows plus overscan (${label})`, () => {
        const { container } = render(<FileViewerContent file={file} highlightMaxLength={max} />);

        expect(mountedLineCount(container)).toBeGreaterThan(0);
        expect(mountedLineCount(container)).toBeLessThan(200);
        expect(container.querySelector('[data-line="1"]')).not.toBeNull();
        expect(container.querySelector(`[data-line="${lines}"]`)).toBeNull();
      });

      it(`mounts the rows around the scroll position (${label})`, () => {
        const { container, getByTestId } = render(<FileViewerContent file={file} highlightMaxLength={max} />);

        fireEvent.scroll(getByTestId('file-viewer-lines'), { target: { scrollTop: scrollLine * FILE_VIEWER_ROW_HEIGHT_PX } });

        expect(container.querySelector(`[data-line="${scrollLine + 1}"]`)).not.toBeNull();
        expect(container.querySelector('[data-line="1"]')).toBeNull();
        expect(mountedLineCount(container)).toBeLessThan(200);
      });
    }

    it('shows the highlight-off notice only for the file forced over the threshold', () => {
      const a = render(<FileViewerContent file={plain} highlightMaxLength={100} />);
      expect(a.queryByText(/highlighting off/)).not.toBeNull();
      cleanup();
      const b = render(<FileViewerContent file={highlighted} />);
      expect(b.queryByText(/highlighting off/)).toBeNull();
    });
  });
});
