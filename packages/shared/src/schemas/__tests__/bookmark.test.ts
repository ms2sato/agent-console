import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  BookmarkSchema,
  BookmarksListResponseSchema,
  CreateBookmarkRequestSchema,
  type Bookmark,
} from '../bookmark.js';

type Assert<T extends true> = T;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// Pins. `Bookmark` is derived from `BookmarkSchema`, so the schema is the only place a field is
// edited. `_BookmarkKeys` compares `keyof` with an explicit literal union, so a field added to
// (or removed from) the schema alone is a `tsc` failure (TS2344). `_BookmarkOriginIsUserOrAgent`
// pins the one member whose shape the schema narrows (a picklist). `Assert<Equals<...>>` is the
// form that fails under drift; a `declare const x: never` form would type-check under it.
//
// Measured reach (`tsc` diagnostics, control clean first), two-sided: adding a field to, or removing
// one from, `BookmarkSchema` fails `_BookmarkKeys` (TS2344) plus the typed fixtures below (TS2741 on
// an added field, TS2353 on a removed one); widening `origin` to `v.string()` fails
// `_BookmarkOriginIsUserOrAgent` (TS2344) and nothing else, and so does adding a third picklist
// member. Each pin's diagnostic sits on the pin's line and does not name the key.
export type _BookmarkKeys = Assert<Equals<keyof Bookmark, 'id' | 'url' | 'title' | 'createdAt' | 'origin'>>;
export type _BookmarkOriginIsUserOrAgent = Assert<Equals<Bookmark['origin'], 'user' | 'agent'>>;

