import type { TerminalSegment, TerminalStyle } from '../buffer-to-rows';
import type { SegmentDecorator, TransformContext } from '../row-transforms';

/**
 * Linkify GitHub issue/PR references in terminal output (issue #958, first
 * row-transform plugin).
 *
 * Matches a bare `#123` or a cross-repo `owner/repo#123`. Guards against common
 * false positives:
 *  - `(?<![\w&#])` — not preceded by a word char, `&` (HTML numeric entity
 *    `&#123;`) or `#`.
 *  - `\d{1,7}` — numbers only, length-capped (a long digit run never matches
 *    because the trailing `\b` cannot fall inside it).
 *  - Hex-color heuristic: a BARE `#` followed by exactly 6 digits (`#123456`) is
 *    treated as a likely `#RRGGBB` color and left un-linked. Cross-repo refs
 *    (`owner/repo#123456`) are unambiguous and always linked. `#RGB`-style
 *    3-digit refs are common real issue numbers, so they are NOT excluded.
 *
 * href is always the `/issues/N` form; GitHub auto-redirects to `/pull/N` for
 * PRs, so one URL shape covers both.
 */
const GITHUB_REF_RE = /(?<![\w&#])(?:([\w.-]+\/[\w.-]+))?#(\d{1,7})\b/g;

const HEX_COLOR_DIGIT_LENGTH = 6;

function resolveHref(repo: string | undefined, num: string, ctx: TransformContext): string | null {
  if (!repo && num.length === HEX_COLOR_DIGIT_LENGTH) {
    // Bare `#123456`: ambiguous with a hex color — do not link.
    return null;
  }
  const target = repo ?? ctx.repoFullName;
  if (!target) return null; // bare ref with no repo context (e.g. quick session)
  return `https://github.com/${target}/issues/${num}`;
}

/**
 * Split one segment's text into link / non-link pieces. Returns null when there
 * is nothing to linkify, so the caller can keep the original segment as-is.
 */
function decorateSegmentText(
  text: string,
  style: TerminalStyle | null,
  ctx: TransformContext,
): TerminalSegment[] | null {
  GITHUB_REF_RE.lastIndex = 0;
  const pieces: TerminalSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GITHUB_REF_RE.exec(text)) !== null) {
    const [full, repo, num] = match;
    const href = resolveHref(repo, num, ctx);
    if (href === null) continue; // matched but not linkable — leave in the text
    if (match.index > lastIndex) {
      pieces.push({ text: text.slice(lastIndex, match.index), style });
    }
    pieces.push({ text: full, style, link: { href } });
    lastIndex = match.index + full.length;
  }
  if (pieces.length === 0) return null;
  if (lastIndex < text.length) {
    pieces.push({ text: text.slice(lastIndex), style });
  }
  return pieces;
}

export const githubRefDecorator: SegmentDecorator = (segments, ctx) => {
  const out: TerminalSegment[] = [];
  for (const seg of segments) {
    // Do not re-decorate a segment that already carries a link.
    if (seg.link) {
      out.push(seg);
      continue;
    }
    const pieces = decorateSegmentText(seg.text, seg.style, ctx);
    if (pieces) out.push(...pieces);
    else out.push(seg);
  }
  return out;
};
