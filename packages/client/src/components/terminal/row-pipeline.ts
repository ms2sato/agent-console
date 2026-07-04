import type { TerminalRow } from './buffer-to-rows';
import { detectRowLinks } from './link-detection';

/**
 * Shared row pipeline (terminal-history-paging.md §6.3): the row-extraction +
 * link-detection steps factored so both `rebuildSnapshot` (live buffer) and the
 * paged chunk replay (history-replay.ts) attach URL links by the same rule
 * rather than by parallel implementation. Future #958 tier-1 restyle steps hook
 * in here too.
 *
 * `rebuildSnapshot` keeps its own cache-aware windowed variant (it only detects
 * freshly-built rows and reuses cached links for immutable scrollback); this
 * module is the full-array form used where every row is fresh (a replayed
 * chunk), which is the common case the two share.
 */

/** Concatenated text of a row's segments (the offset space link ranges use). */
export function rowText(row: TerminalRow): string {
  return row.segments.map((s) => s.text).join('');
}

/**
 * Detect http(s) links across the whole row array (wrapped-line-window aware,
 * via detectRowLinks) and assign each row's `links`. Mutates the rows in place.
 * Rows carry stable keys; the link map is keyed by `row.key`.
 */
export function detectAndAssignLinks(rows: TerminalRow[]): void {
  if (rows.length === 0) return;
  const window = rows.map((r) => ({ key: r.key, text: rowText(r), isWrapped: r.isWrapped }));
  const linkMap = detectRowLinks(window);
  for (const r of rows) {
    r.links = linkMap.get(r.key) ?? [];
  }
}
