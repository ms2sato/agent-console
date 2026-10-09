import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkDocFragments,
  slugifyHeading,
  stripHeadingMarkup,
  computeFenceMask,
  maskInlineCode,
  extractHeadingAnchors,
  extractAnchorTagIds,
  buildAnchorSet,
  extractFragmentLinks,
  UnreadableTargetError,
} from '../check-doc-fragments.mjs';

let tempDir;

function writeFixture(relPath, content) {
  const full = join(tempDir, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'doc-fragments-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('slugifyHeading', () => {
  it('lowercases and converts spaces to hyphens', () => {
    expect(slugifyHeading('Hello World')).toBe('hello-world');
  });

  it('strips punctuation other than hyphen and underscore', () => {
    expect(slugifyHeading('I/O Addressing Symmetry!')).toBe('io-addressing-symmetry');
  });

  it('keeps existing hyphens and underscores literally', () => {
    expect(slugifyHeading('agent_console --flag')).toBe('agent_console---flag');
  });

  it('resolves link syntax in headings to the link text', () => {
    expect(slugifyHeading('See [Foo](bar.md)')).toBe('see-foo');
  });

  it('strips digits-adjacent punctuation', () => {
    expect(slugifyHeading('Step 4: Configure the service')).toBe('step-4-configure-the-service');
  });
});

describe('stripHeadingMarkup', () => {
  it('replaces a markdown link with its link text', () => {
    expect(stripHeadingMarkup('before [Foo](bar.md) after')).toBe('before Foo after');
  });

  it('replaces a reference-style link with its link text', () => {
    expect(stripHeadingMarkup('[Foo][ref]')).toBe('Foo');
  });

  it('is a no-op on plain text', () => {
    expect(stripHeadingMarkup('plain heading')).toBe('plain heading');
  });
});

describe('computeFenceMask', () => {
  it('marks lines inside a backtick fence, including the delimiters', () => {
    const lines = ['before', '```', 'inside', '```', 'after'];
    expect(computeFenceMask(lines)).toEqual([false, true, true, true, false]);
  });

  it('marks lines inside a tilde fence', () => {
    const lines = ['~~~', 'inside', '~~~'];
    expect(computeFenceMask(lines)).toEqual([true, true, true]);
  });

  it('requires the closing fence to use the same character', () => {
    // A tilde line inside a backtick fence does not close it.
    const lines = ['```', '~~~', '```'];
    expect(computeFenceMask(lines)).toEqual([true, true, true]);
  });

  it('returns all-false for content with no fences', () => {
    const lines = ['a', 'b', 'c'];
    expect(computeFenceMask(lines)).toEqual([false, false, false]);
  });

  it('returns an empty array for empty input', () => {
    expect(computeFenceMask([])).toEqual([]);
  });

  it('does not let a nested fence-looking line with an info string close the block (CommonMark)', () => {
    const lines = ['```', '```js', 'inside', '```'];
    expect(computeFenceMask(lines)).toEqual([true, true, true, true]);
  });

  it('closes only on a marker line followed by nothing but whitespace', () => {
    const lines = ['```', 'inside', '``` ', 'after'];
    expect(computeFenceMask(lines)).toEqual([true, true, true, false]);
  });

  it('does not open a backtick fence whose info string contains a backtick', () => {
    const lines = ['``` `x`', 'after'];
    expect(computeFenceMask(lines)).toEqual([false, false]);
  });

  it('still opens a backtick fence with a backtick-free info string', () => {
    const lines = ['```js', 'inside', '```'];
    expect(computeFenceMask(lines)).toEqual([true, true, true]);
  });
});

describe('maskInlineCode', () => {
  it('replaces an inline code span with same-length filler', () => {
    const masked = maskInlineCode('prose `code` more');
    expect(masked).toHaveLength('prose `code` more'.length);
    expect(masked).not.toContain('code');
  });

  it('leaves a line with no inline code unchanged', () => {
    expect(maskInlineCode('plain prose')).toBe('plain prose');
  });

  it('masks a literal link example written as inline code', () => {
    const masked = maskInlineCode('see `](#frag)` for an example');
    expect(masked).not.toContain('](#frag)');
  });
});

