#!/usr/bin/env node

/**
 * Mirror Drift Check — COVERAGE_PATTERNS ↔ test-trigger.md
 *
 * The executable single-writer is `COVERAGE_PATTERNS` in `check-utils.js`
 * (consumed by `preflight-check.js`). Its markdown mirror lives in
 * `.claude/rules/test-trigger.md` (auto-loaded rule consumed by agents).
 *
 * The mirror has two encodings inside the same file:
 *   - YAML frontmatter `globs:` list (glob form)
 *   - Markdown table "File Pattern" column (glob form, in backticks)
 *
 * This check normalizes all three sources to a common glob form and
 * asserts set equality. Drift exits non-zero with a per-side report.
 *
 * Normalization rule: every pattern is canonicalized to its glob form.
 *   regex `^DIR\/.+\.EXT$` ↔ glob `DIR/**\/*.EXT`
 * Patterns that do not fit this canonical shape are reported as
 * "unconvertible" so the check fails closed rather than silently passing.
 *
 * Negation entries in the YAML frontmatter (e.g., `!**\/*.test.ts`) are
 * intentionally excluded from comparison: they mirror the `isTestFile()`
 * helper in check-utils.js, not COVERAGE_PATTERNS.
 *
 * Issue: https://github.com/ms2sato/agent-console/issues/752
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { COVERAGE_PATTERNS } from './check-utils.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const TEST_TRIGGER_MD = resolve(REPO_ROOT, '.claude/rules/test-trigger.md');

// --- Conversion ---

/**
 * Convert a regex `source` string of the canonical shape
 *   ^DIR\/.+\.EXT$
 * to its equivalent glob:
 *   DIR/**\/*.EXT
 *
 * Returns null if the regex does not fit this shape, signalling that the
 * caller cannot mechanically compare it against the markdown mirror.
 */
