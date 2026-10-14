import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Terminal } from '@xterm/headless';
import { extractRow, extractRowWithCursor, wrapContinuationOptions } from '../buffer-to-rows';
import { joinSelectedRows } from '../copy-text';

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()));
}

/** Extract absolute row 0 of a fresh terminal after writing `data`. */
async function rowFrom(term: Terminal, data: string) {
  await write(term, data);
  const buffer = term.buffer.active;
  const line = buffer.getLine(0);
  if (!line) throw new Error('no line 0');
  return extractRow(line, term.cols, buffer.getNullCell(), 0);
}

describe('extractRow', () => {
  let term: Terminal;

  beforeEach(() => {
    term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  });

  afterEach(() => {
    term.dispose();
  });

  it('plain text -> single default segment', async () => {
    const row = await rowFrom(term, 'hello');
    expect(row.segments).toHaveLength(1);
    expect(row.segments[0].text).toBe('hello');
    expect(row.segments[0].style).toBeNull();
  });

  it('16-color palette red fg -> #cd3131', async () => {
    const row = await rowFrom(term, '\x1b[31mred\x1b[0m');
    expect(row.segments[0].text).toBe('red');
    expect(row.segments[0].style?.fg).toBe('#cd3131');
  });

  it('truecolor -> #ff6b35 (Claude Code orange)', async () => {
    const row = await rowFrom(term, '\x1b[38;2;255;107;53morange\x1b[0m');
    expect(row.segments[0].text).toBe('orange');
    expect(row.segments[0].style?.fg).toBe('#ff6b35');
  });

  it('256-palette color cube (208 -> #ff8700)', async () => {
    const row = await rowFrom(term, '\x1b[38;5;208mX\x1b[0m');
    expect(row.segments[0].style?.fg).toBe('#ff8700');
  });

  it('256-palette grayscale ramp (240 -> #585858)', async () => {
    const row = await rowFrom(term, '\x1b[38;5;240mX\x1b[0m');
    expect(row.segments[0].style?.fg).toBe('#585858');
  });

  it('bold + underline flags', async () => {
    const row = await rowFrom(term, '\x1b[1;4mA\x1b[0m');
    expect(row.segments[0].style?.bold).toBe(true);
    expect(row.segments[0].style?.underline).toBe(true);
  });

  it('inverse swaps default fg/bg to concrete colors', async () => {
    const row = await rowFrom(term, '\x1b[7mZ\x1b[0m');
    expect(row.segments[0].style?.fg).toBe('#1a1a2e'); // default bg becomes fg
    expect(row.segments[0].style?.bg).toBe('#eeeeee'); // default fg becomes bg
  });

  it('groups consecutive same-style cells and splits on style change', async () => {
    const row = await rowFrom(term, 'ab\x1b[31mcd\x1b[0mef');
    expect(row.segments.map((s) => s.text)).toEqual(['ab', 'cd', 'ef']);
    expect(row.segments[0].style).toBeNull();
    expect(row.segments[1].style?.fg).toBe('#cd3131');
    expect(row.segments[2].style).toBeNull();
  });

  it('CJK wide chars: width-0 cells skipped, characters preserved once', async () => {
    const row = await rowFrom(term, 'こんにちは');
    const text = row.segments.map((s) => s.text).join('');
    expect(text).toBe('こんにちは');
    expect(text).toHaveLength(5);
  });

  it('empty row keeps one empty segment for line height', async () => {
    const row = await rowFrom(term, '');
    expect(row.segments).toHaveLength(1);
    expect(row.segments[0].text).toBe('');
  });
});

