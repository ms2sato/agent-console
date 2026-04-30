#!/usr/bin/env bun

/**
 * Language-agnostic ASCII / Latin-script lint for public artifacts.
 *
 * Per .claude/rules/workflow.md "Language Policy", all public artifacts
 * (docs, rules, skills, agents, top-level project docs) must be written
 * in English. This script enforces that mechanically by detecting any
 * Letter character (\p{L}) that does NOT belong to Latin / Greek / Cyrillic
 * scripts. The detection is language-agnostic: it does not hard-code
 * Japanese or any specific writing system; it allows the Latin family
 * (English, French, German, Vietnamese, ...) and the technical extensions
 * (Greek for math, Cyrillic for diff names) and rejects everything else.
 *
 * Output format (one violation per line):
 *   path/to/file.md:LINE:COL CHAR U+CODEPOINT
 *
 * Exit code:
 *   0 = no violations
 *   1 = at least one violation found (or unexpected error)
 *
 * Usage:
 *   bun scripts/check-public-artifacts-language.mjs
 *   bun scripts/check-public-artifacts-language.mjs path/to/file.md ...
 *   bun scripts/check-public-artifacts-language.mjs --stdin < file.txt
 *
 * In --stdin mode, the input is treated as a single virtual file named
 * `<stdin>` and reported using the same `<filename>:LINE:COL CHAR U+CODEPOINT`
 * format. This mode powers the commit-msg git hook (see scripts/git-hooks/).
 */

import { Glob } from 'bun';

const VIOLATION_RE = /(?=\p{L})(?![\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])./gu;

const DEFAULT_PATTERNS = [
  'CLAUDE.md',
  'docs/**/*.md',
  '.claude/rules/**/*.md',
  '.claude/skills/**/*.md',
  '.claude/agents/**/*.md',
];

/**
 * Find non-Latin-script Letter characters in a single string.
 * Pure function — no I/O, fully testable.
 *
 * @param {string} text
 * @returns {Array<{line: number, col: number, char: string, codepoint: string}>}
 *   line and col are 1-based. col is a UTF-16 code-unit offset within the
 *   line (matches what most editors display in their gutter).
 */
export function findViolationsInText(text) {
  const violations = [];
  if (text.length === 0) return violations;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const re = new RegExp(VIOLATION_RE.source, VIOLATION_RE.flags);
    let match;
    while ((match = re.exec(line)) !== null) {
      const char = match[0];
      const cp = char.codePointAt(0);
      const codepoint = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
      violations.push({
        line: i + 1,
        col: match.index + 1,
        char,
        codepoint,
      });
    }
  }
  return violations;
}

/**
 * Resolve the default target file list using Bun.Glob.
 *
 * @param {object} [options]
 * @param {string} [options.cwd] working directory (default: process.cwd())
 * @returns {Promise<string[]>} repo-relative file paths, deduplicated, sorted
 */
export async function findDefaultFiles({ cwd = process.cwd() } = {}) {
  const set = new Set();
  for (const pattern of DEFAULT_PATTERNS) {
    const glob = new Glob(pattern);
    // dot: true is required to scan into .claude/ — Bun.Glob otherwise skips
    // hidden directories. The patterns themselves explicitly name .claude.
    for await (const file of glob.scan({ cwd, onlyFiles: true, dot: true })) {
      set.add(file);
    }
  }
  return [...set].sort();
}

/**
 * Read a file and find its violations.
 *
 * @param {string} file repo-relative path
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {Promise<Array<{line, col, char, codepoint}>>}
 */
export async function findViolationsInFile(file, { cwd = process.cwd() } = {}) {
  const abs = `${cwd}/${file}`;
  const text = await Bun.file(abs).text();
  return findViolationsInText(text);
}

/**
 * Format a violation list as one line per violation.
 *
 * @param {string} file
 * @param {Array<{line, col, char, codepoint}>} violations
 * @returns {string[]} array of formatted lines (no trailing newline)
 */
export function formatFileViolations(file, violations) {
  return violations.map(
    (v) => `${file}:${v.line}:${v.col} ${v.char} ${v.codepoint}`,
  );
}

/**
 * Run the full check across the default file set (or an explicit list).
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string[]} [options.files] explicit file list (skips glob)
 * @returns {Promise<{
 *   files: string[],
 *   violations: Array<{file: string, line: number, col: number, char: string, codepoint: string}>,
 *   filesWithViolations: number,
 * }>}
 */
export async function runCheck({ cwd = process.cwd(), files } = {}) {
  const targetFiles = files ?? (await findDefaultFiles({ cwd }));
  const violations = [];
  const offenders = new Set();
  for (const file of targetFiles) {
    const fileViolations = await findViolationsInFile(file, { cwd });
    if (fileViolations.length > 0) offenders.add(file);
    for (const v of fileViolations) {
      violations.push({ file, ...v });
    }
  }
  return {
    files: targetFiles,
    violations,
    filesWithViolations: offenders.size,
  };
}

/**
 * Read all of process.stdin as a UTF-8 string.
 *
 * @param {NodeJS.ReadableStream} [stream]
 * @returns {Promise<string>}
 */
export async function readStreamAsText(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Scan a single text blob (typically a commit-msg file piped via stdin) and
 * return per-line formatted violation lines plus a summary.
 *
 * Pure function — no I/O — so tests can exercise it directly without spawning
 * a subprocess to feed stdin. The CLI wrapper layers I/O on top.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.label] virtual filename used in the output prefix (default: `<stdin>`)
 * @returns {{ violations: Array<{file: string, line: number, col: number, char: string, codepoint: string}>, lines: string[] }}
 */
export function checkStdinText(text, { label = '<stdin>' } = {}) {
  const found = findViolationsInText(text);
  const violations = found.map((v) => ({ file: label, ...v }));
  const lines = formatFileViolations(label, found);
  return { violations, lines };
}

async function runStdinMode() {
  const text = await readStreamAsText();
  const { violations, lines } = checkStdinText(text);
  if (violations.length === 0) return 0;
  for (const line of lines) console.log(line);
  console.error('');
  console.error(
    `FAIL — ${violations.length} violation${violations.length === 1 ? '' : 's'} in commit message / stdin input.`,
  );
  console.error(
    'Commit messages and other public artifacts must be written in English. ' +
      'See .claude/rules/workflow.md "Language Policy".',
  );
  return 1;
}

async function main(argv) {
  const args = argv.slice(2);
  const useStdin = args.includes('--stdin');
  if (useStdin) return runStdinMode();

  const explicit = args.filter((a) => !a.startsWith('-'));
  const result = await runCheck({
    files: explicit.length > 0 ? explicit : undefined,
  });

  if (result.violations.length === 0) {
    console.log(
      `OK — language check clean (${result.files.length} file${result.files.length === 1 ? '' : 's'} scanned).`,
    );
    return 0;
  }

  for (const v of result.violations) {
    console.log(`${v.file}:${v.line}:${v.col} ${v.char} ${v.codepoint}`);
  }
  console.error('');
  console.error(
    `FAIL — ${result.violations.length} violation${result.violations.length === 1 ? '' : 's'} ` +
      `in ${result.filesWithViolations} file${result.filesWithViolations === 1 ? '' : 's'}.`,
  );
  console.error(
    'Public artifacts (docs, rules, skills, agents) must be written in English. ' +
      'See .claude/rules/workflow.md "Language Policy".',
  );
  return 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-public-artifacts-language.mjs');
if (isMain) {
  process.exit(await main(process.argv));
}