export function regexSourceToGlob(source) {
  // The dir portion may only contain word chars, hyphens, escaped slashes,
  // or escaped dots. This rejects regex constructs like `(a|b)` so an
  // alternation regex falls through to the "unconvertible" bucket.
  const m = source.match(/^\^((?:[\w-]|\\\/|\\\.)+)\\\/\.\+\\(\.\w+)\$$/);
  if (!m) return null;
  const dir = m[1].replace(/\\\//g, '/').replace(/\\\./g, '.');
  return `${dir}/**/*${m[2]}`;
}

// --- Markdown parsing ---

/**
 * Extract positive (non-negated) globs from the YAML `globs:` frontmatter.
 * Negation entries (lines beginning with `!`) are excluded — they mirror
 * `isTestFile()` rather than COVERAGE_PATTERNS.
 */
export function parseFrontmatterGlobs(markdown) {
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const frontmatter = fmMatch[1];
  // Find the `globs:` block: lines under it until a sibling key or EOF.
  const lines = frontmatter.split('\n');
  const out = [];
  let inGlobs = false;
  for (const line of lines) {
    if (/^globs\s*:\s*$/.test(line)) {
      inGlobs = true;
      continue;
    }
    if (inGlobs) {
      // Sibling top-level key (no leading whitespace, contains colon) ends the block.
      if (/^[A-Za-z_][\w-]*\s*:/.test(line)) {
        inGlobs = false;
        continue;
      }
      const itemMatch = line.match(/^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/);
      if (itemMatch && !itemMatch[1].startsWith('!')) {
        out.push(itemMatch[1]);
      }
    }
  }
  return out;
}

/**
 * Extract the first column ("File Pattern") of the markdown table that
 * lives under the "Expected Test File Locations" section. Each cell is
 * expected to be a single backtick-quoted glob.
 */
export function parseMarkdownTablePatterns(markdown) {
  const lines = markdown.split('\n');
  const tableLines = lines.filter((l) => /^\|/.test(l));
  if (tableLines.length === 0) return [];
  // Drop header row and any separator rows (---).
  const dataRows = tableLines.filter((l) => !/^\|[\s|:-]+\|\s*$/.test(l)).slice(1);
  const out = [];
  for (const row of dataRows) {
    const cells = row.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length === 0) continue;
    const m = cells[0].match(/^`([^`]+)`$/);
    if (m) out.push(m[1]);
  }
  return out;
}

// --- Drift detection ---

function setDiff(a, b) {
  return [...a].filter((x) => !b.has(x)).sort();
}

/**
 * Compare COVERAGE_PATTERNS to the markdown mirror's two encodings.
 * Pure function: takes the inputs, returns a structured result.
 */
export function detectDrift({ coveragePatterns, markdown }) {
  const converted = coveragePatterns.map((p) => ({ source: p.source, glob: regexSourceToGlob(p.source) }));
  const unconvertible = converted.filter((p) => p.glob === null).map((p) => p.source);
  const codeGlobs = new Set(converted.filter((p) => p.glob !== null).map((p) => p.glob));
  const tableGlobs = new Set(parseMarkdownTablePatterns(markdown));
  const yamlGlobs = new Set(parseFrontmatterGlobs(markdown));

  const diffs = {
    codeMissingFromTable: setDiff(codeGlobs, tableGlobs),
    tableMissingFromCode: setDiff(tableGlobs, codeGlobs),
    codeMissingFromYaml: setDiff(codeGlobs, yamlGlobs),
    yamlMissingFromCode: setDiff(yamlGlobs, codeGlobs),
  };

  const hasDrift =
    unconvertible.length > 0 ||
    diffs.codeMissingFromTable.length > 0 ||
    diffs.tableMissingFromCode.length > 0 ||
    diffs.codeMissingFromYaml.length > 0 ||
    diffs.yamlMissingFromCode.length > 0;

  return { hasDrift, unconvertible, codeGlobs, tableGlobs, yamlGlobs, diffs };
}

/**
 * Render the result as a unified diff-style report. Lines prefixed with
 * `+` are present in the executable side and missing from the mirror;
 * `-` are present in the mirror and missing from the executable side.
 */
export function formatReport(result) {
  if (!result.hasDrift) {
    return '✅ COVERAGE_PATTERNS and test-trigger.md are in sync.';
  }
  const out = [];
  out.push('❌ Mirror drift detected between COVERAGE_PATTERNS and test-trigger.md');
  out.push('');
  if (result.unconvertible.length > 0) {
    out.push('Unconvertible regex patterns (not in canonical "^DIR\\/.+\\.EXT$" form):');
    for (const src of result.unconvertible) out.push(`  ! ${src}`);
    out.push('');
    out.push('  Either reshape the regex to the canonical form, or extend');
    out.push('  regexSourceToGlob() in check-mirror-drift.js to handle the new shape.');
    out.push('');
  }
  const sections = [
    ['In COVERAGE_PATTERNS, missing from markdown table:', result.diffs.codeMissingFromTable, '+'],
    ['In markdown table, missing from COVERAGE_PATTERNS:', result.diffs.tableMissingFromCode, '-'],
    ['In COVERAGE_PATTERNS, missing from YAML globs:', result.diffs.codeMissingFromYaml, '+'],
    ['In YAML globs, missing from COVERAGE_PATTERNS:', result.diffs.yamlMissingFromCode, '-'],
  ];
  for (const [title, list, sigil] of sections) {
    if (list.length === 0) continue;
    out.push(title);
    for (const g of list) out.push(`  ${sigil} ${g}`);
    out.push('');
  }
  out.push('Update test-trigger.md to mirror COVERAGE_PATTERNS, or vice versa.');
  out.push('Canonical source: .claude/skills/orchestrator/check-utils.js (COVERAGE_PATTERNS).');
  out.push('Mirror: .claude/rules/test-trigger.md (markdown table + YAML globs frontmatter).');
  return out.join('\n');
}

// --- Entry point ---

export function run() {
  const markdown = readFileSync(TEST_TRIGGER_MD, 'utf-8');
  const result = detectDrift({ coveragePatterns: COVERAGE_PATTERNS, markdown });
  const report = formatReport(result);
  if (result.hasDrift) {
    console.error(report);
    return 1;
  }
  console.log(report);
  return 0;
}

const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('check-mirror-drift.js');
if (isMainModule) {
  process.exit(run());
}

export { TEST_TRIGGER_MD, REPO_ROOT };
