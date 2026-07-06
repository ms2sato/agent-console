import { forwardRef, useRef, useState } from 'react';
import type { KeyboardEvent, CompositionEvent, FormEvent, ClipboardEvent } from 'react';
import type { TerminalInstance } from './terminal-store';
import { extractImageFiles } from './image-paste';
import { useIsMobile } from '../../hooks/useIsMobile';

interface TerminalKeyboardInputProps {
  instance: TerminalInstance;
  // Called when an image is pasted (image-only or image+text clipboard). The
  // adapter phase (PR-3) wires this to MessagePanel; the labs route surfaces a
  // toast so the contract is E2E-visible.
  onFilesReceived?: (files: File[]) => void;
}

// F5-F10 CSI codes per audit §3.7. F5+ use `\x1b[<code>~` at base and
// `\x1b[<code>;<mod+1>~` when modified.
const F5_PLUS_CODES: Record<string, number> = {
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
};

// F1-F4 use SS3 form (`\x1bOP/Q/R/S`) at base and `\x1b[1;<mod+1>P/Q/R/S`
// when modified. Audit §3.7.
const F1_TO_F4_LETTERS: Record<string, string> = {
  F1: 'P',
  F2: 'Q',
  F3: 'R',
  F4: 'S',
};

// Arrow key final letters, indexed by e.key. Audit §3.2 / §3.11.
const ARROW_LETTERS: Record<string, string> = {
  ArrowUp: 'A',
  ArrowDown: 'B',
  ArrowRight: 'C',
  ArrowLeft: 'D',
};

/**
 * Visually-hidden focusable textarea that captures input, including IME
 * composition. Tapping the terminal focuses it, which pops the mobile soft
 * keyboard. A soft-key bar provides keys that are hard to reach on mobile.
 */
