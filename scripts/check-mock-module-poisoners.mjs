#!/usr/bin/env bun

/**
 * Detector for new `mock.module()` call sites outside the sanctioned
 * central mock registry.
 *
 * `.claude/rules/testing.md` Anti-Pattern #2 prohibits `mock.module()` on
 * any target that another test file imports for real: `bun:test`'s
 * `mock.module()` is process-global and irreversible for the life of the
 * test process, so it poisons every test file loaded afterward in the
 * same process (Issue 970, PR 976, Issue 977, Issue 1225). This repo
 * has converged on a structural discipline instead of relying on review
 * alone: module-level mocks live in the central mock registry
 * (`packages/server/src/__tests__/test-utils.ts` and
 * `packages/server/src/__tests__/utils/**`), where load order and
 * cross-file semantics are managed deliberately. Individual test files do
 * not register their own `mock.module()` calls.
 *
 * v1 does not perform import-graph analysis ("who else imports the
 * target?"). Under the registry discipline above, that question collapses
 * to a location check: is this call inside the sanctioned registry, or
 * not? A genuinely file-exclusive mock (testing.md AP#2's permitted
 * exception) trips this detector and is resolved by an explicit, justified
 * `KNOWN_VIOLATIONS` entry, or preferably by moving the mock into the
 * central registry. Import-graph / export-level merge precision is a
 * documented v2 refinement — `test-standards.md` records the empirical
 * finding that `mock.module()` merges the factory's return onto the real
 * module rather than replacing it — warranted only if allowlist-exception
 * pressure appears.
 *
 * Detection is AST-based (the `typescript` package's `ts.createSourceFile`,
 * the same approach as `scripts/schema-source-normalize.mjs`) — NOT a
 * regex / text scan. Prose in this repo routinely *mentions*
 * `mock.module(` while documenting the prohibition (this very file does);
 * a text scan would false-positive on every one of those mentions. The
 * AST naturally excludes comments and string literals from being mistaken
 * for a call expression.
 *
 * A call is flagged when its callee is a static `.module` access — either
 * `PropertyAccessExpression` form (`mock.module(...)`) or the equivalent
 * `ElementAccessExpression` form with a string-literal property
 * (`mock['module'](...)`), any parenthesization of either side included —
 * on an identifier named `mock`. A non-string-literal first argument (e.g.
 * `mock.module(someVar, ...)`) is still a violation; its specifier is
 * reported as `<dynamic>`.
 *
 * v1's evasion boundary is drawn at whether recognizing a form requires
 * binding/dataflow resolution: static syntax variants (property vs bracket
 * access, parenthesization) are all in scope regardless of which one is
 * used, because none of them need resolving what `mock` is bound to or
 * where a computed value came from. Two evasions remain out of scope for
 * that reason, both accepted as v1 limitations, not chased:
 *   - an aliased/renamed binding (`import { mock as m } from 'bun:test';
 *     m.module(...)`) — recognizing it requires resolving what `m` is
 *     bound to;
 *   - a computed bracket property (`mock[someVar](...)`) — recognizing it
 *     requires resolving `someVar`'s value, i.e. dataflow analysis.
 *
 * Output format (one line per violation):
 *
 *   file:line:col mock.module('<specifier>') — module-level mock outside the central mock registry; see .claude/rules/testing.md Anti-Pattern #2
 *
 * followed by a summary count. Exit 0 when clean, 1 when there are new
 * (non-allowlisted) violations OR stale allowlist entries.
 *
 * Allowlist strategy:
 *
 * `KNOWN_VIOLATIONS` is an exported array of `{ file, specifier, reason }`
 * entries, keyed by `file + specifier` pairs — NOT line numbers. Line-keyed
 * allowlists forced position recalculation twice in one PR (#1009, in the
 * sibling blame-shift checker) when unrelated lines shifted; `file +
 * specifier` keys are stable under drift that doesn't touch the mock call
 * itself.
 *
 * An allowlist entry that no longer matches any detected (non-sanctioned)
 * call is itself a CI failure, reported with a distinct "stale allowlist
 * entry" message. This keeps the allowlist monotonically accurate by
 * structure rather than by header-comment convention.
 *
 * Matching is cardinality-aware: each entry authorizes exactly ONE
 * occurrence of its `(file, specifier)` pair. Two entries sharing the same
 * key authorize two occurrences, and so on — a second, previously-unseen
 * `mock.module()` call added later with the same specifier in the same
 * file is a new violation, not a free ride on an existing entry.
 *
 * Usage:
 *   bun scripts/check-mock-module-poisoners.mjs
 *
 * No CLI file arguments in v1 — the script always scans the full tree, so
 * the `isExcludedFile`-bypass trap documented for the blame-shift checker
 * (explicit file args skipping exclusions) cannot recur here.
 */

