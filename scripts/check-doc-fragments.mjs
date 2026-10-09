#!/usr/bin/env node

/**
 * Dangling Markdown link-fragment checker.
 *
 * Validates every `](#frag)` (same-file) and `](relative.md#frag)`
 * (cross-file) Markdown link against the heading-anchor set the target
 * file actually generates, using GitHub's heading-slug rule:
 *
 *   - lowercase
 *   - strip every character that is not a letter, digit, space, `-`, or `_`
 *   - each space becomes a `-` (not collapsed)
 *   - a slug that repeats within the same file gets a `-1`, `-2`, ...
 *     suffix on the 2nd, 3rd, ... occurrence
 *
 * Markdown link syntax inside a heading (`## See [Foo](bar.md)`) contributes
 * its link TEXT to the slug, not the destination. `<a id="x">` / `<a
 * name="x">` tags anywhere in the body are also valid anchors, used
 * literally (no slugification). Fenced code blocks (``` or ~~~) and
 * single-backtick inline code spans are excluded from link and
 * anchor-tag scanning, so an example showing literal link syntax inside
 * a fence or inline code is never treated as a real link.
 *
 * Scope: every `.md` file under `docs/`, `.claude/`, and the top-level
 * `CLAUDE.md` is scanned as a SOURCE (its links are validated). A
 * cross-file link's TARGET is read directly off disk wherever it points
 * (it need not be inside one of the scanned roots) -- this is what lets a
 * doc under `docs/` link into `.claude/rules/*.md` and vice versa without
 * the checker treating that as out of scope.
 *
 * Exit codes:
 *   0 = no dangling fragments
 *   1 = at least one dangling fragment found (printed, one per line)
 *   2 = a target file could not be read for a reason OTHER than "it does
 *       not exist" (e.g. a permission error). A missing `.md` target is
 *       NOT this case -- it is reported as an ordinary miss under exit 1,
 *       because a link to a file that was never created is itself a
 *       dangling link.
 *
 * Usage:
 *   node scripts/check-doc-fragments.mjs
 */

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const DEFAULT_ROOTS = ['docs', '.claude', 'CLAUDE.md'];

/** Thrown when a target file exists-check needs to fail loudly rather than be reported as a miss. */
export class UnreadableTargetError extends Error {
  constructor(filePath, cause) {
    super(`Unreadable target file: ${filePath} (${cause?.message ?? cause})`);
    this.name = 'UnreadableTargetError';
    this.filePath = filePath;
    this.cause = cause;
  }
}

// --- Pure helpers (heading parsing, slugification, link extraction) ---

/**
 * Replace Markdown link syntax inside heading text with its link text,
 * so `## See [Foo](bar.md)` is slugified as if it read `## See Foo`.
 * Reference-style links (`[Foo][ref]`) are handled the same way.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripHeadingMarkup(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
}

/**
 * GitHub heading-slug rule, applied to a single heading's raw text.
 * Pure function, no duplicate-suffix handling (that is per-file, see
 * extractHeadingAnchors) -- this only produces the BASE slug.
 *
 * @param {string} headingText
 * @returns {string}
 */
export function slugifyHeading(headingText) {
  const plain = stripHeadingMarkup(headingText).trim();
  const lower = plain.toLowerCase();
  const stripped = lower.replace(/[^\p{L}\p{N} _-]/gu, '');
  return stripped.replace(/ /g, '-');
}

/**
 * Compute, per line index, whether that line is inside (or is itself a
 * delimiter of) a fenced code block (``` or ~~~, >=3 repeats, up to 3
 * leading spaces, closing fence must use the same character and be at
 * least as long as the opening one -- CommonMark's rule).
 *
 * @param {string[]} lines
 * @returns {boolean[]}
 */
export function computeFenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) {
      mask[i] = true;
      if (m && m[1][0] === fence.char && m[1].length >= fence.len) {
        fence = null;
      }
      continue;
    }
    if (m) {
      fence = { char: m[1][0], len: m[1].length };
      mask[i] = true;
      continue;
    }
  }
  return mask;
}

/**
 * Replace every single-backtick inline code span (`` `...` ``) on a line
 * with a same-length run of a non-matching filler character. This keeps a
 * literal link/anchor-tag EXAMPLE written as inline code (e.g. `` `](#frag)` ``
 * in prose explaining this very checker) from being scanned as a real
 * link or anchor -- the same "quoted syntax is not a real instance"
 * concern fenced blocks are skipped for, one level down. Does not affect
 * heading slugification, which already drops backticks as punctuation.
 * Triple-backtick-or-more fences are handled separately by computeFenceMask
 * and are not re-processed here.
 *
 * @param {string} line
 * @returns {string}
 */