describe('BookmarkSchema', () => {
  it('accepts a well-formed Bookmark object (parse-path, closes the #926 silent-drop gap)', () => {
    // Constructed as the shared `Bookmark` TS type, then parsed through the
    // wire schema: proves the two are kept in sync (pre-pr-completeness.md
    // Q10). A field added to one but not the other fails this test.
    const bookmark: Bookmark = {
      id: 'bookmark-1',
      url: 'https://example.com',
      title: 'Example',
      createdAt: '2026-08-20T00:00:00.000Z',
      origin: 'user',
    };

    const result = v.safeParse(BookmarkSchema, bookmark);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toEqual(bookmark);
    }
  });

  it('accepts a null title', () => {
    const bookmark: Bookmark = {
      id: 'bookmark-1',
      url: 'https://example.com',
      title: null,
      createdAt: '2026-08-20T00:00:00.000Z',
      origin: 'user',
    };

    const result = v.safeParse(BookmarkSchema, bookmark);
    expect(result.success).toBe(true);
  });

  it('rejects a missing required field', () => {
    const result = v.safeParse(BookmarkSchema, {
      id: 'bookmark-1',
      url: 'https://example.com',
      title: null,
      origin: 'user',
      // createdAt omitted
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty id string', () => {
    const result = v.safeParse(BookmarkSchema, {
      id: '',
      url: 'https://example.com',
      title: null,
      createdAt: '2026-08-20T00:00:00.000Z',
      origin: 'user',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty url string', () => {
    const result = v.safeParse(BookmarkSchema, {
      id: 'bookmark-1',
      url: '',
      title: null,
      createdAt: '2026-08-20T00:00:00.000Z',
      origin: 'user',
    });
    expect(result.success).toBe(false);
  });

  it('rejects title: undefined (must be explicitly null, not omitted -- strictObject requires the key present)', () => {
    const result = v.safeParse(BookmarkSchema, {
      id: 'bookmark-1',
      url: 'https://example.com',
      createdAt: '2026-08-20T00:00:00.000Z',
      origin: 'user',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key (strict-parse contract)', () => {
    const result = v.safeParse(BookmarkSchema, {
      id: 'bookmark-1',
      url: 'https://example.com',
      title: null,
      createdAt: '2026-08-20T00:00:00.000Z',
      origin: 'user',
      userId: 'user-1',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.issues)).toContain('userId');
    }
  });

  describe('origin field', () => {
    const base = {
      id: 'bookmark-1',
      url: 'https://example.com',
      title: null,
      createdAt: '2026-08-20T00:00:00.000Z',
    };

    it("round-trips origin: 'user'", () => {
      const result = v.safeParse(BookmarkSchema, { ...base, origin: 'user' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.origin).toBe('user');
      }
    });

    it("round-trips origin: 'agent'", () => {
      const result = v.safeParse(BookmarkSchema, { ...base, origin: 'agent' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.origin).toBe('agent');
      }
    });

    it('rejects an origin value outside the picklist', () => {
      const result = v.safeParse(BookmarkSchema, { ...base, origin: 'admin' });
      expect(result.success).toBe(false);
    });

    it('rejects a missing origin field (strictObject requires the key present)', () => {
      const result = v.safeParse(BookmarkSchema, base);
      expect(result.success).toBe(false);
    });
  });
});

describe('BookmarksListResponseSchema', () => {
  it('accepts a well-formed { bookmarks: [...] } response', () => {
    const bookmarks: Bookmark[] = [
      { id: 'bookmark-1', url: 'https://example.com', title: 'Example', createdAt: '2026-08-20T00:00:00.000Z', origin: 'user' },
      { id: 'bookmark-2', url: 'http://example.org', title: null, createdAt: '2026-08-19T00:00:00.000Z', origin: 'agent' },
    ];

    const result = v.safeParse(BookmarksListResponseSchema, { bookmarks });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toEqual({ bookmarks });
    }
  });

  it('accepts an empty bookmarks array (boundary case)', () => {
    const result = v.safeParse(BookmarksListResponseSchema, { bookmarks: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toEqual({ bookmarks: [] });
    }
  });

  it('rejects a response missing the bookmarks field', () => {
    const result = v.safeParse(BookmarksListResponseSchema, {});
    expect(result.success).toBe(false);
  });

  it('rejects a response whose array contains an invalid bookmark', () => {
    const result = v.safeParse(BookmarksListResponseSchema, {
      bookmarks: [{ id: 'bookmark-1', url: 'https://example.com', title: null /* createdAt omitted */ }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level key (strict-parse contract)', () => {
    const result = v.safeParse(BookmarksListResponseSchema, { bookmarks: [], total: 0 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.issues)).toContain('total');
    }
  });
});

describe('CreateBookmarkRequestSchema', () => {
  const validBase = { url: 'https://example.com', sessionId: 'session-1' };

  it('accepts a well-formed request with a title', () => {
    const result = v.safeParse(CreateBookmarkRequestSchema, { ...validBase, title: 'My bookmark' });
    expect(result.success).toBe(true);
  });

  it('accepts a well-formed request with title omitted', () => {
    const result = v.safeParse(CreateBookmarkRequestSchema, validBase);
    expect(result.success).toBe(true);
  });

  it('accepts an http: URL', () => {
    const result = v.safeParse(CreateBookmarkRequestSchema, { ...validBase, url: 'http://example.com' });
    expect(result.success).toBe(true);
  });

  it('accepts an https: URL', () => {
    const result = v.safeParse(CreateBookmarkRequestSchema, { ...validBase, url: 'https://example.com' });
    expect(result.success).toBe(true);
  });

  it('rejects a javascript: URL scheme (S4 scheme allowlist)', () => {
    const result = v.safeParse(CreateBookmarkRequestSchema, {
      ...validBase,
      url: 'javascript:alert(1)',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a data: URL scheme (S4 scheme allowlist)', () => {
    const result = v.safeParse(CreateBookmarkRequestSchema, {
      ...validBase,
      url: 'data:text/html,<script>alert(1)</script>',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a file: URL scheme (S4 scheme allowlist)', () => {
    const result = v.safeParse(CreateBookmarkRequestSchema, {
      ...validBase,
      url: 'file:///etc/passwd',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a vbscript: URL scheme (S4 scheme allowlist)', () => {
    const result = v.safeParse(CreateBookmarkRequestSchema, {
      ...validBase,
      url: 'vbscript:msgbox("hi")',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty url', () => {
    const result = v.safeParse(CreateBookmarkRequestSchema, { ...validBase, url: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed (non-parseable) url', () => {
    const result = v.safeParse(CreateBookmarkRequestSchema, { ...validBase, url: 'not a url' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty sessionId', () => {
    const result = v.safeParse(CreateBookmarkRequestSchema, { ...validBase, sessionId: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing sessionId', () => {
    const result = v.safeParse(CreateBookmarkRequestSchema, { url: validBase.url });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key (strict-parse contract)', () => {
    const result = v.safeParse(CreateBookmarkRequestSchema, { ...validBase, extra: 'nope' });
    expect(result.success).toBe(false);
  });

  describe('title length cap (200 characters)', () => {
    it('accepts a title exactly at the 200-character cap', () => {
      const result = v.safeParse(CreateBookmarkRequestSchema, { ...validBase, title: 'a'.repeat(200) });
      expect(result.success).toBe(true);
    });

    it('rejects a title one character over the 200-character cap', () => {
      const result = v.safeParse(CreateBookmarkRequestSchema, { ...validBase, title: 'a'.repeat(201) });
      expect(result.success).toBe(false);
    });
  });
});
