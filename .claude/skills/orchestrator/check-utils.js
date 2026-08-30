/**
 * Shared utilities for preflight-check.js and acceptance-check.js
 *
 * Contains file categorization, test coverage detection, integration test
 * analysis, and package boundary analysis.
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// --- Utility functions ---

export function exec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

export function getChangedFiles(prNumber) {
  const result = exec(`gh pr diff ${prNumber} --name-only`);
  if (result === null) {
    console.error(`Error: Could not retrieve diff for PR #${prNumber}. Please verify the gh command and PR number.`);
    process.exit(1);
  }
  return result.split('\n').filter(Boolean);
}

export function getLocalChangedFiles() {
  // Use gh pr diff equivalent for local mode to ensure parity with CI mode.
  // gh pr diff compares against the target branch, which is typically 'main'.
  // The equivalent git command is: git diff --name-only origin/main...HEAD
  // This ensures both local and CI modes produce the same file list.
  const baseBranch = process.env.BASE_BRANCH || 'origin/main';
  const result = exec(`git diff --name-only ${baseBranch}...HEAD`);
  if (result === null) {
    console.error(`Error: Could not retrieve local git diff against ${baseBranch}.`);
    process.exit(1);
  }
  return result.split('\n').filter(Boolean);
}

// --- File categorization ---

export function categorizeFile(filePath) {
  if (filePath.startsWith('packages/integration/')) {
    return 'integration';
  }
  if (filePath.includes('.test.') || filePath.includes('.spec.') || filePath.includes('__tests__/')) {
    return 'test';
  }
  if (filePath.startsWith('packages/client/')) {
    return 'client';
  }
  if (filePath.startsWith('packages/server/')) {
    return 'server';
  }
  if (filePath.startsWith('packages/shared/')) {
    return 'shared';
  }
  return 'other';
}

export function categorizeFiles(files) {
  const categories = { client: [], server: [], shared: [], integration: [], test: [], other: [] };
  for (const file of files) {
    const category = categorizeFile(file);
    categories[category].push(file);
  }
  return categories;
}

// --- Test file detection ---

// Patterns that require test coverage (production code only)
export const COVERAGE_PATTERNS = [
  /^packages\/server\/src\/routes\/.+\.ts$/,
  /^packages\/server\/src\/services\/.+\.ts$/,
  /^packages\/server\/src\/mcp\/.+\.ts$/,
  /^packages\/server\/src\/lib\/.+\.ts$/,
  /^packages\/client\/src\/hooks\/.+\.ts$/,
  /^packages\/client\/src\/components\/.+\.tsx$/,
  /^packages\/shared\/src\/.+\.ts$/,
  /^packages\/embedded-agent\/src\/.+\.ts$/,
  /^\.claude\/hooks\/.+\.sh$/,
];

// Source-file extensions considered for coverage analysis. `.sh` is included
// because `.claude/hooks/**/*.sh` participates in COVERAGE_PATTERNS; the
// matching test extension is `.mjs` (see expectedTestExt below).
const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|sh)$/;

// Test-file naming pattern. `.mjs` is recognised so hook tests
// (e.g. `enforce-permissions.test.mjs`) are matched against their
// `.sh` source.
const TEST_NAME_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/;

function expectedTestExt(sourceExt) {
  if (sourceExt === '.tsx') return '.tsx';
  if (sourceExt === '.sh') return '.mjs';
  return '.ts';
}

// Alternate extension accepted as sibling coverage alongside the primary
// suggestion above. `.tsx` sources may have a JSX-free pure-logic test
// that naturally lives as `.ts` (no runtime need for the JSX-enabling
// extension) — sibling matching below already accepts any test extension
// via basename comparison, so this only affects the *suggested* path shown
// for missing coverage (see Issue #1049). No alternate is offered for
// other source extensions; the reverse (a `.ts` source suggesting a `.tsx`
// alternate) is not a real-world case and is out of scope.
function alternateTestExt(sourceExt) {
  return sourceExt === '.tsx' ? '.ts' : null;
}

// Files excluded from coverage requirements (no runtime logic to test)
const COVERAGE_EXCLUSIONS = [
  /^packages\/shared\/src\/types\/.+\.ts$/,
  // *-types.ts / *-types.tsx convention: files containing only type
  // definitions (interfaces / type aliases) with no runtime logic.
  // Testing them is not meaningful — the type system already enforces
  // their shape at consume sites.
  /-types\.tsx?$/,
  // *.gen.ts / *.gen.tsx convention: build-time generated files
  // (e.g. schema-version.gen.ts from a codegen step). Their contents
  // are derived from an authoritative source at build time; a hand-
  // written sibling test would be tautological — the generator is
  // what needs testing, not the emitted output.
  /\.gen\.tsx?$/,
  // Bare `types.ts` / `types.tsx` (as a full path segment) convention:
  // module-level type-definitions-only file colocated with its
  // consumers (natural in React / Node.js codebases where each feature
  // directory may own a `types.ts` alongside its runtime modules).
  // Same rationale as `-types.tsx?$` above — the type system enforces
  // shape at consume sites, so a runtime test would be tautological.
  // Anchored on the segment boundary so files like `mytypes.ts` or
  // `custom-types.ts` (which is already covered by the -types pattern)
  // are not double-matched here, and files like `type.ts` (singular)
  // are NOT excluded — they may contain runtime enums / factories.
  /(?:^|\/)types\.tsx?$/,
];

export function isTestFile(filePath) {
  return filePath.includes('.test.') || filePath.includes('.spec.') || filePath.includes('__tests__/');
}

/**
 * Check whether a file's content consists only of re-export statements.
 * Pure function — operates on the content string, no filesystem access.
 *
 * Re-export-only files (e.g., `packages/shared/src/index.ts` that only
 * `export * from './foo'`) have no runtime logic to test. Their sibling
 * test would be tautological (PR #694 added one only to silence the
 * coverage rule). This helper detects that pattern so the rule can skip.
 *
 * Recognises:
 *   export * from '...';
 *   export * as Name from '...';
 *   export { A, B } from '...';
 *   export type { A } from '...';
 *   export type * from '...';
 *
 * Block comments and line comments are stripped before matching. Empty
 * files return false (not re-export-only — they need real coverage).
 */
export function isReExportOnlyContent(content) {
  // Strip block comments (/* ... */, including JSDoc), then line comments (// ...).
  const noBlockComments = content.replace(/\/\*[\s\S]*?\*\//g, '');
  const noLineComments = noBlockComments.replace(/\/\/[^\n]*/g, '');

  const trimmed = noLineComments.trim();
  if (trimmed.length === 0) return false;

  // Split into statements on `;`, normalising whitespace so multi-line exports collapse.
  const statements = trimmed
    .split(';')
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => s.length > 0);

  // Each statement must be `export [type] (* [as Name] | { ... }) from '...'`.
  const reExportPattern = /^export\s+(type\s+)?(\*(\s+as\s+\w+)?|\{[^{}]*\})\s+from\s+['"][^'"]+['"]$/;

  return statements.every(stmt => reExportPattern.test(stmt));
}

/**
 * Filesystem wrapper around `isReExportOnlyContent`.
 * Returns false on read errors so an unreadable file falls through to the
 * normal coverage rule (safer default — surface the gap rather than hide it).
 */
export function isReExportOnlyFile(filePath) {
  if (!existsSync(filePath)) return false;
  try {
    const content = readFileSync(filePath, 'utf-8');
    return isReExportOnlyContent(content);
  } catch {
    return false;
  }
}

export function requiresTestCoverage(filePath) {
  if (isTestFile(filePath)) return false;
  if (COVERAGE_EXCLUSIONS.some(pattern => pattern.test(filePath))) return false;
  if (!COVERAGE_PATTERNS.some(pattern => pattern.test(filePath))) return false;
  // Skip re-export-only files: their sibling test would be tautological
  // (the type system already enforces re-export shape at consume sites).
  if (isReExportOnlyFile(filePath)) return false;
  return true;
}

// --- Comment-only diff detection ---

// Language comment syntax by extension. Extensions not listed here default
// to "not comment-only" (opt-in later per file type, per Issue #1189
// non-goals) rather than guessing at an unfamiliar comment syntax.
const LINE_COMMENT_PREFIX_BY_EXT = {
  '.ts': '//',
  '.tsx': '//',
  '.js': '//',
  '.jsx': '//',
  '.mjs': '//',
  '.cjs': '//',
  '.sh': '#',
};

// Extensions whose language also supports C-style block comments (/* ... */
// and JSDoc-style `*`-prefixed continuation lines).
const BLOCK_COMMENT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function fileExtension(filePath) {
  const match = filePath.match(/\.[a-zA-Z0-9]+$/);
  return match ? match[0] : '';
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Scan a file's FULL content top-to-bottom and return, for each 1-based
 * line number, whether that line begins already inside an unterminated
 * block comment opened on an earlier line. This mirrors (rather than
 * reuses — the two operate on different structures: a flat line array vs.
 * diff hunks) the block-open/close judgment `isCommentOnlyDiff` applies
 * within a hunk, so a `--unified=0` hunk that edits only the BODY of an
 * existing block comment (whose `/**`/`/*` opener sits outside the hunk,
 * in unchanged context) can still be seeded with the correct starting
 * state instead of unconditionally starting "not in a block".
 *
 * Deliberately simple: does NOT account for `/*` or `//` appearing inside
 * string/glob/regex literals (e.g. `glob('packages/server/src/*')` reads
 * as an unterminated block-comment opener to this scanner). This function
 * can therefore return a FALSE "starts inside a block" for a line that is
 * actually real code — it is not safe to trust on its own. What makes the
 * overall result safe is NOT this function's own conservatism (it has
 * none); it is that `isCommentOnlyDiff` treats a seed produced here as
 * only conditionally trusted, and additionally requires the specific
 * changed line to have block-comment-body shape (see its "seed-derived
 * ... only conditionally trusted" note) before accepting it as comment
 * content. A phantom seed whose lines don't have that shape is rejected
 * there, not here.
 *
 * Returns `[]` for extensions with no block-comment syntax.
 */
