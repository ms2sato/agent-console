import { useEffect, useRef, useState } from 'react';
import type { TerminalInstance } from './terminal-store';

export const CLIPBOARD_NOTICE_TEXT = 'Copied from the terminal -- click to put it on your clipboard';
export const CLIPBOARD_COPY_FAILED_TEXT = 'Could not copy -- select and copy manually';

interface TerminalClipboardNoticeProps {
  instance: Pick<TerminalInstance, 'onClipboardWrite'>;
  /**
   * Whether the silent write path exists at all. False in multi-user mode: the OSC 52 bytes
   * arrive over the shared PTY stream and carry no sender, so "this client typed recently"
   * cannot attribute the write to this client when other authenticated users can attach to
   * the same worker. Every write then goes through the click-to-copy notice.
   */
  allowSilentWrite: boolean;
}

/**
 * OSC 52 clipboard writes (design doc "OSC 52 clipboard"). Silent write only when
 * `allowSilentWrite` (single-user mode) and this client typed into this worker recently (the
 * store's `recentInput`) and the document has focus; otherwise, and on any rejection, a non-modal notice whose click performs the write
 * inside the user gesture. The notice follows the newest event: a newer event replaces the
 * pending text (a newer silent write clears it) and a superseded event's rejection is ignored.
 * A failed click keeps the notice and shows failure feedback. Nothing here reads the clipboard.
 */
export function TerminalClipboardNotice({ instance, allowSilentWrite }: TerminalClipboardNoticeProps) {
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const latestEventSeq = useRef(0);

  useEffect(() => {
    return instance.onClipboardWrite((event) => {
      const seq = ++latestEventSeq.current;
      setCopyFailed(false);
      if (allowSilentWrite && event.recentInput && document.hasFocus()) {
        setPendingText(null);
        void writeClipboard(event.text).catch(() => {
          if (seq === latestEventSeq.current) setPendingText(event.text);
        });
      } else {
        setPendingText(event.text);
      }
    });
  }, [instance, allowSilentWrite]);

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
          const seq = latestEventSeq.current;
          writeClipboard(pendingText).then(
            () => {
              if (seq !== latestEventSeq.current) return;
              setCopyFailed(false);
              setPendingText(null);
            },
            () => {
              if (seq === latestEventSeq.current) setCopyFailed(true);
            },
          );
        }}
      >
        {CLIPBOARD_NOTICE_TEXT}
      </button>
      {copyFailed && <span className="text-red-300">{CLIPBOARD_COPY_FAILED_TEXT}</span>}
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
