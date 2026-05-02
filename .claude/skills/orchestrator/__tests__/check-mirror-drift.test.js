import { describe, it, expect } from 'bun:test';
import {
  regexSourceToGlob,
  parseFrontmatterGlobs,
  parseMarkdownTablePatterns,
  detectDrift,
  formatReport,
} from '../check-mirror-drift.js';

describe('regexSourceToGlob', () => {
  it('converts the canonical "^DIR\\/.+\\.EXT$" shape to a glob', () => {
    expect(regexSourceToGlob('^packages\\/server\\/src\\/routes\\/.+\\.ts$')).toBe(
      'packages/server/src/routes/**/*.ts',
    );
    expect(regexSourceToGlob('^packages\\/client\\/src\\/components\\/.+\\.tsx$')).toBe(
      'packages/client/src/components/**/*.tsx',
    );
    expect(regexSourceToGlob('^\\.claude\\/hooks\\/.+\\.sh$')).toBe('.claude/hooks/**/*.sh');
  });

  it('returns null for regex shapes outside the canonical form', () => {
    expect(regexSourceToGlob('^packages\\/server\\/src\\/routes\\/foo\\.ts$')).toBeNull();
    expect(regexSourceToGlob('^packages\\/(client|server)\\/.+\\.ts$')).toBeNull();
    expect(regexSourceToGlob('not-a-regex-source')).toBeNull();
  });
});

describe('parseFrontmatterGlobs', () => {
  it('returns positive globs only and skips negation entries', () => {
    const md = [
      '---',
      'globs:',
      '  - "packages/server/src/routes/**/*.ts"',
      '  - "packages/shared/src/**/*.ts"',
      '  - "!**/*.test.ts"',
      '  - "!**/__tests__/**"',
      '---',
      '',
      '# body',
    ].join('\n');
    expect(parseFrontmatterGlobs(md)).toEqual([
      'packages/server/src/routes/**/*.ts',
      'packages/shared/src/**/*.ts',
    ]);
  });

  it('returns [] when the frontmatter has no globs key', () => {
    const md = '---\nname: foo\n---\n# body\n';
    expect(parseFrontmatterGlobs(md)).toEqual([]);
  });

  it('returns [] when there is no frontmatter at all', () => {
    expect(parseFrontmatterGlobs('# just markdown\n\nbody\n')).toEqual([]);
  });

  it('handles unquoted YAML list items', () => {
    const md = [
      '---',
      'globs:',
      '  - packages/shared/src/**/*.ts',
      '---',
      '',
    ].join('\n');
    expect(parseFrontmatterGlobs(md)).toEqual(['packages/shared/src/**/*.ts']);
  });

  it('stops collecting at a sibling top-level key', () => {
    const md = [
      '---',
      'globs:',
      '  - "packages/server/src/routes/**/*.ts"',
      'name: foo',
      '---',
      '',
    ].join('\n');
    expect(parseFrontmatterGlobs(md)).toEqual(['packages/server/src/routes/**/*.ts']);
  });
});

describe('parseMarkdownTablePatterns', () => {
  it('extracts backtick-quoted patterns from the first column, skipping header / separator', () => {
    const md = [
      '# Heading',
      '',
      '| File Pattern | Expected Test Location |',
      '|-------------|------------------------|',
      '| `packages/server/src/routes/**/*.ts` | `.../__tests__/*.test.ts` |',
      '| `packages/shared/src/**/*.ts` | `.../__tests__/*.test.ts` |',
      '',
      '## Another Section',
    ].join('\n');
    expect(parseMarkdownTablePatterns(md)).toEqual([
      'packages/server/src/routes/**/*.ts',
      'packages/shared/src/**/*.ts',
    ]);
  });

  it('returns [] when there is no table', () => {
    expect(parseMarkdownTablePatterns('# heading only\n\nbody\n')).toEqual([]);
  });
});

