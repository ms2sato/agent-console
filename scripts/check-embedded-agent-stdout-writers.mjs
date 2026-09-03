#!/usr/bin/env bun

/**
 * Detector for stray stdout writers in the embedded-agent subprocess loop.
 *
 * `packages/embedded-agent/src/main.ts` (and every module it pulls in) runs
 * as a subprocess whose stdout is the NDJSON wire-protocol channel between
 * the loop and the server (see docs/design/embedded-agent-worker.md's
 * "Process contract" section). Nothing except a serialized protocol event
 * may ever reach stdout — any stray line (a debug `console.log`, an
 * accidental `process.stdout.write`) corrupts the channel and counts as a
 * protocol-parse failure server-side. This script enforces that mechanically
 * instead of relying on review: it forbids `console.log`, `console.info`,
 * `console.debug`, `process.stdout.write`, and `Bun.stdout` anywhere in
 * `packages/embedded-agent/src/**\/*.ts` (excluding `__tests__/` and
 * `*.test.ts`), with a single allowlisted exception — the protocol writer
 * itself.
 *
 * Detection is AST-node based (the `typescript` package's
 * `ts.createSourceFile`): the parsed tree is walked for every
 * `PropertyAccessExpression` / `ElementAccessExpression` node, each is
 * resolved back to its full dotted/bracketed access chain (root identifier
 * plus ordered property-name path), and the chain is compared against
 * FORBIDDEN_CHAINS. This is a real structural match, not a substring scan
 * against a "code-only" reconstruction of the source text (an earlier
 * revision of this script used that technique and was replaced after
 * CodeRabbit found two evasions a substring scan cannot see:
 * `console.log?.('x')` — optional chaining breaks a literal `console.log(`
 * substring — and `console.info /* comment *\/ ('x')` — a comment between
 * the property access and the call parens survives comment-blanking as
 * whitespace, which also breaks the literal substring. Matching on the AST
 * node itself is immune to both: `a?.b` and `a.b` are the same
 * PropertyAccessExpression node kind in TypeScript's AST (see
 * `resolveAccessChain`'s doc comment), and a comment is trivia that never
 * becomes part of the node structure at all, so neither evasion has
 * anywhere to hide.
 *
 * A match no longer requires the access to be immediately followed by a
 * call — `console.log`, `process.stdout.write`, and `Bun.stdout` are all
 * flagged as soon as the chain is referenced (a bare `const w = Bun.stdout`
 * already matched this way even before this rewrite; the rewrite makes the
 * other four chains consistent with that, which also closes a residual gap
 * where indirection like `const log = console.log; log('x')` would
 * otherwise reach stdout through a captured reference the old call-shaped
 * substring could never see coming).
 *
 * Fail-closed on parse failure: if `ts.createSourceFile` reports parse
 * diagnostics (checked via the same `parseDiagnostics` runtime-property
 * technique `schema-source-normalize.mjs`'s `normalizeSchemaSource` uses),
 * this script does not silently skip the file — it falls back to a raw
 * literal-substring scan of the file's unmodified text (`FORBIDDEN_TOKENS`,
 * derived from the same FORBIDDEN_CHAINS table the AST matcher uses, so the
 * two matchers can never drift out of sync with each other's labels). The
 * worst case is a false positive on a malformed file, never a
 * silently-skipped real violation.
 *
 * Allowlist: matched by file path + the name of the enclosing named
 * function the hit falls inside (walking the AST parent chain), not by line
 * number — so an edit above the writer cannot silently detach the allowlist
 * entry. Every entry requires a non-empty `reason`, enforced by
 * `assertAllowlistValid` at module load.
 *
 * Output format (one line per hit, allowlisted hits included so the
 * allowlist stays auditable):
 *
 *   path/to/file.ts:LINE:COL <token>
 *   path/to/file.ts:LINE:COL <token> (allowlisted: <reason, truncated>)
 *
 * Exit codes:
 *   0 = zero non-allowlisted hits
 *   1 = at least one non-allowlisted hit, or an unexpected internal error
 *
 * Usage:
 *   bun scripts/check-embedded-agent-stdout-writers.mjs
 */

import ts from 'typescript';
import { Glob } from 'bun';

const DEFAULT_GLOB = 'packages/embedded-agent/src/**/*.ts';