import ts from 'typescript';
import { Glob } from 'bun';

const DEFAULT_GLOBS = ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'];

// ---------------------------------------------------------------------------
// Sanctioned locations — the central mock registry. Permanent, intentional
// infrastructure exemption, not debt: deliberately separate from the
// allowlist below. `testing.md` refers to this list by name only (no
// path-list mirror in markdown, to avoid check-mirror-drift-class
// divergence) — this array in this script is the single writer.
// ---------------------------------------------------------------------------
export const SANCTIONED_LOCATIONS = [
  'packages/server/src/__tests__/test-utils.ts',
  'packages/server/src/__tests__/utils/',
];

/**
 * @param {string} file repo-relative path, forward-slash separated
 * @returns {boolean}
 */
export function isSanctionedLocation(file) {
  return SANCTIONED_LOCATIONS.some((loc) =>
    loc.endsWith('/') ? file.startsWith(loc) : file === loc,
  );
}

/**
 * Strip enclosing parentheses from an expression node, e.g. `(mock)` -> `mock`.
 *
 * @param {ts.Expression} node
 * @returns {ts.Expression}
 */
function unwrapParens(node) {
  while (ts.isParenthesizedExpression(node)) {
    node = node.expression;
  }
  return node;
}

/**
 * If `callee` is a static `.module` access — either `x.module` or
 * `x['module']` (any parenthesization of either side) — return the accessed
 * object expression (unwrapped) and the property name. Otherwise `null`.
 *
 * `mock['module'](...)` invokes the same bun:test API as `mock.module(...)`
 * but uses `ElementAccessExpression` instead of `PropertyAccessExpression`;
 * both forms must be recognized so the gate cannot be evaded by switching
 * accessor syntax.
 *
 * @param {ts.Expression} callee
 * @returns {{ obj: ts.Expression, propName: string } | null}
 */
function matchStaticModuleAccess(callee) {
  const expr = unwrapParens(callee);
  if (ts.isPropertyAccessExpression(expr)) {
    return { obj: unwrapParens(expr.expression), propName: expr.name.text };
  }
  if (
    ts.isElementAccessExpression(expr) &&
    expr.argumentExpression &&
    ts.isStringLiteralLike(expr.argumentExpression)
  ) {
    return { obj: unwrapParens(expr.expression), propName: expr.argumentExpression.text };
  }
  return null;
}

/**
 * Parse a source file and return every `mock.module(...)` (or the
 * equivalent `mock['module'](...)` / parenthesized) call site found.
 *
 * Pure function — exported for direct testing.
 *
 * @param {string} source
 * @param {string} fileName repo-relative path (used only to pick the
 *   TSX vs TS scanner mode; not read from disk)
 * @returns {Array<{line: number, col: number, specifier: string}>}
 */
export function findMockModuleCallsInSource(source, fileName) {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKind,
  );

  const calls = [];

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const access = matchStaticModuleAccess(node.expression);
      if (access && access.propName === 'module' && ts.isIdentifier(access.obj) && access.obj.text === 'mock') {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const firstArg = node.arguments[0];
        const specifier =
          firstArg && ts.isStringLiteralLike(firstArg) ? firstArg.text : '<dynamic>';
        calls.push({ line: line + 1, col: character + 1, specifier });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return calls;
}

/**
 * Format a violation for display.
 *
 * @param {{file: string, line: number, col: number, specifier: string}} v
 * @returns {string}
 */
export function formatViolation(v) {
  return `${v.file}:${v.line}:${v.col} mock.module('${v.specifier}') — module-level mock outside the central mock registry; see .claude/rules/testing.md Anti-Pattern #2`;
}

/**
 * Format a stale allowlist entry for display.
 *
 * @param {{file: string, specifier: string}} entry
 * @returns {string}
 */
export function formatStaleEntry(entry) {
  return `${entry.file} mock.module('${entry.specifier}') — stale allowlist entry — remove it in this PR`;
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
      set.add(file);
    }
  }
  return [...set].sort();
}

/**
 * Read a single file from disk and scan it for `mock.module()` calls,
 * excluding sanctioned locations.
 *
 * @param {string} file repo-relative path
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {Promise<Array<{file: string, line: number, col: number, specifier: string}>>}
 */
export async function findViolationsInFile(file, { cwd = process.cwd() } = {}) {
  if (isSanctionedLocation(file)) return [];
  const abs = `${cwd}/${file}`;
  const text = await Bun.file(abs).text();
  return findMockModuleCallsInSource(text, file).map((v) => ({ file, ...v }));
}

/**
 * Allowlist key for a `{file, specifier}`-shaped record (violation or
 * `KNOWN_VIOLATIONS` entry).
 *
 * @param {{file: string, specifier: string}} v
 * @returns {string}
 */