function scanBlockCommentLineStarts(content, ext) {
  if (!BLOCK_COMMENT_EXTS.has(ext)) return [];

  const startsInBlock = [];
  let inBlock = false;

  for (const rawLine of content.split('\n')) {
    startsInBlock.push(inBlock);
    if (inBlock) {
      const closeIdx = rawLine.indexOf('*/');
      if (closeIdx === -1) continue; // whole line stays inside the block
      inBlock = false;
      continue; // ignore anything after the close for re-open purposes,
      // consistent with the per-hunk logic never handling a second block
      // comment starting later on the same physical line
    }

    const lineCommentIdx = rawLine.indexOf('//');
    const openIdx = rawLine.indexOf('/*');
    if (openIdx === -1) continue;
    if (lineCommentIdx !== -1 && lineCommentIdx < openIdx) continue; // `//` shadows a later `/*`

    const closeIdx = rawLine.indexOf('*/', openIdx + 2);
    if (closeIdx === -1) inBlock = true; // opened, not closed on this line
    // else: opened and closed on the same line, state unchanged (false)
  }

  return startsInBlock; // startsInBlock[i] === true means line (i+1) starts inside an open block
}

/**
 * Determine whether a unified diff (as produced by `git diff --unified=0`)
 * for a single file consists entirely of comment and/or blank line changes,
 * for the given file's language.
 *
 * Block-comment state is tracked per side (added `+` vs removed `-` are two
 * different file versions) and resets at each hunk boundary (`@@ ... @@`).
 * `--unified=0` hunks carry no surrounding context, so when a hunk edits
 * only the BODY of an existing block comment, the `/*` opener line sits
 * outside the hunk. When `opts.baseContent` / `opts.headContent` (the
 * full file content on each side) is supplied, the per-side starting
 * state is seeded from `scanBlockCommentLineStarts` (see that function)
 * using the hunk header's line numbers, so this case is recognised
 * correctly (Issue #1394).
 *
 * Seed-derived vs. in-hunk-confirmed trust are NOT equivalent, and this
 * function does not treat them as equivalent. `scanBlockCommentLineStarts`
 * can produce a false "inside a block" seed (it does not distinguish a
 * `/*` inside a string/glob/regex literal from a real comment opener), so
 * while `inBlock` is true FROM A SEED, each changed line must additionally
 * look like block-comment-body shape (starts with `*`, or is the line that
 * closes the block) before being accepted as comment content; a line that
 * fails that shape check drops the (apparently phantom) block state and is
 * re-evaluated under the normal rules below, same as if no seed had ever
 * applied. Once a `/*` opener is directly observed within the hunk's own
 * diff text (not inferred from the file-content scan), the state it
 * establishes is fully trusted for the rest of the hunk — no shape check —
 * matching this function's behavior before content-seeding existed.
 *
 * (Follow-up candidate, not done here: `scanBlockCommentLineStarts`'s
 * open/close transition logic and this function's in-hunk equivalent are
 * two named, hand-verified implementations of the same judgment rather
 * than a shared helper — acceptable as-is, but a future PR could extract
 * the transition into one function both call.)
 *
 * When content is not supplied — or a specific line's state cannot
 * otherwise be confirmed — an unconfirmed line is still treated as
 * non-comment: the safe, fail-closed default. The worst case is a
 * comment-only file still being required to have a sibling test, never
 * the reverse. For the same reason, a block-comment close marker followed
 * by non-whitespace on the same line is treated as real code, not a
 * comment-only close.
 *
 * File-level diff metadata (`diff --git`, `index`, `--- a/file`,
 * `+++ b/file`) is only ever skipped while it appears BEFORE the first
 * `@@` hunk marker — content lines after that point are always parsed,
 * even when they happen to start with `+++`/`---` (e.g. a changed
 * `++counter;` / `--counter;` expression renders as `+++counter;` /
 * `---counter;`).
 *
 * For `.sh` files, a changed shebang line (`#!...`) is never exempted even
 * though it starts with `#` — changing the interpreter is a behavioral
 * change, not a comment edit.
 *
 * Returns false (not comment-only) for files with no changed lines and for
 * extensions with no known comment syntax.
 *
 * @param {string} diffText
 * @param {string} filePath
 * @param {{ baseContent?: string | null, headContent?: string | null }} [opts]
 *   Full file content on each side of the diff (base = pre-image, head =
 *   post-image), used only to seed block-comment state at each hunk's
 *   start. Omit (or pass null) when unavailable — the function still
 *   works, just without the outside-the-hunk-opener recognition.
 */
