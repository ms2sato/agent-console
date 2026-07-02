/**
 * Copy-text assembly. Terminals join soft-wrapped rows into one logical line on
 * copy (a wrapped URL/command copies as a single line), while hard line breaks
 * stay as newlines. `joinSelectedRows` is the pure join rule; `collectSelectedRowPieces`
 * slices the live selection per row (DOM, but Range-only — no React).
 */

export interface CopyRow {
  text: string; // the row's selected text (already sliced to the selection edges)
  isWrapped: boolean; // true = this row is a soft-wrap continuation of the previous
}

/**
 * Join per-row selected text into clipboard text. A row that is a soft-wrap
 * continuation (`isWrapped`) is appended to the previous row with no separator;
 * a hard row starts a new line.
 */
export function joinSelectedRows(rows: CopyRow[]): string {
  if (rows.length === 0) return '';
  let out = rows[0].text;
  for (let i = 1; i < rows.length; i++) {
    out += (rows[i].isWrapped ? '' : '\n') + rows[i].text;
  }
  return out;
}

/**
 * Slice a selection into per-row pieces. For each child row of `container` that
 * the selection touches, intersect the selection with that row and take its
 * exact selected text (so partial first/last-row edges are preserved). Rows are
 * matched to `rowIsWrapped(index)` by their child index (1:1 with the buffer).
 */
export function collectSelectedRowPieces(
  container: Element,
  selRange: Range,
  rowIsWrapped: (index: number) => boolean,
): CopyRow[] {
  const children = Array.from(container.children);
  const pieces: CopyRow[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!selRange.intersectsNode(child)) continue;
    const rowRange = document.createRange();
    rowRange.selectNodeContents(child);
    // Clamp to the intersection of the selection and this row.
    if (selRange.compareBoundaryPoints(Range.START_TO_START, rowRange) > 0) {
      rowRange.setStart(selRange.startContainer, selRange.startOffset);
    }
    if (selRange.compareBoundaryPoints(Range.END_TO_END, rowRange) < 0) {
      rowRange.setEnd(selRange.endContainer, selRange.endOffset);
    }
    pieces.push({ text: rowRange.toString(), isWrapped: rowIsWrapped(i) });
  }
  return pieces;
}