export const TerminalKeyboardInput = forwardRef<HTMLTextAreaElement, TerminalKeyboardInputProps>(
  function TerminalKeyboardInput({ instance, onFilesReceived }, ref) {
    const composingRef = useRef(false);
    const [composeText, setComposeText] = useState('');
    // The soft-key bar only helps on touch devices without a physical keyboard;
    // on desktop it wastes space. The hidden textarea + IME + key handling below
    // stay active on both — desktop still needs the input path.
    const isMobile = useIsMobile();

    const send = (data: string) => instance.sendInput(data);

    const clearTextarea = (el: HTMLTextAreaElement) => {
      el.value = '';
    };

    const handleCompositionStart = () => {
      composingRef.current = true;
    };

    const handleCompositionUpdate = (e: CompositionEvent<HTMLTextAreaElement>) => {
      setComposeText(e.data);
    };

    const handleCompositionEnd = (e: CompositionEvent<HTMLTextAreaElement>) => {
      composingRef.current = false;
      setComposeText('');
      if (e.data) send(e.data);
      clearTextarea(e.currentTarget);
    };

    const handleInput = (e: FormEvent<HTMLTextAreaElement>) => {
      if (composingRef.current) return;
      const el = e.currentTarget;
      if (el.value) {
        send(el.value);
        clearTextarea(el);
      }
    };

    const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
      // Paste during IME composition is an edge case; let the default happen.
      if (composingRef.current) return;
      // Image precedence matches production (Terminal.tsx): when the clipboard
      // carries an image, route it to onFilesReceived and swallow the event —
      // no text is sent, even if text is also present.
      const imageFiles = extractImageFiles(e.clipboardData.items);
      if (imageFiles.length > 0 && onFilesReceived) {
        e.preventDefault();
        onFilesReceived(imageFiles);
        return;
      }
      const text = e.clipboardData.getData('text/plain');
      // No text (e.g. an image-only clipboard with no handler): let default run.
      if (!text) return;
      e.preventDefault();
      instance.paste(text);
    };

    // Keyboard-to-PTY conversion. Modeled on xterm.js's evaluateKeyboardEvent
    // (canonical reference: xterm.js master @ 8aab310, file
    // `src/common/input/Keyboard.ts`). Issue #985 / PR #986 restored parity
    // after the xterm.js renderer was removed in PR #962.
    //
    // Modifier bitmask (xterm convention): shift=1, alt=2, ctrl=4, meta=8. The
    // CSI parameter is `modifiers + 1` — so Shift alone = 2, Alt alone = 3,
    // Ctrl alone = 5, Ctrl+Shift = 6, etc.
    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (composingRef.current || e.nativeEvent.isComposing) return;

      const modifiers =
        (e.shiftKey ? 1 : 0) |
        (e.altKey ? 2 : 0) |
        (e.ctrlKey ? 4 : 0) |
        (e.metaKey ? 8 : 0);
      const modParam = modifiers + 1;

      const emit = (seq: string) => {
        e.preventDefault();
        send(seq);
      };

      // Named-key branches — one per audit §3 subsection. All branches guard
      // Meta explicitly (xterm.js `break`s on Meta for keys it does not
      // reserve). Every non-return path either emits or is a deliberate
      // deferred behavior (Shift+PageUp/PageDown, audit §5).
      switch (e.key) {
        case 'Tab':
          // Alt+Tab / Ctrl+Tab are OS/browser reserved; do nothing.
          if (e.metaKey || e.altKey || e.ctrlKey) return;
          return emit(e.shiftKey ? '\x1b[Z' : '\t');

        case 'Enter':
          if (e.metaKey) return;
          // Agent-console deliberate divergence (audit §3.4): Claude Code needs
          // Shift+Enter -> \n to insert a soft newline. xterm.js emits \r here.
          if (e.shiftKey && !e.ctrlKey && !e.altKey) return emit('\n');
          if (e.altKey && !e.ctrlKey && !e.shiftKey) return emit('\x1b\r');
          return emit('\r');

        case 'Escape':
          if (e.metaKey) return;
          if (e.altKey && !e.ctrlKey && !e.shiftKey) return emit('\x1b\x1b');
          return emit('\x1b');

        case 'Backspace':
          if (e.metaKey) return;
          if (e.altKey && !e.ctrlKey) return emit('\x1b\x7f');
          if (e.ctrlKey && !e.altKey) return emit('\b');
          // Shift+Backspace: xterm ignores Shift here (audit §3.3).
          return emit('\x7f');

        case 'Delete':
          if (e.metaKey) return;
          return emit(modifiers === 0 ? '\x1b[3~' : `\x1b[3;${modParam}~`);

        case 'Insert':
          // Shift+Insert / Ctrl+Insert = OS copy/paste; audit §3.6 suppresses
          // PTY output for those, matching xterm.js.
          if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
          return emit('\x1b[2~');

        case 'Home':
          if (e.metaKey) return;
          if (modifiers === 0) {
            return emit(instance.getApplicationCursorMode() ? '\x1bOH' : '\x1b[H');
          }
          return emit(`\x1b[1;${modParam}H`);

        case 'End':
          if (e.metaKey) return;
          if (modifiers === 0) {
            return emit(instance.getApplicationCursorMode() ? '\x1bOF' : '\x1b[F');
          }
          return emit(`\x1b[1;${modParam}F`);

        case 'PageUp':
          // Shift+PageUp is UI scrollback (audit §5 deferred); let default run.
          if (e.shiftKey) return;
          if (e.metaKey) return;
          return emit(modifiers === 0 ? '\x1b[5~' : `\x1b[5;${modParam}~`);

        case 'PageDown':
          if (e.shiftKey) return;
          if (e.metaKey) return;
          return emit(modifiers === 0 ? '\x1b[6~' : `\x1b[6;${modParam}~`);

        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowRight':
        case 'ArrowLeft': {
          // xterm.js explicitly breaks on Meta+Arrow (audit §3.2 last row).
          if (e.metaKey) return;
          const letter = ARROW_LETTERS[e.key];
          if (modifiers === 0) {
            return emit(
              instance.getApplicationCursorMode() ? `\x1bO${letter}` : `\x1b[${letter}`,
            );
          }
          return emit(`\x1b[1;${modParam}${letter}`);
        }

        case 'F1':
        case 'F2':
        case 'F3':
        case 'F4': {
          if (e.metaKey) return;
          const letter = F1_TO_F4_LETTERS[e.key];
          return emit(modifiers === 0 ? `\x1bO${letter}` : `\x1b[1;${modParam}${letter}`);
        }
        case 'F5':
        case 'F6':
        case 'F7':
        case 'F8':
        case 'F9':
        case 'F10': {
          if (e.metaKey) return;
          const code = F5_PLUS_CODES[e.key];
          return emit(modifiers === 0 ? `\x1b[${code}~` : `\x1b[${code};${modParam}~`);
        }
        // F11 / F12 intentionally omitted (audit §4.3): browsers always
        // intercept (fullscreen / devtools), so emitting has no PTY reach.
      }

      // Ctrl + non-letter special forms + Ctrl+letter control byte, audit §3.9.
      if (e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.shiftKey) {
          // Ctrl+Shift+{2,6,-} = US-layout xterm parity (audit §4.2 item 17).
          // Discriminated by `code` so localized keyboard layouts do not misfire.
          if (e.code === 'Digit2') return emit('\x00');
          if (e.code === 'Digit6') return emit('\x1e');
          if (e.code === 'Minus') return emit('\x1f');
          // Tightening (audit §4.2 item 20): Ctrl+Shift+letter is NOT a control
          // byte — xterm reserves Ctrl+Shift for the special forms above.
          return;
        }
        if (e.key === ' ') return emit('\x00'); // Ctrl+Space (audit §4.1 item 8)
        if (e.key === '3') return emit('\x1b'); // Ctrl+3 = ESC
        if (e.key === '4') return emit('\x1c'); // Ctrl+4 = FS
        if (e.key === '5') return emit('\x1d'); // Ctrl+5 = GS
        if (e.key === '6') return emit('\x1e'); // Ctrl+6 = RS
        if (e.key === '7') return emit('\x1f'); // Ctrl+7 = US
        if (e.key === '/') return emit('\x1f'); // Ctrl+/ = US (audit §4.2 item 16)
        // Ctrl + single letter -> control character (0x01 .. 0x1a).
        if (e.key.length === 1) {
          const code = e.key.toUpperCase().charCodeAt(0);
          if (code >= 64 && code <= 95) return emit(String.fromCharCode(code - 64));
        }
        return;
      }

      // Alt + single character (readline Meta). macOptionIsMeta = true default
      // per audit §3.13 — treating Option as Meta matches what Claude Code,
      // vim, and bash users expect from a terminal emulator. Shift is already
      // reflected in the browser's `e.key` case, so Alt+Shift+B yields 'B'.
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
        return emit('\x1b' + e.key);
      }
    };

    return (
      <>
        {composeText && (
          <div className="pointer-events-none absolute bottom-16 left-2 z-10 rounded bg-slate-800/90 px-2 py-1 text-sm text-yellow-300 underline">
            {composeText}
          </div>
        )}

        <textarea
          ref={ref}
          onCompositionStart={handleCompositionStart}
          onCompositionUpdate={handleCompositionUpdate}
          onCompositionEnd={handleCompositionEnd}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          aria-label="Terminal input"
          className="absolute opacity-0"
          style={{ width: 1, height: 1, left: 0, top: 0, resize: 'none', border: 'none', padding: 0 }}
        />

        {/* Mobile only. The border/padding live on the bar itself, so omitting
            it on desktop leaves no stray divider. */}
        {isMobile && <SoftKeyBar onKey={send} />}
      </>
    );
  },
);

