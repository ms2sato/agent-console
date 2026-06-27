import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KNOWN_VIOLATIONS,
  findViolationsInSource,
  findDefaultFiles,
  formatViolation,
  isExcludedFile,
  runCheck,
  tokenizeComments,
  violationKey,
} from '../check-source-comment-blame-shift.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/check-source-comment-blame-shift.mjs');

describe('tokenizeComments — comment recognition', () => {
  it('yields nothing for code with no comments', () => {
    const out = [...tokenizeComments(`const x = 1;\nlet y = 2;`)];
    expect(out).toEqual([]);
  });

  it('yields a line comment with its text and start position', () => {
    const source = `const x = 1; // hello world\n`;
    const out = [...tokenizeComments(source)];
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('line');
    expect(out[0].text).toBe(' hello world');
    expect(out[0].line).toBe(1);
    // `//` is at col 14, text starts at col 16
    expect(out[0].col).toBe(16);
  });

  it('yields one chunk per line for a multi-line block comment', () => {
    const source = `/* line1\n   line2\n */\n`;
    const out = [...tokenizeComments(source)];
    expect(out).toHaveLength(3);
    expect(out.map((c) => c.kind)).toEqual(['block', 'block', 'block']);
    expect(out[0].text).toBe(' line1');
    expect(out[1].text).toBe('   line2');
    expect(out[2].text).toBe(' ');
    expect(out[0].line).toBe(1);
    expect(out[1].line).toBe(2);
    expect(out[2].line).toBe(3);
  });

  it('does not enter a comment inside a double-quoted string', () => {
    const source = `const url = "https://example.com // not a comment";\n// real comment\n`;
    const out = [...tokenizeComments(source)];
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(' real comment');
  });

  it('does not enter a comment inside a single-quoted string', () => {
    const source = `const s = '// fake'; // real\n`;
    const out = [...tokenizeComments(source)];
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(' real');
  });

  it('does not enter a comment inside a template literal', () => {
    const source =
      'const t = `// not a comment ${1 + 1}`; // real\n';
    const out = [...tokenizeComments(source)];
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(' real');
  });

  it('does not enter a line comment inside a regex literal', () => {
    const source = `const re = /^https?:\\/\\//;\n// real\n`;
    const out = [...tokenizeComments(source)];
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(' real');
  });

  it('handles escaped quotes inside strings', () => {
    const source = `const s = "he said \\"// not a comment\\""; // real\n`;
    const out = [...tokenizeComments(source)];
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(' real');
  });

  it('recognises JSDoc /** ... */ as a block comment', () => {
    const source = `/**\n * Hello\n */\n`;
    const out = [...tokenizeComments(source)];
    expect(out).toHaveLength(3);
    expect(out[1].text).toBe(' * Hello');
  });
});

