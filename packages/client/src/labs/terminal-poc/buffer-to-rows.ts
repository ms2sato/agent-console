import { Terminal } from '@xterm/headless';
import type { LinkRange } from './link-detection';

/**
 * Pure extraction from an xterm headless buffer line into a React-renderable
 * row model. Kept free of DOM / React so it is unit-testable against a real
 * headless Terminal instance.
 */

// @xterm/headless does not export IBufferCell / IBufferLine directly, so we
// derive them from the exported Terminal's buffer namespace via indexed access.
type IBufferCell = ReturnType<Terminal['buffer']['active']['getNullCell']>;
export type IBufferLine = NonNullable<ReturnType<Terminal['buffer']['active']['getLine']>>;

export interface PocStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

export interface PocSegment {
  text: string;
  style: PocStyle | null; // null = default style (CSS inherits)
}

export interface PocRow {
  key: number; // absolute row index in the buffer
  segments: PocSegment[];
  isWrapped: boolean; // true = this row is a soft-wrap continuation of the previous
  links: LinkRange[]; // URL column ranges over the row's concatenated text (empty = none)
}

// Standard xterm dark-theme 16-color palette (ANSI 0-15).
const ANSI_16 = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510',
  '#2472c8', '#bc3fc0', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543',
  '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
] as const;

// Defaults used when inverse video needs a concrete color to swap in.
const DEFAULT_FG = '#eeeeee';
const DEFAULT_BG = '#1a1a2e';

function toHex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

/** Map an xterm 256-color palette index to a hex string (standard xterm formulas). */
function paletteToHex(index: number): string {
  if (index < 16) return ANSI_16[index];
  if (index < 232) {
    // 6x6x6 color cube: indices 16-231.
    const i = index - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const channel = (v: number) => (v === 0 ? 0 : v * 40 + 55);
    return toHex((channel(r) << 16) | (channel(g) << 8) | channel(b));
  }
  // Grayscale ramp: indices 232-255.
  const level = (index - 232) * 10 + 8;
  return toHex((level << 16) | (level << 8) | level);
}

type ColorResolver = 'fg' | 'bg';

function resolveColor(cell: IBufferCell, which: ColorResolver): string | undefined {
  if (which === 'fg') {
    if (cell.isFgDefault()) return undefined;
    if (cell.isFgRGB()) return toHex(cell.getFgColor());
    if (cell.isFgPalette()) return paletteToHex(cell.getFgColor());
    return undefined;
  }
  if (cell.isBgDefault()) return undefined;
  if (cell.isBgRGB()) return toHex(cell.getBgColor());
  if (cell.isBgPalette()) return paletteToHex(cell.getBgColor());
  return undefined;
}

function cellStyle(cell: IBufferCell): PocStyle | null {
  let fg = resolveColor(cell, 'fg');
  let bg = resolveColor(cell, 'bg');

  if (cell.isInverse()) {
    // Swap fg/bg; substitute concrete defaults so the swap is visible.
    const swappedFg = bg ?? DEFAULT_BG;
    const swappedBg = fg ?? DEFAULT_FG;
    fg = swappedFg;
    bg = swappedBg;
  }

  const style: PocStyle = {};
  if (fg !== undefined) style.fg = fg;
  if (bg !== undefined) style.bg = bg;
  if (cell.isBold()) style.bold = true;
  if (cell.isItalic()) style.italic = true;
  if (cell.isDim()) style.dim = true;
  if (cell.isUnderline()) style.underline = true;
  if (cell.isStrikethrough()) style.strikethrough = true;

  return Object.keys(style).length === 0 ? null : style;
}

/**
 * Comparison key for grouping consecutive cells into one segment. Uses the
 * color modes + raw color values + attribute flags so two cells only merge
 * when they render identically.
 */
function styleKey(cell: IBufferCell): string {
  return [
    cell.getFgColorMode(), cell.getFgColor(),
    cell.getBgColorMode(), cell.getBgColor(),
    cell.isBold() ? 1 : 0,
    cell.isItalic() ? 1 : 0,
    cell.isDim() ? 1 : 0,
    cell.isUnderline() ? 1 : 0,
    cell.isStrikethrough() ? 1 : 0,
    cell.isInverse() ? 1 : 0,
  ].join(':');
}