export function isCommentOnlyDiff(diffText, filePath, opts = {}) {
  const { baseContent = null, headContent = null } = opts;
  const ext = fileExtension(filePath);
  const lineCommentPrefix = LINE_COMMENT_PREFIX_BY_EXT[ext];
  if (!lineCommentPrefix) return false;

  const supportsBlockComments = BLOCK_COMMENT_EXTS.has(ext);
  const addedBlockStarts = supportsBlockComments && headContent !== null ? scanBlockCommentLineStarts(headContent, ext) : null;
  const removedBlockStarts = supportsBlockComments && baseContent !== null ? scanBlockCommentLineStarts(baseContent, ext) : null;

  let insideHunk = false;
  let inBlockAdded = false;
  let inBlockRemoved = false;
  // Whether the CURRENT inBlock* = true state was established by actually
  // observing a `/*` opener line within this hunk's own diff text (fully
  // trusted, matches pre-#1394 behavior exactly), as opposed to being
  // seeded from scanBlockCommentLineStarts's file-content scan (which does
  // not distinguish a `/*` inside a string literal from a real comment
  // opener, and therefore is only conditionally trusted — see below).
  let addedBlockConfirmed = false;
  let removedBlockConfirmed = false;
  let sawChangedLine = false;

  for (const rawLine of diffText.split('\n')) {
    if (rawLine.startsWith('@@')) {
      insideHunk = true;
      const headerMatch = rawLine.match(HUNK_HEADER_RE);
      const oldStart = headerMatch ? parseInt(headerMatch[1], 10) : null;
      const newStart = headerMatch ? parseInt(headerMatch[2], 10) : null;
      inBlockAdded = !!(addedBlockStarts && newStart !== null && addedBlockStarts[newStart - 1]);
      inBlockRemoved = !!(removedBlockStarts && oldStart !== null && removedBlockStarts[oldStart - 1]);
      // A hunk boundary is always seed-or-nothing — an in-hunk-confirmed
      // opener can only be observed AFTER this point, within the hunk.
      addedBlockConfirmed = false;
      removedBlockConfirmed = false;
      continue;
    }
    // Lines before the first hunk marker are file-level diff metadata, not
    // content — skip them here rather than via a `+++`/`---` prefix check,
    // which would also (wrongly) swallow a changed `++x;` / `--x;` line.
    if (!insideHunk) continue;

    let sign;
    let content;
    if (rawLine.startsWith('+')) {
      sign = '+';
      content = rawLine.slice(1);
    } else if (rawLine.startsWith('-')) {
      sign = '-';
      content = rawLine.slice(1);
    } else {
      continue;
    }

    sawChangedLine = true;
    const trimmed = content.trim();
    if (trimmed.length === 0) continue;

    if (ext === '.sh' && trimmed.startsWith('#!')) return false;

    let inBlock = sign === '+' ? inBlockAdded : inBlockRemoved;
    const blockConfirmed = sign === '+' ? addedBlockConfirmed : removedBlockConfirmed;

    if (inBlock) {
      const closeIdx = trimmed.indexOf('*/');
      // A confirmed (in-hunk-observed) opener trusts any line unconditionally
      // (original behavior, unchanged). A seed-derived opener additionally
      // requires this specific line to look like block-comment-body shape
      // — a JSDoc-style `*`-prefixed continuation, or the line that closes
      // the block — before accepting it as comment content. Without this,
      // a phantom `/*` picked up from a string/glob literal by the
      // file-content scan (e.g. `'packages/server/src/*'`) would silently
      // swallow real code changes as "still inside the block" all the way
      // to the next literal `*/` anywhere later in the file.
      const looksLikeBlockBody = blockConfirmed || closeIdx !== -1 || trimmed.startsWith('*');
      if (looksLikeBlockBody) {
        if (closeIdx === -1) continue; // still inside the block; whole line is comment body
        const after = trimmed.slice(closeIdx + 2).trim();
        if (after.length > 0) return false; // real code follows the block close
        if (sign === '+') {
          inBlockAdded = false;
          addedBlockConfirmed = false;
        } else {
          inBlockRemoved = false;
          removedBlockConfirmed = false;
        }
        continue;
      }
      // Untrusted seed state whose line doesn't look like comment body:
      // drop the (likely phantom) block state and fall through to
      // evaluate this line under the normal, non-block rules below.
      if (sign === '+') {
        inBlockAdded = false;
        addedBlockConfirmed = false;
      } else {
        inBlockRemoved = false;
        removedBlockConfirmed = false;
      }
      inBlock = false;
    }

    if (trimmed.startsWith(lineCommentPrefix)) continue;

    if (supportsBlockComments && trimmed.startsWith('/*')) {
      const closeIdx = trimmed.indexOf('*/', 2);
      if (closeIdx === -1) {
        // The opener itself was observed directly in this hunk's diff
        // text, not inferred from a file-content scan — fully trusted.
        if (sign === '+') {
          inBlockAdded = true;
          addedBlockConfirmed = true;
        } else {
          inBlockRemoved = true;
          removedBlockConfirmed = true;
        }
        continue;
      }
      const after = trimmed.slice(closeIdx + 2).trim();
      if (after.length > 0) return false; // real code follows the block close
      continue;
    }

    // Not blank, not a confirmed comment-open/continuation/close line:
    // real code (this also fail-closes a bare `*` line with no confirmed
    // opener in this hunk, and a seed-derived in-block line that did not
    // have block-comment-body shape).
    return false;
  }

  return sawChangedLine;
}

