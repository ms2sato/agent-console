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
  // Optional hover text set by link transforms (e.g. the localhost -> user-
  // accessible-host rewrite) to explain an href substitution. Absent when the
  // href was not rewritten.
  title?: string;
}

export interface DetectRow {
  key: number;
  text: string;
  isWrapped: boolean; // true = continuation of the previous logical line
  fillsLastColumn: boolean; // written cells reach the last column (see TerminalRow)
}

// Conservative: explicit http(s) schemes only. Bare-domain and mailto matching
// are deliberately out of scope (future work).
const URL_RE = /https?:\/\/\S+/g;

// Trailing characters that terminal linkifiers treat as sentence punctuation
// rather than part of the URL.
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', "'", '"']);

// Characters a URL can continue with after an application-authored break
// (RFC 3986 unreserved + reserved + '%'); whitespace is excluded by construction.
const URL_CONTINUATION_START = /^[A-Za-z0-9\-._~%:/?#[\]@!$&'()*+,;=]/;

/**
 * Match-free part of the edge-of-row heuristic: could `cur` continue `prev`?
 * True for a soft-wrap continuation, or when `prev` is written through its last
 * column and `cur` starts with a URL-plausible character (a TUI re-wrapping its
 * content with real newlines). detectRowLinks additionally requires the group
 * to end in an open URL before it actually joins across such a break.
 */
export function mayContinuePreviousRow(prev: DetectRow, cur: DetectRow): boolean {
  return cur.isWrapped || (prev.fillsLastColumn && URL_CONTINUATION_START.test(cur.text));
}

/**
 * True when `text` ends in a URL that runs through its final character.
 * Conservative on purpose: a URL whose last character is sentence punctuation
 * (`.`, `,`, `)` ...) is NOT treated as open, so a URL hard-broken right after
 * such a character stays un-joined (a truncated href). The shape "sentence ends
 * with a URL at the exact last column, next line is prose" is the false-positive
 * case, and a wrong joined href is worse than a truncated one.
 */
function endsInOpenUrl(text: string): boolean {
  let last: RegExpMatchArray | undefined;
  for (const match of text.matchAll(URL_RE)) last = match;
  if (!last) return false;
  const end = (last.index ?? 0) + last[0].length;
  return end === text.length && !TRAILING_PUNCTUATION.has(text[end - 1]);
}

/**
 * Detect http(s) links across rows. Rows whose followers have `isWrapped ===
 * true` form one logical line, and so do rows split by an application-authored
 * break at the edge of the row when the text so far ends in an open URL
 * (`mayContinuePreviousRow` + `endsInOpenUrl`). Their text is joined, matched
 * once, and each match is mapped back to per-row `[start, end)` column ranges.
 * Joining is for detection only; copy keeps the newline.
 *
 * @returns Map of row key -> its link column ranges (only rows with links appear).
 */
export function detectRowLinks(rows: DetectRow[]): Map<number, LinkRange[]> {
  const result = new Map<number, LinkRange[]>();
  let i = 0;
  while (i < rows.length) {
    let j = i + 1;
    let text = rows[i].text;
    while (j < rows.length) {
      const cur = rows[j];
      if (!cur.isWrapped && !(mayContinuePreviousRow(rows[j - 1], cur) && endsInOpenUrl(text))) break;
      text += cur.text;
      j++;
    }
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