/**
 * Extract one buffer line into a PocRow. Consecutive cells with identical
 * style merge into a single segment. Width-0 cells (the trailing half of a
 * CJK wide glyph) are skipped so wide characters are not duplicated.
 */
export function extractRow(
  line: IBufferLine,
  cols: number,
  nullCell: IBufferCell,
  key: number,
): PocRow {
  const segments = walkCells(line, cols, nullCell, -1);
  trimTrailingDefaultWhitespace(segments);

  // Keep at least one (empty) segment so the row box renders its line height.
  if (segments.length === 0) {
    segments.push({ text: '', style: null });
  }

  return { key, segments, isWrapped: line.isWrapped, links: [] };
}

// Cursor cell rendering: a solid block (light bg, dark fg) at the cursor cell.
const CURSOR_STYLE: PocStyle = { fg: DEFAULT_BG, bg: DEFAULT_FG };

/**
 * Like extractRow but forces the cell at column `cursorX` into its own segment
 * styled as the cursor block. Computed in the store where cell access is cheap;
 * this keeps the cursor at the correct visual position even after CJK glyphs
 * (which advance the column by 2) without any DOM measurement.
 */
export function extractRowWithCursor(
  line: IBufferLine,
  cols: number,
  nullCell: IBufferCell,
  key: number,
  cursorX: number,
): PocRow {
  const segments = walkCells(line, cols, nullCell, cursorX);
  // Trim trailing default-style blanks like extractRow, but protect the cursor
  // segment (and everything up to it): the cursor commonly sits on a blank cell
  // just after the text, so only whitespace strictly AFTER the cursor is trimmed.
  const cursorIndex = segments.findIndex((s) => s.style === CURSOR_STYLE);
  const protectedCount = cursorIndex === -1 ? 0 : cursorIndex + 1;
  trimTrailingDefaultWhitespace(segments, protectedCount);
  if (segments.length === 0) {
    segments.push({ text: '', style: null });
  }
  return { key, segments, isWrapped: line.isWrapped, links: [] };
}

/**
 * Shared cell walk. When `cursorX >= 0`, the cell at that column becomes its
 * own single-cell segment with the cursor style and never merges with
 * neighbours. Width-0 cells (trailing half of a wide char) are skipped.
 */
function walkCells(
  line: IBufferLine,
  cols: number,
  nullCell: IBufferCell,
  cursorX: number,
): PocSegment[] {
  const segments: PocSegment[] = [];
  let currentKey: string | null = null;
  let currentText = '';
  let currentStyle: PocStyle | null = null;

  const flush = () => {
    if (currentKey !== null) {
      segments.push({ text: currentText, style: currentStyle });
    }
  };

  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x, nullCell);
    if (!cell) break;
    if (cell.getWidth() === 0) continue; // trailing half of a wide char

    const chars = cell.getChars() || ' ';

    if (x === cursorX) {
      flush();
      segments.push({ text: chars, style: CURSOR_STYLE });
      currentKey = null;
      currentText = '';
      currentStyle = null;
      continue;
    }

    const key2 = styleKey(cell);
    if (key2 !== currentKey) {
      flush();
      currentKey = key2;
      currentText = chars;
      currentStyle = cellStyle(cell);
    } else {
      currentText += chars;
    }
  }
  flush();

  return segments;
}

/**
 * Trim trailing whitespace from the last segment when that segment has no
 * style (default background), keeping the DOM light without altering visible
 * colored cells. `protectedCount` leading segments are never trimmed or popped
 * (used to keep the cursor segment on the cursor row).
 */
function trimTrailingDefaultWhitespace(segments: PocSegment[], protectedCount = 0): void {
  while (segments.length > protectedCount) {
    const last = segments[segments.length - 1];
    if (last.style !== null) break;
    const trimmed = last.text.replace(/ +$/, '');
    if (trimmed === last.text) break;
    if (trimmed === '') {
      segments.pop();
    } else {
      segments[segments.length - 1] = { text: trimmed, style: null };
      break;
    }
  }
}

export { DEFAULT_FG, DEFAULT_BG };
