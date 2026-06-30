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
 * The KNOWN_VIOLATIONS set below is the inventory of pre-existing
 * violations at the time this detector landed. The cleanup of those
 * violations is tracked as a separate work stream in Issue 898 — that
 * track removes references from source comments and migrates the
 * narrative into PR descriptions / git log. This detector exists only
 * to gate NEW growth: any violation whose key is NOT in KNOWN_VIOLATIONS
 * fails the check.
 *
 * Maintenance rule: when fixing a pre-existing violation in an Issue 898
 * cleanup PR, REMOVE its entry from KNOWN_VIOLATIONS in the same PR. The
 * key format is `file:line:col:pattern-name` (a stable string). Keep the
 * set sorted to make reviews and merges painless.
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
// KNOWN_VIOLATIONS — pre-existing violations baked in at the time this
// detector landed. See the file header for the maintenance rule.
// Track for cleanup: Issue 898.
// Key format: `file:line:col:pattern-name`.
// ---------------------------------------------------------------------------
export const KNOWN_VIOLATIONS = new Set([
  'packages/client/src/components/repositories/AddRepositoryForm.tsx:45:53:issue-ref',
  'packages/client/src/lib/api.ts:301:54:issue-ref',
  'packages/client/src/lib/api.ts:323:54:issue-ref',
  'packages/server/src/app-context.ts:125:17:issue-ref',
  'packages/server/src/app-context.ts:156:34:issue-ref',
  'packages/server/src/app-context.ts:163:34:issue-ref',
  'packages/server/src/app-context.ts:170:27:issue-ref',
  'packages/server/src/app-context.ts:181:45:issue-ref',
  'packages/server/src/app-context.ts:488:53:issue-ref',
  'packages/server/src/app-context.ts:665:55:issue-ref',
  'packages/server/src/app-context.ts:761:52:issue-ref',
  'packages/server/src/database/connection.ts:1277:45:issue-ref',
  'packages/server/src/database/connection.ts:1287:48:issue-ref',
  'packages/server/src/jobs/handlers.ts:122:6:issue-ref',
  'packages/server/src/jobs/handlers.ts:123:41:issue-ref',
  'packages/server/src/jobs/handlers.ts:123:54:pr-ref',
  'packages/server/src/jobs/handlers.ts:126:44:issue-ref',
  'packages/server/src/jobs/handlers.ts:128:53:pr-ref',
  'packages/server/src/lib/config.ts:52:12:issue-ref',
  'packages/server/src/lib/config.ts:53:46:issue-ref',
  'packages/server/src/lib/config.ts:53:59:pr-ref',
  'packages/server/src/lib/git.ts:9:4:issue-ref',
  'packages/server/src/lib/git.ts:45:35:issue-ref',
  'packages/server/src/lib/git.ts:309:42:issue-ref',
  'packages/server/src/lib/git.ts:392:22:issue-ref',
  'packages/server/src/lib/server-config.ts:114:44:issue-ref',
  'packages/server/src/lib/template.ts:76:10:issue-ref',
  'packages/server/src/mcp/mcp-server.ts:176:7:issue-ref',
  'packages/server/src/mcp/mcp-server.ts:176:58:issue-ref',
  'packages/server/src/mcp/mcp-server.ts:176:71:pr-ref',
  'packages/server/src/mcp/mcp-server.ts:181:33:issue-ref',
  'packages/server/src/mcp/mcp-server.ts:190:33:issue-ref',
  'packages/server/src/mcp/mcp-server.ts:420:59:issue-ref',
  'packages/server/src/mcp/mcp-server.ts:642:12:issue-ref',
  'packages/server/src/mcp/mcp-server.ts:642:25:pr-ref',
  'packages/server/src/mcp/mcp-server.ts:647:38:pr-ref',
  'packages/server/src/mcp/mcp-server.ts:687:14:issue-ref',
  'packages/server/src/mcp/mcp-server.ts:687:34:issue-ref',
  'packages/server/src/mcp/mcp-server.ts:687:47:pr-ref',
  'packages/server/src/mcp/mcp-server.ts:752:15:issue-ref',
  'packages/server/src/mcp/mcp-server.ts:890:25:issue-ref',
  'packages/server/src/mcp/mcp-server.ts:891:43:issue-ref',
  'packages/server/src/mcp/mcp-server.ts:896:45:pr-ref',
  'packages/server/src/mcp/mcp-server.ts:1089:37:issue-ref',
  'packages/server/src/mcp/mcp-server.ts:1094:42:pr-ref',
  'packages/server/src/mcp/mcp-server.ts:1230:32:issue-ref',
  'packages/server/src/mcp/mcp-server.ts:1236:13:pr-ref',
  'packages/server/src/routes/repositories.ts:54:42:issue-ref',
  'packages/server/src/routes/repositories.ts:86:58:issue-ref',
  'packages/server/src/routes/repositories.ts:189:8:issue-ref',
  'packages/server/src/routes/repositories.ts:191:71:pr-ref',
  'packages/server/src/routes/repositories.ts:192:42:pr-ref',
  'packages/server/src/routes/repositories.ts:242:23:issue-ref',
  'packages/server/src/routes/repositories.ts:276:10:issue-ref',
  'packages/server/src/routes/repositories.ts:304:8:issue-ref',
  'packages/server/src/routes/repositories.ts:325:10:issue-ref',
  'packages/server/src/routes/sessions.ts:201:8:issue-ref',
  'packages/server/src/routes/sessions.ts:201:42:pr-ref',
  'packages/server/src/routes/sessions.ts:250:8:issue-ref',
  'packages/server/src/routes/workers.ts:31:40:issue-ref',
  'packages/server/src/routes/workers.ts:60:35:issue-ref',
  'packages/server/src/routes/workers.ts:353:8:issue-ref',
  'packages/server/src/routes/workers.ts:353:44:pr-ref',
  'packages/server/src/routes/workers.ts:394:8:issue-ref',
  'packages/server/src/routes/workers.ts:394:44:pr-ref',
  'packages/server/src/routes/workers.ts:413:42:issue-ref',
  'packages/server/src/routes/worktrees.ts:86:16:bare-ref',
  'packages/server/src/routes/worktrees.ts:86:32:issue-ref',
  'packages/server/src/routes/worktrees.ts:86:45:pr-ref',
  'packages/server/src/routes/worktrees.ts:140:20:issue-ref',
  'packages/server/src/routes/worktrees.ts:303:41:issue-ref',
  'packages/server/src/routes/worktrees.ts:305:65:issue-ref',
  'packages/server/src/services/branch-watcher-service.ts:152:35:issue-ref',
  'packages/server/src/services/conditional-wakeup-manager.ts:62:48:pr-ref',
  'packages/server/src/services/conditional-wakeup-manager.ts:98:31:issue-ref',
  'packages/server/src/services/conditional-wakeup-manager.ts:240:61:issue-ref',
  'packages/server/src/services/elevation-args.ts:10:19:issue-ref',
  'packages/server/src/services/elevation-args.ts:14:48:pr-ref',
  'packages/server/src/services/elevation-args.ts:49:32:pr-ref',
  'packages/server/src/services/elevation-args.ts:146:48:pr-ref',
  'packages/server/src/services/git-diff-service.ts:112:47:issue-ref',
  'packages/server/src/services/github-cli.ts:12:17:pr-ref',
  'packages/server/src/services/github-issue-service.ts:5:16:issue-ref',
  'packages/server/src/services/github-issue-service.ts:9:33:pr-ref',
  'packages/server/src/services/github-issue-service.ts:9:43:pr-ref',
  'packages/server/src/services/github-issue-service.ts:67:32:pr-ref',
  'packages/server/src/services/github-pr-service.ts:6:4:issue-ref',
  'packages/server/src/services/github-pr-service.ts:14:39:pr-ref',
  'packages/server/src/services/github-pr-service.ts:14:69:pr-ref',
  'packages/server/src/services/interactive-process-manager.ts:95:31:issue-ref',
  'packages/server/src/services/interactive-process-manager.ts:211:46:issue-ref',
  'packages/server/src/services/privilege-elevation.ts:5:28:issue-ref',
  'packages/server/src/services/privilege-elevation.ts:339:56:issue-ref',
  'packages/server/src/services/pty-message-injection-service.ts:30:10:issue-ref',
  'packages/server/src/services/pty-message-injection-service.ts:34:10:issue-ref',
  'packages/server/src/services/pty-operation-executor.ts:15:45:issue-ref',
  'packages/server/src/services/repository-clone-service.ts:2:43:issue-ref',
  'packages/server/src/services/repository-clone-service.ts:57:14:pr-ref',
  'packages/server/src/services/repository-clone-service.ts:238:49:issue-ref',
  'packages/server/src/services/repository-clone-service.ts:387:17:pr-ref',
  'packages/server/src/services/repository-clone-service.ts:575:48:issue-ref',
  'packages/server/src/services/repository-clone-service.ts:624:27:pr-ref',
  'packages/server/src/services/repository-manager.ts:32:60:issue-ref',
  'packages/server/src/services/repository-manager.ts:36:5:issue-ref',
  'packages/server/src/services/repository-manager.ts:36:18:pr-ref',
  'packages/server/src/services/repository-manager.ts:211:8:issue-ref',
  'packages/server/src/services/repository-manager.ts:213:41:issue-ref',
  'packages/server/src/services/repository-manager.ts:222:20:issue-ref',
  'packages/server/src/services/repository-manager.ts:255:44:issue-ref',
  'packages/server/src/services/repository-manager.ts:313:13:pr-ref',
  'packages/server/src/services/repository-manager.ts:451:62:issue-ref',
  'packages/server/src/services/repository-manager.ts:452:6:pr-ref',
  'packages/server/src/services/repository-manager.ts:453:38:issue-ref',
  'packages/server/src/services/repository-manager.ts:547:9:issue-ref',
  'packages/server/src/services/resolve-spawn-username.ts:54:17:pr-ref',
  'packages/server/src/services/session-manager.ts:463:76:issue-ref',
  'packages/server/src/services/session-manager.ts:829:209:issue-ref',
  'packages/server/src/services/session-metadata-service.ts:147:20:issue-ref',
  'packages/server/src/services/session-metadata-service.ts:192:25:issue-ref',
  'packages/server/src/services/session-metadata-suggester.ts:25:66:issue-ref',
  'packages/server/src/services/session-metadata-suggester.ts:26:6:pr-ref',
  'packages/server/src/services/session-metadata-suggester.ts:26:64:issue-ref',
  'packages/server/src/services/session-metadata-suggester.ts:139:8:bare-ref',
  'packages/server/src/services/session-metadata-suggester.ts:139:15:pr-ref',
  'packages/server/src/services/session-metadata-suggester.ts:145:8:issue-ref',
  'packages/server/src/services/session-metadata-suggester.ts:145:28:issue-ref',
  'packages/server/src/services/session-metadata-suggester.ts:145:41:pr-ref',
  'packages/server/src/services/worker-lifecycle-manager.ts:187:10:issue-ref',
  'packages/server/src/services/worker-lifecycle-manager.ts:481:31:issue-ref',
  'packages/server/src/services/worker-manager.ts:98:6:issue-ref',
  'packages/server/src/services/worker-manager.ts:123:53:issue-ref',
  'packages/server/src/services/worker-manager.ts:274:15:issue-ref',
  'packages/server/src/services/worker-manager.ts:316:8:issue-ref',
  'packages/server/src/services/worker-manager.ts:426:8:issue-ref',
  'packages/server/src/services/worktree-creation-service.ts:26:25:issue-ref',
  'packages/server/src/services/worktree-creation-service.ts:27:8:bare-ref',
  'packages/server/src/services/worktree-creation-service.ts:27:15:pr-ref',
  'packages/server/src/services/worktree-creation-service.ts:56:63:issue-ref',
  'packages/server/src/services/worktree-creation-service.ts:97:48:issue-ref',
  'packages/server/src/services/worktree-deletion-service.ts:210:12:issue-ref',
  'packages/server/src/services/worktree-deletion-service.ts:268:35:issue-ref',
  'packages/server/src/services/worktree-deletion-service.ts:387:29:issue-ref',
  'packages/server/src/services/worktree-service.ts:19:33:issue-ref',
  'packages/server/src/services/worktree-service.ts:49:32:issue-ref',
  'packages/server/src/services/worktree-service.ts:62:63:issue-ref',
  'packages/server/src/services/worktree-service.ts:112:5:issue-ref',
  'packages/server/src/services/worktree-service.ts:143:41:issue-ref',
  'packages/server/src/services/worktree-service.ts:252:7:issue-ref',
  'packages/server/src/services/worktree-service.ts:362:22:issue-ref',
  'packages/server/src/services/worktree-service.ts:435:64:issue-ref',
  'packages/server/src/services/worktree-service.ts:524:24:issue-ref',
  'packages/server/src/services/worktree-service.ts:577:54:issue-ref',
  'packages/server/src/services/worktree-service.ts:635:7:issue-ref',
  'packages/server/src/services/worktree-service.ts:635:52:issue-ref',
  'packages/server/src/services/worktree-service.ts:635:65:pr-ref',
  'packages/server/src/services/worktree-service.ts:813:26:issue-ref',
  'packages/server/src/services/worktree-service.ts:853:45:issue-ref',
  'packages/server/src/services/worktree-service.ts:962:27:issue-ref',
  'packages/server/src/services/worktree-service.ts:1008:25:issue-ref',
  'packages/server/src/websocket/git-diff-handler.ts:14:6:issue-ref',
  'packages/server/src/websocket/git-diff-handler.ts:40:6:issue-ref',
  'packages/server/src/websocket/git-diff-handler.ts:61:50:issue-ref',
  'packages/server/src/websocket/routes.ts:717:16:issue-ref',
  'packages/server/src/websocket/routes.ts:717:52:pr-ref',
  'packages/shared/src/schemas/repository.ts:17:31:issue-ref',
  'packages/shared/src/schemas/repository.ts:18:14:pr-ref',
  'packages/shared/src/schemas/repository.ts:49:32:issue-ref',
  'packages/shared/src/schemas/repository.ts:59:51:issue-ref',
  'packages/shared/src/schemas/repository.ts:112:45:issue-ref',
  'packages/shared/src/schemas/repository.ts:149:55:issue-ref',
  'packages/shared/src/types/job.ts:91:34:issue-ref',
  'packages/shared/src/types/job.ts:91:47:pr-ref',
  'packages/shared/src/types/job.ts:96:4:issue-ref',
  'packages/shared/src/types/message-contracts.ts:4:13:issue-ref',
]);

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
