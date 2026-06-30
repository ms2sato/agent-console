/**
 * Tests for the @xterm/addon-serialize restore order helpers (Issue #922).
 *
 * Three layers:
 *  1. Pure-function unit tests of `buildTerminalOptionsForRestore` and
 *     `applyCachedSnapshotBeforeOpen` to pin the helper contracts.
 *  2. Real xterm.js + SerializeAddon round-trip that demonstrates the
 *     library's recommended restore: writing a snapshot into a same-size
 *     viewport BEFORE `terminal.open()` preserves the buffer content
 *     including scrollback.
 *  3. Source-text introspection: assert `Terminal.tsx` imports and uses
 *     the helpers, so reverting the production wiring (without reverting
 *     this test) trips a polarity-flip failure. The helper module + the
 *     consumer wiring form one unit; the introspection check guards the
 *     consumer side.
 *
 * xterm.js and SerializeAddon do not require `terminal.open()` for `write`
 * or `serialize` to work, so the xterm round-trip runs in pure happy-dom
 * without mounting any container.
 */
import { describe, expect, it } from 'bun:test';
import { Terminal as XTerm } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import {
  applyCachedSnapshotBeforeOpen,
  buildTerminalOptionsForRestore,
} from '../terminal-restore.js';

const SOURCE_ROWS = 50;
const SOURCE_COLS = 80;
const SOURCE_LINE_COUNT = 200;
const SCROLLBACK = 1000;

function writeAsync(terminal: XTerm, data: string): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(data, () => resolve());
  });
}

async function createSourceSnapshot(): Promise<string> {
  const source = new XTerm({ cols: SOURCE_COLS, rows: SOURCE_ROWS, scrollback: SCROLLBACK });
  const serialize = new SerializeAddon();
  source.loadAddon(serialize);

  // Produce well more lines than the viewport so scrollback is meaningfully populated.
  let payload = '';
  for (let i = 1; i <= SOURCE_LINE_COUNT; i++) {
    payload += `Line ${String(i).padStart(3, '0')}\r\n`;
  }
  await writeAsync(source, payload);

  const snapshot = serialize.serialize();
  source.dispose();
  return snapshot;
}

describe('buildTerminalOptionsForRestore', () => {
  it('returns base options unchanged when no cached state', () => {
    const base = { cursorBlink: true, fontSize: 14 };
    const result = buildTerminalOptionsForRestore(base, null);
    expect(result).toEqual(base);
  });

  it('merges cached cols/rows into the options when cached state is provided', () => {
    const base: { cursorBlink: boolean; fontSize: number; cols?: number; rows?: number } = {
      cursorBlink: true,
      fontSize: 14,
    };
    const result = buildTerminalOptionsForRestore(base, { cols: 120, rows: 40 });
    expect(result).toEqual({ cursorBlink: true, fontSize: 14, cols: 120, rows: 40 });
  });

  it('overrides any pre-existing cols/rows in the base options', () => {
    const base = { cols: 80, rows: 24, fontSize: 14 };
    const result = buildTerminalOptionsForRestore(base, { cols: 100, rows: 35 });
    expect(result.cols).toBe(100);
    expect(result.rows).toBe(35);
  });

  it('does not mutate the base options object', () => {
    const base = { cursorBlink: true, fontSize: 14 };
    buildTerminalOptionsForRestore(base, { cols: 120, rows: 40 });
    expect(base).toEqual({ cursorBlink: true, fontSize: 14 });
  });
});

describe('applyCachedSnapshotBeforeOpen', () => {
  it('writes the processed data to the terminal and invokes the completion callback', () => {
    const captured: { data: string | null; callback: (() => void) | undefined } = {
      data: null,
      callback: undefined,
    };
    const fakeTerminal = {
      write: (data: string, cb?: () => void) => {
        captured.data = data;
        captured.callback = cb;
      },
    };

    let completionCalled = false;
    applyCachedSnapshotBeforeOpen(
      fakeTerminal,
      'raw-data',
      (s) => `processed:${s}`,
      () => {
        completionCalled = true;
      }
    );

    expect(captured.data).toBe('processed:raw-data');
    captured.callback?.();
    expect(completionCalled).toBe(true);
  });

  it('passes through the data unchanged when processData is the identity', () => {
    const captured: { data: string | null } = { data: null };
    const fakeTerminal = {
      write: (data: string) => {
        captured.data = data;
      },
    };
    applyCachedSnapshotBeforeOpen(fakeTerminal, 'raw-data', (s) => s);
    expect(captured.data).toBe('raw-data');
  });
});

describe('xterm.js scrollback restore (recommended order)', () => {
  it('preserves the source buffer when the destination matches the source dimensions and write occurs before open()', async () => {
    const snapshot = await createSourceSnapshot();

    const restored = new XTerm({ cols: SOURCE_COLS, rows: SOURCE_ROWS, scrollback: SCROLLBACK });
    await writeAsync(restored, snapshot);

    // buffer.active.length includes scrollback + viewport rows.
    // For 200 lines into rows=50 the length should exceed the viewport — scrollback present.
    expect(restored.buffer.active.length).toBeGreaterThan(restored.rows);
    // Sanity: the restored terminal kept the source dimensions.
    expect(restored.rows).toBe(SOURCE_ROWS);
    expect(restored.cols).toBe(SOURCE_COLS);

    restored.dispose();
  });

  it('end-to-end: helpers combined produce a same-size restore that preserves scrollback', async () => {
    const snapshot = await createSourceSnapshot();
    const cached = {
      data: snapshot,
      cols: SOURCE_COLS,
      rows: SOURCE_ROWS,
      savedAt: Date.now(),
      offset: 0,
    };

    // Simulate Terminal.tsx's intended restore flow:
    //   1. Merge cached dims into the constructor options.
    //   2. Construct the terminal.
    //   3. Write the snapshot BEFORE open().
    const baseOptions = { cursorBlink: true, scrollback: SCROLLBACK };
    const options = buildTerminalOptionsForRestore(baseOptions, cached);
    const restored = new XTerm(options);

    const writeComplete = new Promise<void>((resolve) => {
      applyCachedSnapshotBeforeOpen(restored, cached.data, (s) => s, () => resolve());
    });
    await writeComplete;

    expect(restored.cols).toBe(SOURCE_COLS);
    expect(restored.rows).toBe(SOURCE_ROWS);
    expect(restored.buffer.active.length).toBeGreaterThan(restored.rows);

    restored.dispose();
  });
});

describe('Terminal.tsx wiring (polarity guard for Issue #922 fix)', () => {
  // The helper module is meaningless unless Terminal.tsx actually uses it.
  // This source-text check fails when Terminal.tsx is reverted to the legacy
  // restore order (no import / no construct-with-cached-dims), producing the
  // polarity flip required by workflow.md's TDD discipline.
  it('imports the restore helpers from lib/terminal-restore', async () => {
    const sourcePath = new URL('../../components/Terminal.tsx', import.meta.url);
    const source = await Bun.file(sourcePath).text();

    expect(source).toMatch(/from\s+['"]\.\.\/lib\/terminal-restore(?:\.js)?['"]/);
    expect(source).toContain('buildTerminalOptionsForRestore');
    expect(source).toContain('applyCachedSnapshotBeforeOpen');
  });
});