describe('findViolationsInSource — positive cases', () => {
  it('detects Issue #NNN inside a line comment', () => {
    const source = `// Issue #123 fix\nconst x = 1;\n`;
    const out = findViolationsInSource(source);
    expect(out).toEqual([{ line: 1, col: 4, pattern: 'issue-ref' }]);
  });

  it('detects PR #NNN inside a line comment', () => {
    const source = `// see PR #456\n`;
    const out = findViolationsInSource(source);
    expect(out).toEqual([{ line: 1, col: 8, pattern: 'pr-ref' }]);
  });

  it('detects bare-ref `// #NNN` at the start of line-comment content', () => {
    // `// #838 / PR #843, foo` — col positions:
    //  1:`/` 2:`/` 3:` ` 4:`#` 5:`8` 6:`3` 7:`8` 8:` `
    //  9:`/` 10:` ` 11:`P` 12:`R` 13:` ` 14:`#` ...
    const source = `// #838 / PR #843, foo\n`;
    const out = findViolationsInSource(source);
    expect(out).toEqual([
      { line: 1, col: 4, pattern: 'bare-ref' },
      { line: 1, col: 11, pattern: 'pr-ref' },
    ]);
  });

  it('does NOT report bare-ref when `#` is preceded by other content', () => {
    const source = `// see #999\n`;
    const out = findViolationsInSource(source);
    expect(out).toEqual([]);
  });

  it('does NOT report bare-ref when `#NNN` is followed by a letter (no word boundary)', () => {
    const source = `// #999abc not a ref\n`;
    const out = findViolationsInSource(source);
    expect(out).toEqual([]);
  });

  it('does NOT report bare-ref for block comments (line-comment only per spec)', () => {
    const source = `/* #999 ref */\n`;
    const out = findViolationsInSource(source);
    expect(out).toEqual([]);
  });

  it('detects CodeRabbit with comma + date', () => {
    const source = `// Lesson: CodeRabbit, 2026-04-25 review\n`;
    const out = findViolationsInSource(source);
    expect(out).toHaveLength(1);
    expect(out[0].pattern).toBe('coderabbit-dated');
  });

  it('detects CodeRabbit with space + date', () => {
    const source = `// CodeRabbit 2026-04-25 caught this\n`;
    const out = findViolationsInSource(source);
    expect(out).toHaveLength(1);
    expect(out[0].pattern).toBe('coderabbit-dated');
  });

  it('does NOT flag bare CodeRabbit references without a date', () => {
    const source = `// per CodeRabbit review\n`;
    const out = findViolationsInSource(source);
    expect(out).toEqual([]);
  });

  it('detects Issue #NNN anywhere inside a JSDoc block (pattern 5)', () => {
    const source = `/**\n * Description.\n * Issue #777 reference.\n */\n`;
    const out = findViolationsInSource(source);
    expect(out).toEqual([{ line: 3, col: 4, pattern: 'issue-ref' }]);
  });

  it('detects PR #NNN inside a JSDoc block', () => {
    const source = `/**\n * From PR #321.\n */\n`;
    const out = findViolationsInSource(source);
    // Line 2: ` * From PR #321.` -- 1:` ` 2:`*` 3:` ` 4:`F` ... 9:`P`
    expect(out).toEqual([{ line: 2, col: 9, pattern: 'pr-ref' }]);
  });

  it('detects multiple matches on the same line in order', () => {
    const source = `// see Issue #1 and PR #2\n`;
    const out = findViolationsInSource(source);
    expect(out).toEqual([
      { line: 1, col: 8, pattern: 'issue-ref' },
      { line: 1, col: 21, pattern: 'pr-ref' },
    ]);
  });

  it('reports each match across multiple comment lines', () => {
    const source = `// Issue #1\nconst x = 1;\n// PR #2\n`;
    const out = findViolationsInSource(source);
    expect(out).toEqual([
      { line: 1, col: 4, pattern: 'issue-ref' },
      { line: 3, col: 4, pattern: 'pr-ref' },
    ]);
  });
});

