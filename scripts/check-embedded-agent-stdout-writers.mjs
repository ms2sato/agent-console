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
 * instead of relying on review: it forbids `console.log(`, `console.info(`,
 * `console.debug(`, `process.stdout.write(`, and `Bun.stdout` anywhere in
 * `packages/embedded-agent/src/**\/*.ts` (excluding `__tests__/` and
 * `*.test.ts`), with a single allowlisted exception — the protocol writer
 * itself.
 *
 * Detection is AST-based (the `typescript` package's `ts.createSourceFile`),
 * reusing `collectLeaves` from `scripts/schema-source-normalize.mjs` — NOT a
 * regex or hand-rolled comment/string scanner. That module already solved
 * comment/string/regex-literal disambiguation correctly (division-vs-regex,
 * template interpolation, JSDoc subtrees); duplicating it here would only
 * reintroduce the same false-positive risk that module's own header comment
 * warns about.
 *
 * The technique: parse the file, walk to its leaf tokens, and build a
 * same-length "code-only" copy of the source text where every character NOT
 * covered by a leaf's own token text is blanked to a space (newlines are
 * preserved so LINE:COL computed against this copy matches the original
 * exactly). This makes ordinary comments invisible (they are trivia between
 * leaves, never leaves themselves) and lets string / template / regex
 * literal CONTENT be blanked deliberately — see BLANK_LEAF_KINDS — while
 * every other token (including a template literal's `${...}` interpolated
 * expression, which is its own separate leaf) keeps its exact original text
 * and position. The forbidden-token search then runs as a plain substring
 * scan against that code-only copy.
 *
 * Fail-closed on parse failure: if `ts.createSourceFile` reports parse
 * diagnostics (same `parseDiagnostics` detection technique
 * `normalizeSchemaSource` uses), this script does not silently skip the
 * file — it falls back to a raw substring scan of the file's unmodified
 * text. The worst case is a false positive on a malformed file, never a
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

import { collectLeaves } from './schema-source-normalize.mjs';

const DEFAULT_GLOB = 'packages/embedded-agent/src/**/*.ts';

/**
 * Forbidden stdout-writer tokens, matched as plain substrings against the
 * code-only reconstruction of a file's text (see the header comment).
 */
export const FORBIDDEN_TOKENS = [
  'console.log(',
  'console.info(',
  'console.debug(',
  'process.stdout.write(',
  'Bun.stdout',
];

/**
 * Leaf kinds whose own text is deliberately blanked in the code-only
 * reconstruction: string / template / regex literal CONTENT is never
 * scanned for forbidden tokens, so a literal string like `"console.info("`
 * cannot trip the detector. A template literal's interpolated expression
 * (`${...}`) is a separate leaf of a different kind and is NOT in this set,
 * so `` `${console.info(x)}` `` is still caught.
 */
const BLANK_LEAF_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
]);

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
 * Build a same-length "code-only" copy of `source`: every character is
 * blanked to a space except (a) newlines, preserved so line numbers stay
 * aligned, and (b) the verbatim text of every leaf token that is NOT one of
 * BLANK_LEAF_KINDS. Comments and whitespace (trivia, never leaves) and
 * string/template/regex literal content are therefore both invisible to a
 * substring search run against the result, while every other token keeps
 * its exact original text and offset.
 *
 * @param {string} source
 * @param {ts.SourceFile} sourceFile
 * @returns {string}
 */
export function buildCodeOnlyText(source, sourceFile) {
  const chars = source.split('');
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== '\n') chars[i] = ' ';
  }
  const leaves = [];
  collectLeaves(sourceFile, sourceFile, leaves);
  for (const leaf of leaves) {
    if (BLANK_LEAF_KINDS.has(leaf.kind)) continue;
    const start = leaf.getStart(sourceFile);
    const end = leaf.getEnd();
    for (let i = start; i < end; i++) {
      const ch = source[i];
      if (ch !== '\n') chars[i] = ch;
    }
  }
  return chars.join('');
}

/**
 * Find every occurrence of every forbidden token in `text`, as raw
 * character offsets. Overlapping/adjacent occurrences of different tokens
 * (e.g. `Bun.stdout` inside `Bun.stdout.write(`) are all reported
 * independently — the caller is not expected to deduplicate.
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

  const codeOnlyText = buildCodeOnlyText(source, sourceFile);
  return findForbiddenTokenOffsets(codeOnlyText).map(({ index, token }) => ({
    ...offsetToLineCol(source, index),
    token,
    functionName: findEnclosingFunctionName(sourceFile, index),
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