/**
 * Single-writer table of forbidden stdout-writer access chains. Both
 * matchers in this file are derived from it:
 *
 *   - The primary AST matcher (`matchForbiddenChain`) compares a resolved
 *     `{root, segments}` chain against `root`/`segments` here.
 *   - The parse-failure fallback (`findForbiddenTokenOffsets`) does a plain
 *     literal-substring scan using `FORBIDDEN_TOKENS`, which is `.map()`ed
 *     out of this same table below — never hand-maintained separately.
 *
 * `root` is the required identifier the chain must resolve back to. No
 * scope/shadowing resolution is attempted: a locally shadowed `console`
 * (`const console = {...}; console.log(...)`) still matches, because this
 * is a purely syntactic identifier-name match. This is an accepted
 * limitation (see `resolveAccessChain`'s doc comment and the
 * corresponding test in the sibling test file) — the pre-AST substring
 * matcher had the identical limitation, so this is not a regression, and
 * real scope resolution is out of scope for a lint of this size.
 *
 * `segments` is the ordered property-name path from `root` to the match
 * point, e.g. `process.stdout.write` -> root `'process'`, segments
 * `['stdout', 'write']`. A chain matches only when BOTH root and the full
 * ordered segment list match exactly — a partial chain (e.g. bare
 * `process.stdout`, or `Bun.stdout.writer`) does not match on its own,
 * though a *sub-chain* of it might (see `Bun.stdout.writer()`'s worked
 * example in `matchForbiddenChain`'s doc comment).
 *
 * `token` is the exact label string reported in output — unchanged from
 * the pre-AST implementation so downstream consumers (allowlist matching,
 * CLI output format, existing tests) keep working. The trailing `(` on
 * four of the five labels is a historical artifact of the old call-shaped
 * substring match and is kept only as a stable label string; it no longer
 * implies "must be called" (see this file's header comment).
 */
export const FORBIDDEN_CHAINS = [
  { root: 'console', segments: ['log'], token: 'console.log(' },
  { root: 'console', segments: ['info'], token: 'console.info(' },
  { root: 'console', segments: ['debug'], token: 'console.debug(' },
  { root: 'process', segments: ['stdout', 'write'], token: 'process.stdout.write(' },
  { root: 'Bun', segments: ['stdout'], token: 'Bun.stdout' },
];

/**
 * Forbidden stdout-writer tokens, matched as plain literal substrings —
 * used ONLY by the parse-failure fallback path. Derived from
 * FORBIDDEN_CHAINS (see that table's doc comment) so the fallback's labels
 * can never drift from the primary AST matcher's labels.
 */
export const FORBIDDEN_TOKENS = FORBIDDEN_CHAINS.map((chain) => chain.token);

/**
 * The single legitimate stdout writer in the embedded-agent subprocess loop.
 * Every allowlist entry requires a non-empty `reason` — enforced by
 * `assertAllowlistValid` below, called at module load against this array.
 */
export const ALLOWLIST = [
  {
    file: 'packages/embedded-agent/src/main.ts',
    functionName: 'writeEvent',
    reason:
      "This is the wire protocol's own stdout writer -- the one legitimate " +
      'stdout use in the process. Every NDJSON event the loop emits to the ' +
      'server passes through this single choke point (see ' +
      "docs/design/embedded-agent-worker.md's \"Process contract\" section).",
  },
];

/**
 * Throw if any allowlist entry is missing a `file`, `functionName`, or a
 * non-empty `reason`. Exported so tests can exercise the assertion directly
 * against a constructed bad entry without needing a second, parallel
 * allowlist fixture inside the production module.
 *
 * @param {Array<{file: string, functionName: string, reason: string}>} allowlist
 */
export function assertAllowlistValid(allowlist) {
  for (const entry of allowlist) {
    if (!entry.file || !entry.functionName) {
      throw new Error(
        `Embedded-agent stdout-writer allowlist entry is missing file/functionName: ${JSON.stringify(entry)}`,
      );
    }
    if (!entry.reason || entry.reason.trim().length === 0) {
      throw new Error(
        `Embedded-agent stdout-writer allowlist entry for ${entry.file} (${entry.functionName}) is missing a reason`,
      );
    }
  }
}

