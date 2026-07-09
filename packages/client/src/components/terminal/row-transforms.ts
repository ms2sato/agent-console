import type { TerminalSegment } from './buffer-to-rows';
import type { LinkRange } from './link-detection';

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

export type SegmentDecorator = (segments: TerminalSegment[], ctx: TransformContext) => TerminalSegment[];

/** Run each decorator in order, threading the output of one into the next. */
export function applySegmentDecorators(
  segments: TerminalSegment[],
  decorators: readonly SegmentDecorator[],
  ctx: TransformContext,
): TerminalSegment[] {
  let result = segments;
  for (const decorate of decorators) {
    result = decorate(result, ctx);
  }
  return result;
}

/**
 * Second, parallel transform lane: link transforms.
 *
 * URL links are detected separately from segments (link-detection.ts stores
 * `LinkRange[]` on each row) and do NOT flow through the SegmentDecorator lane.
 * A link transform post-processes those detected links — e.g. rewriting a
 * localhost href to the user-accessible host so a remote browser can click it.
 * It MUST preserve range offsets (`[start, end)` stay aligned to the row text);
 * only `href` / `title` may change, so the view's column-offset math is
 * unaffected.
 */
export type LinkTransform = (links: LinkRange[], ctx: TransformContext) => LinkRange[];

/** Run each link transform in order, threading the output of one into the next. */
export function applyLinkTransforms(
  links: LinkRange[],
  transforms: readonly LinkTransform[],
  ctx: TransformContext,
): LinkRange[] {
  let result = links;
  for (const transform of transforms) {
    result = transform(result, ctx);
  }
  return result;
}
