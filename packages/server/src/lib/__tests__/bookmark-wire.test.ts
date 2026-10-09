import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import { BookmarkSchema } from '@agent-console/shared';
import { toWireBookmark } from '../bookmark-wire.js';
import type { BookmarkRecord } from '../../repositories/bookmark-repository.js';

const RECORD: BookmarkRecord = {
  id: 'bookmark-1',
  url: 'https://example.com',
  title: 'Example',
  createdAt: '2026-01-01T00:00:00.000Z',
  origin: 'user',
  userId: 'user-1',
  sourceSessionId: 'session-1',
};

describe('toWireBookmark', () => {
  it('projects a full BookmarkRecord to exactly the five wire keys', () => {
    const result = toWireBookmark(RECORD);
    expect(Object.keys(result).sort()).toEqual(['createdAt', 'id', 'origin', 'title', 'url']);
  });

  it('a server-internal field added to BookmarkRecord is never carried across, and the projection still satisfies the strict wire schema', () => {
    const widened = { ...RECORD, internalOnly: 'x' } as BookmarkRecord & { internalOnly: string };
    const result = toWireBookmark(widened);
    expect(Object.keys(result)).not.toContain('internalOnly');
    expect(v.safeParse(BookmarkSchema, result).success).toBe(true);
  });
});