assertAllowlistValid(ALLOWLIST);

/**
 * Find every occurrence of every forbidden token in `text`, as raw
 * character offsets. Used ONLY by the parse-failure fallback path (see this
 * file's header comment) — the primary path uses `findAstViolations`
 * instead. Overlapping/adjacent occurrences of different tokens (e.g.
 * `Bun.stdout` inside `Bun.stdout.write(`) are all reported independently —
 * the caller is not expected to deduplicate.
 *
 * @param {string} text
 * @returns {Array<{index: number, token: string}>}
 */
export function findForbiddenTokenOffsets(text) {
  const hits = [];
  for (const token of FORBIDDEN_TOKENS) {
    let from = 0;
    for (;;) {
      const idx = text.indexOf(token, from);
      if (idx === -1) break;
      hits.push({ index: idx, token });
      from = idx + 1;
    }
  }
  hits.sort((a, b) => a.index - b.index || a.token.localeCompare(b.token));
  return hits;
}

/**
 * Convert a 0-based UTF-16 code-unit offset into a 1-based {line, col} pair.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {{line: number, col: number}}
 */
export function offsetToLineCol(text, offset) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (text[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, col: offset - lineStart + 1 };
}

/**
 * Resolve `node` into its full dotted/bracketed access chain: the root
 * identifier plus the ordered list of property names from the root to
 * `node` itself.
 *
 * `?.` (optional chaining) needs no special-casing here. TypeScript
 * represents `a?.b` and `a.b` as the exact same `PropertyAccessExpression`
 * node kind — the only difference is an optional `questionDotToken`
 * property on the node, which this function never inspects — so
 * `ts.isPropertyAccessExpression(node)` matches both uniformly. A call's
 * own `?.` (`f?.()`) is even further out of scope: it lives on the
 * enclosing `CallExpression`, a different node kind this function never
 * receives, since a `CallExpression` is not itself a property/element
 * access node. (Verified empirically against `console.log?.('x')`,
 * `console?.log('x')`, and `console?.log?.('x')` with a throwaway
 * `ts.createSourceFile` + node dump before writing this function — all
 * three place `questionDotToken` on nodes this function is indifferent to
 * or passes straight through.)
 *
 * `ElementAccessExpression` (`console['info']`) is resolved ONLY when its
 * argument is a `StringLiteral` — a computed key (a variable, an arbitrary
 * expression, or even a template literal) is deliberately left unresolved
 * (returns `null`) rather than attempting constant-folding or control-flow
 * analysis, which this script does not do.
 *
 * Returns `null` when the chain does not bottom out in a bare identifier
 * (e.g. it passes through a call, a parenthesized expression, `this`,
 * etc., or hits an unresolvable computed element access) — every entry in
 * FORBIDDEN_CHAINS requires a bare-identifier root, so an unresolvable
 * chain can never match regardless.
 *
 * @param {ts.Expression} node
 * @returns {{root: string, segments: string[]} | null}
 */