/**
 * Read a file's content at a given git ref via `git show <ref>:<path>`.
 * Returns null on any error (ref/path does not exist, not a git repo,
 * etc.) rather than throwing — callers treat null as "content unavailable"
 * and `isCommentOnlyDiff` falls back to its no-content fail-closed default.
 */
function readGitFileContent(ref, filePath, cwd) {
  const result = spawnSync('git', ['show', `${ref}:${filePath}`], { encoding: 'utf-8', cwd });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

/**
 * Filesystem/git wrapper around `isCommentOnlyDiff`: runs
 * `git diff --unified=0 <baseBranch>...<headRef> -- <file>` and evaluates
 * the result. Returns false (safe default: require coverage) on any git
 * error or when the file has no diff against baseBranch.
 *
 * Also reads the file's full content on both sides of the diff — `headRef`
 * for the post-image, and the merge-base of `baseBranch` and `headRef` (the
 * same base the triple-dot diff itself compares against) for the pre-image
 * — and passes them through so `isCommentOnlyDiff` can seed block-comment
 * state for hunks whose opener falls outside the `--unified=0` context
 * (Issue #1394). Either read failing (e.g. the file did not exist on that
 * side) degrades to that side's no-content fail-closed default rather than
 * failing the whole check.
 *
 * `cwd` defaults to the process's own working directory; tests pass an
 * explicit repo path instead of mutating the shared `process.cwd()` (which
 * would leak across concurrently-running test files in the same process).
 *
 * `headRef` defaults to `'HEAD'` — the checked-out worktree's current
 * commit. Callers driving a check against an arbitrary PR by number (rather
 * than a checkout that is guaranteed to BE that PR's branch) must pass the
 * PR's actual head SHA here instead — see `resolvePrDiffRef`. Passing
 * `'HEAD'` when the local checkout is not that PR silently computes an
 * empty or unrelated diff, which this function cannot distinguish from "the
 * file genuinely has no comment-only changes" — that conflation, not a gap
 * in `isCommentOnlyDiff` itself (its own detection logic is correct and
 * covered by its own tests), is what makes the `headRef` parameter matter.
 */
export function isCommentOnlyFileDiff(
  filePath,
  baseBranch = process.env.BASE_BRANCH || 'origin/main',
  cwd = process.cwd(),
  headRef = 'HEAD',
) {
  const result = spawnSync('git', ['diff', '--unified=0', `${baseBranch}...${headRef}`, '--', filePath], {
    encoding: 'utf-8',
    cwd,
  });
  if (result.error || result.status !== 0) return false;

  const mergeBaseResult = spawnSync('git', ['merge-base', baseBranch, headRef], { encoding: 'utf-8', cwd });
  const mergeBase = !mergeBaseResult.error && mergeBaseResult.status === 0 ? mergeBaseResult.stdout.trim() : null;

  const baseContent = mergeBase ? readGitFileContent(mergeBase, filePath, cwd) : null;
  const headContent = readGitFileContent(headRef, filePath, cwd);

  return isCommentOnlyDiff(result.stdout || '', filePath, { baseContent, headContent });
}

/**
 * Thrown by `resolvePrDiffRef` when a PR's base/head SHAs cannot be
 * resolved or fetched. A shared util function does not own process
 * lifecycle decisions (that is an entry point's job, and this repo's
 * elevation-helpers convention keeps that boundary strict) — callers at
 * the script/entry-point layer catch this and decide how to fail loud.
 */
export class PrDiffRefResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PrDiffRefResolutionError';
  }
}

