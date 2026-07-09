import { describe, it, expect } from 'bun:test';
import {
  applySegmentDecorators,
  applyLinkTransforms,
  type SegmentDecorator,
  type LinkTransform,
  type TransformContext,
} from '../row-transforms';
import type { TerminalSegment } from '../buffer-to-rows';
import type { LinkRange } from '../link-detection';

const CTX: TransformContext = { repoFullName: 'acme/widgets' };

function segs(...texts: string[]): TerminalSegment[] {
  return texts.map((text) => ({ text, style: null }));
}

describe('applySegmentDecorators', () => {
  it('returns the input unchanged (same reference) when the decorator list is empty', () => {
    const input = segs('hello');
    const out = applySegmentDecorators(input, [], CTX);
    expect(out).toBe(input);
  });

  it('applies a single decorator', () => {
    const upper: SegmentDecorator = (segments) =>
      segments.map((s) => ({ ...s, text: s.text.toUpperCase() }));
    const out = applySegmentDecorators(segs('abc'), [upper], CTX);
    expect(out).toEqual([{ text: 'ABC', style: null }]);
  });

  it('threads output of one decorator into the next, in order', () => {
    const order: string[] = [];
    const a: SegmentDecorator = (segments) => {
      order.push('a');
      return [...segments, { text: 'a', style: null }];
    };
    const b: SegmentDecorator = (segments) => {
      order.push('b');
      return [...segments, { text: 'b', style: null }];
    };
    const out = applySegmentDecorators(segs('x'), [a, b], CTX);
    expect(order).toEqual(['a', 'b']);
    expect(out).toEqual(segs('x', 'a', 'b'));
  });

  it('passes the transform context through to every decorator', () => {
    const seen: (string | null)[] = [];
    const spy: SegmentDecorator = (segments, ctx) => {
      seen.push(ctx.repoFullName);
      return segments;
    };
    applySegmentDecorators(segs('x'), [spy, spy], { repoFullName: 'o/r' });
    expect(seen).toEqual(['o/r', 'o/r']);
  });
});

function links(...hrefs: string[]): LinkRange[] {
  return hrefs.map((href, i) => ({ start: i, end: i + 1, href }));
}

describe('applyLinkTransforms', () => {
  it('returns the input unchanged (same reference) when the transform list is empty', () => {
    const input = links('http://a');
    const out = applyLinkTransforms(input, [], CTX);
    expect(out).toBe(input);
  });

  it('threads output of one transform into the next, in order', () => {
    const order: string[] = [];
    const a: LinkTransform = (ls) => {
      order.push('a');
      return ls.map((l) => ({ ...l, href: `${l.href}#a` }));
    };
    const b: LinkTransform = (ls) => {
      order.push('b');
      return ls.map((l) => ({ ...l, href: `${l.href}#b` }));
    };
    const out = applyLinkTransforms(links('http://x'), [a, b], CTX);
    expect(order).toEqual(['a', 'b']);
    expect(out[0].href).toBe('http://x#a#b');
  });

  it('passes the transform context through to every transform', () => {
    const seen: (string | null)[] = [];
    const spy: LinkTransform = (ls, ctx) => {
      seen.push(ctx.repoFullName);
      return ls;
    };
    applyLinkTransforms(links('http://x'), [spy, spy], { repoFullName: 'o/r' });
    expect(seen).toEqual(['o/r', 'o/r']);
  });
});