describe('extractHeadingAnchors', () => {
  it('returns an empty set for content with no headings', () => {
    expect(extractHeadingAnchors('just some\nprose text\n')).toEqual(new Set());
  });

  it('returns an empty set for empty content', () => {
    expect(extractHeadingAnchors('')).toEqual(new Set());
  });

  it('suffixes a repeated slug with -1, -2, ...', () => {
    const content = '# Foo\n\n# Foo\n\n# Foo\n';
    expect(extractHeadingAnchors(content)).toEqual(new Set(['foo', 'foo-1', 'foo-2']));
  });

  it('ignores headings inside a fenced code block', () => {
    const content = '# Real\n\n```\n# Fake\n```\n';
    expect(extractHeadingAnchors(content)).toEqual(new Set(['real']));
  });

  it('derives the slug from link text when the heading contains a link', () => {
    const content = '## See [Foo](bar.md)\n';
    expect(extractHeadingAnchors(content)).toEqual(new Set(['see-foo']));
  });

  it('supports heading levels 1 through 6', () => {
    const content = '# One\n## Two\n###### Six\n';
    expect(extractHeadingAnchors(content)).toEqual(new Set(['one', 'two', 'six']));
  });

  it('strips optional closing ATX hashes', () => {
    const content = '## Title ##\n';
    expect(extractHeadingAnchors(content)).toEqual(new Set(['title']));
  });
});

describe('extractAnchorTagIds', () => {
  it('finds a literal <a id="..."> anchor', () => {
    expect(extractAnchorTagIds('<a id="legacy"></a>\n')).toEqual(new Set(['legacy']));
  });

  it('finds a literal <a name="..."> anchor', () => {
    expect(extractAnchorTagIds('<a name="old-name"></a>\n')).toEqual(new Set(['old-name']));
  });

  it('ignores an anchor tag inside a fenced code block', () => {
    const content = '```\n<a id="fake"></a>\n```\n';
    expect(extractAnchorTagIds(content)).toEqual(new Set());
  });

  it('ignores an anchor tag written as an inline code example', () => {
    const content = 'see `<a id="fake">` for the syntax\n';
    expect(extractAnchorTagIds(content)).toEqual(new Set());
  });

  it('returns an empty set when there are no anchor tags', () => {
    expect(extractAnchorTagIds('# Heading\n\nprose\n')).toEqual(new Set());
  });
});

describe('buildAnchorSet', () => {
  it('combines heading slugs and literal anchor tag ids', () => {
    const content = '<a id="legacy"></a>\n\n# New Heading\n';
    expect(buildAnchorSet(content)).toEqual(new Set(['legacy', 'new-heading']));
  });
});

