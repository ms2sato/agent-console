/**
 * Sibling test for `SqliteBookmarkRepository`.
 *
 * Unlike `sqlite-artifact-repository.test.ts`, bookmarks have no
 * file-storage component -- this is a pure in-memory-DB test, no real
 * filesystem needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Kysely } from 'kysely';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteBookmarkRepository } from '../sqlite-bookmark-repository.js';

describe('SqliteBookmarkRepository', () => {
  let db: Kysely<Database>;
  let repository: SqliteBookmarkRepository;

  beforeEach(async () => {
    db = await createDatabaseForTest();
    repository = new SqliteBookmarkRepository(db);

    // `bookmarks.user_id` carries a real FK to `users.id` -- seed the two
    // synthetic users this file's tests attribute bookmarks to.
    const now = new Date().toISOString();
    for (const id of ['user-1', 'user-2']) {
      await db
        .insertInto('users')
        .values({ id, os_uid: null, username: id, home_dir: `/home/${id}`, created_at: now, updated_at: now })
        .execute();
    }
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('create', () => {
    it('creates a row and returns the wire summary plus userId', async () => {
      const bookmark = await repository.create({
        id: 'bookmark-1',
        userId: 'user-1',
        url: 'https://example.com',
        title: 'My Bookmark',
        sourceSessionId: 'session-1',
      });

      expect(bookmark).toEqual({
        id: 'bookmark-1',
        userId: 'user-1',
        url: 'https://example.com',
        title: 'My Bookmark',
        createdAt: bookmark.createdAt,
      });
      // `create`/`findById` return the server-internal BookmarkRecord (wire
      // summary + userId, needed by route handlers to enforce owner-only
      // delete -- see repositories/bookmark-repository.ts). `userId` is NOT
      // part of the wire `Bookmark` type and must never be serialized into
      // an HTTP response (see packages/shared/src/types/bookmark.ts).
      expect(Object.keys(bookmark).sort()).toEqual(['createdAt', 'id', 'title', 'url', 'userId'].sort());
    });

    it('creates a bookmark with a null title', async () => {
      const bookmark = await repository.create({
        id: 'bookmark-no-title',
        userId: 'user-1',
        url: 'https://example.com',
        title: null,
        sourceSessionId: null,
      });

      expect(bookmark.title).toBeNull();
    });
  });

  describe('findById', () => {
    it('returns null for a non-existent id', async () => {
      expect(await repository.findById('does-not-exist')).toBeNull();
    });

    it('finds an existing bookmark', async () => {
      await repository.create({
        id: 'bookmark-2',
        userId: 'user-1',
        url: 'https://example.com/found',
        title: 'Found Me',
        sourceSessionId: null,
      });

      const found = await repository.findById('bookmark-2');
      expect(found?.id).toBe('bookmark-2');
      expect(found?.title).toBe('Found Me');
    });
  });

  describe('findByUserId', () => {
    it('returns only the given user\'s bookmarks, newest first', async () => {
      await repository.create({
        id: 'bookmark-old',
        userId: 'user-1',
        url: 'https://example.com/old',
        title: 'Old',
        sourceSessionId: null,
      });
      await new Promise((r) => setTimeout(r, 2));
      await repository.create({
        id: 'bookmark-new',
        userId: 'user-1',
        url: 'https://example.com/new',
        title: 'New',
        sourceSessionId: null,
      });
      await repository.create({
        id: 'bookmark-other-user',
        userId: 'user-2',
        url: 'https://example.com/other',
        title: 'Other user',
        sourceSessionId: null,
      });

      const results = await repository.findByUserId('user-1');
      expect(results.map((b) => b.id)).toEqual(['bookmark-new', 'bookmark-old']);
    });

    it('returns an empty array for a user with no bookmarks', async () => {
      expect(await repository.findByUserId('nobody')).toEqual([]);
    });
  });

  describe('findByUserIdAndSourceSessionId', () => {
    it('returns only the given user\'s bookmarks within the given session, newest first', async () => {
      await repository.create({
        id: 'bookmark-session-old',
        userId: 'user-1',
        url: 'https://example.com/old',
        title: 'Session Old',
        sourceSessionId: 'session-1',
      });
      await new Promise((r) => setTimeout(r, 2));
      await repository.create({
        id: 'bookmark-session-new',
        userId: 'user-1',
        url: 'https://example.com/new',
        title: 'Session New',
        sourceSessionId: 'session-1',
      });
      // Same user, but a different session -- must not appear.
      await repository.create({
        id: 'bookmark-other-session',
        userId: 'user-1',
        url: 'https://example.com/other-session',
        title: 'Other session',
        sourceSessionId: 'session-2',
      });

      const results = await repository.findByUserIdAndSourceSessionId('user-1', 'session-1');
      expect(results.map((b) => b.id)).toEqual(['bookmark-session-new', 'bookmark-session-old']);
    });

    it("does not leak another user's bookmark in the SAME session (polarity direction 1)", async () => {
      await repository.create({
        id: 'bookmark-mine',
        userId: 'user-1',
        url: 'https://example.com/mine',
        title: 'Mine',
        sourceSessionId: 'session-1',
      });
      await repository.create({
        id: 'bookmark-theirs',
        userId: 'user-2',
        url: 'https://example.com/theirs',
        title: 'Theirs',
        sourceSessionId: 'session-1',
      });

      const results = await repository.findByUserIdAndSourceSessionId('user-1', 'session-1');
      expect(results.map((b) => b.id)).toEqual(['bookmark-mine']);
    });

    it("does not leak the same user's bookmark from ANOTHER session (polarity direction 2)", async () => {
      await repository.create({
        id: 'bookmark-session-1',
        userId: 'user-1',
        url: 'https://example.com/s1',
        title: 'Session 1',
        sourceSessionId: 'session-1',
      });
      await repository.create({
        id: 'bookmark-session-2',
        userId: 'user-1',
        url: 'https://example.com/s2',
        title: 'Session 2',
        sourceSessionId: 'session-2',
      });

      const results = await repository.findByUserIdAndSourceSessionId('user-1', 'session-1');
      expect(results.map((b) => b.id)).toEqual(['bookmark-session-1']);
    });

    it("stays SQL-scoped, not JS-filtered-after-fetch: the caller's own OLDER bookmark in the target session still appears even when the caller has many NEWER bookmarks in OTHER sessions", async () => {
      await repository.create({
        id: 'bookmark-caller-target-old',
        userId: 'user-1',
        url: 'https://example.com/target',
        title: "Caller's own, in target session, created first",
        sourceSessionId: 'session-1',
      });

      // 10 of the SAME user's bookmarks in OTHER sessions, all created
      // AFTER the caller's own target-session bookmark. If the session
      // filter were a post-fetch JS .filter() applied to an already-capped
      // `findByUserId('user-1')` fetch (rather than a single
      // `WHERE user_id = ? AND source_session_id = ?` SQL query), these 10
      // newer same-user rows from other sessions could push the older
      // target-session row out of a capped window before the session
      // filter even runs. This proves the implementation is genuinely
      // scoped by both conditions in one SQL query.
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1));
        await repository.create({
          id: `bookmark-other-session-${i}`,
          userId: 'user-1',
          url: `https://example.com/other-${i}`,
          title: `Other session ${i}`,
          sourceSessionId: 'session-2',
        });
      }

      const results = await repository.findByUserIdAndSourceSessionId('user-1', 'session-1');
      expect(results.map((b) => b.id)).toEqual(['bookmark-caller-target-old']);
    });

    it('returns an empty array for a user/session combination with no bookmarks', async () => {
      expect(await repository.findByUserIdAndSourceSessionId('user-1', 'session-does-not-exist')).toEqual([]);
    });
  });

  describe('delete', () => {
    it('removes the row, returning true', async () => {
      await repository.create({
        id: 'bookmark-3',
        userId: 'user-1',
        url: 'https://example.com/delete-me',
        title: 'To delete',
        sourceSessionId: null,
      });

      const deleted = await repository.delete('bookmark-3');
      expect(deleted).toBe(true);

      expect(await repository.findById('bookmark-3')).toBeNull();
    });

    it('returns false for a non-existent id, and does not throw', async () => {
      await expect(repository.delete('never-existed')).resolves.toBe(false);
    });
  });
});