interface SoftKeyBarProps {
  onKey: (data: string) => void;
}

const SOFT_KEYS: { label: string; data: string }[] = [
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t' },
  // Shift+Tab (CSI Z, backtab): mobile users cannot easily type the modifier
  // combo, but Claude Code's mode cycle and vim / bash `<S-Tab>` need it.
  // Audit §9 (Owner-approved).
  { label: 'Shift+Tab', data: '\x1b[Z' },
  { label: 'Ctrl+C', data: '\x03' },
  { label: '↑', data: '\x1b[A' },
  { label: '↓', data: '\x1b[B' },
  { label: '←', data: '\x1b[D' },
  { label: '→', data: '\x1b[C' },
  { label: 'Enter', data: '\r' },
];

function SoftKeyBar({ onKey }: SoftKeyBarProps) {
  return (
    <div className="flex flex-wrap gap-1 border-t border-slate-700 bg-slate-900 p-1">
      {SOFT_KEYS.map((key) => (
        <button
          key={key.label}
          type="button"
          // pointerDown + preventDefault so the button never steals focus from
          // the hidden textarea (which would dismiss the mobile keyboard).
          onPointerDown={(e) => {
            e.preventDefault();
            onKey(key.data);
          }}
          // Keyboard activation (Enter / Space) for physical-keyboard users.
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onKey(key.data);
            }
          }}
          className="min-w-10 rounded bg-slate-700 px-3 py-2 text-sm text-white hover:bg-slate-600 active:bg-slate-500"
        >
          {key.label}
        </button>
      ))}
    </div>
  );
}
