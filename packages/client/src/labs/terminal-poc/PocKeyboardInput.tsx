import { forwardRef, useRef, useState } from 'react';
import type { KeyboardEvent, CompositionEvent, FormEvent, ClipboardEvent } from 'react';
import type { PocTerminalInstance } from './poc-terminal-store';
import { extractImageFiles } from './image-paste';

interface PocKeyboardInputProps {
  instance: PocTerminalInstance;
  // Called when an image is pasted (image-only or image+text clipboard). The
  // adapter phase (PR-3) wires this to MessagePanel; the labs route surfaces a
  // toast so the contract is E2E-visible.
  onFilesReceived?: (files: File[]) => void;
}

// Special keys -> escape sequences. Arrow keys use the normal (non-application)
// cursor sequences, which is correct for the PoC.
const SPECIAL_KEYS: Record<string, string> = {
  Enter: '\r',
  Backspace: '\x7f',
  Tab: '\t',
  Escape: '\x1b',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
};

/**
 * Visually-hidden focusable textarea that captures input, including IME
 * composition. Tapping the terminal focuses it, which pops the mobile soft
 * keyboard. A soft-key bar provides keys that are hard to reach on mobile.
 */
export const PocKeyboardInput = forwardRef<HTMLTextAreaElement, PocKeyboardInputProps>(
  function PocKeyboardInput({ instance, onFilesReceived }, ref) {
    const composingRef = useRef(false);
    const [composeText, setComposeText] = useState('');

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

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (composingRef.current || e.nativeEvent.isComposing) return;

      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        send('\n');
        return;
      }

      // Ctrl + single letter -> control character.
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
        const code = e.key.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) {
          e.preventDefault();
          send(String.fromCharCode(code - 64));
          return;
        }
      }

      const seq = SPECIAL_KEYS[e.key];
      if (seq !== undefined) {
        e.preventDefault();
        send(seq);
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

        <SoftKeyBar onKey={send} />
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
