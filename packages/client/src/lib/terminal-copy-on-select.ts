/**
 * Copy the terminal selection to the clipboard at creation time, but only
 * while mouse tracking is active (iTerm2-style copy-on-select, scoped).
 *
 * xterm's SelectionService subscribes to `coreService.onUserInput` and clears
 * the selection on ANY user input (SelectionService.ts:139-143).
 * `CoreMouseService.triggerMouseEvent` reports mouse actions via
 * `triggerDataEvent(report, true)` with `wasUserInput=true`
 * (CoreMouseService.ts:284). So under mouse tracking every reported mouse
 * action — plain click, right-click, wheel, and under the `any` protocol even
 * cell-crossing mouse MOVES — synchronously clears the selection. A selection
 * is therefore too ephemeral to survive until the user presses Cmd+C; a
 * select-then-copy flow is unwinnable under `?1003h`.
 *
 * Instead we capture the selection the instant it exists and write it to the
 * clipboard. Scoped to `mouseTrackingMode !== 'none'` so normal shells keep
 * the standard select-then-copy UX. Under tracking the only selections that
 * can occur are deliberate Option+drag / Cmd+A gestures, so auto-copy matches
 * user intent.
 */
import type { IDisposable, Terminal } from '@xterm/xterm';

export interface ClipboardWriter {
  writeText: (text: string) => Promise<void>;
}

/**
 * Default clipboard writer: the async Clipboard API when available, with a
 * legacy `execCommand('copy')` fallback for insecure origins (non-localhost
 * http) where `navigator.clipboard` is absent.
 */
export function createDefaultClipboardWriter(): ClipboardWriter {
  return {
    writeText: (text: string) => {
      const asyncClipboard = navigator.clipboard;
      if (asyncClipboard?.writeText) {
        return asyncClipboard.writeText(text);
      }
      // Fallback for insecure origins where the async Clipboard API is
      // unavailable. document.execCommand('copy') is deprecated but remains
      // the only synchronous option in those contexts.
      return new Promise<void>((resolve, reject) => {
        try {
          const textarea = document.createElement('textarea');
          textarea.value = text;
          textarea.style.position = 'fixed';
          textarea.style.left = '-9999px';
          document.body.appendChild(textarea);
          textarea.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(textarea);
          if (ok) resolve();
          else reject(new Error('execCommand("copy") returned false'));
        } catch (e) {
          reject(e);
        }
      });
    },
  };
}

/**
 * Install copy-on-select on a terminal. Returns the IDisposable from
 * `onSelectionChange`. Clipboard-write failures (e.g. permission denied) are
 * routed to `onError`; the default swallows them.
 */
export function installCopyOnSelect(
  terminal: Terminal,
  writer: ClipboardWriter = createDefaultClipboardWriter(),
  onError: (e: unknown) => void = () => {},
): IDisposable {
  return terminal.onSelectionChange(() => {
    if (terminal.modes.mouseTrackingMode === 'none') return;
    if (!terminal.hasSelection()) return;
    const text = terminal.getSelection();
    if (!text) return;
    void writer.writeText(text).catch(onError);
  });
}
