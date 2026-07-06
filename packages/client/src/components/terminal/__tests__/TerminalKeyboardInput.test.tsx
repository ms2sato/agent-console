import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TerminalKeyboardInput } from '../TerminalKeyboardInput';
import type { TerminalInstance, TerminalSnapshot } from '../terminal-store';

// Fully-typed MediaQueryList stub (no double-cast). The soft-key gate only reads
// `.matches`; the rest of the interface is inert so useIsMobile's subscribe path
// is a no-op under test.
function createMatchMediaList(matches: boolean): MediaQueryList {
  return {
    matches,
    media: '(max-width: 767px)',
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  };
}

function installMatchMedia(matches: boolean): void {
  window.matchMedia = mock((_query: string) => createMatchMediaList(matches));
}

const SNAPSHOT_STUB: TerminalSnapshot = {
  version: 0,
  status: 'connecting',
  exitInfo: null,
  rows: [],
  cursor: { x: 0, y: 0, visible: true },
  cols: 80,
  terminalRows: 24,
  bufferType: 'normal',
  mouseTracking: false,
  notice: null,
  workerError: null,
  activityState: null,
  loadingHistory: false,
  loadingOlder: false,
  canRequestOlder: false,
  pagedRowCount: 0,
  pagedTopChunkRowCount: 0,
  pagedCapReached: false,
  retentionFloorReached: false,
};

// Render-only stub: TerminalKeyboardInput never subscribes or reads the snapshot
// during render; the methods exist only to satisfy the interface.
function makeMockInstance(): TerminalInstance {
  return {
    subscribe: () => () => {},
    getSnapshot: () => SNAPSHOT_STUB,
    sendInput: () => {},
    resize: () => {},
    forwardScroll: () => {},
    reportMouseButton: () => {},
    paste: () => {},
    getApplicationCursorMode: () => false,
    retry: () => {},
    dismissNotice: () => {},
    requestOlderHistory: () => {},
    evictTopChunk: () => {},
    acquire: () => () => {},
    dispose: () => {},
  };
}

describe('TerminalKeyboardInput soft-key bar visibility', () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    cleanup();
    window.matchMedia = originalMatchMedia;
  });

  it('renders the soft-key bar on mobile', () => {
    installMatchMedia(true);
    render(<TerminalKeyboardInput instance={makeMockInstance()} />);

    expect(screen.getByText('Esc')).toBeTruthy();
    expect(screen.getByText('Ctrl+C')).toBeTruthy();
    // The hidden input path is present on mobile too.
    expect(screen.getByLabelText('Terminal input')).toBeTruthy();
  });

  it('hides the soft-key bar on desktop but keeps the hidden input', () => {
    installMatchMedia(false);
    render(<TerminalKeyboardInput instance={makeMockInstance()} />);

    // No soft keys on desktop.
    expect(screen.queryByText('Esc')).toBeNull();
    expect(screen.queryByText('Ctrl+C')).toBeNull();
    // Input path must remain active so a physical keyboard still works.
    expect(screen.getByLabelText('Terminal input')).toBeTruthy();
  });
});

/**
 * handleKeyDown parity coverage — per `docs/audits/terminal-key-handling-parity.md`
 * §3 (per-key matrix) filtered by §4.1 (Critical) + §4.2 (Recommended).
 *
 * Deferred rows from audit §5 are NOT covered here.
 *
 * Modifier bitmask (xterm convention, audit §2.1): shift=1, alt=2, ctrl=4, meta=8.
 * The CSI parameter is `modifiers + 1` — so Shift alone = 2, Alt alone = 3,
 * Ctrl alone = 5, Ctrl+Shift = 6, etc.
 *
 * These tests are written BEFORE the production fix (Phase B commit 2). Every
 * assertion that is not already met by the current handler must fail RED here —
 * that is the polarity-flip proof required by `workflow.md` "TDD for bug fixes".
 * The unmodified base cases (Tab, Enter, Escape, Backspace, Arrows in CSI form,
 * Ctrl+letter, Shift+Enter divergence, Meta+Arrow, IME guard) already pass on
 * the current handler and stand as regression guards.
 */
