#!/usr/bin/env node

/**
 * Glossary term checker.
 *
 * Mechanically covers the two enumerable classes of glossary drift:
 *
 *   A. Terminology-section terms (glossary-maintenance trigger 5): every
 *      term declared in a top-level `## Terminology` section of a
 *      `docs/design/*.md` file must be defined in `docs/glossary.md`.
 *      Terms are top-level bullets of the form `- **Term**:` / `- **Term** --`
 *      and `### Term` headings inside the section. Table cells, nested
 *      bullets, and fenced code are not terms.
 *   B. Glossary self-consistency: two entries must not share a normalised
 *      heading, and an `Aliases` value must not equal a DIFFERENT entry's
 *      heading. An alias equal to its own entry's heading is exempt.
 *
 * Exported types, MCP parameters, DB columns, and prose in rules are NOT
 * covered: their candidate set is not enumerable without a term judgment,
 * so they stay with the manual acceptance-check Q9.
 *
 * A term is "defined" when its normalised form equals the normalised form of
 * a glossary `### ` heading, of a comma-separated value on an
 * `- **Aliases:**` line, or of a backticked identifier inside a heading.
 * Normalisation: strip backticks and surrounding quotes, cut a heading at
 * ` -- ` / ` (`, trim, lowercase. Matching is exact, never substring.
 *
 * Exit codes:
 *   0 = clean
 *   1 = at least one violation (printed, one per line, `file:LINE term`)
 *   2 = a required file could not be read
 *
 * Usage:
 *   node scripts/check-glossary-terms.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFenceMask } from './check-doc-fragments.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const GLOSSARY_PATH = 'docs/glossary.md';
const DESIGN_DIR = 'docs/design';

/**
 * Terminology terms that are deliberately NOT glossary concepts. Keyed
 * `file :: term` (term as written in the source doc, before normalisation);
 * every entry needs a non-empty `reason`. This is exclusion-of-legitimate-data,
 * not a violation baseline: do not add a real domain concept here, define it
 * in the glossary instead.
 *
 * @type {ReadonlyArray<{key: string, reason: string}>}
 */
export const ALLOWLISTED_TERMS = [
  {
    key: 'docs/design/session-data-path.md :: DB column names',
    reason: 'Naming-convention label for the spelling of column names in this document, not a domain concept.',
  },
  {
    key: 'docs/design/session-data-path.md :: TypeScript field names',
    reason: 'Naming-convention label for the spelling of TypeScript fields in this document, not a domain concept.',
  },
  {
    key: 'docs/design/session-data-path.md :: Scope values',
    reason: 'Naming-convention label for the spelling of scope literals in this document; the concept itself is defined under Session Data Address.',
  },
  {
    key: 'docs/design/session-data-path.md :: "Canonical path"',
    reason: 'Document-local definition of a path-resolution convention (path.resolve, not realpath), not a project-wide domain concept.',
  },
];

// --- Pure helpers ---

/**
 * Normalise a term or heading for matching: strip backticks, strip
 * surrounding quotes, cut at ` -- ` (em dash) / ` (`, trim, lowercase.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeTerm(text) {
  let t = text.replace(/`/g, '');
  const cut = t.search(/ — | \(/);
  if (cut !== -1) t = t.slice(0, cut);
  t = t.trim();
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
  return t.trim().toLowerCase();
}

/**
 * Extract the terms declared in a document's `## Terminology` section.
 *
 * @param {string} content
 * @returns {Array<{term: string, line: number}>} term is as written (markup stripped, not normalised)
 */
export function extractTerminologyTerms(content) {
  const lines = content.split('\n');
  const fenceMask = computeFenceMask(lines);
  const terms = [];
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    if (fenceMask[i]) continue;
    const line = lines[i];
    if (/^## /.test(line)) {
      inSection = /^## Terminology\s*$/.test(line);
      continue;
    }
    if (!inSection) continue;
    const h = /^### (.+?)\s*$/.exec(line);
    if (h) {
      terms.push({ term: h[1], line: i + 1 });
      continue;
    }
    // Top-level bullet only: no leading indentation.
    const b = /^[-*] \*\*(.+?)\*\*\s*(?::|—|-{1,2})/.exec(line);
    if (b) {
      // Strip a trailing colon the closing marker may have swallowed: `**Term:**`.
      terms.push({ term: b[1].replace(/:$/, ''), line: i + 1 });
    }
  }
  return terms;
}

/**
 * Parse the glossary into entries.
 *
 * @param {string} content
 * @returns {Array<{heading: string, line: number, headingKey: string, extraKeys: string[], aliases: Array<{raw: string, key: string, line: number}>}>}
 */
