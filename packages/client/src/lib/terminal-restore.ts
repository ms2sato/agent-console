/**
 * Helpers for the recommended restore order of `@xterm/addon-serialize`
 * snapshots. The library's documented best practice:
 *
 *   1. Construct the terminal at the SAME cols/rows as the snapshot's source.
 *   2. Write the snapshot BEFORE `terminal.open()` is called.
 *
 * Restoring into a smaller pre-fit viewport (the default 80x24) prevents the
 * scrollback buffer from being repopulated — the destination has nowhere to
 * put the scrollback content, so only the visible viewport is reconstructed.
 * Subsequent serialize() calls on that broken terminal produce a viewport-only
 * snapshot, which then perpetuates the no-scrollback state across cache
 * round-trips.
 */
import type { ITerminalInitOnlyOptions, ITerminalOptions, Terminal as XTerm } from '@xterm/xterm';
import type { CachedState } from './terminal-state-cache.js';

/**
 * Merge the cached snapshot's source dimensions into XTerm constructor options.
 *
 * Per `@xterm/addon-serialize/typings/addon-serialize.d.ts:28-29`:
 * > "It's recommended that you write the serialized data into a terminal of
 * >  the same size in which it originated from and then resize it after if
 * >  needed."
 *
 * When no cached state is available (first-ever mount of a worker), returns
 * the base options unchanged so the default xterm dimensions apply.
 */
export function buildTerminalOptionsForRestore<
  T extends ITerminalOptions & ITerminalInitOnlyOptions
>(
  baseOptions: T,
  cached: Pick<CachedState, 'cols' | 'rows'> | null
): T {
  if (!cached) return baseOptions;
  return { ...baseOptions, cols: cached.cols, rows: cached.rows };
}

/**
 * Write a cached snapshot into a freshly-constructed terminal BEFORE
 * `terminal.open()` is called.
 *
 * Per `@xterm/addon-serialize/typings/addon-serialize.d.ts:24-26`:
 * > "When restoring a terminal it is best to do before `Terminal.open` is
 * >  called to avoid wasting CPU cycles rendering incomplete frames."
 *
 * The before-open ordering matters together with the dimension match from
 * {@link buildTerminalOptionsForRestore}: restoring after open() races the
 * initial fit and the snapshot may be written while the viewport is still at
 * the pre-fit defaults, dropping the scrollback content.
 */
export function applyCachedSnapshotBeforeOpen(
  terminal: Pick<XTerm, 'write'>,
  data: string,
  processData: (s: string) => string,
  onComplete?: () => void
): void {
  terminal.write(processData(data), onComplete);
}
