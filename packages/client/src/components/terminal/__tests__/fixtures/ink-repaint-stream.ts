/**
 * Synthetic Ink-style (Claude Code) output stream for seam-correction tests.
 *
 * Reproduces the byte class the #979 forensic measurement attributed the
 * leaked chrome rows to: a TUI that prints content lines above a two-line
 * bottom chrome (input frame + status bar) and repaints that chrome after every
 * frame using ONLY relative cursor movement -- CUU to the chrome top, `CSI K`
 * per line, rewrite. No CUP, no DECSTBM, no alt-screen, no synchronized
 * update. That is deliberate: absolute positioning is the class the rows-parity
 * fix already covers, so a fixture that drifted into it would stop measuring
 * the seam correction. `ink-repaint-stream.test.ts` pins the property.
 *
 * Authored for a terminal of `cols` columns; every emitted line is shorter than
 * `cols`, so one logical line is one buffer row.
 */

export const INK_STATUS_MARKER = 'ctx:';
export const INK_INPUT_FRAME = '> ';
export const INK_CHROME_HEIGHT = 2;

const ESC = '\x1b';

export interface InkRepaintStreamOptions {
  /** Number of frames (each: N content lines, then the repainted chrome). */
  frames: number;
  /** Terminal width the stream is authored for. */
  cols: number;
  /** Status line text; must contain {@link INK_STATUS_MARKER} to be counted as chrome. */
  statusBar: string;
  /** Content lines printed per frame. */
  contentLinesPerFrame: number;
  /**
   * Extra chrome-only repaints after each frame's content (a live Ink UI redraws
   * its status line / spinner many times between content lines). Default 0.
   */
  chromeRepaintsPerFrame?: number;
}

/** Label of a content line; unique per (frame, line). Frames/lines are 1-based. */
export function inkContentLabel(frame: number, line: number): string {
  return `[F${String(frame).padStart(3, '0')}:L${String(line).padStart(2, '0')}]`;
}

/** True for a row of the repainted bottom chrome (status bar or input frame). */
export function isInkChromeRowText(text: string): boolean {
  const trimmed = text.trimEnd();
  return trimmed.includes(INK_STATUS_MARKER) || trimmed === '>' || trimmed.startsWith(INK_INPUT_FRAME);
}

export function generateInkRepaintStream(options: InkRepaintStreamOptions): string {
  const { frames, cols, statusBar, contentLinesPerFrame, chromeRepaintsPerFrame = 0 } = options;
  if (!statusBar.includes(INK_STATUS_MARKER)) {
    throw new Error(`statusBar must contain "${INK_STATUS_MARKER}"`);
  }
  const maxLineLength = cols - 1;
  const fit = (text: string): string => text.slice(0, maxLineLength);

  const chrome = (frame: number): string =>
    `${ESC}[K${INK_INPUT_FRAME}\r\n` +
    `${ESC}[K${fit(statusBar.replace(INK_STATUS_MARKER, `${INK_STATUS_MARKER}${frame}`))}\r\n`;
  const climbToChromeTop = `${ESC}[${INK_CHROME_HEIGHT}A\r`;

  let out = '';
  for (let frame = 1; frame <= frames; frame++) {
    if (frame > 1) {
      // Cursor rests on the row below the chrome: climb to the chrome top.
      out += climbToChromeTop;
    }
    // Content lines overwrite the stale chrome rows first, then scroll the screen.
    for (let line = 1; line <= contentLinesPerFrame; line++) {
      out += `${ESC}[K${fit(`${inkContentLabel(frame, line)} the quick brown fox jumps over the lazy dog`)}\r\n`;
    }
    out += chrome(frame);
    for (let repaint = 0; repaint < chromeRepaintsPerFrame; repaint++) {
      out += climbToChromeTop + chrome(frame);
    }
  }
  return out;
}
