import { describe, it, expect } from 'bun:test';
import { normalizeSchemaSource } from '../schema-source-normalize.mjs';

// Polarity matrix rows are cross-referenced by number; see the PR body /
// Issue #1190 for the full 8-row table this file exercises.

describe('normalizeSchemaSource — row 1: pure comment diff', () => {
  it('produces the same output whether or not a leading line comment is present', () => {
    const withComment = '// docstring fix\nexport const x = 1;\n';
    const withoutComment = 'export const x = 1;\n';
    expect(normalizeSchemaSource(withComment)).toBe(normalizeSchemaSource(withoutComment));
  });

  it('produces the same output whether or not a block comment is present', () => {
    const withComment = '/**\n * Some JSDoc.\n */\nexport const x = 1;\n';
    const withoutComment = 'export const x = 1;\n';
    expect(normalizeSchemaSource(withComment)).toBe(normalizeSchemaSource(withoutComment));
  });

  it('produces the same output when only a trailing inline comment changes', () => {
    const a = 'export const x = 1; // old note\n';
    const b = 'export const x = 1; // completely different note\n';
    expect(normalizeSchemaSource(a)).toBe(normalizeSchemaSource(b));
  });
});

describe('normalizeSchemaSource — row 2: pure code diff', () => {
  it('produces different output when a literal value changes', () => {
    const a = 'export const x = 1;\n';
    const b = 'export const x = 2;\n';
    expect(normalizeSchemaSource(a)).not.toBe(normalizeSchemaSource(b));
  });

  it('produces different output when a field name changes', () => {
    const a = 'export const Schema = v.object({ foo: v.string() });\n';
    const b = 'export const Schema = v.object({ bar: v.string() });\n';
    expect(normalizeSchemaSource(a)).not.toBe(normalizeSchemaSource(b));
  });
});

describe('normalizeSchemaSource — row 3: mixed comment + code diff', () => {
  it('still registers the code change even when a comment also changes', () => {
    const a = '// note A\nexport const x = 1;\n';
    const b = '// note B (totally different)\nexport const x = 2;\n';
    expect(normalizeSchemaSource(a)).not.toBe(normalizeSchemaSource(b));
  });
});

describe('normalizeSchemaSource — row 4: string literal comment-like content', () => {
  it('preserves double-quoted string content containing "//" unchanged', () => {
    const source = 'const x = "// not a comment";\n';
    expect(normalizeSchemaSource(source)).toContain('"// not a comment"');
  });

  it('preserves single-quoted string content containing "/* */" unchanged', () => {
    const source = "const y = '/* also not a comment */';\n";
    expect(normalizeSchemaSource(source)).toContain("'/* also not a comment */'");
  });

  it('flips the hash-relevant output when only the string literal content changes', () => {
    const a = 'const x = "// not a comment";\n';
    const b = 'const x = "// not a comment CHANGED";\n';
    expect(normalizeSchemaSource(a)).not.toBe(normalizeSchemaSource(b));
  });
});

describe('normalizeSchemaSource — row 5: template literal with expression', () => {
  it('preserves template literal text and interpolated expression unchanged', () => {
    const source = 'const t = `foo ${bar} // not-a-comment-inside-template`;\n';
    expect(normalizeSchemaSource(source)).toContain(
      '`foo ${bar} // not-a-comment-inside-template`',
    );
  });

  it('flips the output when only the template literal content changes', () => {
    const a = 'const t = `foo ${bar} // not-a-comment-inside-template`;\n';
    const b = 'const t = `foo ${bar} // not-a-comment-inside-template-CHANGED`;\n';
    expect(normalizeSchemaSource(a)).not.toBe(normalizeSchemaSource(b));
  });

  it('flips the output when only the interpolated expression changes', () => {
    const a = 'const t = `foo ${bar}`;\n';
    const b = 'const t = `foo ${baz}`;\n';
    expect(normalizeSchemaSource(a)).not.toBe(normalizeSchemaSource(b));
  });
});

describe('normalizeSchemaSource — row 6: whitespace / blank-line-only diff', () => {
  it('produces the same output when blank lines are added between statements', () => {
    const a = 'export const x = 1;\nexport const y = 2;\n';
    const b = 'export const x = 1;\n\n\n\nexport const y = 2;\n';
    expect(normalizeSchemaSource(a)).toBe(normalizeSchemaSource(b));
  });

  it('produces the same output when indentation changes without changing tokens', () => {
    const a = 'export const obj = {\n  foo: 1,\n};\n';
    const b = 'export const obj = {\n        foo: 1,\n};\n';
    expect(normalizeSchemaSource(a)).toBe(normalizeSchemaSource(b));
  });

  it('produces the same output when the amount of inline spacing changes (spacing still present)', () => {
    const a = 'export const x = 1;\n';
    const b = 'export  const   x   =   1;\n';
    expect(normalizeSchemaSource(a)).toBe(normalizeSchemaSource(b));
  });
});

describe('normalizeSchemaSource — row 7: unparsable input (fail-closed)', () => {
  it('throws on syntactically invalid TypeScript', () => {
    const broken = "const x = {{{ ) ( unterminated string = 'abc\n";
    expect(() => normalizeSchemaSource(broken)).toThrow();
  });
});

describe('normalizeSchemaSource — row 8: empty file', () => {
  it('returns an empty string without crashing', () => {
    expect(normalizeSchemaSource('')).toBe('');
  });

  it('is deterministic across repeated calls', () => {
    expect(normalizeSchemaSource('')).toBe(normalizeSchemaSource(''));
  });
});

describe('normalizeSchemaSource — regex literal handling', () => {
  // Regex literals ('/pattern/') and the division operator share the '/'
  // character; only a real grammar-aware parser (not a hand-rolled scanner
  // heuristic) can tell them apart reliably. This is the concrete failure
  // mode the TS-parser requirement (vs. regex-based stripping) exists to
  // avoid, since packages/shared/src/schemas/agent.ts contains regex
  // literals with special characters like `*`, `+`, `[`, `]`.
  it('preserves a complex regex literal verbatim', () => {
    const source = 'const p = /\\((?:\\?[:<][^)]*)?[^)]*[+*][^)]*\\)[+*]/;\n';
    expect(normalizeSchemaSource(source)).toContain(
      '/\\((?:\\?[:<][^)]*)?[^)]*[+*][^)]*\\)[+*]/',
    );
  });

  it('does not misinterpret a division expression as a comment', () => {
    const source = '// note\nconst q = 1 / 2;\n';
    expect(normalizeSchemaSource(source)).toBe(normalizeSchemaSource('const q = 1 / 2;\n'));
  });

  it('flips the output when only the regex pattern changes', () => {
    const a = 'const p = /abc/;\n';
    const b = 'const p = /abcd/;\n';
    expect(normalizeSchemaSource(a)).not.toBe(normalizeSchemaSource(b));
  });
});