describe('detectDrift', () => {
  const mkMarkdown = ({ globs, table }) => {
    const fm = ['---', 'globs:'];
    for (const g of globs) fm.push(`  - "${g}"`);
    fm.push('---', '', '# heading', '', '| File Pattern | Expected Test Location |');
    fm.push('|-------------|------------------------|');
    for (const t of table) fm.push(`| \`${t}\` | \`...test...\` |`);
    return fm.join('\n');
  };

  it('happy path: matching code / table / yaml → no drift', () => {
    const result = detectDrift({
      coveragePatterns: [/^packages\/server\/src\/routes\/.+\.ts$/, /^packages\/shared\/src\/.+\.ts$/],
      markdown: mkMarkdown({
        globs: ['packages/server/src/routes/**/*.ts', 'packages/shared/src/**/*.ts'],
        table: ['packages/server/src/routes/**/*.ts', 'packages/shared/src/**/*.ts'],
      }),
    });
    expect(result.hasDrift).toBe(false);
    expect(result.unconvertible).toEqual([]);
    expect(result.diffs.codeMissingFromTable).toEqual([]);
    expect(result.diffs.tableMissingFromCode).toEqual([]);
    expect(result.diffs.codeMissingFromYaml).toEqual([]);
    expect(result.diffs.yamlMissingFromCode).toEqual([]);
  });

  it('detects pattern present in code but missing from markdown table and YAML', () => {
    const result = detectDrift({
      coveragePatterns: [
        /^packages\/server\/src\/routes\/.+\.ts$/,
        /^\.claude\/hooks\/.+\.sh$/,
      ],
      markdown: mkMarkdown({
        globs: ['packages/server/src/routes/**/*.ts'],
        table: ['packages/server/src/routes/**/*.ts'],
      }),
    });
    expect(result.hasDrift).toBe(true);
    expect(result.diffs.codeMissingFromTable).toEqual(['.claude/hooks/**/*.sh']);
    expect(result.diffs.codeMissingFromYaml).toEqual(['.claude/hooks/**/*.sh']);
  });

  it('detects pattern present in markdown but missing from code', () => {
    const result = detectDrift({
      coveragePatterns: [/^packages\/server\/src\/routes\/.+\.ts$/],
      markdown: mkMarkdown({
        globs: ['packages/server/src/routes/**/*.ts', 'packages/server/src/services/**/*.ts'],
        table: ['packages/server/src/routes/**/*.ts', 'packages/server/src/services/**/*.ts'],
      }),
    });
    expect(result.hasDrift).toBe(true);
    expect(result.diffs.tableMissingFromCode).toEqual(['packages/server/src/services/**/*.ts']);
    expect(result.diffs.yamlMissingFromCode).toEqual(['packages/server/src/services/**/*.ts']);
  });

  it('reports an unconvertible regex as drift (fails closed)', () => {
    const result = detectDrift({
      coveragePatterns: [/^packages\/server\/(routes|services)\/.+\.ts$/],
      markdown: mkMarkdown({ globs: [], table: [] }),
    });
    expect(result.hasDrift).toBe(true);
    expect(result.unconvertible).toHaveLength(1);
  });

  it('boundary: empty COVERAGE_PATTERNS + empty markdown mirror → no drift', () => {
    const result = detectDrift({
      coveragePatterns: [],
      markdown: mkMarkdown({ globs: [], table: [] }),
    });
    expect(result.hasDrift).toBe(false);
  });

  it('boundary: empty COVERAGE_PATTERNS but populated markdown → drift on mirror side', () => {
    const result = detectDrift({
      coveragePatterns: [],
      markdown: mkMarkdown({
        globs: ['packages/server/src/routes/**/*.ts'],
        table: ['packages/server/src/routes/**/*.ts'],
      }),
    });
    expect(result.hasDrift).toBe(true);
    expect(result.diffs.tableMissingFromCode).toEqual(['packages/server/src/routes/**/*.ts']);
    expect(result.diffs.yamlMissingFromCode).toEqual(['packages/server/src/routes/**/*.ts']);
  });

  it('YAML negation entries do not contribute to drift', () => {
    const md = [
      '---',
      'globs:',
      '  - "packages/server/src/routes/**/*.ts"',
      '  - "!**/*.test.ts"',
      '  - "!**/__tests__/**"',
      '---',
      '',
      '| File Pattern | Expected |',
      '|---|---|',
      '| `packages/server/src/routes/**/*.ts` | `.test.ts` |',
    ].join('\n');
    const result = detectDrift({
      coveragePatterns: [/^packages\/server\/src\/routes\/.+\.ts$/],
      markdown: md,
    });
    expect(result.hasDrift).toBe(false);
  });
});

describe('formatReport', () => {
  it('returns a green-check message when there is no drift', () => {
    const text = formatReport({
      hasDrift: false,
      unconvertible: [],
      codeGlobs: new Set(),
      tableGlobs: new Set(),
      yamlGlobs: new Set(),
      diffs: {
        codeMissingFromTable: [],
        tableMissingFromCode: [],
        codeMissingFromYaml: [],
        yamlMissingFromCode: [],
      },
    });
    expect(text).toContain('in sync');
  });

  it('renders sections for each non-empty diff bucket', () => {
    const text = formatReport({
      hasDrift: true,
      unconvertible: ['^weird\\/regex$'],
      codeGlobs: new Set(),
      tableGlobs: new Set(),
      yamlGlobs: new Set(),
      diffs: {
        codeMissingFromTable: ['a/**/*.ts'],
        tableMissingFromCode: ['b/**/*.ts'],
        codeMissingFromYaml: ['c/**/*.ts'],
        yamlMissingFromCode: ['d/**/*.ts'],
      },
    });
    expect(text).toContain('Mirror drift detected');
    expect(text).toContain('Unconvertible regex patterns');
    expect(text).toContain('+ a/**/*.ts');
    expect(text).toContain('- b/**/*.ts');
    expect(text).toContain('+ c/**/*.ts');
    expect(text).toContain('- d/**/*.ts');
  });
});

describe('integration with current repo state', () => {
  it('the actual COVERAGE_PATTERNS and test-trigger.md are in sync', async () => {
    const { COVERAGE_PATTERNS } = await import('../check-utils.js');
    const { TEST_TRIGGER_MD } = await import('../check-mirror-drift.js');
    const { readFileSync } = await import('node:fs');
    const md = readFileSync(TEST_TRIGGER_MD, 'utf-8');
    const result = detectDrift({ coveragePatterns: COVERAGE_PATTERNS, markdown: md });
    if (result.hasDrift) {
      throw new Error(formatReport(result));
    }
    expect(result.hasDrift).toBe(false);
  });
});
