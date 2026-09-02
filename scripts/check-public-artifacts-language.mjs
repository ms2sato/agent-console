#!/usr/bin/env bun

/**
 * Language-agnostic ASCII / Latin-script lint for public artifacts.
 *
 * Per .claude/rules/workflow.md "Language Policy", all public artifacts
 * (docs, rules, skills, agents, top-level project docs) must be written
 * in English. This script enforces that mechanically by detecting any
 * Letter character (\p{L}) that does NOT belong to the Latin script.
 * The detection is language-agnostic: it does not hard-code Japanese or
 * any specific writing system; it allows the Latin family (English,
 * French, German, Vietnamese, ...) and rejects everything else,
 * including Greek and Cyrillic.
 *
 * Scope: the target file set is root-based, not extension-based. Every
 * file under `docs/`, `.claude/`, `scripts/`, and the top-level
 * `CLAUDE.md` is scanned, regardless of extension. Roots are the
 * Language Policy's own subject and stay stable; an extension list is an
 * enumeration of instances that silently misses new instances (this is
 * exactly the gap this scope closes — shell scripts under `.claude/hooks`
 * and `.mjs` scripts under `scripts` were never scanned by the previous
 * extension list).
 * Binary / non-UTF-8 files are excluded by CONTENT (a fatal UTF-8 decode
 * failure in findViolationsInFile), never by an extension list — see
 * that function. Files whose non-Latin content is intentional data
 * (fixtures, or Language Policy's own "User-facing artifacts" carve-out)
 * are excluded by explicit, reasoned entry in EXCLUDED_FILES below —
 * distinct from the binary skip, because these files ARE readable text.
 *
 * Greek and Cyrillic used to be blanket-allowed (Greek for math notation,
 * Cyrillic for quoted diff-name identifiers), but that allowance let a
 * whole Cyrillic word substituted for its English look-alike inside
 * otherwise-English prose pass silently — a mixed-script rule would have
 * caught only a mixed-script *token*, not a wholly non-Latin word standing
 * alone in a sentence. The allowance is gone;
 * a legitimate non-Latin character on a specific line (e.g. a deliberate
 * homograph-attack example) is exempted per-line via the escape marker
 * below instead.
 *
 * Per-line escape marker: a line containing the literal substring
 * `lang-check:allow` is skipped entirely by the scan — no character on
 * that line is checked, regardless of script. This is a loud,
 * review-visible per-line override (the marker itself is plainly visible
 * in the source and the diff — the common usage pattern is an HTML
 * comment, e.g. `<!-- lang-check:allow -->`, which stays visible there
 * even though HTML comments are not rendered in Markdown output), not a
 * silent blanket allowance and not a separate allowlist file. Use it
 * sparingly, only where the non-Latin content is itself the point (e.g.
 * a homograph example).
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

const VIOLATION_RE = /(?=\p{L})(?!\p{Script=Latin})./gu;

/**
 * A line containing this literal substring is fully exempted from the
 * scan — see the "Per-line escape marker" section in the header comment
 * above for the rationale.
 */
const ESCAPE_MARKER = 'lang-check:allow';

const DEFAULT_PATTERNS = [
  'CLAUDE.md',
  'docs/**',
  '.claude/**',
  'scripts/**',
];

/**
 * Files intentionally excluded from the language scan, with a mandatory
 * stated reason per entry (enforced by a sibling test — an entry without
 * a reason fails review). Every file listed here is fully readable text;
 * it is excluded because of what its content IS, not because it cannot
 * be decoded (that is the separate binary skip in findViolationsInFile).
 *
 * Two reason classes appear below:
 *
 * - "checker fixture": the file is this language checker's OWN test
 *   data. Its non-Latin content is deliberately the thing under test,
 *   not prose that should be English.
 * - "user-facing carve-out": workflow.md's Language Policy explicitly
 *   distinguishes "Public artifacts" (code, comments, docs — must be
 *   English) from "User-facing artifacts" ("Review annotations, memos,
 *   and other content visible only to the user" — follows the user's
 *   preferred language). A letter-based whole-file scan cannot separate
 *   those two layers when both live in the same source file; the policy
 *   itself already permits the split, this list just names where it
 *   currently occurs.
 */
