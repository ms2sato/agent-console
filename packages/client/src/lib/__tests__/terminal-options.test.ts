/**
 * Tests for buildBaseTerminalOptions (packages/client/src/lib/terminal-options.ts).
 *
 * These options restore drag-copy in the web terminal while a TUI
 * (e.g. Claude Code's fullscreen UI) has DEC mouse tracking enabled. When
 * mouse tracking is on, xterm.js disables its SelectionService, killing
 * drag-selection. Three xterm.js constructor options are the fix:
 *   - macOptionClickForcesSelection: allow Option+drag selection on Mac
 *     (macOS has no Shift+drag bypass — that only works on non-Mac).
 *   - rightClickSelectsWord: false so a right-click keeps the current
 *     selection for the "select -> right-click -> Copy" flow (defaults to
 *     true on Mac, which would overwrite the selection with one word).
 *   - altClickMovesCursor: false so a short Option+click does not emit
 *     cursor-move escape sequences into the PTY.
 */
import { describe, expect, it } from 'bun:test';
import { buildBaseTerminalOptions } from '../terminal-options';

describe('buildBaseTerminalOptions mouse-tracking copy options', () => {
  it('should not select a word on right-click (keeps existing selection for Copy)', () => {
    expect(buildBaseTerminalOptions().rightClickSelectsWord).toBe(false);
  });

  it('should force selection on Option+drag even under mouse tracking', () => {
    expect(buildBaseTerminalOptions().macOptionClickForcesSelection).toBe(true);
  });

  it('should not move the cursor on Option+click (avoids stray PTY input)', () => {
    expect(buildBaseTerminalOptions().altClickMovesCursor).toBe(false);
  });
});

/**
 * Contract pins — regression guards for the pre-existing base options. These
 * pass in BOTH the pre-fix (refactor) and post-fix states, so they are NOT
 * part of the copy-fix polarity set; they only guard against accidental
 * changes to the unrelated base configuration.
 */
describe('buildBaseTerminalOptions contract pins (not part of the copy-fix polarity set)', () => {
  it('should enable cursor blink', () => {
    expect(buildBaseTerminalOptions().cursorBlink).toBe(true);
  });

  it('should use font size 14', () => {
    expect(buildBaseTerminalOptions().fontSize).toBe(14);
  });

  it('should include JetBrains Mono in the font stack (#818)', () => {
    expect(buildBaseTerminalOptions().fontFamily).toContain('"JetBrains Mono"');
  });

  it('should use the dark theme background', () => {
    expect(buildBaseTerminalOptions().theme?.background).toBe('#1a1a2e');
  });
});
