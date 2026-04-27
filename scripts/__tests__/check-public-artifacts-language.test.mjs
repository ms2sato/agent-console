import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findViolationsInText,
  findDefaultFiles,
  findViolationsInFile,
  formatFileViolations,
  runCheck,
} from '../check-public-artifacts-language.mjs';

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

  it('returns no violations for Greek letters (used in math)', () => {
    expect(findViolationsInText('α β γ δ Σ Δ π')).toEqual([]);
  });

  it('returns no violations for Cyrillic letters (used in diff names, examples)', () => {
    expect(findViolationsInText('Привет мир')).toEqual([]);
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
    return root;
  }

  it('discovers CLAUDE.md, docs/**/*.md, and .claude/{rules,skills,agents}/**/*.md', async () => {
    const root = makeFixture();
    try {
      writeFileSync(join(root, 'CLAUDE.md'), '# top\n');
      writeFileSync(join(root, 'docs/a.md'), '# a\n');
      writeFileSync(join(root, '.claude/rules/r1.md'), '# r1\n');
      writeFileSync(join(root, '.claude/skills/foo/SKILL.md'), '# s\n');
      writeFileSync(join(root, '.claude/agents/agent.md'), '# a\n');
      // a non-target file that must NOT be included
      writeFileSync(join(root, 'package.json'), '{}');
      writeFileSync(join(root, 'docs/notes.txt'), 'こんにちは');

      const files = await findDefaultFiles({ cwd: root });
      expect(files).toEqual([
        '.claude/agents/agent.md',
        '.claude/rules/r1.md',
        '.claude/skills/foo/SKILL.md',
        'CLAUDE.md',
        'docs/a.md',
      ]);
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
});