describe('findViolationsInSource — negative cases (no false positives)', () => {
  it('does NOT flag string literals containing `// Issue #N`', () => {
    const source = `const note = "// Issue #123 in string"; const x = 1;\n`;
    const out = findViolationsInSource(source);
    expect(out).toEqual([]);
  });

  it('does NOT flag string literals containing a URL with #N fragment', () => {
    const source = `const url = "https://github.com/foo/bar/issues/123";\n`;
    const out = findViolationsInSource(source);
    expect(out).toEqual([]);
  });

  it('does NOT flag the detector script (the patterns are code, not comments)', async () => {
    // The detector script itself contains regex source strings like
    // `/Issue #\d+/g` and pattern names like `'issue-ref'`. Those live in
    // code (regex literals and string literals), not comments — so the
    // detector run against itself must not flag them.
    const source = await Bun.file(SCRIPT_PATH).text();
    const out = findViolationsInSource(source);
    // The script's own doc comments DO contain "Issue 898" (no `#`) and
    // pattern descriptions like "Issue #NNN" with literal "NNN" (letters,
    // not digits). Neither matches the detector's regex. Sanity-check
    // there are zero flagged violations.
    expect(out).toEqual([]);
  });

  it('does NOT flag template literal contents', () => {
    const source = 'const msg = `// Issue #123 in template`;\n';
    const out = findViolationsInSource(source);
    expect(out).toEqual([]);
  });

  it('does NOT flag regex literal contents', () => {
    const source = `const re = /Issue #\\d+/g;\n`;
    const out = findViolationsInSource(source);
    expect(out).toEqual([]);
  });

  it('does NOT flag regex literals with escaped slashes (URL pattern)', () => {
    // The kind of pattern that appears in actual production code:
    //   /^https:\/\/hooks\.slack\.com\//
    // Without regex-state handling, the `\/\/` substring would falsely
    // trigger entering a line-comment state.
    const source = `const URL = /^https:\\/\\/hooks\\.slack\\.com\\//;\n// trailing\n`;
    const out = findViolationsInSource(source);
    expect(out).toEqual([]);
  });

  it('does NOT flag `// Issue #N` inside a string used as a template', () => {
    const source = `const t = "// Issue #1"; const u = '// PR #2';\n`;
    const out = findViolationsInSource(source);
    expect(out).toEqual([]);
  });
});

describe('isExcludedFile', () => {
  it('excludes files in __tests__/ directories', () => {
    expect(isExcludedFile('packages/server/src/foo/__tests__/bar.ts')).toBe(true);
    expect(isExcludedFile('packages/server/src/__tests__/bar.ts')).toBe(true);
  });

  it('excludes .test.* files', () => {
    expect(isExcludedFile('packages/server/src/foo.test.ts')).toBe(true);
    expect(isExcludedFile('packages/server/src/foo.test.tsx')).toBe(true);
    expect(isExcludedFile('packages/server/src/foo.test.js')).toBe(true);
    expect(isExcludedFile('packages/server/src/foo.test.jsx')).toBe(true);
  });

  it('excludes .spec.* files', () => {
    expect(isExcludedFile('packages/server/src/foo.spec.ts')).toBe(true);
  });

  it('does NOT exclude normal source files', () => {
    expect(isExcludedFile('packages/server/src/foo.ts')).toBe(false);
    expect(isExcludedFile('packages/client/src/components/Bar.tsx')).toBe(false);
    expect(isExcludedFile('packages/shared/src/types.ts')).toBe(false);
  });
});

describe('formatViolation / violationKey', () => {
  it('formatViolation produces `file:line:col pattern` form', () => {
    const v = { file: 'a/b.ts', line: 10, col: 5, pattern: 'issue-ref' };
    expect(formatViolation(v)).toBe('a/b.ts:10:5 issue-ref');
  });

  it('violationKey produces `file:line:col:pattern` form', () => {
    const v = { file: 'a/b.ts', line: 10, col: 5, pattern: 'issue-ref' };
    expect(violationKey(v)).toBe('a/b.ts:10:5:issue-ref');
  });
});

