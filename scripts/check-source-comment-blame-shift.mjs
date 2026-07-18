#!/usr/bin/env bun

/**
 * Detector for source-comment blame-shift references.
 *
 * Scans `packages/<pkg>/src/**` for code comments that contain references
 * to transient context — Issue numbers, PR numbers, dated CodeRabbit
 * mentions, and bare cross-references. Such references rot as the
 * codebase evolves: when an Issue is reorganised, when a PR is rebased
 * away, when a date passes from "recent" to "ancient history" — the
 * pointer in the comment becomes confusing or wrong. The right home for
 * this context is the PR description and the git log (`git blame`,
 * `git log -S`), not in the source itself.
 *
 * Patterns detected (case-sensitive, only inside `//` line comments or
 * `/* ... *\/` block comments — NOT inside string literals):
 *
 *   1. `Issue #NNN`        (one-or-more digits)
 *   2. `PR #NNN`           (one-or-more digits)
 *   3. Lone `// #NNN`      (line comment whose content begins with `#NNN`
 *                           followed by space, punctuation, or end-of-line)
 *   4. `CodeRabbit, YYYY-MM-DD` or `CodeRabbit YYYY-MM-DD`
 *   5. JSDoc / multi-line block comments containing patterns 1 or 2
 *      (handled naturally by scanning each comment line)
 *
 * Output format (one violation per line, stable sorted by file/line/col):
 *
 *   path/to/file.ts:LINE:COL pattern-name
 *
 * Exit codes:
 *   0 = no NEW violations (allowlisted matches are reported but do not fail)
 *   1 = at least one NEW violation, or unexpected error
 *
 * Allowlist strategy:
 *
 * KNOWN_VIOLATIONS started as the inventory of pre-existing violations at
 * the time this detector landed, gated by a cleanup work stream (Issue
 * 898). That cleanup is complete and the repository has zero violations,
 * so KNOWN_VIOLATIONS is now empty: any violation found by this detector
 * fails the check immediately. If a future pre-existing violation needs
 * to be absorbed temporarily (e.g. a large migration), add entries back
 * using the `file:line:col:pattern-name` key format and document a
 * cleanup track per `.claude/rules/workflow.md`'s allowlist-baseline
 * template.
 *
 * Usage:
 *   bun scripts/check-source-comment-blame-shift.mjs
 *   bun scripts/check-source-comment-blame-shift.mjs path/to/file.ts ...
 */

import { Glob } from 'bun';

const DEFAULT_GLOBS = [
  'packages/*/src/**/*.ts',
  'packages/*/src/**/*.tsx',
  'packages/*/src/**/*.js',
  'packages/*/src/**/*.jsx',
];

/**
 * State machine that walks a source string and yields each comment as a
 * sequence of line-bounded text chunks plus their source position.
 *
 * Comment kinds:
 *   - 'line'  -> `// ...`
 *   - 'block' -> `/* ... *\/`
 *
 * String literals (`'...'`, `"..."`, `` `...` ``) are tracked so a `//`
 * sequence inside a string is NOT mistaken for the start of a line
 * comment. Regex literals are tracked so escaped slashes inside the
 * regex (e.g. `/^https?:\/\//`) are not mistaken for line comments.
 *
 * Each yielded chunk has the shape:
 *   { text, line, col, kind }
 * where `line` and `col` are the 1-based source position of the first
 * character of `text`.
 *
 * @param {string} source
 * @returns {Generator<{text: string, line: number, col: number, kind: 'line' | 'block'}>}
 */
