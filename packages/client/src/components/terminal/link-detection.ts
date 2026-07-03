/**
 * Pure URL detection over terminal rows. Kept free of DOM / React so the range
 * math (including wrapped-URL joining) is unit-testable in isolation.
 *
 * Ranges are offsets into each row's extracted text (JS string code units, the
 * same units the view splits segment text by) — cell widths are irrelevant here.
 */

export interface LinkRange {
  start: number; // inclusive column offset into the row's text
  end: number; // exclusive
  href: string; // the full (joined, punctuation-trimmed) URL
}

export interface DetectRow {
  key: number;
  text: string;
  isWrapped: boolean; // true = continuation of the previous logical line
}

// Conservative: explicit http(s) schemes only. Bare-domain and mailto matching
// are deliberately out of scope (future work).
const URL_RE = /https?:\/\/\S+/g;

// Trailing characters that terminal linkifiers treat as sentence punctuation
// rather than part of the URL.
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', "'", '"']);

/**
 * Detect http(s) links across rows. Consecutive rows whose followers have
 * `isWrapped === true` form one logical line: their text is joined, matched
 * once, and each match is mapped back to per-row `[start, end)` column ranges.
 *
 * @returns Map of row key -> its link column ranges (only rows with links appear).
 */
export function detectRowLinks(rows: DetectRow[]): Map<number, LinkRange[]> {
  const result = new Map<number, LinkRange[]>();
  let i = 0;
  while (i < rows.length) {
    // A logical line = rows[i] plus following rows flagged isWrapped.
    let j = i + 1;
    while (j < rows.length && rows[j].isWrapped) j++;
    detectInLogicalLine(rows.slice(i, j), result);
    i = j;
  }
  return result;
}

interface RowSpan {
  key: number;
  offset: number; // where this row's text starts in the joined string
  length: number;
}

function detectInLogicalLine(group: DetectRow[], result: Map<number, LinkRange[]>): void {
  let text = '';
  const spans: RowSpan[] = [];
  for (const row of group) {
    spans.push({ key: row.key, offset: text.length, length: row.text.length });
    text += row.text;
  }

  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    let end = start + match[0].length;
    // Trim trailing sentence punctuation from the end of the URL.
    while (end > start && TRAILING_PUNCTUATION.has(text[end - 1])) end--;
    if (end <= start) continue;
    const href = text.slice(start, end);

    // Map the joined-string range back onto each row it overlaps.
    for (const span of spans) {
      const rowStart = span.offset;
      const rowEnd = span.offset + span.length;
      const s = Math.max(start, rowStart);
      const e = Math.min(end, rowEnd);
      if (s >= e) continue;
      const ranges = result.get(span.key) ?? [];
      ranges.push({ start: s - rowStart, end: e - rowStart, href });
      result.set(span.key, ranges);
    }
  }
}