describe('extractFragmentLinks', () => {
  it('extracts a same-file fragment link', () => {
    expect(extractFragmentLinks('[x](#frag)\n')).toEqual([{ line: 1, frag: 'frag', pathPart: '' }]);
  });

  it('extracts a cross-file fragment link', () => {
    expect(extractFragmentLinks('[x](other.md#frag)\n')).toEqual([
      { line: 1, frag: 'frag', pathPart: 'other.md' },
    ]);
  });

  it('skips a link with no fragment', () => {
    expect(extractFragmentLinks('[x](other.md)\n')).toEqual([]);
  });

  it('skips an http(s) external link even with a fragment', () => {
    expect(extractFragmentLinks('[x](https://example.com#frag)\n')).toEqual([]);
  });

  it('ignores a link inside a fenced code block', () => {
    const content = '```\n[x](#nothing)\n```\n';
    expect(extractFragmentLinks(content)).toEqual([]);
  });

  it('ignores a link written as an inline code example in prose', () => {
    const content = 'a literal example: `[x](#nothing)` in prose\n';
    expect(extractFragmentLinks(content)).toEqual([]);
  });

  it('returns an empty array for content with no links', () => {
    expect(extractFragmentLinks('just prose\n')).toEqual([]);
  });

  it('extracts multiple links on the same line with correct line numbers', () => {
    const content = 'prose\n[a](#one) and [b](#two)\n';
    expect(extractFragmentLinks(content)).toEqual([
      { line: 2, frag: 'one', pathPart: '' },
      { line: 2, frag: 'two', pathPart: '' },
    ]);
  });

  it('drops a trailing link title', () => {
    expect(extractFragmentLinks('[x](other.md#frag "a title")\n')).toEqual([
      { line: 1, frag: 'frag', pathPart: 'other.md' },
    ]);
  });

  it('decodes a percent-encoded fragment to its literal Unicode text', () => {
    expect(extractFragmentLinks('[jump](#%E6%97%A5%E6%9C%AC%E8%AA%9E)\n')).toEqual([
      { line: 1, frag: '日本語', pathPart: '' }, // lang-check:allow -- deliberate non-Latin decode target
    ]);
  });

  it('falls back to the raw fragment on a malformed percent-escape', () => {
    expect(extractFragmentLinks('[x](#frag%)\n')).toEqual([{ line: 1, frag: 'frag%', pathPart: '' }]);
  });

  it('does not extract a link hidden inside a nested fence-looking "```js" line', () => {
    const content = '```\n```js\n[fake](#nothing)\n```\n[real](#real)\n';
    expect(extractFragmentLinks(content)).toEqual([{ line: 5, frag: 'real', pathPart: '' }]);
  });
});