describe('extractRowWithCursor', () => {
  let term: Terminal;

  beforeEach(() => {
    term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  });

  afterEach(() => {
    term.dispose();
  });

  it('renders the cursor cell as its own styled block at the given column', async () => {
    await write(term, 'abc');
    const buffer = term.buffer.active;
    const line = buffer.getLine(0);
    if (!line) throw new Error('no line');
    const row = extractRowWithCursor(line, term.cols, buffer.getNullCell(), 0, 1);
    // 'b' (column 1) should be an isolated cursor-styled segment.
    const cursorSeg = row.segments.find((s) => s.text === 'b');
    expect(cursorSeg?.style?.bg).toBe('#eeeeee');
    expect(cursorSeg?.style?.fg).toBe('#1a1a2e');
  });

  it('places the cursor correctly after a CJK glyph (column advances by 2)', async () => {
    // Write one wide char then a caret target; cursor at column 2 sits on 'X'.
    await write(term, 'あX');
    const buffer = term.buffer.active;
    const line = buffer.getLine(0);
    if (!line) throw new Error('no line');
    const row = extractRowWithCursor(line, term.cols, buffer.getNullCell(), 0, 2);
    const cursorSeg = row.segments.find((s) => s.style?.bg === '#eeeeee');
    expect(cursorSeg?.text).toBe('X');
  });

  it('cursor at end of text: trailing blanks after the cursor cell are trimmed, cursor cell remains', async () => {
    // Cursor sits on the blank cell just after 'abc' (column 3).
    await write(term, 'abc');
    const buffer = term.buffer.active;
    const line = buffer.getLine(0);
    if (!line) throw new Error('no line');
    const row = extractRowWithCursor(line, term.cols, buffer.getNullCell(), 0, 3);

    // The cursor cell (a single blank block) is the last segment - no trailing
    // full-width whitespace segment survives after it.
    const lastSeg = row.segments[row.segments.length - 1];
    expect(lastSeg.style?.bg).toBe('#eeeeee');
    expect(lastSeg.text).toBe(' ');
    const text = row.segments.map((s) => s.text).join('');
    expect(text).toBe('abc '); // 'abc' + single cursor blank, no full-width padding
  });

  it('cursor mid-text: content unchanged except trailing trim', async () => {
    await write(term, 'abc');
    const buffer = term.buffer.active;
    const line = buffer.getLine(0);
    if (!line) throw new Error('no line');
    const row = extractRowWithCursor(line, term.cols, buffer.getNullCell(), 0, 1);
    const text = row.segments.map((s) => s.text).join('');
    expect(text).toBe('abc'); // no trailing blank cells beyond the text
  });

  it('parity: cursor row visible text matches extractRow plus cursor styling', async () => {
    await write(term, 'abc');
    const buffer = term.buffer.active;
    const line = buffer.getLine(0);
    if (!line) throw new Error('no line');
    const plain = extractRow(line, term.cols, buffer.getNullCell(), 0);
    const withCursor = extractRowWithCursor(line, term.cols, buffer.getNullCell(), 0, 1);

    const plainText = plain.segments.map((s) => s.text).join('');
    const cursorText = withCursor.segments.map((s) => s.text).join('');
    expect(cursorText).toBe(plainText);

    // The 'b' cell carries cursor styling in the cursor row but not the plain row.
    expect(withCursor.segments.find((s) => s.text === 'b')?.style?.bg).toBe('#eeeeee');
    expect(plain.segments.find((s) => s.style?.bg === '#eeeeee')).toBeUndefined();
  });
});

