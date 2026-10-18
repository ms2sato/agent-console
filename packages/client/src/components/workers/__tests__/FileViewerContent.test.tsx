// NOTE: These tests hand the component a ready-made FileContentResponse, so
// they DO NOT exercise the fetch / valibot parse path. Wire-level parsing of
// the content route lives in lib/__tests__/api.test.ts (fetchFileContent) and
// packages/integration/src/file-viewer-boundary.test.ts.
import { describe, it, expect, afterEach } from 'bun:test';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { FileContentResponse } from '@agent-console/shared';
import { FileViewerContent, FILE_VIEWER_HIGHLIGHT_MAX_BYTES } from '../FileViewerContent';
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

    it('highlights a file of exactly the threshold length (keyword in its own colored span, no notice)', () => {
      // Literal on purpose: the boundary is the specified 256 KiB, not whatever the constant holds.
      const content = typescriptOfLength(262144);
      const { container, queryByText } = render(
        <FileViewerContent file={textFile('a.ts', content, { language: 'typescript' })} />
      );

      const keyword = spanWithText(container, 'const');
      expect(keyword).toBeDefined();
      expect(keyword?.style.color).not.toBe('');
      expect(queryByText(/highlighting off/)).toBeNull();
    });

    it('renders one character over the threshold as plain text with the one-line notice', () => {
      const content = typescriptOfLength(262145);
      const { container, getByText } = render(
        <FileViewerContent file={textFile('a.ts', content, { language: 'typescript' })} />
      );

      expect(getByText('highlighting off for files over 256 KiB')).toBeTruthy();
      expect(spanWithText(container, 'const')).toBeUndefined();
      expect(container.querySelector('[data-line="1"]')?.textContent).toContain('const answer = 42;');
    });

    it('does not tokenise a file whose wire language is text', () => {
      const { container } = render(
        <FileViewerContent file={textFile('notes.txt', 'const answer = 42;', { language: 'text' })} />
      );
      expect(spanWithText(container, 'const')).toBeUndefined();
      expect(container.querySelector('[data-line="1"]')?.textContent).toContain('const answer = 42;');
    });
  });

  describe('windowed rendering of a 30k-line file', () => {
    const LINES = 30_000;
    // Short lines: 60000 characters, under the highlight threshold.
    const highlighted = textFile('many.ts', 'a\n'.repeat(LINES), { language: 'typescript' });
    // Long lines: 30000 x 21 characters, over the highlight threshold.
    const plain = textFile('many.txt', 'a line of plain text\n'.repeat(LINES));

    for (const [label, file] of [
      ['highlighted', highlighted],
      ['plain', plain],
    ] as const) {
      it(`mounts only the viewport rows plus overscan (${label})`, () => {
        const { container } = render(<FileViewerContent file={file} />);

        expect(mountedLineCount(container)).toBeGreaterThan(0);
        expect(mountedLineCount(container)).toBeLessThan(200);
        expect(container.querySelector('[data-line="1"]')).not.toBeNull();
        expect(container.querySelector(`[data-line="${LINES}"]`)).toBeNull();
      });

      it(`mounts the rows around the scroll position (${label})`, () => {
        const { container, getByTestId } = render(<FileViewerContent file={file} />);

        fireEvent.scroll(getByTestId('file-viewer-lines'), { target: { scrollTop: 20_000 * FILE_VIEWER_ROW_HEIGHT_PX } });

        expect(container.querySelector('[data-line="20001"]')).not.toBeNull();
        expect(container.querySelector('[data-line="1"]')).toBeNull();
        expect(mountedLineCount(container)).toBeLessThan(200);
      });
    }

    it('shows the highlight-off notice only for the plain file', () => {
      expect(plain.content?.length).toBeGreaterThan(262144);
      expect(highlighted.content?.length).toBeLessThanOrEqual(262144);
      const a = render(<FileViewerContent file={plain} />);
      expect(a.queryByText(/highlighting off/)).not.toBeNull();
      cleanup();
      const b = render(<FileViewerContent file={highlighted} />);
      expect(b.queryByText(/highlighting off/)).toBeNull();
    });
  });
});
