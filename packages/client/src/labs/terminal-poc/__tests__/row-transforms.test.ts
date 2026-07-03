import { describe, it, expect } from 'bun:test';
import { applySegmentDecorators, type SegmentDecorator, type TransformContext } from '../row-transforms';
import type { PocSegment } from '../buffer-to-rows';

const CTX: TransformContext = { repoFullName: 'acme/widgets' };

function segs(...texts: string[]): PocSegment[] {
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