export function maskInlineCode(line) {
  return line.replace(/`[^`\n]*`/g, (span) => '\u0000'.repeat(span.length));
}

/**
 * Extract the set of heading-derived anchors for a file's content, in
 * document order, applying the duplicate-slug `-1`, `-2`, ... suffix rule.
 * Fenced code blocks are skipped entirely.
 *
 * @param {string} content
 * @returns {Set<string>}
 */
export function extractHeadingAnchors(content) {
  const lines = content.split('\n');
  const fenceMask = computeFenceMask(lines);
  const anchors = new Set();
  const counts = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (fenceMask[i]) continue;
    const m = /^#{1,6}\s+(.+)$/.exec(lines[i]);
    if (!m) continue;
    // Optional closing ATX hashes: "## Title ##" -> "Title"
    const headingText = m[1].trim().replace(/\s+#+\s*$/, '');
    const base = slugifyHeading(headingText);
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

/**
 * Extract literal `<a id="x">` / `<a name="x">` anchor ids from a file's
 * content (not slugified -- used verbatim). Fenced code blocks and
 * inline code spans are skipped.
 *
 * @param {string} content
 * @returns {Set<string>}
 */
export function extractAnchorTagIds(content) {
  const lines = content.split('\n');
  const fenceMask = computeFenceMask(lines);
  const ids = new Set();
  const re = /<a\s[^>]*\b(?:id|name)=["']([^"']+)["']/gi;
  for (let i = 0; i < lines.length; i++) {
    if (fenceMask[i]) continue;
    const line = maskInlineCode(lines[i]);
    let m;
    const lineRe = new RegExp(re.source, re.flags);
    while ((m = lineRe.exec(line)) !== null) {
      ids.add(m[1]);
    }
  }
  return ids;
}

/**
 * Full anchor set a file generates: headings (slugified, duplicate-suffixed)
 * plus literal `<a id>`/`<a name>` tags.
 *
 * @param {string} content
 * @returns {Set<string>}
 */
export function buildAnchorSet(content) {
  const anchors = extractHeadingAnchors(content);
  for (const id of extractAnchorTagIds(content)) anchors.add(id);
  return anchors;
}

/**
 * Extract every `](#frag)` / `](path#frag)` link from a file's content,
 * skipping fenced code blocks, inline code spans, and external
 * (`scheme://`) URLs. A link with no `#` in its destination is out of
 * scope (nothing to validate).
 *
 * @param {string} content
 * @returns {Array<{line: number, frag: string, pathPart: string}>}
 */
export function extractFragmentLinks(content) {
  const lines = content.split('\n');
  const fenceMask = computeFenceMask(lines);
  const links = [];
  const re = /\]\(([^)]*)\)/g;
  for (let i = 0; i < lines.length; i++) {
    if (fenceMask[i]) continue;
    const line = maskInlineCode(lines[i]);
    let m;
    const lineRe = new RegExp(re.source, re.flags);
    while ((m = lineRe.exec(line)) !== null) {
      const raw = m[1].trim();
      // Drop an optional trailing "title" (](url "title")).
      const dest = raw.split(/\s+/)[0] ?? '';
      if (dest === '') continue;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(dest)) continue; // external scheme (http:, mailto:, ...)
      const hashIdx = dest.indexOf('#');
      if (hashIdx === -1) continue; // no fragment: out of scope
      const pathPart = dest.slice(0, hashIdx);
      const frag = dest.slice(hashIdx + 1);
      links.push({ line: i + 1, frag, pathPart });
    }
  }
  return links;
}

// --- Filesystem traversal + resolution ---

/**
 * Recursively collect every `.md` file under `root` (a directory), or
 * `root` itself if it is already a `.md` file. Skips `.git` and
 * `node_modules` defensively.
 *
 * @param {string} rootAbsPath
 * @returns {string[]} absolute file paths
 */
function collectMarkdownFiles(rootAbsPath) {
  let stat;
  try {
    stat = statSync(rootAbsPath);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    return rootAbsPath.endsWith('.md') ? [rootAbsPath] : [];
  }
  if (!stat.isDirectory()) return [];

  const results = [];
  const stack = [rootAbsPath];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
  }
  return results;
}