/**
 * Resolve a PR's exact base/head commit SHAs via the GitHub API and ensure
 * both are fetched into the local git object store, returning them as a
 * `{ baseRef, headRef }` pair suitable for `findTestFiles`'s `diffRef`
 * option / `isCommentOnlyFileDiff`'s `baseBranch`/`headRef` parameters.
 *
 * This exists because `getChangedFiles(prNumber)` already resolves a PR's
 * file list remotely via `gh pr diff --name-only` (works from ANY local
 * checkout), but `isCommentOnlyFileDiff` — by design, see its own doc
 * comment — diffs against whatever `HEAD` the calling process's cwd happens
 * to have checked out. `acceptance-check.js` is invoked against an
 * arbitrary PR number from the Orchestrator's own worktree, which is
 * essentially never checked out to that PR's branch, so without this
 * resolution the comment-only exemption silently degrades to "not
 * comment-only" for that script's actual usage pattern.
 *
 * Deliberately fails LOUD — throws `PrDiffRefResolutionError` rather than
 * falling back to `'HEAD'` on any error — a silent fallback would just make
 * the underlying bug intermittent (correct only when the caller happens to
 * already be on the right branch) instead of fixing it. It throws rather
 * than calling `process.exit` itself so the failure path is a value an
 * entry point's `main` can catch and a test can trigger directly, instead
 * of a side effect that kills the process (and any test runner) outright.
 *
 * `execImpl` is a pay-as-you-go dependency-injection seam (defaults to the
 * module's own `exec`): callers with no test seam of their own ignore it;
 * a test that needs to simulate `gh`/`git` failure passes a fake.
 *
 * @param {string|number} prNumber
 * @param {{ execImpl?: typeof exec }} [opts]
 * @returns {{ baseRef: string, headRef: string }}
 */