export function* tokenizeComments(source) {
  let i = 0;
  let line = 1;
  let col = 1;
  let state = 'code'; // code | sq | dq | bq | regex | rcc | lc | bc
  // Track last non-whitespace, non-comment significant char. Used to
  // decide whether a `/` starts a regex literal or is a division
  // operator. The set CAN_PRECEDE_REGEX captures common JS operators and
  // punctuators that precede a regex literal in valid programs.
  let prevSig = '';
  // Stack of "template expression frames" — one per open `${` inside an
  // enclosing `bq` (backtick template) state. Each frame tracks the
  // brace depth WITHIN that expression. When state is 'code' AND
  // templateStack is non-empty, a `}` at depth 0 of the top frame closes
  // the interpolation and returns the tokenizer to 'bq'. Nested
  // templates work transparently because each `${` pushes its own frame
  // and each closing `}` pops one. Without this stack, comments inside
  // template-string interpolation expressions were silently skipped.
  const templateStack = [];
  let commentText = '';
  let commentLine = 0;
  let commentCol = 0;
  let commentKind = 'line';

  const startCommentChunk = (kind) => {
    commentText = '';
    commentLine = line;
    commentCol = col;
    commentKind = kind;
  };

  const flushCommentChunk = function* () {
    yield { text: commentText, line: commentLine, col: commentCol, kind: commentKind };
    commentText = '';
  };

  // Operators / punctuators after which a `/` starts a regex literal.
  // Whitespace is skipped when tracking prevSig, so `=` followed by
  // whitespace then `/regex/` still sees prevSig = '='. The set is
  // permissive: false positives (treating a div as regex) are extremely
  // rare in practice and only matter when the "regex" contains `//` or
  // `/*` (which would otherwise be tokenized as comments).
  const CAN_PRECEDE_REGEX = new Set([
    '', '(', ',', '=', ':', '[', '!', '&', '|', '?', '+', '-', '*', '/', '%',
    '^', '~', '<', '>', ';', '{', '}', '\n',
  ]);

  const setPrevSig = (ch) => {
    if (ch === ' ' || ch === '\t' || ch === '\r') return; // ignore inline whitespace
    prevSig = ch;
  };

  while (i < source.length) {
    const ch = source[i];
    const next = i + 1 < source.length ? source[i + 1] : '';

    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'lc';
        i += 2; col += 2;
        startCommentChunk('line');
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'bc';
        i += 2; col += 2;
        startCommentChunk('block');
        continue;
      }
      if (ch === '/' && CAN_PRECEDE_REGEX.has(prevSig)) {
        state = 'regex';
        i++; col++;
        continue;
      }
      if (ch === "'") {
        state = 'sq';
        setPrevSig(ch);
        i++; col++;
        continue;
      }
      if (ch === '"') {
        state = 'dq';
        setPrevSig(ch);
        i++; col++;
        continue;
      }
      if (ch === '`') {
        state = 'bq';
        setPrevSig(ch);
        i++; col++;
        continue;
      }
      if (ch === '\n') {
        prevSig = '\n';
        line++; col = 1; i++;
        continue;
      }
      // Inside a template-string interpolation: track `{` and `}` so we
      // know when a `}` closes the enclosing `${`. Top frame's
      // braceDepth is incremented on `{` and decremented on `}`. When
      // it reaches -1 (i.e. we see `}` at depth 0), we pop and return
      // to `bq`.
      if (templateStack.length > 0) {
        if (ch === '{') {
          templateStack[templateStack.length - 1].braceDepth += 1;
          setPrevSig(ch);
          i++; col++;
          continue;
        }
        if (ch === '}') {
          const top = templateStack[templateStack.length - 1];
          if (top.braceDepth === 0) {
            templateStack.pop();
            state = 'bq';
            // After popping, the closing `}` is consumed; the next char
            // is part of the enclosing template literal.
            i++; col++;
            continue;
          }
          top.braceDepth -= 1;
          setPrevSig(ch);
          i++; col++;
          continue;
        }
      }
      setPrevSig(ch);
      i++; col++;
      continue;
    }

    if (state === 'sq' || state === 'dq') {
      const quote = state === 'sq' ? "'" : '"';
      if (ch === '\\') {
        // Skip the escape sequence (at minimum one char; we are lenient
        // about unicode/longer escapes since we only care about not
        // exiting the string early).
        if (next === '\n') {
          // line-continuation: advance and bump line
          i += 2; line++; col = 1;
        } else {
          i += 2; col += 2;
        }
        continue;
      }
      if (ch === quote) {
        state = 'code';
        setPrevSig(quote);
        i++; col++;
        continue;
      }
      if (ch === '\n') {
        // Unterminated string literal — tolerate it: drop back to code.
        state = 'code';
        line++; col = 1; i++;
        continue;
      }
      i++; col++;
      continue;
    }

    if (state === 'bq') {
      if (ch === '\\') {
        if (next === '\n') { i += 2; line++; col = 1; }
        else { i += 2; col += 2; }
        continue;
      }
      if (ch === '`') {
        state = 'code';
        setPrevSig('`');
        i++; col++;
        continue;
      }
      if (ch === '$' && next === '{') {
        // Enter the interpolation expression: push a fresh template
        // frame and transition to 'code'. The matching `}` (at depth 0
        // of this frame) will pop back to 'bq'.
        templateStack.push({ braceDepth: 0 });
        state = 'code';
        // Setting prevSig to '{' makes a leading `/` (e.g. `${/re/}`)
        // correctly classify as a regex literal.
        prevSig = '{';
        i += 2; col += 2;
        continue;
      }
      if (ch === '\n') { line++; col = 1; i++; continue; }
      i++; col++;
      continue;
    }

    if (state === 'regex') {
      if (ch === '\\') {
        // Escaped char inside regex — skip both chars together.
        if (next === '\n') { i += 2; line++; col = 1; }
        else { i += 2; col += 2; }
        continue;
      }
      if (ch === '[') {
        state = 'rcc';
        i++; col++;
        continue;
      }
      if (ch === '/') {
        state = 'code';
        i++; col++;
        // Consume regex flags (letters following the closing slash).
        while (i < source.length && /[a-z]/i.test(source[i])) {
          i++; col++;
        }
        setPrevSig('/');
        continue;
      }
      if (ch === '\n') {
        // Regex literals cannot contain unescaped newlines; treat as
        // recovery from a misclassification and fall back to code.
        state = 'code';
        line++; col = 1; i++;
        continue;
      }
      i++; col++;
      continue;
    }

    if (state === 'rcc') {
      // Regex character class [...]
      if (ch === '\\') {
        if (next === '\n') { i += 2; line++; col = 1; }
        else { i += 2; col += 2; }
        continue;
      }
      if (ch === ']') {
        state = 'regex';
        i++; col++;
        continue;
      }
      if (ch === '\n') {
        state = 'code';
        line++; col = 1; i++;
        continue;
      }
      i++; col++;
      continue;
    }

    if (state === 'lc') {
      if (ch === '\n') {
        yield* flushCommentChunk();
        state = 'code';
        prevSig = '\n';
        line++; col = 1; i++;
        continue;
      }
      commentText += ch;
      i++; col++;
      continue;
    }

    if (state === 'bc') {
      if (ch === '*' && next === '/') {
        yield* flushCommentChunk();
        state = 'code';
        i += 2; col += 2;
        setPrevSig('/');
        continue;
      }
      if (ch === '\n') {
        yield* flushCommentChunk();
        line++; col = 1; i++;
        startCommentChunk('block');
        continue;
      }
      commentText += ch;
      i++; col++;
      continue;
    }
  }

  // EOF inside a comment — flush whatever we accumulated.
  if (state === 'lc' || state === 'bc') {
    yield { text: commentText, line: commentLine, col: commentCol, kind: state === 'lc' ? 'line' : 'block' };
  }
}