describe('trailing blanks at a soft-wrap point', () => {
  const COLS = 10;
  let term: Terminal;

  beforeEach(() => {
    term = new Terminal({ cols: COLS, rows: 24, allowProposedApi: true });
  });

  afterEach(() => {
    term.dispose();
  });

  /** "abcdefghi" + a space fills row 0 through its last column; "XYZ" wraps onto row 1. */
  const WRAPPED = 'abcdefghi XYZ';
  const text = (row: { segments: { text: string }[] }) => row.segments.map((s) => s.text).join('');

  it('keepTrailingWhitespace: true keeps the default-style space that ends a full row', async () => {
    await write(term, WRAPPED);
    const buffer = term.buffer.active;
    const row = extractRow(buffer.getLine(0)!, term.cols, buffer.getNullCell(), 0, { keepTrailingWhitespace: true });
    expect(text(row)).toBe('abcdefghi ');
  });

  it('the same row without the option (or with it false) is trimmed: today\'s behaviour, pinned', async () => {
    await write(term, WRAPPED);
    const buffer = term.buffer.active;
    const line = buffer.getLine(0)!;
    expect(text(extractRow(line, term.cols, buffer.getNullCell(), 0))).toBe('abcdefghi');
    expect(text(extractRow(line, term.cols, buffer.getNullCell(), 0, { keepTrailingWhitespace: false }))).toBe('abcdefghi');
  });

  it('the cursor-row variant keeps the space AND the cursor segment', async () => {
    await write(term, WRAPPED);
    const buffer = term.buffer.active;
    const row = extractRowWithCursor(buffer.getLine(0)!, term.cols, buffer.getNullCell(), 0, 2, { keepTrailingWhitespace: true });
    expect(text(row)).toBe('abcdefghi ');
    expect(row.segments.find((s) => s.style?.bg === '#eeeeee')?.text).toBe('c');
  });

  it('wrapContinuationOptions asks the buffer: true only when the NEXT line is a soft-wrap continuation', async () => {
    await write(term, WRAPPED + '\r\nnext');
    const buffer = term.buffer.active;
    expect(wrapContinuationOptions(buffer, 0)).toEqual({ keepTrailingWhitespace: true }); // row 1 is a continuation
    expect(wrapContinuationOptions(buffer, 1)).toEqual({ keepTrailingWhitespace: false }); // row 2 is a hard line
    expect(wrapContinuationOptions(buffer, buffer.length - 1)).toEqual({ keepTrailingWhitespace: false }); // no successor
  });

  it('a wide character that wraps leaves an EMPTY filler cell: it is not kept as a space, but a written space still is (both ways)', async () => {
    // At 10 columns `abcdefghi` fills nine, and the two-column `界` does not fit in
    // the one that remains: xterm wraps it and leaves column 9 empty (chars '').
    const wide = 'abcdefghi界';
    await write(term, wide);
    const buffer = term.buffer.active;
    const rows = [0, 1].map((y) =>
      extractRow(buffer.getLine(y)!, term.cols, buffer.getNullCell(), y, wrapContinuationOptions(buffer, y)),
    );
    expect(rows[1].isWrapped).toBe(true);
    expect(text(rows[0])).toBe('abcdefghi'); // no filler space
    expect(joinSelectedRows(rows.map((r) => ({ text: text(r), isWrapped: r.isWrapped })))).toBe(wide);

    // Control in the same terminal size: a WRITTEN space at the same column is kept.
    const other = new Terminal({ cols: COLS, rows: 24, allowProposedApi: true });
    try {
      await write(other, WRAPPED);
      const b2 = other.buffer.active;
      const r0 = extractRow(b2.getLine(0)!, other.cols, b2.getNullCell(), 0, wrapContinuationOptions(b2, 0));
      expect(text(r0)).toBe('abcdefghi ');
    } finally {
      other.dispose();
    }
  });

  it('end to end through the join: the copied line equals the original, space included', async () => {
    await write(term, WRAPPED);
    const buffer = term.buffer.active;
    const rows = [0, 1].map((y) =>
      extractRow(buffer.getLine(y)!, term.cols, buffer.getNullCell(), y, wrapContinuationOptions(buffer, y)),
    );
    expect(rows[1].isWrapped).toBe(true);
    expect(joinSelectedRows(rows.map((r) => ({ text: text(r), isWrapped: r.isWrapped })))).toBe(WRAPPED);
  });
});

describe('fillsLastColumn', () => {
  const COLS = 10;
  let term: Terminal;

  beforeEach(() => {
    term = new Terminal({ cols: COLS, rows: 24, allowProposedApi: true });
  });

  afterEach(() => {
    term.dispose();
  });

  async function extract(data: string, cursorX?: number) {
    await write(term, data);
    const buffer = term.buffer.active;
    const line = buffer.getLine(0)!;
    return cursorX === undefined
      ? extractRow(line, COLS, buffer.getNullCell(), 0)
      : extractRowWithCursor(line, COLS, buffer.getNullCell(), 0, cursorX);
  }

  it('is true when the last cell is written', async () => {
    expect((await extract('abcdefghij')).fillsLastColumn).toBe(true);
  });

  it('is false when the row ends with a trailing blank', async () => {
    expect((await extract('abcdefghi')).fillsLastColumn).toBe(false);
  });

  it('is true for a CJK-prefixed row whose text is shorter than cols in code units', async () => {
    // 4 wide chars (8 cells) + 2 ASCII = 10 cells, 6 code units.
    const row = await extract('あいうえoo');
    expect(row.segments.map((s) => s.text).join('')).toHaveLength(6);
    expect(row.fillsLastColumn).toBe(true);
  });

  it('extractRowWithCursor: a cursor on a blank last cell does not count as written', async () => {
    expect((await extract('abcdefghi', COLS - 1)).fillsLastColumn).toBe(false);
  });

  it('extractRowWithCursor: a written last cell is true', async () => {
    expect((await extract('abcdefghij', 0)).fillsLastColumn).toBe(true);
  });
});
