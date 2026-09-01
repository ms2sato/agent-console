import { describe, it, expect } from 'bun:test';
import { Glob } from 'bun';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkStdinText,
  findViolationsInText,
  findDefaultFiles,
  findViolationsInFile,
  formatFileViolations,
  runCheck,
  isExcludedFile,
  EXCLUDED_FILES,
} from '../check-public-artifacts-language.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/check-public-artifacts-language.mjs');
const HOOK_PATH = resolve(REPO_ROOT, 'scripts/git-hooks/commit-msg');

describe('findViolationsInText — allowed cases', () => {
  it('returns no violations for empty string', () => {
    expect(findViolationsInText('')).toEqual([]);
  });

  it('returns no violations for only newlines', () => {
    expect(findViolationsInText('\n\n\n')).toEqual([]);
  });

  it('returns no violations for plain ASCII English', () => {
    expect(findViolationsInText('The quick brown fox jumps over 13 lazy dogs.')).toEqual([]);
  });

  it('returns no violations for accented Latin (French, German, Vietnamese)', () => {
    expect(findViolationsInText('café façade naïve résumé über löschen tiếng Việt')).toEqual([]);
  });

  it('returns no violations for ASCII punctuation and symbols', () => {
    expect(findViolationsInText("!@#$%^&*()_+-=[]{}|;':\",./<>?`~")).toEqual([]);
  });

  it('returns no violations for em-dash, en-dash, ellipsis', () => {
    expect(findViolationsInText('hello — world – goodbye …')).toEqual([]);
  });

  it('returns no violations for arrows and check marks', () => {
    expect(findViolationsInText('input → output ✓ pass ✅ done ⚠ warn ❌ fail')).toEqual([]);
  });

  it('returns no violations for box-drawing characters', () => {
    const box = '┌──┐\n│  │\n└──┘';
    expect(findViolationsInText(box)).toEqual([]);
  });

  it('returns no violations for emoji (non-Letter symbols)', () => {
    expect(findViolationsInText('Status: 🚀 launched, 💡 idea, 🤖 bot')).toEqual([]);
  });

  it('returns no violations for digits and numbers', () => {
    expect(findViolationsInText('Version 1.2.3-beta+build.456')).toEqual([]);
  });

  it('returns no violations for circled Latin letter ⓘ (Script=Latin variant)', () => {
    expect(findViolationsInText('ⓘ Note: this is allowed')).toEqual([]);
  });
});