export function resolveAccessChain(node) {
  if (ts.isIdentifier(node)) {
    return { root: node.text, segments: [] };
  }
  if (ts.isPropertyAccessExpression(node)) {
    const base = resolveAccessChain(node.expression);
    if (!base) return null;
    return { root: base.root, segments: [...base.segments, node.name.text] };
  }
  if (ts.isElementAccessExpression(node)) {
    const arg = node.argumentExpression;
    if (!arg || !ts.isStringLiteral(arg)) return null;
    const base = resolveAccessChain(node.expression);
    if (!base) return null;
    return { root: base.root, segments: [...base.segments, arg.text] };
  }
  return null;
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
function segmentsEqual(a, b) {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

/**
 * If `node` is a `PropertyAccessExpression` or `ElementAccessExpression`
 * whose resolved chain (see `resolveAccessChain`) exactly matches an entry
 * in FORBIDDEN_CHAINS, return that entry's `token`; otherwise `null`.
 *
 * Every such node in the tree is checked independently at its own
 * position, which is what makes a longer chain's inner sub-chain
 * detectable without any extra bookkeeping: for `Bun.stdout.writer()`, the
 * outer `Bun.stdout.writer` access does not match (no FORBIDDEN_CHAINS
 * entry has segments `['stdout', 'writer']`), but the AST walk in
 * `findAstViolations` also visits the inner `Bun.stdout` access nested
 * inside it as a separate node, and THAT one resolves to `{root: 'Bun',
 * segments: ['stdout']}`, which does match. The same independence is what
 * prevents double-counting a call's callee: for `process.stdout.write(x)`,
 * only the outer 3-segment `process.stdout.write` access matches; the
 * inner `process.stdout` (2 segments) does not appear in the table at all
 * and is correctly not flagged on its own.
 *
 * @param {ts.Node} node
 * @returns {string | null}
 */
export function matchForbiddenChain(node) {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return null;
  const chain = resolveAccessChain(node);
  if (!chain) return null;
  const entry = FORBIDDEN_CHAINS.find(
    (candidate) => candidate.root === chain.root && segmentsEqual(candidate.segments, chain.segments),
  );
  return entry ? entry.token : null;
}

/**
 * Walk the full AST of `sourceFile` and collect every node whose resolved
 * access chain matches FORBIDDEN_CHAINS (see `matchForbiddenChain`).
 * Comments and whitespace are trivia the AST never represents as nodes at
 * all, and string/template literal CONTENT is text belonging to a
 * `StringLiteral`/`TemplateLiteral`-family leaf node rather than to any
 * `PropertyAccessExpression`/`ElementAccessExpression` — so both are
 * naturally invisible to this walk without any separate blanking step.
 *
 * @param {ts.SourceFile} sourceFile
 * @returns {Array<{start: number, token: string}>}
 */
export function findAstViolations(sourceFile) {
  const hits = [];
  const visit = (node) => {
    const token = matchForbiddenChain(node);
    if (token) {
      hits.push({ start: node.getStart(sourceFile), token });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  hits.sort((a, b) => a.start - b.start || a.token.localeCompare(b.token));
  return hits;
}

/**
 * Walk the AST parent chain (top-down, overwriting on each nested match) to
 * find the name of the innermost function-like node whose range contains
 * `position`: a `FunctionDeclaration`/`MethodDeclaration`'s own name, a
 * named `FunctionExpression`'s own name, or a `FunctionExpression` /
 * `ArrowFunction` assigned to a simple identifier via `VariableDeclaration`.
 *
 * @param {ts.SourceFile} sourceFile
 * @param {number} position
 * @returns {string | null}
 */
export function findEnclosingFunctionName(sourceFile, position) {
  let currentName = null;
  const visit = (node) => {
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    if (position < start || position >= end) return;
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      if (node.name) currentName = node.name.getText(sourceFile);
    } else if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      if (ts.isFunctionExpression(node) && node.name) {
        currentName = node.name.getText(sourceFile);
      } else if (
        node.parent &&
        ts.isVariableDeclaration(node.parent) &&
        ts.isIdentifier(node.parent.name)
      ) {
        currentName = node.parent.name.getText(sourceFile);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return currentName;
}

/**
 * @param {ts.SourceFile} sourceFile
 * @returns {boolean} true if the source failed to parse (has syntax errors)
 */
function hasParseErrors(sourceFile) {
  // See schema-source-normalize.mjs's identical check: `parseDiagnostics` is
  // not part of the public .d.ts surface but is a stable runtime property of
  // ts.SourceFile relied upon by tools such as ts-morph. ts.createSourceFile
  // never throws on malformed input (the parser is error-tolerant), so this
  // is the only way to detect a syntax error.
  const diagnostics = /** @type {{ parseDiagnostics?: unknown[] }} */ (sourceFile).parseDiagnostics;
  return Boolean(diagnostics && diagnostics.length > 0);
}

/**
 * Scan a single source text (pure function — no I/O) for forbidden
 * stdout-writer tokens.
 *
 * @param {string} source
 * @returns {Array<{line: number, col: number, token: string, functionName: string | null}>}
 */
export function findViolationsInSource(source) {
  const sourceFile = ts.createSourceFile(
    'embedded-agent-source.ts',
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  if (hasParseErrors(sourceFile)) {
    // Fail-closed fallback: scan the raw, unmodified text directly. This
    // may false-positive on a forbidden token that only appears inside a
    // comment or string literal of the unparseable file, but it must never
    // silently skip a file that could contain a real violation.
    return findForbiddenTokenOffsets(source).map(({ index, token }) => ({
      ...offsetToLineCol(source, index),
      token,
      functionName: null,
    }));
  }

  return findAstViolations(sourceFile).map(({ start, token }) => ({
    ...offsetToLineCol(source, start),
    token,
    functionName: findEnclosingFunctionName(sourceFile, start),
  }));
}

/**
 * @param {string} file repo-relative path
 * @returns {boolean}
 */
export function isExcludedFile(file) {
  if (file.includes('/__tests__/')) return true;
  if (/\.test\.ts$/.test(file)) return true;
  return false;
}

/**
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {Promise<string[]>}
 */
export async function findDefaultFiles({ cwd = process.cwd() } = {}) {
  const set = new Set();
  const glob = new Glob(DEFAULT_GLOB);
  for await (const file of glob.scan({ cwd, onlyFiles: true })) {
    if (isExcludedFile(file)) continue;
    set.add(file);
  }
  return [...set].sort();
}

/**
 * @param {{file: string, functionName: string | null}} hit
 * @param {Array<{file: string, functionName: string, reason: string}>} allowlist
 * @returns {{file: string, functionName: string, reason: string} | undefined}
 */
function matchAllowlistEntry(hit, allowlist) {
  if (hit.functionName === null) return undefined;
  return allowlist.find((entry) => entry.file === hit.file && entry.functionName === hit.functionName);
}

/**
 * Run the full check across the default file set (or an explicit list).
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string[]} [options.files] explicit repo-relative file list (skips the default glob)
 * @param {Array<{file: string, functionName: string, reason: string}>} [options.allowlist]
 * @returns {Promise<{
 *   files: string[],
 *   violations: Array<{file: string, line: number, col: number, token: string, allowlistReason: string | null}>,
 *   newViolations: Array<{file: string, line: number, col: number, token: string, allowlistReason: string | null}>,
 *   allowlisted: Array<{file: string, line: number, col: number, token: string, allowlistReason: string | null}>,
 * }>}
 */
export async function runCheck({ cwd = process.cwd(), files, allowlist = ALLOWLIST } = {}) {
  const targetFiles = files ?? (await findDefaultFiles({ cwd }));
  const violations = [];
  for (const file of targetFiles) {
    const abs = `${cwd}/${file}`;
    const source = await Bun.file(abs).text();
    for (const hit of findViolationsInSource(source)) {
      const entry = matchAllowlistEntry({ file, functionName: hit.functionName }, allowlist);
      violations.push({
        file,
        line: hit.line,
        col: hit.col,
        token: hit.token,
        allowlistReason: entry ? entry.reason : null,
      });
    }
  }
  const newViolations = violations.filter((v) => v.allowlistReason === null);
  const allowlisted = violations.filter((v) => v.allowlistReason !== null);
  return { files: targetFiles, violations, newViolations, allowlisted };
}

/**
 * @param {string} reason
 * @returns {string}
 */
function truncateReason(reason) {
  return reason.length > 60 ? `${reason.slice(0, 60)}...` : reason;
}

/**
 * @param {{file: string, line: number, col: number, token: string, allowlistReason: string | null}} v
 * @returns {string}
 */
export function formatViolation(v) {
  const base = `${v.file}:${v.line}:${v.col} ${v.token}`;
  return v.allowlistReason === null ? base : `${base} (allowlisted: ${truncateReason(v.allowlistReason)})`;
}

async function main() {
  const result = await runCheck({});

  const sortViolations = (vs) =>
    [...vs].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);

  for (const v of sortViolations(result.violations)) {
    console.log(formatViolation(v));
  }

  const summary = `Found ${result.newViolations.length} violation(s) (${result.allowlisted.length} allowlisted) across ${result.files.length} file(s).`;
  if (result.newViolations.length === 0) {
    console.log(summary);
    return 0;
  }
  console.error('');
  console.error(summary);
  console.error(
    'Only the wire protocol writer may write to stdout in the embedded-agent subprocess loop. ' +
      'Route logs/diagnostics to stderr instead (console.warn/console.error).',
  );
  return 1;
}

const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('check-embedded-agent-stdout-writers.mjs');
if (isMainModule) {
  process.exit(await main());
}