describe('runCheck — allowlist behaviour', () => {
  function makeFixture() {
    const root = mkdtempSync(join(tmpdir(), 'blame-shift-'));
    mkdirSync(join(root, 'packages/server/src'), { recursive: true });
    mkdirSync(join(root, 'packages/server/src/__tests__'), { recursive: true });
    return root;
  }

  it('reports a violation whose key is in the allowlist as allowlisted (not failing)', async () => {
    const root = makeFixture();
    try {
      writeFileSync(
        join(root, 'packages/server/src/foo.ts'),
        `// Issue #1\nconst x = 1;\n`,
      );
      // The key for this violation: foo:1:4:issue-ref
      const allowlist = new Set(['packages/server/src/foo.ts:1:4:issue-ref']);
      const result = await runCheck({ cwd: root, allowlist });
      expect(result.violations).toHaveLength(1);
      expect(result.allowlisted).toHaveLength(1);
      expect(result.newViolations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the same pattern in a DIFFERENT file (different key) fails (not allowlisted)', async () => {
    const root = makeFixture();
    try {
      writeFileSync(
        join(root, 'packages/server/src/foo.ts'),
        `// Issue #1\nconst x = 1;\n`,
      );
      writeFileSync(
        join(root, 'packages/server/src/bar.ts'),
        `// Issue #1\nconst y = 1;\n`,
      );
      const allowlist = new Set(['packages/server/src/foo.ts:1:4:issue-ref']);
      const result = await runCheck({ cwd: root, allowlist });
      expect(result.violations).toHaveLength(2);
      expect(result.allowlisted).toHaveLength(1);
      expect(result.newViolations).toHaveLength(1);
      expect(result.newViolations[0].file).toBe('packages/server/src/bar.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('honours an empty allowlist (every violation is new)', async () => {
    const root = makeFixture();
    try {
      writeFileSync(
        join(root, 'packages/server/src/foo.ts'),
        `// Issue #1\nconst x = 1;\n`,
      );
      const result = await runCheck({ cwd: root, allowlist: new Set() });
      expect(result.allowlisted).toEqual([]);
      expect(result.newViolations).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('excludes __tests__/ and *.test.* files from scanning', async () => {
    const root = makeFixture();
    try {
      writeFileSync(
        join(root, 'packages/server/src/foo.ts'),
        `// Issue #1\nconst x = 1;\n`,
      );
      writeFileSync(
        join(root, 'packages/server/src/__tests__/foo.ts'),
        `// Issue #2\n`,
      );
      writeFileSync(
        join(root, 'packages/server/src/foo.test.ts'),
        `// Issue #3\n`,
      );
      const result = await runCheck({ cwd: root, allowlist: new Set() });
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].file).toBe('packages/server/src/foo.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('findDefaultFiles — scan glob', () => {
  it('returns no files when packages/*/src is empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'blame-shift-default-'));
    try {
      mkdirSync(join(root, 'packages/foo/src'), { recursive: true });
      const files = await findDefaultFiles({ cwd: root });
      expect(files).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns .ts/.tsx/.js/.jsx files under packages/*/src/**', async () => {
    const root = mkdtempSync(join(tmpdir(), 'blame-shift-default-'));
    try {
      mkdirSync(join(root, 'packages/a/src/sub'), { recursive: true });
      mkdirSync(join(root, 'packages/b/src'), { recursive: true });
      writeFileSync(join(root, 'packages/a/src/x.ts'), '');
      writeFileSync(join(root, 'packages/a/src/sub/y.tsx'), '');
      writeFileSync(join(root, 'packages/b/src/z.js'), '');
      writeFileSync(join(root, 'packages/b/src/w.jsx'), '');
      // Ignored: not under packages/*/src/
      writeFileSync(join(root, 'packages/a/other.ts'), '');
      const files = await findDefaultFiles({ cwd: root });
      expect(files).toEqual([
        'packages/a/src/sub/y.tsx',
        'packages/a/src/x.ts',
        'packages/b/src/w.jsx',
        'packages/b/src/z.js',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('KNOWN_VIOLATIONS — baseline integrity', () => {
  it('is a non-empty Set (pre-existing violations were baked in)', () => {
    expect(KNOWN_VIOLATIONS).toBeInstanceOf(Set);
    expect(KNOWN_VIOLATIONS.size).toBeGreaterThan(0);
  });

  it('entries follow the `file:line:col:pattern` key shape', () => {
    for (const key of KNOWN_VIOLATIONS) {
      expect(key).toMatch(/^[^:]+:\d+:\d+:(issue-ref|pr-ref|bare-ref|coderabbit-dated)$/);
    }
  });

  it('against the live tree, the script exits 0 (all current violations are allowlisted)', () => {
    const result = spawnSync('bun', [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Found 0 new violations');
  });
});