describe('findViolationsInText — blocked cases', () => {
  it('flags Greek letters (Issue #1450 — no longer allowed for math notation)', () => {
    const result = findViolationsInText('α β γ');
    expect(result).toHaveLength(3);
    for (const v of result) {
      expect(v.codepoint).toMatch(/^U\+03/);
    }
  });

  it('flags a mixed-script token (Cyrillic substituted inside an otherwise-Latin word)', () => {
    // 'мутation' — the first three letters are Cyrillic look-alikes of "mut",
    // the rest ("ation") is Latin. This is the exact repro shape from Issue #1450.
    const result = findViolationsInText('мутation');
    expect(result).toHaveLength(3);
    for (const v of result) {
      expect(v.codepoint).toMatch(/^U\+04/);
    }
  });

  it('flags a wholly-Cyrillic word standing alone in English prose (the case a mixed-token rule would miss)', () => {
    // The real incident: a whole Cyrillic word substituted for its English
    // look-alike, not a mixed-script token. A rule that only rejected
    // mixed-script tokens would structurally miss this case.
    const result = findViolationsInText('Applying this мутация introduces a regression.');
    expect(result.length).toBeGreaterThan(0);
    for (const v of result) {
      expect(v.codepoint).toMatch(/^U\+04/);
    }
  });

  it('flags Hiragana', () => {
    const result = findViolationsInText('こんにちは');
    expect(result.length).toBe(5);
    expect(result[0]).toEqual({
      line: 1,
      col: 1,
      char: 'こ',
      codepoint: 'U+3053',
    });
  });

  it('flags Katakana', () => {
    const result = findViolationsInText('カタカナ');
    expect(result).toHaveLength(4);
    expect(result.map((v) => v.codepoint)).toEqual(['U+30AB', 'U+30BF', 'U+30AB', 'U+30CA']);
  });

  it('flags Han / CJK Unified Ideographs', () => {
    const result = findViolationsInText('日本語');
    expect(result).toHaveLength(3);
    expect(result.map((v) => v.codepoint)).toEqual(['U+65E5', 'U+672C', 'U+8A9E']);
  });

  it('flags Hangul (Korean)', () => {
    const result = findViolationsInText('한글');
    expect(result).toHaveLength(2);
    expect(result.map((v) => v.codepoint)).toEqual(['U+D55C', 'U+AE00']);
  });

  it('flags Arabic', () => {
    const result = findViolationsInText('مرحبا');
    expect(result).toHaveLength(5);
    for (const v of result) {
      expect(v.codepoint).toMatch(/^U\+06/);
    }
  });

  it('flags Hebrew', () => {
    const result = findViolationsInText('שלום');
    expect(result).toHaveLength(4);
    for (const v of result) {
      expect(v.codepoint).toMatch(/^U\+05/);
    }
  });

  it('flags Devanagari (Hindi)', () => {
    const result = findViolationsInText('नमस्ते');
    expect(result.length).toBeGreaterThan(0);
    for (const v of result) {
      expect(v.codepoint).toMatch(/^U\+09/);
    }
  });

  it('flags Thai', () => {
    const result = findViolationsInText('สวัสดี');
    expect(result.length).toBeGreaterThan(0);
    for (const v of result) {
      expect(v.codepoint).toMatch(/^U\+0E/);
    }
  });

  it('flags U+2139 INFORMATION SOURCE (Letterlike Symbols, Script=Common)', () => {
    const result = findViolationsInText('ℹ');
    expect(result).toEqual([
      { line: 1, col: 1, char: 'ℹ', codepoint: 'U+2139' },
    ]);
  });
});

describe('findViolationsInText — line and column reporting', () => {
  it('reports line numbers (1-based) across multiline text', () => {
    const text = 'line 1\nline 2 こ\n\nline 4';
    const result = findViolationsInText(text);
    expect(result).toHaveLength(1);
    expect(result[0].line).toBe(2);
    expect(result[0].col).toBe(8);
    expect(result[0].codepoint).toBe('U+3053');
  });

  it('reports columns (1-based) within a line', () => {
    const result = findViolationsInText('abc日def');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      line: 1,
      col: 4,
      char: '日',
      codepoint: 'U+65E5',
    });
  });

  it('reports each violator separately when multiple appear in one line', () => {
    const result = findViolationsInText('日本語 mixed with English');
    expect(result).toHaveLength(3);
    expect(result.map((v) => v.col)).toEqual([1, 2, 3]);
  });

  it('handles mixed allowed and blocked content', () => {
    const text = 'OK status: ✅\nNG status: ✗ で失敗';
    const result = findViolationsInText(text);
    expect(result).toHaveLength(3);
    for (const v of result) {
      expect(v.line).toBe(2);
    }
    expect(result.map((v) => v.codepoint)).toEqual(['U+3067', 'U+5931', 'U+6557']);
  });
});

describe('findViolationsInText — per-line escape marker', () => {
  it('exempts a line with Cyrillic when the escape marker is present', () => {
    const result = findViolationsInText('а Cyrillic vs a Latin lang-check:allow');
    expect(result).toEqual([]);
  });

  it('exempts a line with Greek when the escape marker is present', () => {
    const result = findViolationsInText('α β γ lang-check:allow');
    expect(result).toEqual([]);
  });

  it('does not exempt other lines in the same multiline text', () => {
    const text = 'мутация lang-check:allow\nмутация\n';
    const result = findViolationsInText(text);
    expect(result.length).toBeGreaterThan(0);
    for (const v of result) {
      expect(v.line).toBe(2);
    }
  });

  it('still flags a line without the marker even when other lines are exempted', () => {
    const text = 'α β lang-check:allow\nこんにちは\n';
    const result = findViolationsInText(text);
    expect(result.length).toBe(5);
    for (const v of result) {
      expect(v.line).toBe(2);
    }
  });
});

