import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import type { ReviewComment, ReviewQueueGroup, ReviewQueueItem } from '../../types/git-diff';
import {
  ReviewQueueGroupSchema,
  ReviewQueueItemSchema,
  ReviewQueueResponseSchema,
  ReviewCommentSchema,
  ReviewStatusResponseSchema,
} from '../review-queue';

// `ReviewQueueItem` / `ReviewQueueGroup` stay hand-written interfaces the server imports;
// these pins fix each schema's output to its interface exactly. `Assert<Equals<...>>` fails
// `tsc` (TS2344) under drift in either direction.
type Assert<T extends true> = T;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export type _ReviewQueueItemIsExact = Assert<Equals<v.InferOutput<typeof ReviewQueueItemSchema>, ReviewQueueItem>>;
export type _ReviewCommentIsExact = Assert<Equals<v.InferOutput<typeof ReviewCommentSchema>, ReviewComment>>;
export type _ReviewQueueGroupIsExact = Assert<Equals<v.InferOutput<typeof ReviewQueueGroupSchema>, ReviewQueueGroup>>;

const item = {
  workerId: 'w1',
  sessionId: 's1',
  sessionTitle: 'Session',
  sourceSessionId: 's0',
  sourceSessionTitle: 'Source',
  annotationCount: 2,
  summary: { totalFiles: 3, reviewFiles: 1, mechanicalFiles: 2, confidence: 'high' },
  status: 'pending',
  commentCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const group = { sourceSessionId: 's0', sourceSessionTitle: 'Source', items: [item] };

describe('ReviewQueueResponseSchema', () => {
  it('accepts a bare array of groups, including an empty queue and an empty group', () => {
    expect(v.safeParse(ReviewQueueResponseSchema, []).success).toBe(true);
    expect(v.safeParse(ReviewQueueResponseSchema, [group]).success).toBe(true);
    expect(v.safeParse(ReviewQueueResponseSchema, [{ ...group, items: [] }]).success).toBe(true);
  });

  it('rejects an envelope object instead of a bare array', () => {
    expect(v.safeParse(ReviewQueueResponseSchema, { groups: [group] }).success).toBe(false);
  });

  it('rejects an extra field on a group', () => {
    expect(v.safeParse(ReviewQueueResponseSchema, [{ ...group, extra: 1 }]).success).toBe(false);
  });
});

describe('ReviewQueueItemSchema', () => {
  it('accepts an item with and without the parent session fields, and a completed status', () => {
    expect(v.safeParse(ReviewQueueItemSchema, item).success).toBe(true);
    expect(
      v.safeParse(ReviewQueueItemSchema, { ...item, parentSessionId: 'p1', parentSessionTitle: 'Parent' }).success,
    ).toBe(true);
    expect(v.safeParse(ReviewQueueItemSchema, { ...item, status: 'completed' }).success).toBe(true);
  });

  it('accepts every confidence level', () => {
    for (const confidence of ['high', 'medium', 'low']) {
      expect(v.safeParse(ReviewQueueItemSchema, { ...item, summary: { ...item.summary, confidence } }).success).toBe(
        true,
      );
    }
  });

  it('rejects an extra field on the item and on the summary', () => {
    expect(v.safeParse(ReviewQueueItemSchema, { ...item, extra: 1 }).success).toBe(false);
    expect(v.safeParse(ReviewQueueItemSchema, { ...item, summary: { ...item.summary, extra: 1 } }).success).toBe(false);
  });

  it('rejects each dropped required field', () => {
    for (const key of Object.keys(item)) {
      const { [key]: _dropped, ...rest } = item as Record<string, unknown>;
      expect(v.safeParse(ReviewQueueItemSchema, rest).success).toBe(false);
    }
  });

  it('rejects an unknown status, an unknown confidence and a null parent id', () => {
    expect(v.safeParse(ReviewQueueItemSchema, { ...item, status: 'archived' }).success).toBe(false);
    expect(
      v.safeParse(ReviewQueueItemSchema, { ...item, summary: { ...item.summary, confidence: 'certain' } }).success,
    ).toBe(false);
    expect(v.safeParse(ReviewQueueItemSchema, { ...item, parentSessionId: null }).success).toBe(false);
  });
});

describe('ReviewCommentSchema', () => {
  const comment: ReviewComment = { id: 'c1', file: 'a.ts', line: 3, body: 'nit', createdAt: '2026-01-01T00:00:00.000Z' };

  it('accepts the real comment shape', () => {
    expect(v.safeParse(ReviewCommentSchema, comment).success).toBe(true);
  });

  it('rejects an extra field, a dropped field and a fractional line', () => {
    expect(v.safeParse(ReviewCommentSchema, { ...comment, extra: 1 }).success).toBe(false);
    const { body: _dropped, ...rest } = comment;
    expect(v.safeParse(ReviewCommentSchema, rest).success).toBe(false);
    expect(v.safeParse(ReviewCommentSchema, { ...comment, line: 1.5 }).success).toBe(false);
  });
});

describe('ReviewStatusResponseSchema', () => {
  it('accepts { workerId, status }', () => {
    expect(v.safeParse(ReviewStatusResponseSchema, { workerId: 'w1', status: 'completed' }).success).toBe(true);
  });

  it('rejects an extra field and a dropped field', () => {
    expect(v.safeParse(ReviewStatusResponseSchema, { workerId: 'w1', status: 'completed', extra: 1 }).success).toBe(false);
    expect(v.safeParse(ReviewStatusResponseSchema, { workerId: 'w1' }).success).toBe(false);
    expect(v.safeParse(ReviewStatusResponseSchema, { status: 'completed' }).success).toBe(false);
  });
});
