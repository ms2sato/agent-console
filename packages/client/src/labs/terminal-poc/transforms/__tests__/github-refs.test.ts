import { describe, it, expect } from 'bun:test';
import { githubRefDecorator } from '../github-refs';
import type { TransformContext } from '../../row-transforms';
import type { PocSegment, PocStyle } from '../../buffer-to-rows';

const REPO: TransformContext = { repoFullName: 'acme/widgets' };
const NO_REPO: TransformContext = { repoFullName: null };

function seg(text: string, style: PocStyle | null = null, link?: { href: string }): PocSegment {
  return link ? { text, style, link } : { text, style };
}

function run(segments: PocSegment[], ctx: TransformContext): PocSegment[] {
  return githubRefDecorator(segments, ctx);
}

describe('githubRefDecorator', () => {
  it('linkifies a bare #123 against the context repo', () => {
    const out = run([seg('see #123 please')], REPO);
    expect(out).toEqual([
      { text: 'see ', style: null },
      { text: '#123', style: null, link: { href: 'https://github.com/acme/widgets/issues/123' } },
      { text: ' please', style: null },
    ]);
  });

  it('linkifies a cross-repo owner/repo#123 to that repo', () => {
    const out = run([seg('other/proj#7')], REPO);
    expect(out).toEqual([
      { text: 'other/proj#7', style: null, link: { href: 'https://github.com/other/proj/issues/7' } },
    ]);
  });

  it('links multiple refs in one segment and preserves the between-text', () => {
    const out = run([seg('#1 and org/repo#2 done')], REPO);
    expect(out).toEqual([
      { text: '#1', style: null, link: { href: 'https://github.com/acme/widgets/issues/1' } },
      { text: ' and ', style: null },
      { text: 'org/repo#2', style: null, link: { href: 'https://github.com/org/repo/issues/2' } },
      { text: ' done', style: null },
    ]);
  });

  it('leaves bare refs untouched when repoFullName is null but still links cross-repo refs', () => {
    const bare = run([seg('bug #5 here')], NO_REPO);
    expect(bare).toEqual([{ text: 'bug #5 here', style: null }]);

    const cross = run([seg('x/y#5 here')], NO_REPO);
    expect(cross).toEqual([
      { text: 'x/y#5', style: null, link: { href: 'https://github.com/x/y/issues/5' } },
      { text: ' here', style: null },
    ]);
  });

  it('preserves the segment style on every split piece', () => {
    const style: PocStyle = { bold: true, fg: '#ff0000' };
    const out = run([seg('a #9 b', style)], REPO);
    expect(out).toEqual([
      { text: 'a ', style },
      { text: '#9', style, link: { href: 'https://github.com/acme/widgets/issues/9' } },
      { text: ' b', style },
    ]);
  });

  it('does not re-decorate a segment that already carries a link', () => {
    const existing = seg('#123', null, { href: 'https://example.com/x' });
    const out = run([existing], REPO);
    expect(out).toEqual([existing]);
  });

  describe('false positives excluded', () => {
    it('does not match HTML numeric entity &#123;', () => {
      const out = run([seg('&#123; entity')], REPO);
      expect(out).toEqual([{ text: '&#123; entity', style: null }]);
    });

    it('does not match #abc (non-numeric)', () => {
      const out = run([seg('#abc tag')], REPO);
      expect(out).toEqual([{ text: '#abc tag', style: null }]);
    });

    it('does not match a hex color #123456 (bare, exactly 6 digits)', () => {
      const out = run([seg('color: #123456;')], REPO);
      expect(out).toEqual([{ text: 'color: #123456;', style: null }]);
    });

    it('does not match a hex-with-letters color #12ab34 (no numeric \\b)', () => {
      const out = run([seg('color: #12ab34;')], REPO);
      expect(out).toEqual([{ text: 'color: #12ab34;', style: null }]);
    });

    it('does not match #123 embedded in a word (foo#123 has a preceding word char)', () => {
      const out = run([seg('foo#123')], REPO);
      expect(out).toEqual([{ text: 'foo#123', style: null }]);
    });

    it('still links a cross-repo ref even at 6 digits (unambiguous)', () => {
      const out = run([seg('big/repo#123456')], REPO);
      expect(out).toEqual([
        {
          text: 'big/repo#123456',
          style: null,
          link: { href: 'https://github.com/big/repo/issues/123456' },
        },
      ]);
    });

    it('links a 5-digit and 7-digit bare ref (only 6 is treated as hex)', () => {
      expect(run([seg('#12345')], REPO)).toEqual([
        { text: '#12345', style: null, link: { href: 'https://github.com/acme/widgets/issues/12345' } },
      ]);
      expect(run([seg('#1234567')], REPO)).toEqual([
        { text: '#1234567', style: null, link: { href: 'https://github.com/acme/widgets/issues/1234567' } },
      ]);
    });
  });

  it('returns segments with no refs unchanged (same reference)', () => {
    const input = [seg('plain text, no refs')];
    const out = run(input, REPO);
    expect(out).toEqual(input);
  });
});