describe('formatFileViolations', () => {
  it('produces canonical file:line:col char U+CODEPOINT format', () => {
    const lines = formatFileViolations('docs/foo.md', [
      { line: 1, col: 5, char: '日', codepoint: 'U+65E5' },
      { line: 2, col: 10, char: '本', codepoint: 'U+672C' },
    ]);
    expect(lines).toEqual([
      'docs/foo.md:1:5 日 U+65E5',
      'docs/foo.md:2:10 本 U+672C',
    ]);
  });

  it('returns an empty array when there are no violations', () => {
    expect(formatFileViolations('docs/clean.md', [])).toEqual([]);
  });
});

describe('findDefaultFiles + runCheck (integration with a temp tree)', () => {
  function makeFixture() {
    const root = mkdtempSync(join(tmpdir(), 'lang-check-'));
    mkdirSync(join(root, 'docs'), { recursive: true });
    mkdirSync(join(root, '.claude/rules'), { recursive: true });
    mkdirSync(join(root, '.claude/skills/foo'), { recursive: true });
    mkdirSync(join(root, '.claude/agents'), { recursive: true });
    mkdirSync(join(root, '.claude/hooks'), { recursive: true });
    mkdirSync(join(root, 'scripts/smoke'), { recursive: true });
    return root;
  }

  it('discovers CLAUDE.md and every file under docs/, .claude/, scripts/ regardless of extension (R1: root-based, no extension filter)', async () => {
    const root = makeFixture();
    try {
      writeFileSync(join(root, 'CLAUDE.md'), '# top\n');
      writeFileSync(join(root, 'docs/a.md'), '# a\n');
      writeFileSync(join(root, '.claude/rules/r1.md'), '# r1\n');
      writeFileSync(join(root, '.claude/skills/foo/SKILL.md'), '# s\n');
      writeFileSync(join(root, '.claude/agents/agent.md'), '# a\n');
      // Previously-unscanned extensions/roots — the gap Issue #1491 named.
      writeFileSync(join(root, '.claude/hooks/check.sh'), '#!/bin/sh\necho ok\n');
      writeFileSync(join(root, 'scripts/build.mjs'), 'console.log("ok");\n');
      writeFileSync(join(root, 'scripts/smoke/probe.ts'), 'export const ok = true;\n');
      writeFileSync(join(root, '.claude/skills/foo/helper.js'), 'module.exports = {};\n');
      // No extension filter means even a non-.md text file under a scanned
      // root is now discovered (was previously invisible under the old
      // docs/**/*.md-shaped pattern).
      writeFileSync(join(root, 'docs/notes.txt'), 'plain text notes\n');
      // Outside every scanned root entirely — must NOT be included.
      writeFileSync(join(root, 'package.json'), '{}');

      const files = await findDefaultFiles({ cwd: root });
      expect(files).toEqual([
        '.claude/agents/agent.md',
        '.claude/hooks/check.sh',
        '.claude/rules/r1.md',
        '.claude/skills/foo/SKILL.md',
        '.claude/skills/foo/helper.js',
        'CLAUDE.md',
        'docs/a.md',
        'docs/notes.txt',
        'scripts/build.mjs',
        'scripts/smoke/probe.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runCheck flags violations in newly-scanned categories: .sh under .claude/hooks, .mjs/.ts under scripts, .js under .claude/skills', async () => {
    const root = makeFixture();
    try {
      writeFileSync(join(root, '.claude/hooks/check.sh'), '#!/bin/sh\n# 日本語のコメント\necho ok\n');
      writeFileSync(join(root, 'scripts/build.mjs'), '// коммент\nconsole.log("ok");\n');
      writeFileSync(join(root, 'scripts/smoke/probe.ts'), '// θ threshold\nexport const ok = true;\n');
      writeFileSync(join(root, '.claude/skills/foo/helper.js'), '// 한글 comment\nmodule.exports = {};\n');

      const result = await runCheck({ cwd: root });
      const offenders = new Set(result.violations.map((v) => v.file));
      expect(offenders).toEqual(
        new Set([
          '.claude/hooks/check.sh',
          'scripts/build.mjs',
          'scripts/smoke/probe.ts',
          '.claude/skills/foo/helper.js',
        ]),
      );
      expect(result.filesWithViolations).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runCheck returns zero violations when all files are clean', async () => {
    const root = makeFixture();
    try {
      writeFileSync(join(root, 'CLAUDE.md'), '# Clean English file.\n');
      writeFileSync(join(root, 'docs/a.md'), 'Café and résumé are fine.\n');
      const result = await runCheck({ cwd: root });
      expect(result.violations).toEqual([]);
      expect(result.filesWithViolations).toBe(0);
      expect(result.files.length).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runCheck reports per-file violations with absolute file path key', async () => {
    const root = makeFixture();
    try {
      writeFileSync(join(root, 'docs/a.md'), 'Hello\n日本\n');
      writeFileSync(join(root, 'docs/b.md'), 'Clean line\n');
      const result = await runCheck({ cwd: root });
      expect(result.filesWithViolations).toBe(1);
      expect(result.violations).toHaveLength(2);
      for (const v of result.violations) {
        expect(v.file).toBe('docs/a.md');
        expect(v.line).toBe(2);
      }
      expect(result.violations.map((v) => v.codepoint)).toEqual(['U+65E5', 'U+672C']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runCheck honors an explicit files list (skips glob)', async () => {
    const root = makeFixture();
    try {
      writeFileSync(join(root, 'docs/a.md'), '日\n');
      writeFileSync(join(root, 'docs/b.md'), '本\n');
      const result = await runCheck({ cwd: root, files: ['docs/a.md'] });
      expect(result.files).toEqual(['docs/a.md']);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].file).toBe('docs/a.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runCheck flags Cyrillic and Greek content (Issue #1450 — no longer allowed)', async () => {
    const root = makeFixture();
    try {
      writeFileSync(join(root, 'docs/a.md'), 'Applying this мутация introduces a regression.\n');
      writeFileSync(join(root, 'docs/b.md'), 'Angle theta equals α plus β.\n');
      const result = await runCheck({ cwd: root });
      expect(result.filesWithViolations).toBe(2);
      expect(result.violations.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runCheck honors the per-line escape marker for a legitimate homograph example', async () => {
    const root = makeFixture();
    try {
      writeFileSync(
        join(root, 'docs/a.md'),
        'Compare а Cyrillic vs a Latin lang-check:allow\n',
      );
      const result = await runCheck({ cwd: root });
      expect(result.violations).toEqual([]);
      expect(result.filesWithViolations).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('findViolationsInFile reads a real file from disk', async () => {
    const root = makeFixture();
    try {
      writeFileSync(join(root, 'docs/a.md'), 'plain ASCII\n');
      const violations = await findViolationsInFile('docs/a.md', { cwd: root });
      expect(violations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('binary / non-UTF-8 exclusion (R2: by content, not by extension)', () => {
    it('skips a file with an invalid UTF-8 byte sequence instead of throwing or misreporting', async () => {
      const root = makeFixture();
      try {
        // 0xC3 0x28 is a well-known invalid UTF-8 continuation-byte pair.
        writeFileSync(
          join(root, 'docs/binary.md'),
          Buffer.from([0x68, 0x69, 0xc3, 0x28, 0x65, 0x6e, 0x64]),
        );
        const violations = await findViolationsInFile('docs/binary.md', { cwd: root });
        expect(violations).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('does NOT skip a file that merely contains a NUL byte alongside otherwise-valid UTF-8 (NUL is not a binary proxy)', async () => {
      // Real-world shape: scripts/check-mock-module-poisoners.mjs contains
      // one NUL byte as deliberate poisoner test data and decodes as
      // fully valid UTF-8 — a NUL-byte heuristic would wrongly skip it.
      // R2 requires the actual decode-failure property, not a proxy.
      const root = makeFixture();
      try {
        writeFileSync(
          join(root, 'scripts/nul-fixture.mjs'),
          Buffer.from('const poison = "before\0after"; // 日\n', 'utf8'),
        );
        const violations = await findViolationsInFile('scripts/nul-fixture.mjs', { cwd: root });
        expect(violations).toHaveLength(1);
        expect(violations[0].char).toBe('日');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('runCheck treats a binary file as contributing zero violations and zero offenders', async () => {
      const root = makeFixture();
      try {
        writeFileSync(join(root, 'docs/binary.md'), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]));
        writeFileSync(join(root, 'docs/clean.md'), 'Clean English text.\n');
        const result = await runCheck({ cwd: root });
        expect(result.violations).toEqual([]);
        expect(result.filesWithViolations).toBe(0);
        expect(result.files).toContain('docs/binary.md');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('EXCLUDED_FILES (R2: reasoned exclusion list for intentional non-Latin content)', () => {
    it('every entry has a non-empty reason', () => {
      expect(EXCLUDED_FILES.length).toBeGreaterThan(0);
      for (const entry of EXCLUDED_FILES) {
        expect(typeof entry.file).toBe('string');
        expect(entry.file.length).toBeGreaterThan(0);
        expect(typeof entry.reason).toBe('string');
        expect(entry.reason.trim().length).toBeGreaterThan(0);
      }
    });

    it('every entry is classified as either a checker fixture or a user-facing carve-out, and both classes are represented', () => {
      const classes = EXCLUDED_FILES.map((entry) => {
        if (entry.reason.startsWith('checker fixture:')) return 'checker fixture';
        if (entry.reason.startsWith('user-facing carve-out:')) return 'user-facing carve-out';
        return null;
      });
      expect(classes).not.toContain(null);
      expect(classes).toContain('checker fixture');
      expect(classes).toContain('user-facing carve-out');
    });

    it('isExcludedFile matches only files literally on the list', () => {
      expect(isExcludedFile('.claude/skills/orchestrator/sprint-retro.js')).toBe(true);
      expect(isExcludedFile('.claude/skills/orchestrator/other-file.js')).toBe(false);
    });

    it('exclusion polarity — checker-fixture class: the listed path with non-Latin content passes; the same content at an unlisted path fails', async () => {
      const root = makeFixture();
      try {
        mkdirSync(join(root, 'scripts/__tests__'), { recursive: true });
        const nonLatinContent = 'Greek sample: α β γ\n';
        // Exact path from EXCLUDED_FILES's checker-fixture entry.
        writeFileSync(join(root, 'scripts/__tests__/check-public-artifacts-language.test.mjs'), nonLatinContent);
        // Identical content, unlisted path.
        writeFileSync(join(root, 'scripts/__tests__/unlisted-fixture.mjs'), nonLatinContent);

        const result = await runCheck({ cwd: root });
        const offenders = new Set(result.violations.map((v) => v.file));
        expect(offenders.has('scripts/__tests__/check-public-artifacts-language.test.mjs')).toBe(false);
        expect(offenders.has('scripts/__tests__/unlisted-fixture.mjs')).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('exclusion polarity — user-facing-carve-out class: the listed path with non-Latin content passes; the same content at an unlisted path fails', async () => {
      const root = makeFixture();
      try {
        mkdirSync(join(root, '.claude/skills/orchestrator'), { recursive: true });
        const nonLatinContent = "console.log('レビュー手順です');\n";
        // Exact path from EXCLUDED_FILES's user-facing-carve-out entry.
        writeFileSync(join(root, '.claude/skills/orchestrator/sprint-retro.js'), nonLatinContent);
        // Identical content, unlisted path.
        writeFileSync(join(root, '.claude/skills/orchestrator/unlisted-file.js'), nonLatinContent);

        const result = await runCheck({ cwd: root });
        const offenders = new Set(result.violations.map((v) => v.file));
        expect(offenders.has('.claude/skills/orchestrator/sprint-retro.js')).toBe(false);
        expect(offenders.has('.claude/skills/orchestrator/unlisted-file.js')).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('exclusion is applied uniformly for an explicit files list, not only the default glob path', async () => {
      const root = makeFixture();
      try {
        mkdirSync(join(root, '.claude/skills/orchestrator'), { recursive: true });
        writeFileSync(
          join(root, '.claude/skills/orchestrator/sprint-retro.js'),
          "console.log('レビュー手順です');\n",
        );
        const result = await runCheck({
          cwd: root,
          files: ['.claude/skills/orchestrator/sprint-retro.js'],
        });
        expect(result.violations).toEqual([]);
        expect(result.files).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('exclusion matches an explicit path with a leading ./ the same as the bare form', async () => {
      const root = makeFixture();
      try {
        mkdirSync(join(root, '.claude/skills/orchestrator'), { recursive: true });
        writeFileSync(
          join(root, '.claude/skills/orchestrator/sprint-retro.js'),
          "console.log('レビュー手順です');\n",
        );
        const result = await runCheck({
          cwd: root,
          files: ['./.claude/skills/orchestrator/sprint-retro.js'],
        });
        expect(result.violations).toEqual([]);
        expect(result.files).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('preserves the caller-provided path string for a non-excluded ./ path (normalization is exclusion-matching-only)', async () => {
      const root = makeFixture();
      try {
        writeFileSync(join(root, 'docs/a.md'), 'Hello\n日本\n');
        const result = await runCheck({
          cwd: root,
          files: ['./docs/a.md'],
        });
        // Not excluded, so it is scanned and reported under the exact
        // caller-provided string — normalization must not rewrite it to
        // the bare 'docs/a.md' form.
        expect(result.files).toEqual(['./docs/a.md']);
        expect(result.violations).toHaveLength(2);
        expect(result.violations[0].file).toBe('./docs/a.md');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('path normalization does not change which files the default glob path scans (only the explicit-files path is affected)', async () => {
      const root = makeFixture();
      try {
        writeFileSync(join(root, 'CLAUDE.md'), '# top\n');
        writeFileSync(join(root, 'docs/a.md'), '# a\n');
        writeFileSync(join(root, '.claude/hooks/check.sh'), '#!/bin/sh\necho ok\n');
        const defaultFiles = await findDefaultFiles({ cwd: root });
        const result = await runCheck({ cwd: root });
        // Bun.Glob never emits a leading `./`, so normalizeRelativePath is a
        // no-op on this path — the default scan's target set is identical
        // to findDefaultFiles's raw output (module normalization only ever
        // changes behavior for the explicit `files` argument).
        expect(result.files).toEqual(defaultFiles);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

describe('checkStdinText (pure function — stdin-mode core)', () => {
  it('returns no violations for empty input (vacuous truth boundary)', () => {
    const result = checkStdinText('');
    expect(result.violations).toEqual([]);
    expect(result.lines).toEqual([]);
  });

  it('returns no violations for pure ASCII single-line commit-msg', () => {
    const result = checkStdinText('feat: add commit-msg hook for language check\n');
    expect(result.violations).toEqual([]);
    expect(result.lines).toEqual([]);
  });

  it('flags a single non-Latin character with the <stdin> label', () => {
    const result = checkStdinText('日');
    expect(result.lines).toEqual(['<stdin>:1:1 日 U+65E5']);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].file).toBe('<stdin>');
  });

  it('flags multiple non-Latin characters across lines', () => {
    const result = checkStdinText('feat: 機能 add\nfix bug 修正\n');
    expect(result.lines).toEqual([
      '<stdin>:1:7 機 U+6A5F',
      '<stdin>:1:8 能 U+80FD',
      '<stdin>:2:9 修 U+4FEE',
      '<stdin>:2:10 正 U+6B63',
    ]);
  });

  it('honors a custom label override', () => {
    const result = checkStdinText('日', { label: '<commit-msg>' });
    expect(result.lines).toEqual(['<commit-msg>:1:1 日 U+65E5']);
  });

  it('flags a Cyrillic word substituted into an otherwise-English commit message (Issue #1450)', () => {
    const result = checkStdinText('fix: apply this мутация to the schema\n');
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0].file).toBe('<stdin>');
  });

  it('flags Greek letters in a commit message', () => {
    const result = checkStdinText('fix: bound the α threshold\n');
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('honors the per-line escape marker in stdin mode', () => {
    const result = checkStdinText('fix: apply this мутация lang-check:allow\n');
    expect(result.violations).toEqual([]);
    expect(result.lines).toEqual([]);
  });
});

function runScriptStdin(input) {
  return spawnSync('bun', [SCRIPT_PATH, '--stdin'], {
    input,
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
}

describe('check-public-artifacts-language.mjs --stdin (subprocess)', () => {
  it('exit 0 with no output for empty stdin', () => {
    const result = runScriptStdin('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('exit 0 for pure ASCII single-line commit-msg', () => {
    const result = runScriptStdin('feat: add commit-msg hook for language check\n');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('exit 1 with one violation line for a single non-Latin character', () => {
    const result = runScriptStdin('日');
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe('<stdin>:1:1 日 U+65E5');
    expect(result.stderr).toContain('FAIL');
  });

  it('exit 1 listing all violations across multiple lines', () => {
    const result = runScriptStdin('feat: 機能 add\nfix bug 修正\n');
    expect(result.status).toBe(1);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toEqual([
      '<stdin>:1:7 機 U+6A5F',
      '<stdin>:1:8 能 U+80FD',
      '<stdin>:2:9 修 U+4FEE',
      '<stdin>:2:10 正 U+6B63',
    ]);
  });

  it('exit 1 for the exact Issue #1450 repro ("mutation and мутation")', () => {
    const result = runScriptStdin('mutation and мутation\n');
    expect(result.status).toBe(1);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it('exit 0 when the escape marker exempts the offending line', () => {
    const result = runScriptStdin('mutation and мутation lang-check:allow\n');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('regression — file-mode behavior is unchanged when --stdin is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'lang-check-stdin-regression-'));
    try {
      writeFileSync(join(root, 'docs.md'), 'feat: 日本\n');
      const result = spawnSync('bun', [SCRIPT_PATH, 'docs.md'], {
        encoding: 'utf8',
        cwd: root,
      });
      expect(result.status).toBe(1);
      const lines = result.stdout.trim().split('\n');
      expect(lines).toEqual([
        'docs.md:1:7 日 U+65E5',
        'docs.md:1:8 本 U+672C',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function runHookWithFile(input) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'commit-msg-hook-'));
  const msgPath = join(tmpDir, 'COMMIT_EDITMSG');
  writeFileSync(msgPath, input);
  try {
    return spawnSync(HOOK_PATH, [msgPath], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('scripts/git-hooks/commit-msg (shell hook)', () => {
  it('exit 0 for empty commit-msg file', () => {
    const result = runHookWithFile('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('exit 0 for pure ASCII commit-msg', () => {
    const result = runHookWithFile('feat: add commit-msg hook for language check\n');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('exit 1 with violation line for non-Latin commit-msg', () => {
    const result = runHookWithFile('feat: 日本語のメッセージ\n');
    expect(result.status).toBe(1);
    const stdoutLines = result.stdout.trim().split('\n');
    expect(stdoutLines[0]).toMatch(/^<stdin>:1:7 . U\+[0-9A-F]+$/);
    expect(stdoutLines.length).toBeGreaterThan(1);
  });

  it('exit 1 listing all violations across multiple lines', () => {
    const result = runHookWithFile('feat: 機能 add\nfix bug 修正\n');
    expect(result.status).toBe(1);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toEqual([
      '<stdin>:1:7 機 U+6A5F',
      '<stdin>:1:8 能 U+80FD',
      '<stdin>:2:9 修 U+4FEE',
      '<stdin>:2:10 正 U+6B63',
    ]);
  });
});