describe('TerminalKeyboardInput handleKeyDown', () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    cleanup();
    window.matchMedia = originalMatchMedia;
  });

  interface HandleKeyDownSetup {
    sendInput: ReturnType<typeof mock>;
    textarea: HTMLTextAreaElement;
  }

  function setupHandler(applicationCursorMode = false): HandleKeyDownSetup {
    installMatchMedia(false);
    const sendInput = mock();
    const instance: TerminalInstance = {
      subscribe: () => () => {},
      getSnapshot: () => SNAPSHOT_STUB,
      sendInput,
      resize: () => {},
      forwardScroll: () => {},
      reportMouseButton: () => {},
      paste: () => {},
      retry: () => {},
      dismissNotice: () => {},
      requestOlderHistory: () => {},
      evictTopChunk: () => {},
      acquire: () => () => {},
      dispose: () => {},
      getApplicationCursorMode: () => applicationCursorMode,
    };
    render(<TerminalKeyboardInput instance={instance} />);
    const textarea = screen.getByLabelText('Terminal input') as HTMLTextAreaElement;
    textarea.focus();
    return { sendInput, textarea };
  }

  describe('Tab (audit §3.1)', () => {
    it('Tab -> \\t (regression guard)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key: 'Tab', code: 'Tab', keyCode: 9 });
      expect(sendInput).toHaveBeenCalledWith('\t');
    });

    it('Shift+Tab -> \\x1b[Z (backtab, CSI Z) — audit §4.1 item 1', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key: 'Tab', code: 'Tab', keyCode: 9, shiftKey: true });
      expect(sendInput).toHaveBeenCalledWith('\x1b[Z');
    });
  });

  describe('Enter (audit §3.4)', () => {
    it('Enter -> \\r (regression guard)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', keyCode: 13 });
      expect(sendInput).toHaveBeenCalledWith('\r');
    });

    // Deliberate agent-console divergence from xterm.js's `\r`. Claude Code
    // requires `\n` to insert a soft newline in its prompt buffer. Not a
    // regression — Phase B preserves this. See audit §3.4.
    it('Shift+Enter -> \\n (deliberate divergence preserved, audit §3.4)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        shiftKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\n');
    });

    it('Alt+Enter -> \\x1b\\r (audit §4.2 item 12)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', keyCode: 13, altKey: true });
      expect(sendInput).toHaveBeenCalledWith('\x1b\r');
    });
  });

  describe('Escape (audit §3.5)', () => {
    it('Escape -> \\x1b (regression guard)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key: 'Escape', code: 'Escape', keyCode: 27 });
      expect(sendInput).toHaveBeenCalledWith('\x1b');
    });

    it('Alt+Escape -> \\x1b\\x1b (audit §4.2 item 13)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        altKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\x1b\x1b');
    });
  });

  describe('Backspace (audit §3.3)', () => {
    it('Backspace -> \\x7f (DEL, regression guard)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key: 'Backspace', code: 'Backspace', keyCode: 8 });
      expect(sendInput).toHaveBeenCalledWith('\x7f');
    });

    it('Alt+Backspace -> \\x1b\\x7f (readline backward-kill-word, audit §4.1 item 7)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
        altKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\x1b\x7f');
    });

    it('Ctrl+Backspace -> \\b (0x08, audit §4.2 item 14)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
        ctrlKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\b');
    });
  });

  // Arrow key matrix, non-application-cursor-mode (CSI form).
  // Base sequences: \x1b[A / B / C / D for Up / Down / Right / Left.
  // Modified: \x1b[1;<mod+1><X> — see audit §3.2.
  describe('Arrow keys (CSI form, application cursor mode off, audit §3.2)', () => {
    const arrows: Array<[string, number, string]> = [
      ['ArrowUp', 38, 'A'],
      ['ArrowDown', 40, 'B'],
      ['ArrowRight', 39, 'C'],
      ['ArrowLeft', 37, 'D'],
    ];

    it.each(arrows)('%s (base) -> \\x1b[%s (regression guard)', (key, keyCode, letter) => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key, code: key, keyCode });
      expect(sendInput).toHaveBeenCalledWith(`\x1b[${letter}`);
    });

    it.each(arrows)('Shift+%s -> \\x1b[1;2%s (audit §4.1 item 2)', (key, keyCode, letter) => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key, code: key, keyCode, shiftKey: true });
      expect(sendInput).toHaveBeenCalledWith(`\x1b[1;2${letter}`);
    });

    it.each(arrows)('Alt+%s -> \\x1b[1;3%s (audit §4.1 item 2)', (key, keyCode, letter) => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key, code: key, keyCode, altKey: true });
      expect(sendInput).toHaveBeenCalledWith(`\x1b[1;3${letter}`);
    });

    it.each(arrows)('Ctrl+%s -> \\x1b[1;5%s (audit §4.1 item 2)', (key, keyCode, letter) => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key, code: key, keyCode, ctrlKey: true });
      expect(sendInput).toHaveBeenCalledWith(`\x1b[1;5${letter}`);
    });

    it.each(arrows)(
      'Ctrl+Shift+%s -> \\x1b[1;6%s (audit §4.2 recommended)',
      (key, keyCode, letter) => {
        const { sendInput, textarea } = setupHandler();
        fireEvent.keyDown(textarea, {
          key,
          code: key,
          keyCode,
          ctrlKey: true,
          shiftKey: true,
        });
        expect(sendInput).toHaveBeenCalledWith(`\x1b[1;6${letter}`);
      },
    );

    // Regression guard: xterm.js explicitly `break`s on Meta+Arrow; the current
    // impl agrees (Meta is not a bypass path). Audit §3.2 last row.
    it.each(arrows)('Meta+%s does NOT send (audit §3.2 last row)', (key, keyCode) => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key, code: key, keyCode, metaKey: true });
      expect(sendInput).not.toHaveBeenCalled();
    });
  });

  // Arrow key SS3 form when DECCKM (application cursor mode) is on. Audit §3.11.
  // The regression test here uses `getApplicationCursorMode = () => true`.
  describe('Arrow keys (SS3 form, application cursor mode on, audit §3.11)', () => {
    const arrows: Array<[string, number, string]> = [
      ['ArrowUp', 38, 'A'],
      ['ArrowDown', 40, 'B'],
      ['ArrowRight', 39, 'C'],
      ['ArrowLeft', 37, 'D'],
    ];

    it.each(arrows)('%s (SS3) -> \\x1bO%s (audit §4.2 item 19)', (key, keyCode, letter) => {
      const { sendInput, textarea } = setupHandler(true);
      fireEvent.keyDown(textarea, { key, code: key, keyCode });
      expect(sendInput).toHaveBeenCalledWith(`\x1bO${letter}`);
    });
  });

  describe('Home / End (CSI form, audit §3.6)', () => {
    it('Home -> \\x1b[H (audit §4.1 item 3)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key: 'Home', code: 'Home', keyCode: 36 });
      expect(sendInput).toHaveBeenCalledWith('\x1b[H');
    });

    it('End -> \\x1b[F (audit §4.1 item 3)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key: 'End', code: 'End', keyCode: 35 });
      expect(sendInput).toHaveBeenCalledWith('\x1b[F');
    });

    it('Ctrl+Home -> \\x1b[1;5H (audit §4.1 item 3)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: 'Home',
        code: 'Home',
        keyCode: 36,
        ctrlKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\x1b[1;5H');
    });

    it('Ctrl+End -> \\x1b[1;5F (audit §4.1 item 3)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key: 'End', code: 'End', keyCode: 35, ctrlKey: true });
      expect(sendInput).toHaveBeenCalledWith('\x1b[1;5F');
    });

    it('Shift+Home -> \\x1b[1;2H (audit §4.1 item 3)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: 'Home',
        code: 'Home',
        keyCode: 36,
        shiftKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\x1b[1;2H');
    });
  });

  describe('Home / End (SS3 form, application cursor mode on, audit §3.11)', () => {
    it('Home (SS3) -> \\x1bOH (audit §4.2 item 19)', () => {
      const { sendInput, textarea } = setupHandler(true);
      fireEvent.keyDown(textarea, { key: 'Home', code: 'Home', keyCode: 36 });
      expect(sendInput).toHaveBeenCalledWith('\x1bOH');
    });

    it('End (SS3) -> \\x1bOF (audit §4.2 item 19)', () => {
      const { sendInput, textarea } = setupHandler(true);
      fireEvent.keyDown(textarea, { key: 'End', code: 'End', keyCode: 35 });
      expect(sendInput).toHaveBeenCalledWith('\x1bOF');
    });
  });

  describe('Delete / Insert (audit §3.6)', () => {
    it('Delete -> \\x1b[3~ (audit §4.1 item 4)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key: 'Delete', code: 'Delete', keyCode: 46 });
      expect(sendInput).toHaveBeenCalledWith('\x1b[3~');
    });

    it('Ctrl+Delete -> \\x1b[3;5~ (audit §4.1 item 4)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: 'Delete',
        code: 'Delete',
        keyCode: 46,
        ctrlKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\x1b[3;5~');
    });

    it('Shift+Delete -> \\x1b[3;2~ (audit §4.1 item 4)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: 'Delete',
        code: 'Delete',
        keyCode: 46,
        shiftKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\x1b[3;2~');
    });

    it('Insert -> \\x1b[2~ (audit §4.2 item 18)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key: 'Insert', code: 'Insert', keyCode: 45 });
      expect(sendInput).toHaveBeenCalledWith('\x1b[2~');
    });
  });

  describe('PageUp / PageDown (audit §3.6)', () => {
    it('PageUp -> \\x1b[5~ (audit §4.1 item 5)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key: 'PageUp', code: 'PageUp', keyCode: 33 });
      expect(sendInput).toHaveBeenCalledWith('\x1b[5~');
    });

    it('PageDown -> \\x1b[6~ (audit §4.1 item 5)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key: 'PageDown', code: 'PageDown', keyCode: 34 });
      expect(sendInput).toHaveBeenCalledWith('\x1b[6~');
    });

    it('Ctrl+PageUp -> \\x1b[5;5~ (audit §4.1 item 5)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: 'PageUp',
        code: 'PageUp',
        keyCode: 33,
        ctrlKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\x1b[5;5~');
    });

    it('Ctrl+PageDown -> \\x1b[6;5~ (audit §4.1 item 5)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: 'PageDown',
        code: 'PageDown',
        keyCode: 34,
        ctrlKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\x1b[6;5~');
    });
  });

  // F1-F4 use SS3 form (\x1bOP/Q/R/S) at base; F5-F10 use CSI form (\x1b[<n>~).
  // Modified F1-F4: \x1b[1;<mod+1>P/Q/R/S. Modified F5-F10: \x1b[<n>;<mod+1>~.
  // Audit §3.7 / §4.2 items 9-10. F11 / F12 explicitly deferred per audit §4.3.
  describe('Function keys F1-F10 (audit §3.7)', () => {
    const fKeys: Array<[string, number, string]> = [
      ['F1', 112, '\x1bOP'],
      ['F2', 113, '\x1bOQ'],
      ['F3', 114, '\x1bOR'],
      ['F4', 115, '\x1bOS'],
      ['F5', 116, '\x1b[15~'],
      ['F6', 117, '\x1b[17~'],
      ['F7', 118, '\x1b[18~'],
      ['F8', 119, '\x1b[19~'],
      ['F9', 120, '\x1b[20~'],
      ['F10', 121, '\x1b[21~'],
    ];

    it.each(fKeys)('%s -> %o (audit §4.2 item 9)', (key, keyCode, expected) => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key, code: key, keyCode });
      expect(sendInput).toHaveBeenCalledWith(expected);
    });

    it('Ctrl+F1 -> \\x1b[1;5P (audit §4.2 item 10)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key: 'F1', code: 'F1', keyCode: 112, ctrlKey: true });
      expect(sendInput).toHaveBeenCalledWith('\x1b[1;5P');
    });

    it('Shift+F5 -> \\x1b[15;2~ (audit §4.2 item 10)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key: 'F5', code: 'F5', keyCode: 116, shiftKey: true });
      expect(sendInput).toHaveBeenCalledWith('\x1b[15;2~');
    });
  });

  // Alt + character (readline Meta). xterm.js sends `\x1b` + the character.
  // Audit §3.8 / §4.1 item 6.
  describe('Alt + character (readline Meta, audit §3.8)', () => {
    it('Alt+b -> \\x1bb (readline backward-word, audit §4.1 item 6)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key: 'b', code: 'KeyB', keyCode: 66, altKey: true });
      expect(sendInput).toHaveBeenCalledWith('\x1bb');
    });

    it('Alt+f -> \\x1bf (readline forward-word, audit §4.1 item 6)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key: 'f', code: 'KeyF', keyCode: 70, altKey: true });
      expect(sendInput).toHaveBeenCalledWith('\x1bf');
    });

    it('Alt+d -> \\x1bd (readline kill-word, audit §4.1 item 6)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key: 'd', code: 'KeyD', keyCode: 68, altKey: true });
      expect(sendInput).toHaveBeenCalledWith('\x1bd');
    });

    it('Alt+. -> \\x1b. (readline yank-last-arg, audit §4.2 item 11)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key: '.', code: 'Period', keyCode: 190, altKey: true });
      expect(sendInput).toHaveBeenCalledWith('\x1b.');
    });

    it('Alt+Shift+B -> \\x1bB (upper-case propagation, audit §4.2 recommended)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: 'B',
        code: 'KeyB',
        keyCode: 66,
        altKey: true,
        shiftKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\x1bB');
    });

    it('Alt+5 -> \\x1b5 (readline argument prefix, audit §4.2 item 11)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, { key: '5', code: 'Digit5', keyCode: 53, altKey: true });
      expect(sendInput).toHaveBeenCalledWith('\x1b5');
    });
  });

  // Ctrl + non-letter special forms. xterm.js maps a fixed set to control
  // bytes. Audit §3.9 / §4.1 item 8 / §4.2 items 15-17.
  describe('Ctrl + non-letter (audit §3.9)', () => {
    it('Ctrl+Space -> \\x00 (NUL, audit §4.1 item 8)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: ' ',
        code: 'Space',
        keyCode: 32,
        ctrlKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\x00');
    });

    it('Ctrl+3 -> \\x1b (ESC, audit §4.2 item 15)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: '3',
        code: 'Digit3',
        keyCode: 51,
        ctrlKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\x1b');
    });

    it('Ctrl+4 -> \\x1c (FS, audit §4.2 item 15)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: '4',
        code: 'Digit4',
        keyCode: 52,
        ctrlKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\x1c');
    });

    it('Ctrl+5 -> \\x1d (GS, audit §4.2 item 15)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: '5',
        code: 'Digit5',
        keyCode: 53,
        ctrlKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\x1d');
    });

    it('Ctrl+6 -> \\x1e (RS, audit §4.2 item 15)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: '6',
        code: 'Digit6',
        keyCode: 54,
        ctrlKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\x1e');
    });

    it('Ctrl+7 -> \\x1f (US, audit §4.2 item 15)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: '7',
        code: 'Digit7',
        keyCode: 55,
        ctrlKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\x1f');
    });

    it('Ctrl+/ -> \\x1f (US, audit §4.2 item 16)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: '/',
        code: 'Slash',
        keyCode: 191,
        ctrlKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\x1f');
    });

    it('Ctrl+Shift+2 (US @) -> \\x00 (NUL, audit §4.2 item 17)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: '@',
        code: 'Digit2',
        keyCode: 50,
        ctrlKey: true,
        shiftKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\x00');
    });

    it('Ctrl+Shift+6 (US ^) -> \\x1e (RS, audit §4.2 item 17)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: '^',
        code: 'Digit6',
        keyCode: 54,
        ctrlKey: true,
        shiftKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\x1e');
    });

    it('Ctrl+Shift+- (US _) -> \\x1f (US, audit §4.2 item 17)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: '_',
        code: 'Minus',
        keyCode: 189,
        ctrlKey: true,
        shiftKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\x1f');
    });
  });

  describe('Ctrl + letter (existing branch + tightening, audit §3.9)', () => {
    it('Ctrl+a -> \\x01 (regression guard)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: 'a',
        code: 'KeyA',
        keyCode: 65,
        ctrlKey: true,
      });
      expect(sendInput).toHaveBeenCalledWith('\x01');
    });

    // Audit §3.9 last paragraph + §4.2 item 20: xterm.js reserves Ctrl+Shift+2/6/-
    // for the special forms verified above; a plain Ctrl+Shift+letter should NOT
    // fall through to the Ctrl+letter control-byte branch. The current impl
    // incorrectly emits \x01 here; Phase B tightens the precondition to
    // `!e.shiftKey` so Ctrl+Shift+A becomes a no-op.
    it('Ctrl+Shift+A does NOT emit \\x01 (tightening, audit §4.2 item 20)', () => {
      const { sendInput, textarea } = setupHandler();
      fireEvent.keyDown(textarea, {
        key: 'A',
        code: 'KeyA',
        keyCode: 65,
        ctrlKey: true,
        shiftKey: true,
      });
      expect(sendInput).not.toHaveBeenCalled();
    });
  });

  describe('IME composition guard (audit §3.10)', () => {
    it('while composing, Shift+Tab does NOT call sendInput', () => {
      const { sendInput, textarea } = setupHandler();
      // Enter composition state before dispatching the keydown. The handler's
      // early-return on `composingRef.current` must swallow all keys until
      // compositionend, or an IME popup selection would leak Shift+Tab bytes
      // into the PTY.
      fireEvent.compositionStart(textarea);
      fireEvent.keyDown(textarea, {
        key: 'Tab',
        code: 'Tab',
        keyCode: 9,
        shiftKey: true,
      });
      expect(sendInput).not.toHaveBeenCalled();
    });
  });
});