export function resolvePrDiffRef(prNumber, { execImpl = exec } = {}) {
  const shasJson = execImpl(`gh api repos/{owner}/{repo}/pulls/${prNumber} --jq "{base: .base.sha, head: .head.sha}"`);
  if (shasJson === null) {
    throw new PrDiffRefResolutionError(
      `Could not resolve base/head SHAs for PR #${prNumber} via gh api. Cannot determine whether changed files are comment-only.`,
    );
  }
  let shas;
  try {
    shas = JSON.parse(shasJson);
  } catch {
    throw new PrDiffRefResolutionError(`Unexpected response resolving PR #${prNumber} SHAs (not valid JSON): ${shasJson}`);
  }
  const { base: baseRef, head: headRef } = shas;
  if (!baseRef || !headRef) {
    throw new PrDiffRefResolutionError(`PR #${prNumber}'s gh api response is missing a base/head SHA (base=${baseRef}, head=${headRef}).`);
  }
  // Fetch by bare SHA (no refspec) — GitHub allows fetching any reachable
  // commit this way, which works even after the PR's branch has been
  // deleted post-merge.
  const fetchResult = execImpl(`git fetch origin ${baseRef} ${headRef}`);
  if (fetchResult === null) {
    throw new PrDiffRefResolutionError(
      `Could not fetch PR #${prNumber}'s base/head commits (${baseRef}, ${headRef}) from origin. Cannot determine whether changed files are comment-only.`,
    );
  }
  return { baseRef, headRef };
}

/**
 * @param {string[]} changedFiles
 * @param {{ baseRef?: string, headRef?: string, cwd?: string }} [diffRef]
 *   Passed through to `isCommentOnlyFileDiff` for the comment-only-diff
 *   check. Omit (or pass individual fields as `undefined`) to keep that
 *   function's own defaults (`origin/main`, the process cwd's checked-out
 *   `HEAD`) — the behavior preflight-check.js's no-PR-number / CI-checkout
 *   modes have always relied on. Pass the object returned by
 *   `resolvePrDiffRef(prNumber)` when checking an arbitrary PR from a
 *   worktree that may not be checked out to that PR's branch.
 */
export function findTestFiles(changedFiles, diffRef = {}) {
  const { baseRef, headRef, cwd } = diffRef;
  const testFiles = [];
  const productionFiles = [];

  for (const file of changedFiles) {
    if (isTestFile(file)) {
      testFiles.push(file);
    } else if (SOURCE_EXT_RE.test(file)) {
      productionFiles.push(file);
    }
  }

  const testCoverage = [];
  for (const prodFile of productionFiles) {
    const ext = prodFile.match(SOURCE_EXT_RE)[0];
    const baseName = prodFile.replace(SOURCE_EXT_RE, '');
    const dir = baseName.substring(0, baseName.lastIndexOf('/'));
    const fileName = baseName.substring(baseName.lastIndexOf('/') + 1);

    const hasTest = testFiles.some(tf => {
      if (!TEST_NAME_RE.test(tf)) return false;
      const tfDir = tf.substring(0, tf.lastIndexOf('/'));
      const tfFileName = tf.substring(tf.lastIndexOf('/') + 1);
      const tfBaseName = tfFileName.replace(TEST_NAME_RE, '');
      if (tfBaseName !== fileName) return false;
      return tfDir === dir || tfDir === dir + '/__tests__';
    });

    // A file that otherwise needs coverage is exempted when its actual diff
    // hunks are comment-only/blank — no behavior changed, so a sibling test
    // would be tautological (Issue #1189).
    const isCommentOnly = requiresTestCoverage(prodFile) && isCommentOnlyFileDiff(prodFile, baseRef, cwd, headRef);
    const needsCoverage = requiresTestCoverage(prodFile) && !isCommentOnly;
    const expectedTestPath = dir + '/__tests__/' + fileName + '.test' + expectedTestExt(ext);
    const altExt = alternateTestExt(ext);
    const alternateTestPath = altExt ? dir + '/__tests__/' + fileName + '.test' + altExt : null;
    testCoverage.push({ file: prodFile, hasTest, expectedTestPath, alternateTestPath, needsCoverage, isCommentOnly });
  }

  return { testFiles, productionFiles, testCoverage };
}