export function parseGlossaryEntries(content) {
  const lines = content.split('\n');
  const fenceMask = computeFenceMask(lines);
  const entries = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    if (fenceMask[i]) continue;
    const line = lines[i];
    const h = /^### (.+?)\s*$/.exec(line);
    if (h) {
      const heading = h[1];
      const extraKeys = [];
      for (const m of heading.matchAll(/`([^`]+)`/g)) {
        const k = normalizeTerm(m[1]);
        if (k) extraKeys.push(k);
      }
      current = { heading, line: i + 1, headingKey: normalizeTerm(heading), extraKeys, aliases: [] };
      entries.push(current);
      continue;
    }
    if (/^#{1,2} /.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const a = /^- \*\*Aliases:\*\*\s*(.*)$/.exec(line);
    if (a) {
      for (const raw of splitAliases(a[1])) {
        const key = normalizeTerm(raw);
        if (key) current.aliases.push({ raw, key, line: i + 1 });
      }
    }
  }
  return entries;
}

/**
 * Split an Aliases value on commas / semicolons that are outside
 * parentheses and backticks.
 *
 * @param {string} value
 * @returns {string[]}
 */
function splitAliases(value) {
  const parts = [];
  let depth = 0;
  let inTick = false;
  let cur = '';
  for (const ch of value) {
    if (ch === '`') inTick = !inTick;
    if (!inTick) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if ((ch === ',' || ch === ';') && depth === 0) {
        parts.push(cur);
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/**
 * Set of normalised strings the glossary defines.
 *
 * @param {ReturnType<typeof parseGlossaryEntries>} entries
 * @returns {Set<string>}
 */
export function buildDefinedSet(entries) {
  const defined = new Set();
  for (const e of entries) {
    if (e.headingKey) defined.add(e.headingKey);
    for (const k of e.extraKeys) defined.add(k);
    for (const a of e.aliases) defined.add(a.key);
  }
  return defined;
}

/**
 * Class B: glossary self-consistency violations.
 *
 * @param {ReturnType<typeof parseGlossaryEntries>} entries
 * @param {string} glossaryRel
 * @returns {Array<{file: string, line: number, term: string, reason: string}>}
 */
export function checkGlossaryConsistency(entries, glossaryRel) {
  const violations = [];
  const firstByHeading = new Map();
  for (const e of entries) {
    if (!e.headingKey) continue;
    const first = firstByHeading.get(e.headingKey);
    if (first) {
      violations.push({
        file: glossaryRel,
        line: e.line,
        term: e.heading,
        reason: `duplicate glossary heading (first at line ${first.line})`,
      });
    } else {
      firstByHeading.set(e.headingKey, e);
    }
  }
  for (const e of entries) {
    for (const a of e.aliases) {
      const owner = firstByHeading.get(a.key);
      // `owner !== e` exempts a self-alias (a case/quote variant of the entry's own heading).
      if (owner && owner !== e) {
        violations.push({
          file: glossaryRel,
          line: a.line,
          term: a.raw,
          reason: `alias of "${e.heading}" equals the heading of a different entry (line ${owner.line})`,
        });
      }
    }
  }
  return violations;
}

/**
 * Run the full check.
 *
 * @param {object} options
 * @param {string} options.cwd repo root
 * @param {string} [options.glossaryPath]
 * @param {string} [options.designDir]
 * @param {ReadonlyArray<{key: string, reason: string}>} [options.allowlist]
 * @returns {{violations: Array<{file: string, line: number, term: string, reason: string}>, docsScanned: number}}
 */
export function checkGlossaryTerms({
  cwd,
  glossaryPath = GLOSSARY_PATH,
  designDir = DESIGN_DIR,
  allowlist = ALLOWLISTED_TERMS,
}) {
  const glossaryContent = readFileSync(resolve(cwd, glossaryPath), 'utf8');
  const entries = parseGlossaryEntries(glossaryContent);
  const defined = buildDefinedSet(entries);
  const allowed = new Set(allowlist.map((a) => a.key));

  const violations = [...checkGlossaryConsistency(entries, glossaryPath)];

  const absDir = resolve(cwd, designDir);
  const docs = readdirSync(absDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => d.name)
    .sort();
  for (const name of docs) {
    const rel = relative(cwd, join(absDir, name));
    const content = readFileSync(join(absDir, name), 'utf8');
    for (const { term, line } of extractTerminologyTerms(content)) {
      if (allowed.has(`${rel} :: ${term}`)) continue;
      if (defined.has(normalizeTerm(term))) continue;
      violations.push({ file: rel, line, term, reason: 'Terminology term has no docs/glossary.md entry' });
    }
  }
  return { violations, docsScanned: docs.length };
}

// --- CLI ---

function main() {
  let result;
  try {
    result = checkGlossaryTerms({ cwd: REPO_ROOT });
  } catch (err) {
    console.error(`FAIL — ${err instanceof Error ? err.message : err}`);
    return 2;
  }
  if (result.violations.length === 0) {
    console.log(`OK — glossary term check clean (${result.docsScanned} design doc(s) scanned).`);
    return 0;
  }
  for (const v of result.violations) console.log(`${v.file}:${v.line}  ${v.term} -> ${v.reason}`);
  console.error('');
  console.error(`FAIL — ${result.violations.length} glossary violation${result.violations.length === 1 ? '' : 's'} found.`);
  return 1;
}

if (import.meta.main) {
  process.exitCode = main();
}