export const EXCLUDED_FILES = [
  {
    file: 'scripts/__tests__/check-public-artifacts-language.test.mjs',
    reason:
      "checker fixture: this file's own test cases deliberately contain " +
      'Greek, Cyrillic, Han, Hangul, Arabic, Hebrew, Devanagari, Thai, ' +
      'Hiragana, and Katakana sample text to exercise ' +
      'findViolationsInText detection paths across scripts. The ' +
      'non-Latin content is the thing under test, not a policy violation.',
  },
  {
    file: '.claude/skills/orchestrator/__tests__/check-utils.test.js',
    reason:
      "checker fixture: exercises runLanguageCheck's violation-reporting " +
      'path end-to-end via a fixture file whose content includes a ' +
      'two-character Japanese sample word; deliberate test data for ' +
      'this checker family, not a policy violation.',
  },
  {
    file: '.claude/skills/orchestrator/acceptance-check.js',
    reason:
      "user-facing carve-out: getQuestions()'s review-question text is " +
      'displayed interactively to the owner during an Orchestrator PR ' +
      'acceptance-review session — workflow.md Language Policy ' +
      '"User-facing artifacts" (content visible only to the user follows ' +
      "the user's preferred language), not public documentation. " +
      "Residual, accepted: this whole-file exclusion also hides this " +
      "file's own code comments and identifiers from the scan — a real " +
      'non-English comment landing here today would not be caught. ' +
      're-arm condition: if that ships, the fix is NOT a per-line pragma ' +
      '— extract the user-facing strings into a separate excluded data ' +
      'module and let this logic file re-join the scanned set (structure ' +
      'over convention, matching design-principles.md).',
  },
  {
    file: '.claude/skills/orchestrator/sprint-retro.js',
    reason:
      "user-facing carve-out: getSteps()'s retro step instructions are " +
      'displayed interactively to the owner during an Orchestrator retro ' +
      "session — same workflow.md \"User-facing artifacts\" carve-out as " +
      "acceptance-check.js's entry above. Residual, accepted, and " +
      're-arm condition: identical to that entry — extract to a data ' +
      'module rather than adding a pragma if a real comment/identifier ' +
      'violation ships here.',
  },
  {
    file: '.claude/skills/orchestrator/__tests__/acceptance-check.test.js',
    reason:
      'user-facing carve-out: asserts the exact Japanese review-question ' +
      "substrings defined in acceptance-check.js's q2Extra text; " +
      'necessarily carries the same excluded content as the file it ' +
      'tests.',
  },
];

/**
 * @param {string} file repo-relative path, as returned by findDefaultFiles
 * @returns {boolean}
 */
export function isExcludedFile(file) {
  return EXCLUDED_FILES.some((entry) => entry.file === file);
}

/**
 * Strip a leading `./` (or repeated `./`) so an explicit CLI-supplied path
 * like `./.claude/skills/orchestrator/sprint-retro.js` compares equal to
 * the bare repo-relative form Bun.Glob produces and EXCLUDED_FILES uses.
 * Only the explicit `files` argument to runCheck can carry this prefix —
 * findDefaultFiles's glob output never does — but exclusion matching must
 * be uniform regardless of how a file was targeted (see runCheck below).
 *
 * @param {string} file
 * @returns {string}
 */
function normalizeRelativePath(file) {
  return file.replace(/^(?:\.\/)+/, '');
}

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
    if (line.includes(ESCAPE_MARKER)) continue;
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
 * Binary / non-UTF-8 files are excluded by CONTENT here: the raw bytes
 * are decoded with a fatal UTF-8 TextDecoder, and a decode failure is
 * treated as "not scannable text" and returns no violations. This is
 * deliberately NOT an extension-based skip (R2) — a text file that
 * merely contains a stray NUL byte (e.g. a poisoner test fixture) still
 * decodes as valid UTF-8 and is fully scanned; `Bun.file().text()` is
 * NOT used here because it silently mis-decodes invalid byte sequences
 * (e.g. UTF-16-looking garbage) instead of throwing, which would let
 * genuine binary content pass through unnoticed.
 *
 * @param {string} file repo-relative path
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {Promise<Array<{line, col, char, codepoint}>>}
 */
export async function findViolationsInFile(file, { cwd = process.cwd() } = {}) {
  const abs = `${cwd}/${file}`;
  const bytes = await Bun.file(abs).arrayBuffer();
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return [];
  }
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
 * EXCLUDED_FILES is applied here — uniformly, regardless of whether the
 * file list came from the default glob or was passed explicitly — so an
 * excluded file is never flagged no matter how it was targeted.
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
  const candidateFiles = files ?? (await findDefaultFiles({ cwd }));
  // normalizeRelativePath is applied only to the exclusion predicate, not
  // to the paths used for scanning or reporting — a non-excluded caller
  // path like `./docs/a.md` must still be scanned and reported verbatim
  // as `./docs/a.md`, not silently rewritten to `docs/a.md`.
  const targetFiles = candidateFiles.filter((f) => !isExcludedFile(normalizeRelativePath(f)));
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
