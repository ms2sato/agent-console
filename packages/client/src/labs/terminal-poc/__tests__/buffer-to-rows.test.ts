import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Terminal } from '@xterm/headless';
import { extractRow, extractRowWithCursor } from '../buffer-to-rows';

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
});