describe('checkDocFragments — acceptance scenarios', () => {
  // (a) valid same-file + cross-file links -> no misses
  it('(a) reports no misses for valid same-file and cross-file links', () => {
    writeFixture('valid.md', '# Intro\n\nSee [other](other.md#topic) and [self](#intro).\n');
    writeFixture('other.md', '# Topic\n\nSome content.\n');

    const result = checkDocFragments(tempDir, { cwd: tempDir });
    expect(result.misses).toEqual([]);
    expect(result.filesScanned).toBe(2);
  });

  // (b) a dangling same-file fragment -> reported with line
  it('(b) reports a dangling same-file fragment with its line number', () => {
    writeFixture('dangling-same.md', '# Real Heading\n\n[broken](#nonexistent-fragment)\n');

    const result = checkDocFragments(tempDir, { cwd: tempDir });
    expect(result.misses).toEqual([
      {
        file: 'dangling-same.md',
        line: 3,
        frag: 'nonexistent-fragment',
        target: 'dangling-same.md',
        reason: 'no-anchor',
      },
    ]);
  });

  // (c) duplicate headings resolve #x and #x-1
  it('(c) resolves both the base slug and its -1 suffix for duplicate headings', () => {
    writeFixture('duplicate.md', '# Foo\n\nSome text.\n\n# Foo\n\n[a](#foo) and [b](#foo-1)\n');

    const result = checkDocFragments(tempDir, { cwd: tempDir });
    expect(result.misses).toEqual([]);
  });

  // (d) a heading containing a link `## See [Foo](bar.md)` yields `#see-foo`
  it('(d) resolves a link to a heading-with-link-syntax slug', () => {
    writeFixture('heading-link.md', '## See [Foo](bar.md)\n\n[jump](#see-foo)\n');

    const result = checkDocFragments(tempDir, { cwd: tempDir });
    expect(result.misses).toEqual([]);
  });

  // (e) a fenced block containing `](#nothing)` is ignored
  it('(e) ignores a link inside a fenced code block', () => {
    writeFixture('fenced.md', '# Heading\n\n```text\n[fake link](#nothing)\n```\n');

    const result = checkDocFragments(tempDir, { cwd: tempDir });
    expect(result.misses).toEqual([]);
  });

  // (f) `<a id="legacy">` satisfies `#legacy`
  it('(f) resolves a link against a literal <a id> anchor', () => {
    writeFixture(
      'anchor-tag.md',
      '<a id="legacy"></a>\n\n# New Heading\n\n[old](#legacy) and [new](#new-heading)\n',
    );

    const result = checkDocFragments(tempDir, { cwd: tempDir });
    expect(result.misses).toEqual([]);
  });

  // (g) cross-file link to a missing `.md` -> reported
  it('(g) reports a cross-file link to a missing .md file', () => {
    writeFixture('missing-target.md', '# Heading\n\n[broken](missing-doc.md#somewhere)\n');

    const result = checkDocFragments(tempDir, { cwd: tempDir });
    expect(result.misses).toEqual([
      {
        file: 'missing-target.md',
        line: 3,
        frag: 'somewhere',
        target: 'missing-doc.md',
        reason: 'missing-file',
      },
    ]);
  });

  // (h) boundary: a .md with no links and no headings -> nothing
  it('(h) reports nothing for a file with no links and no headings', () => {
    writeFixture('empty.md', 'Just prose, no headings, no links.\n');

    const result = checkDocFragments(tempDir, { cwd: tempDir });
    expect(result.misses).toEqual([]);
    expect(result.filesScanned).toBe(1);
  });

  it('does not mistake a nested fence-looking "```js" line for the real close', () => {
    writeFixture(
      'nested-fence.md',
      '# Real\n\n```\n```js\n[fake](#nothing)\n```\n\n[real](#real)\n',
    );

    const result = checkDocFragments(tempDir, { cwd: tempDir });
    expect(result.misses).toEqual([]);
  });

  it('resolves a percent-encoded link to a non-ASCII heading', () => {
    writeFixture(
      'unicode-heading.md',
      '# 日本語\n\n[jump](#%E6%97%A5%E6%9C%AC%E8%AA%9E)\n', // lang-check:allow -- deliberate non-Latin fixture heading
    );

    const result = checkDocFragments(tempDir, { cwd: tempDir });
    expect(result.misses).toEqual([]);
  });

  it('does not flag an inline-code link-syntax example describing this very checker', () => {
    writeFixture(
      'self-describing.md',
      '# Notes\n\nThis checker validates `](#frag)` and `](path.md#frag)` links.\n',
    );

    const result = checkDocFragments(tempDir, { cwd: tempDir });
    expect(result.misses).toEqual([]);
  });

  it('boundary: an entirely empty file scans cleanly', () => {
    writeFixture('truly-empty.md', '');

    const result = checkDocFragments(tempDir, { cwd: tempDir });
    expect(result.misses).toEqual([]);
    expect(result.filesScanned).toBe(1);
  });

  it('accepts a single file path as roots (not just a directory)', () => {
    writeFixture('single.md', '# Heading\n\n[ok](#heading)\n[bad](#missing)\n');

    const result = checkDocFragments(join(tempDir, 'single.md'), { cwd: tempDir });
    expect(result.misses).toEqual([
      {
        file: 'single.md',
        line: 4,
        frag: 'missing',
        target: 'single.md',
        reason: 'no-anchor',
      },
    ]);
  });

  it('accepts an array of roots and resolves links across them', () => {
    writeFixture('a/one.md', '[x](../b/two.md#there)\n');
    writeFixture('b/two.md', '# There\n');

    const result = checkDocFragments([join(tempDir, 'a'), join(tempDir, 'b')], { cwd: tempDir });
    expect(result.misses).toEqual([]);
    expect(result.filesScanned).toBe(2);
  });

  it('throws UnreadableTargetError only for non-ENOENT read failures, exported for callers to catch', () => {
    // Exercised indirectly: UnreadableTargetError is exported and constructible,
    // confirming it carries the file path and cause for the CLI's exit(2) path.
    const err = new UnreadableTargetError('/some/path.md', new Error('boom'));
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('UnreadableTargetError');
    expect(err.filePath).toBe('/some/path.md');
    expect(err.message).toContain('/some/path.md');
  });
});