// --- Integration test detection ---

export const INTEGRATION_TRIGGER_PATTERNS = [
  { pattern: /^packages\/client\/src\/components\/.+\.tsx$/, reason: 'UI component (may involve state transitions or forms)' },
  { pattern: /^packages\/server\/src\/routes\/.+\.ts$/, reason: 'API route (client-server contract)' },
  { pattern: /^packages\/shared\/src\/.+\.ts$/, reason: 'shared type (cross-package contract)' },
];

export function listExistingIntegrationTests() {
  const dir = 'packages/integration/src';
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))
      .map(f => dir + '/' + f);
  } catch {
    return [];
  }
}

export function detectIntegrationTestNeeds(changedFiles, categories) {
  const triggers = [];

  for (const file of changedFiles) {
    if (isTestFile(file)) continue;
    for (const { pattern, reason } of INTEGRATION_TRIGGER_PATTERNS) {
      if (pattern.test(file)) {
        triggers.push({ file, reason });
        break;
      }
    }
  }

  if (triggers.length === 0) return null;

  const hasIntegrationTestInPr = changedFiles.some(
    f => f.startsWith('packages/integration/') && isTestFile(f)
  );

  const isCrossPackage = categories.client.length > 0 && categories.server.length > 0;
  const hasSharedChanges = categories.shared.length > 0;

  return {
    triggers,
    hasIntegrationTestInPr,
    isCrossPackage,
    hasSharedChanges,
    existingIntegrationTests: listExistingIntegrationTests(),
  };
}

// --- Package boundary analysis ---

export function analyzePackageBoundaries(categories) {
  const boundaries = [];

  if (categories.shared.length > 0) {
    boundaries.push({
      type: 'shared-type-change',
      message: 'Shared types/utilities changed — verify both client and server consumers are updated',
      files: categories.shared,
    });
  }

  if (categories.client.length > 0 && categories.server.length > 0) {
    boundaries.push({
      type: 'cross-package',
      message: 'Changes span client and server — verify WebSocket/REST API contracts are consistent',
      files: [...categories.client, ...categories.server],
    });
  }

  if (categories.server.some((f) => f.includes('websocket') || f.includes('ws'))) {
    boundaries.push({
      type: 'websocket-change',
      message: 'WebSocket handler changed — verify protocol compatibility with client',
      files: categories.server.filter((f) => f.includes('websocket') || f.includes('ws')),
    });
  }

  return boundaries;
}

// --- Issue and acceptance criteria ---

export function getLinkedIssueNumber(prNumber) {
  const result = exec(`gh pr view ${prNumber} --json body --jq .body`);
  if (!result) return null;

  const match = result.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i);
  return match ? match[1] : null;
}

export function getIssueInfo(issueNumber) {
  const title = exec(`gh issue view ${issueNumber} --json title --jq .title`);
  const body = exec(`gh issue view ${issueNumber} --json body --jq .body`);
  return { title: title || '', body: body || '' };
}

export function getAcceptanceCriteria(issueNumber) {
  const result = exec(`gh issue view ${issueNumber} --json body --jq .body`);
  if (!result) return [];

  const lines = result.split('\n');
  const criteria = [];

  for (const line of lines) {
    const match = line.match(/^- \[ \]\s+(.+)/);
    if (match) {
      criteria.push(match[1].trim());
    }
  }

  return criteria;
}

// --- Proposed Behavior ---

export function getProposedBehavior(issueNumber) {
  const result = exec(`gh issue view ${issueNumber} --json body --jq .body`);
  if (!result) return [];

  const lines = result.split('\n');
  const items = [];
  let inSection = false;

  for (const line of lines) {
    // Detect "## Proposed Behavior" heading
    if (/^##\s+Proposed Behavior\s*$/i.test(line)) {
      inSection = true;
      continue;
    }
    // Exit section on next heading
    if (inSection && /^##\s+/.test(line)) {
      break;
    }
    if (!inSection) continue;

    // Parse list items: "- text", "- [ ] text", "- [x] text"
    const match = line.match(/^- (?:\[[ x]\]\s+)?(.+)/);
    if (match) {
      items.push(match[1].trim());
    }
  }

  return items;
}

