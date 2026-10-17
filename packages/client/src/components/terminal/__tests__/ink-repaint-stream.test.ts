import { describe, it, expect } from 'bun:test';
import { Terminal } from '@xterm/headless';
import {
  generateInkRepaintStream,
  inkContentLabel,
  isInkChromeRowText,
  INK_STATUS_MARKER,
} from './fixtures/ink-repaint-stream';

const STATUS = 'ctx:4% | Sonnet 5 | ms2sato@ca-mini tmp ... /rc';

/** Absolute positioning / region / alt-screen / synchronized-update sequences. */
const ABSOLUTE_POSITIONING_CLASSES: Record<string, RegExp> = {
  'CUP (CSI row;col H, or HVP f; either parameter optional)': /\x1b\[\d*(?:;\d*)?[Hf]/,
  'DECSTBM (CSI top;bottom r)': /\x1b\[\d*;?\d*r/,
  'alt-screen (?1049)': /\x1b\[\?1049[hl]/,
  'synchronized update (?2026)': /\x1b\[\?2026[hl]/,
};

function detectAbsolutePositioning(stream: string): string[] {
  return Object.entries(ABSOLUTE_POSITIONING_CLASSES)
    .filter(([, re]) => re.test(stream))
    .map(([name]) => name);
}

function makeStream(): string {
  return generateInkRepaintStream({ frames: 12, cols: 100, statusBar: STATUS, contentLinesPerFrame: 20 });
}

describe('generateInkRepaintStream', () => {
  it('stays in the relative-repaint class: no CUP, DECSTBM, alt-screen or synchronized update', () => {
    expect(detectAbsolutePositioning(makeStream())).toEqual([]);
  });

  it('control: the detector flags a string containing each absolute-positioning sequence', () => {
    const CUP = 'CUP (CSI row;col H, or HVP f; either parameter optional)';
    expect(detectAbsolutePositioning('x\x1b[39;1Hy')).toEqual([CUP]);
    expect(detectAbsolutePositioning('x\x1b[Hy')).toEqual([CUP]);
    expect(detectAbsolutePositioning('x\x1b[5Hy')).toEqual([CUP]);
    expect(detectAbsolutePositioning('x\x1b[;5Hy')).toEqual([CUP]);
    expect(detectAbsolutePositioning('x\x1b[5;Hy')).toEqual([CUP]);
    expect(detectAbsolutePositioning('x\x1b[3;4fy')).toEqual([CUP]);
    // Near miss: a relative cursor-up is the movement the fixture is allowed to use.
    expect(detectAbsolutePositioning('x\x1b[2Ay')).toEqual([]);
    expect(detectAbsolutePositioning('x\x1b[1;38ry')).toEqual(['DECSTBM (CSI top;bottom r)']);
    expect(detectAbsolutePositioning('x\x1b[?1049hy')).toEqual(['alt-screen (?1049)']);
    expect(detectAbsolutePositioning('x\x1b[?2026hy')).toEqual(['synchronized update (?2026)']);
  });

  it('repaints with relative movement only: CUU to the chrome top and CSI K per line', () => {
    const stream = makeStream();
    expect(stream.match(/\x1b\[2A\r/g)).toHaveLength(11); // every frame but the first
    expect(stream).toContain('\x1b[K');
  });

  it('replayed at the authored size it leaves every content line once and exactly one chrome pair on screen', async () => {
    const term = new Terminal({ cols: 100, rows: 24, scrollback: 10_000, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write(makeStream(), () => resolve()));
    const buf = term.buffer.active;
    const texts: string[] = [];
    for (let y = 0; y < buf.length; y++) texts.push(buf.getLine(y)?.translateToString(true) ?? '');
    term.dispose();

    for (let frame = 1; frame <= 12; frame++) {
      for (let line = 1; line <= 20; line++) {
        const label = inkContentLabel(frame, line);
        expect(texts.filter((t) => t.includes(label))).toHaveLength(1);
      }
    }
    const chrome = texts.filter(isInkChromeRowText);
    expect(chrome).toHaveLength(2);
    expect(chrome.some((t) => t.includes(`${INK_STATUS_MARKER}12`))).toBe(true);
  });

  it('chromeRepaintsPerFrame adds relative-only chrome repaints and still settles to one chrome pair', async () => {
    const stream = generateInkRepaintStream({ frames: 3, cols: 100, statusBar: STATUS, contentLinesPerFrame: 5, chromeRepaintsPerFrame: 4 });
    expect(detectAbsolutePositioning(stream)).toEqual([]);
    // 2 frame-to-frame climbs + 3 frames * 4 repaints
    expect(stream.match(/\x1b\[2A\r/g)).toHaveLength(2 + 12);

    const term = new Terminal({ cols: 100, rows: 24, scrollback: 1000, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write(stream, () => resolve()));
    const buf = term.buffer.active;
    const texts: string[] = [];
    for (let y = 0; y < buf.length; y++) texts.push(buf.getLine(y)?.translateToString(true) ?? '');
    term.dispose();
    expect(texts.filter(isInkChromeRowText)).toHaveLength(2);
    for (let frame = 1; frame <= 3; frame++) {
      for (let line = 1; line <= 5; line++) {
        expect(texts.filter((t) => t.includes(inkContentLabel(frame, line)))).toHaveLength(1);
      }
    }
  });

  it('rejects a status bar without the marker', () => {
    expect(() => generateInkRepaintStream({ frames: 1, cols: 80, statusBar: 'no marker', contentLinesPerFrame: 1 })).toThrow();
  });
});