/**
 * Find blame-shift violations within a comment chunk.
 *
 * Pure function — takes a chunk descriptor and emits `{ pattern, col }`
 * records keyed by source column (the chunk's `col` plus the match's
 * offset within `chunk.text`).
 *
 * @param {{text: string, line: number, col: number, kind: 'line' | 'block'}} chunk
 * @returns {Array<{pattern: string, col: number}>}
 */
function findViolationsInChunk(chunk) {
  const hits = [];
  const { text, col, kind } = chunk;

  // 1. Issue #NNN — `\b` word boundaries prevent matches inside longer
  //    identifiers; see the word-boundary tests for the expected shape.
  for (const m of text.matchAll(/\bIssue #\d+\b/g)) {
    hits.push({ pattern: 'issue-ref', col: col + m.index });
  }

  // 2. PR #NNN — same word-boundary rationale as issue-ref above.
  for (const m of text.matchAll(/\bPR #\d+\b/g)) {
    hits.push({ pattern: 'pr-ref', col: col + m.index });
  }

  // 3. Lone `// #NNN` — line comments only. The content (text accumulated
  //    after `//`) begins with optional whitespace then `#NNN` followed
  //    by a word boundary (space, punctuation, or end-of-line).
  if (kind === 'line') {
    const m = text.match(/^(\s*)#(\d+)\b/);
    if (m) {
      const hashCol = col + m[1].length;
      hits.push({ pattern: 'bare-ref', col: hashCol });
    }
  }

  // 4. `CodeRabbit, YYYY-MM-DD` or `CodeRabbit YYYY-MM-DD`
  for (const m of text.matchAll(/CodeRabbit[,]?\s+\d{4}-\d{2}-\d{2}/g)) {
    hits.push({ pattern: 'coderabbit-dated', col: col + m.index });
  }

  return hits;
}

/**
 * Scan a single source text and return the list of violations with their
 * (line, col, pattern) coordinates.
 *
 * Pure function — exported for direct testing.
 *
 * @param {string} source
 * @returns {Array<{line: number, col: number, pattern: string}>}
 */
export function findViolationsInSource(source) {
  const violations = [];
  for (const chunk of tokenizeComments(source)) {
    for (const hit of findViolationsInChunk(chunk)) {
      violations.push({ line: chunk.line, col: hit.col, pattern: hit.pattern });
    }
  }
  // Stable sort by line, then col, then pattern.
  violations.sort((a, b) => a.line - b.line || a.col - b.col || a.pattern.localeCompare(b.pattern));
  return violations;
}

/**
 * Construct the allowlist key for a violation. Keys are file-line-col-pattern.
 *
 * @param {{file: string, line: number, col: number, pattern: string}} v
 * @returns {string}
 */
export function violationKey(v) {
  return `${v.file}:${v.line}:${v.col}:${v.pattern}`;
}

/**
 * Format a violation for display.
 *
 * @param {{file: string, line: number, col: number, pattern: string}} v
 * @returns {string}
 */
export function formatViolation(v) {
  return `${v.file}:${v.line}:${v.col} ${v.pattern}`;
}

/**
 * Should a file be excluded from scanning? Test files and `__tests__/`
 * directories are excluded regardless of their location under
 * `packages/<pkg>/src/`.
 *
 * @param {string} file
 * @returns {boolean}
 */
export function isExcludedFile(file) {
  if (file.includes('/__tests__/')) return true;
  if (/\.test\.(ts|tsx|js|jsx)$/.test(file)) return true;
  if (/\.spec\.(ts|tsx|js|jsx)$/.test(file)) return true;
  return false;
}

/**
 * Resolve the default target file list.
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {Promise<string[]>}
 */
export async function findDefaultFiles({ cwd = process.cwd() } = {}) {
  const set = new Set();
  for (const pattern of DEFAULT_GLOBS) {
    const glob = new Glob(pattern);
    for await (const file of glob.scan({ cwd, onlyFiles: true })) {
      if (isExcludedFile(file)) continue;
      set.add(file);
    }
  }
  return [...set].sort();
}

/**
 * Read a single file from disk and scan it.
 *
 * @param {string} file repo-relative path
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {Promise<Array<{file: string, line: number, col: number, pattern: string}>>}
 */
export async function findViolationsInFile(file, { cwd = process.cwd() } = {}) {
  const abs = `${cwd}/${file}`;
  const text = await Bun.file(abs).text();
  return findViolationsInSource(text).map((v) => ({ file, ...v }));
}

/**
 * Run the full check across a list of files (or the default glob set).
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string[]} [options.files] explicit list (skips the default glob)
 * @param {Set<string>} [options.allowlist]
 * @returns {Promise<{
 *   files: string[],
 *   violations: Array<{file: string, line: number, col: number, pattern: string}>,
 *   newViolations: Array<{file: string, line: number, col: number, pattern: string}>,
 *   allowlisted: Array<{file: string, line: number, col: number, pattern: string}>,
 * }>}
 */
export async function runCheck({ cwd = process.cwd(), files, allowlist = KNOWN_VIOLATIONS } = {}) {
  const targetFiles = files ?? (await findDefaultFiles({ cwd }));
  const violations = [];
  for (const file of targetFiles) {
    const fileViolations = await findViolationsInFile(file, { cwd });
    violations.push(...fileViolations);
  }
  const newViolations = [];
  const allowlisted = [];
  for (const v of violations) {
    if (allowlist.has(violationKey(v))) {
      allowlisted.push(v);
    } else {
      newViolations.push(v);
    }
  }
  return { files: targetFiles, violations, newViolations, allowlisted };
}

// ---------------------------------------------------------------------------
// KNOWN_VIOLATIONS — see the file header for the allowlist strategy.
// Key format: `file:line:col:pattern-name`.
// ---------------------------------------------------------------------------
export const KNOWN_VIOLATIONS = new Set();

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

async function main(argv) {
  const args = argv.slice(2);
  const explicit = args.filter((a) => !a.startsWith('-'));
  const result = await runCheck({
    files: explicit.length > 0 ? explicit : undefined,
  });

  // Sort all output for stable diffs.
  const sortViolations = (vs) =>
    [...vs].sort(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.col - b.col ||
        a.pattern.localeCompare(b.pattern),
    );

  const newSorted = sortViolations(result.newViolations);
  for (const v of newSorted) {
    console.log(formatViolation(v));
  }

  const summary = `Found ${result.newViolations.length} new violation${result.newViolations.length === 1 ? '' : 's'} (${result.allowlisted.length} allowlisted)`;
  if (result.newViolations.length === 0) {
    console.log(summary);
    return 0;
  }
  console.error('');
  console.error(summary);
  console.error(
    'New comment references to Issues / PRs / dated CodeRabbit reviews are not allowed. ' +
      'Such references rot as the codebase evolves; move the narrative into the PR description / git log instead.',
  );
  return 1;
}

const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('check-source-comment-blame-shift.mjs');
if (isMainModule) {
  process.exit(await main(process.argv));
}
