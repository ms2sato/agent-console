/**
 * Clear the stale context-menu copy prime when its selection is lost.
 *
 * On right-click, xterm primes its hidden helper textarea for the native
 * context-menu "Copy": it sets `textarea.value = selectionText` and calls
 * `textarea.select()` (Clipboard.ts rightClickHandler). xterm never un-primes
 * it — the value is cleared only on textarea blur or on Enter/^C keydown.
 *
 * xterm's own 'copy' listener handles Cmd+C only while `hasSelection()` is
 * true; otherwise it declines and the BROWSER DEFAULT copy runs, which copies
 * the textarea's still-fully-selected STALE value from the previous
 * right-click. Under mouse tracking, plain clicks never create an xterm
 * selection, so after the first right-click copy every subsequent Cmd+C
 * without a live selection silently re-copies the FIRST copy's text.
 *
 * This cleanup clears the primed value as soon as the selection it mirrored is
 * gone. `SelectionService.clearSelection()` fires `onSelectionChange`, so the
 * selection-wipe is observable via the public API. The "primed" state is
 * identified by its signature: a non-empty value that is fully selected
 * (`select()` leaves selectionStart 0 / selectionEnd = length). IME
 * composition text never sits fully selected in the textarea, so composition
 * is not affected.
 */
import type { IDisposable, Terminal } from '@xterm/xterm';

/**
 * True iff the textarea currently holds the right-click copy prime: a
 * non-empty value that is fully selected from start to end.
 */
export function isPrimedForContextMenuCopy(
  ta: Pick<HTMLTextAreaElement, 'value' | 'selectionStart' | 'selectionEnd'>,
): boolean {
  return ta.value.length > 0 && ta.selectionStart === 0 && ta.selectionEnd === ta.value.length;
}

/**
 * Install the cleanup on a terminal. Returns the IDisposable from
 * `onSelectionChange`.
 *
 * `terminal.textarea` is read lazily inside the handler on purpose: it is
 * undefined until `open()`, but selection events only fire post-open.
 */
export function installCopyPrimeCleanup(terminal: Terminal): IDisposable {
  return terminal.onSelectionChange(() => {
    if (terminal.hasSelection()) return;
    const ta = terminal.textarea;
    if (ta && isPrimedForContextMenuCopy(ta)) {
      ta.value = '';
    }
  });
}