/**
 * Resolve a cross-file link's `pathPart` to an absolute path.
 *
 * @param {string} pathPart
 * @param {string} sourceAbsPath
 * @param {string} cwd
 * @returns {string}
 */
function resolveTargetPath(pathPart, sourceAbsPath, cwd) {
  if (pathPart.startsWith('/')) return resolve(cwd, '.' + pathPart);
  return resolve(dirname(sourceAbsPath), pathPart);
}

/**
 * Lazily read a file and compute its anchor set, memoized. Returns
 * `{ exists: false }` for a missing file. Throws UnreadableTargetError for
 * any other read failure.
 *
 * @param {string} absPath
 * @param {Map<string, {exists: boolean, content?: string, anchors?: Set<string>}>} cache
 * @returns {{exists: boolean, content?: string, anchors?: Set<string>}}
 */
function getFileRecord(absPath, cache) {
  const cached = cache.get(absPath);
  if (cached) return cached;

  let content;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const record = { exists: false };
      cache.set(absPath, record);
      return record;
    }
    throw new UnreadableTargetError(absPath, err);
  }
  const record = { exists: true, content, anchors: buildAnchorSet(content) };
  cache.set(absPath, record);
  return record;
}

/**
 * Run the full fragment check.
 *
 * @param {string|string[]} roots repo-relative (or absolute) root paths;
 *   each is either a directory (scanned recursively for `.md` files) or a
 *   single `.md` file
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {{misses: Array<{file: string, line: number, frag: string, target: string, reason: 'missing-file'|'no-anchor'}>, filesScanned: number}}
 */
export function checkDocFragments(roots, { cwd = process.cwd() } = {}) {
  const rootList = Array.isArray(roots) ? roots : [roots];
  const sourceFiles = new Set();
  for (const root of rootList) {
    const abs = resolve(cwd, root);
    for (const f of collectMarkdownFiles(abs)) sourceFiles.add(f);
  }
  const sortedSources = [...sourceFiles].sort();

  const cache = new Map();
  const misses = [];

  for (const sourceAbsPath of sortedSources) {
    const sourceRecord = getFileRecord(sourceAbsPath, cache);
    if (!sourceRecord.exists) continue; // should not happen: we just listed it from disk
    const sourceRel = relative(cwd, sourceAbsPath);

    for (const link of extractFragmentLinks(sourceRecord.content)) {
      let targetAbsPath;
      if (link.pathPart === '') {
        targetAbsPath = sourceAbsPath;
      } else if (link.pathPart.toLowerCase().endsWith('.md')) {
        targetAbsPath = resolveTargetPath(link.pathPart, sourceAbsPath, cwd);
      } else {
        continue; // cross-reference into a non-markdown file: out of scope
      }

      const targetRel = relative(cwd, targetAbsPath);
      const targetRecord = getFileRecord(targetAbsPath, cache);
      if (!targetRecord.exists) {
        misses.push({
          file: sourceRel,
          line: link.line,
          frag: link.frag,
          target: targetRel,
          reason: 'missing-file',
        });
        continue;
      }
      if (!targetRecord.anchors.has(link.frag)) {
        misses.push({
          file: sourceRel,
          line: link.line,
          frag: link.frag,
          target: targetRel,
          reason: 'no-anchor',
        });
      }
    }
  }

  return { misses, filesScanned: sortedSources.length };
}

// --- CLI ---

/**
 * @param {{file: string, line: number, frag: string, target: string, reason: string}} miss
 * @returns {string}
 */
function formatMiss(miss) {
  const suffix =
    miss.reason === 'missing-file'
      ? `target file not found: ${miss.target}`
      : `no such anchor in ${miss.target}`;
  return `${miss.file}:${miss.line}  #${miss.frag} -> ${suffix}`;
}

function main() {
  let result;
  try {
    result = checkDocFragments(DEFAULT_ROOTS, { cwd: REPO_ROOT });
  } catch (err) {
    if (err instanceof UnreadableTargetError) {
      console.error(`FAIL — ${err.message}`);
      return 2;
    }
    throw err;
  }

  if (result.misses.length === 0) {
    console.log(`OK — doc fragment check clean (${result.filesScanned} file(s) scanned).`);
    return 0;
  }

  for (const miss of result.misses) console.log(formatMiss(miss));
  console.error('');
  console.error(
    `FAIL — ${result.misses.length} dangling fragment${result.misses.length === 1 ? '' : 's'} found.`,
  );
  return 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-doc-fragments.mjs');
if (isMain) {
  process.exitCode = main();
}
