import type { PocSegment } from './buffer-to-rows';

/**
 * Row-transform pipeline (issue #958), first stage: segment decorators.
 *
 * A segment decorator is a pure function that rewrites a row's segment list —
 * typically splitting a segment to attach a `link` to part of its text (e.g.
 * linkifying `#123`). This is the THIN stage: it only reshapes segments within a
 * single row. Range-claiming transforms (fold/accordion, rich blocks) that span
 * multiple rows are a separate, later stage and are NOT modeled here.
 *
 * Decorators run in the presentation layer (inside the memoized row renderer),
 * never in the store — the store stays renderer-agnostic.
 */

export interface TransformContext {
  /** `owner/repo` for the session's GitHub repo, or null when unknown (e.g. quick sessions). */
  repoFullName: string | null;
}

export type SegmentDecorator = (segments: PocSegment[], ctx: TransformContext) => PocSegment[];

/** Run each decorator in order, threading the output of one into the next. */
export function applySegmentDecorators(
  segments: PocSegment[],
  decorators: readonly SegmentDecorator[],
  ctx: TransformContext,
): PocSegment[] {
  let result = segments;
  for (const decorate of decorators) {
    result = decorate(result, ctx);
  }
  return result;
}
