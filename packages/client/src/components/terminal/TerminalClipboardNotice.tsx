import { useEffect, useState } from 'react';
import type { TerminalInstance } from './terminal-store';

export const CLIPBOARD_NOTICE_TEXT = 'Copied from the terminal -- click to put it on your clipboard';

interface TerminalClipboardNoticeProps {
  instance: Pick<TerminalInstance, 'onClipboardWrite'>;
}

/**
 * OSC 52 clipboard writes (design doc "OSC 52 clipboard"). Silent write only when this
 * client typed into this worker recently (the store's `recentInput`) and the document has
 * focus; otherwise, and on any rejection, a non-modal notice whose click performs the write
 * inside the user gesture. A second event replaces the pending text. Nothing here reads the
 * clipboard.
 */
export function TerminalClipboardNotice({ instance }: TerminalClipboardNoticeProps) {
  const [pendingText, setPendingText] = useState<string | null>(null);

  useEffect(() => {
    return instance.onClipboardWrite((event) => {
      if (event.recentInput && document.hasFocus()) {
        void writeClipboard(event.text).catch(() => setPendingText(event.text));
      } else {
        setPendingText(event.text);
      }
    });
  }, [instance]);

  if (pendingText === null) return null;

  return (
    <div
      role="status"
      className="absolute bottom-3 left-3 z-20 flex items-center gap-2 rounded bg-slate-700 text-white text-xs shadow-lg"
    >
      <button
        type="button"
        className="px-3 py-2 hover:bg-slate-600 rounded-l"
        onClick={() => {
          void writeClipboard(pendingText).catch(() => {});
          setPendingText(null);
        }}
      >
        {CLIPBOARD_NOTICE_TEXT}
      </button>
      <button
        type="button"
        aria-label="Dismiss clipboard notice"
        className="px-2 py-2 hover:bg-slate-600 rounded-r"
        onClick={() => setPendingText(null)}
      >
        x
      </button>
    </div>
  );
}

/** Rejects (never throws synchronously) when the Clipboard API is missing or refuses. */
async function writeClipboard(text: string): Promise<void> {
  if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
  await navigator.clipboard.writeText(text);
}