/**
 * Extract meaningful keywords from a proposed behavior item.
 * Returns backtick-enclosed terms, uppercase abbreviations (2+ chars),
 * and camelCase/PascalCase identifiers.
 */
export function extractKeywords(text) {
  const keywords = [];

  // Backtick-enclosed terms (code references)
  const codeRefs = text.matchAll(/`([^`]+)`/g);
  for (const m of codeRefs) {
    keywords.push(m[1]);
  }

  // Remove backtick-enclosed terms for further processing
  const plain = text.replace(/`[^`]+`/g, '');

  // Uppercase abbreviations (2+ chars): UI, API, MCP, REST, WebSocket, etc.
  const abbrevs = plain.matchAll(/\b([A-Z][A-Z0-9]+)\b/g);
  for (const m of abbrevs) {
    keywords.push(m[1]);
  }

  // camelCase / PascalCase identifiers
  const camelCase = plain.matchAll(/\b([a-z]+(?:[A-Z][a-z]+)+|[A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g);
  for (const m of camelCase) {
    keywords.push(m[1]);
  }

  return [...new Set(keywords)];
}

export function getPrDiff(prNumber) {
  return exec(`gh pr diff ${prNumber}`) || '';
}

/**
 * Check each proposed behavior item against the PR diff using keyword matching.
 * Returns an array of { item, keywords, matched, matchedKeywords }.
 */
export function checkProposedBehaviorCoverage(proposedItems, prDiff) {
  return proposedItems.map(item => {
    const keywords = extractKeywords(item);
    const matchedKeywords = keywords.filter(kw => prDiff.includes(kw));
    return {
      item,
      keywords,
      matched: matchedKeywords.length > 0,
      matchedKeywords,
    };
  });
}

// --- Public-artifact language check ---

/**
 * Run scripts/check-public-artifacts-language.mjs and return its result.
 *
 * The Bun script is the source of truth for the detection regex and the
 * file:line:col output format; this helper just spawns it so that
 * preflight-check.js and acceptance-check.js can share the same verdict
 * without duplicating the regex or the glob walk.
 *
 * @param {object} [options]
 * @param {string} [options.repoRoot] absolute path to repo root
 * @returns {{exitCode: number, stdout: string, stderr: string}}
 */
export function runLanguageCheck({ repoRoot, binary = 'bun' } = {}) {
  const root = repoRoot || resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const scriptPath = resolve(root, 'scripts/check-public-artifacts-language.mjs');
  const result = spawnSync(binary, [scriptPath], {
    cwd: root,
    encoding: 'utf-8',
  });
  // result.error is set when the binary itself cannot be spawned (e.g. bun
  // missing from PATH). We surface this as a distinct condition rather than
  // letting the consumer mistake an empty stdout for "0 violations".
  if (result.error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Failed to spawn '${binary}': ${result.error.message}`,
      spawnFailed: true,
    };
  }
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    spawnFailed: false,
  };
}

// --- Source-comment blame-shift check ---

/**
 * Run scripts/check-source-comment-blame-shift.mjs and return its result.
 *
 * The Bun script is the source of truth for the detection regex, the
 * `file:line:col pattern` output format, and the KNOWN_VIOLATIONS
 * allowlist; this helper spawns it so that preflight-check.js (which
 * runs under node) can surface the verdict alongside the other gates.
 *
 * @param {object} [options]
 * @param {string} [options.repoRoot] absolute path to repo root
 * @param {string} [options.binary] runtime binary (default: 'bun')
 * @returns {{exitCode: number, stdout: string, stderr: string, spawnFailed: boolean}}
 */
export function runCommentBlameShiftCheck({ repoRoot, binary = 'bun' } = {}) {
  const root = repoRoot || resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const scriptPath = resolve(root, 'scripts/check-source-comment-blame-shift.mjs');
  const result = spawnSync(binary, [scriptPath], {
    cwd: root,
    encoding: 'utf-8',
  });
  if (result.error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Failed to spawn '${binary}': ${result.error.message}`,
      spawnFailed: true,
    };
  }
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    spawnFailed: false,
  };
}

// --- CI status check ---

export function getCiStatus(prNumber) {
  const result = exec(`gh pr checks ${prNumber} --json name,state,bucket 2>/dev/null`);
  if (!result) return null;
  try {
    const checks = JSON.parse(result);
    const failed = checks.filter(c => c.bucket === 'fail');
    const pending = checks.filter(c => c.bucket === 'pending');
    const passed = checks.filter(c => c.bucket === 'pass');
    return { checks, failed, pending, passed, allGreen: failed.length === 0 && pending.length === 0 };
  } catch {
    return null;
  }
}