function allowlistKey(v) {
  return `${v.file} ${v.specifier}`;
}

/**
 * Group an array of `{file, specifier}`-shaped records by their allowlist
 * key.
 *
 * @template T
 * @param {T[]} items
 * @returns {Map<string, T[]>}
 */
function groupByAllowlistKey(items) {
  const map = new Map();
  for (const item of items) {
    const key = allowlistKey(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}

/**
 * Run the full check across the default file set (or an explicit list, for
 * tests).
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string[]} [options.files] explicit list (skips the default glob)
 * @param {Array<{file: string, specifier: string, reason: string}>} [options.allowlist]
 * @returns {Promise<{
 *   files: string[],
 *   violations: Array<{file: string, line: number, col: number, specifier: string}>,
 *   newViolations: Array<{file: string, line: number, col: number, specifier: string}>,
 *   allowlisted: Array<{file: string, line: number, col: number, specifier: string}>,
 *   staleEntries: Array<{file: string, specifier: string, reason: string}>,
 * }>}
 */
export async function runCheck({ cwd = process.cwd(), files, allowlist = KNOWN_VIOLATIONS } = {}) {
  const targetFiles = files ?? (await findDefaultFiles({ cwd }));
  const violations = [];
  for (const file of targetFiles) {
    violations.push(...(await findViolationsInFile(file, { cwd })));
  }

  // Cardinality-aware matching: each KNOWN_VIOLATIONS entry authorizes
  // exactly ONE occurrence of its (file, specifier) pair, not unlimited
  // occurrences. A second mock.module() call added later with the same
  // specifier in the same file would otherwise silently ride along on the
  // first entry's allowlisting. Two entries with the same key authorize two
  // occurrences, and so on — entries and violations are paired up in
  // (line, col) order within each key group; any excess on either side is
  // reported (excess violations as new, excess entries as stale).
  const violationsByKey = groupByAllowlistKey(violations);
  const allowlistByKey = groupByAllowlistKey(allowlist);

  const newViolations = [];
  const allowlisted = [];
  const staleEntries = [];

  const allKeys = new Set([...violationsByKey.keys(), ...allowlistByKey.keys()]);
  for (const key of allKeys) {
    const vs = [...(violationsByKey.get(key) ?? [])].sort(
      (a, b) => a.line - b.line || a.col - b.col,
    );
    const entries = allowlistByKey.get(key) ?? [];
    const consumeCount = Math.min(vs.length, entries.length);
    allowlisted.push(...vs.slice(0, consumeCount));
    newViolations.push(...vs.slice(consumeCount));
    if (entries.length > vs.length) {
      staleEntries.push(...entries.slice(vs.length));
    }
  }

  return { files: targetFiles, violations, newViolations, allowlisted, staleEntries };
}

// ---------------------------------------------------------------------------
// KNOWN_VIOLATIONS — see the file header for the allowlist strategy. Keys
// are `file + specifier` pairs. The original 8-entry baseline (enumerated
// against `main` at the time this script landed, Issue 1226) was fully
// converted to DI seam / spyOn / central-registry migration per the
// mock.module()-merge playbook in Issue 1238. Empty now; a new justified
// entry is added the same way -- via the permitted file-exclusive
// exception in `.claude/rules/testing.md` Anti-Pattern #2 -- and removed
// in the same PR that converts it. A stale entry left behind fails CI by
// design.
// ---------------------------------------------------------------------------
export const KNOWN_VIOLATIONS = [];

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

async function main() {
  const result = await runCheck();

  const sortViolations = (vs) =>
    [...vs].sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col,
    );

  const newSorted = sortViolations(result.newViolations);
  for (const v of newSorted) {
    console.log(formatViolation(v));
  }

  const staleSorted = [...result.staleEntries].sort(
    (a, b) => a.file.localeCompare(b.file) || a.specifier.localeCompare(b.specifier),
  );
  for (const entry of staleSorted) {
    console.log(formatStaleEntry(entry));
  }

  const summary = `Found ${result.newViolations.length} new violation${
    result.newViolations.length === 1 ? '' : 's'
  } and ${result.staleEntries.length} stale allowlist entr${
    result.staleEntries.length === 1 ? 'y' : 'ies'
  } (${result.allowlisted.length} allowlisted)`;

  if (result.newViolations.length === 0 && result.staleEntries.length === 0) {
    console.log(summary);
    return 0;
  }
  console.error('');
  console.error(summary);
  console.error(
    'New mock.module() calls outside the central mock registry are not allowed. ' +
      'See .claude/rules/testing.md Anti-Pattern #2.',
  );
  return 1;
}

const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('check-mock-module-poisoners.mjs');
if (isMainModule) {
  process.exit(await main());
}
