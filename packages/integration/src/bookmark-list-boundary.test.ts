/**
 * Client-Server Boundary Test: GET/POST/DELETE /api/bookmarks.
 *
 * Exercises the real chain `SessionBookmarksPanel` depends on:
 * `fetchBookmarks()` / `createBookmark()` / `deleteBookmark()` (the real
 * client functions) -> real Hono `/api/bookmarks` handlers -> real
 * `SqliteBookmarkRepository` -> JSON response -> `BookmarksListResponseSchema`
 * / `BookmarkSchema` parse (the same parser the client functions use in
 * production, per `.claude/rules/pre-pr-completeness.md` Q10 -- neither the
 * server's route test (which asserts the raw JSON body shape) nor the
 * client's component test (which mocks the API functions themselves,
 * bypassing the schema parse) exercises this specific parse-at-the-real-wire
 * path end-to-end).
 *
 * Unlike `artifact-list-boundary.test.ts`, bookmarks have no file-storage
 * component -- no `AGENT_CONSOLE_HOME` tmpdir dance is needed here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { randomUUID } from 'crypto';
import type { Hono } from 'hono';

import {
  createTestApp,
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';
import type { AppBindings } from '@agent-console/server/src/app-context';
import { getDatabase } from '@agent-console/server/src/database/connection';
import { SqliteBookmarkRepository } from '@agent-console/server/src/repositories/sqlite-bookmark-repository';

import { fetchBookmarks, createBookmark, deleteBookmark, ApiError } from '@agent-console/client/src/lib/api';

import { createFetchBridge, findRequest } from './test-utils';

describe('Client-Server Boundary: /api/bookmarks', () => {
  let app: Hono<AppBindings>;
  let bridge: ReturnType<typeof createFetchBridge>;
  let repository: SqliteBookmarkRepository;

  beforeEach(async () => {
    await setupTestEnvironment();

    repository = new SqliteBookmarkRepository(getDatabase());
    app = await createTestApp({ bookmarkRepository: repository });
    bridge = createFetchBridge(app);
  });

  afterEach(async () => {
    bridge.restore();
    await cleanupTestEnvironment();
  });

  it('survives the create -> server -> JSON wire -> BookmarksListResponseSchema parse round-trip', async () => {
    const created = await createBookmark('https://example.com', 'My bookmark', 'session-1');

    const result = await fetchBookmarks('session-1');

    const getRequest = findRequest(bridge.capturedRequests, 'GET', '/api/bookmarks');
    expect(getRequest).toBeDefined();

    // The crucial assertion: if `BookmarksListResponseSchema` (or
    // `BookmarkSchema`) silently drops/renames a field, `v.parse` inside
    // `fetchBookmarks()` throws and this whole test fails, rather than the
    // client silently receiving `undefined` fields in production.
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(created.id);
    expect(result[0].url).toBe('https://example.com');
    expect(result[0].title).toBe('My bookmark');
    expect(typeof result[0].id).toBe('string');
    expect(typeof result[0].createdAt).toBe('string');
  });

  it("returns only the caller's own bookmarks, scoped at the real wire", async () => {
    await createBookmark('https://example.com/mine', 'Mine', 'session-1');

    // Owned by someone else -- must NOT appear in the caller's list.
    // `bookmarks.user_id` carries a real FK to `users.id`, so the other
    // owner needs a real row too.
    const now = new Date().toISOString();
    await getDatabase()
      .insertInto('users')
      .values({ id: 'someone-else', os_uid: null, username: 'someone-else', home_dir: '/home/someone-else', created_at: now, updated_at: now })
      .execute();
    await repository.create({
      id: randomUUID(),
      userId: 'someone-else',
      url: 'https://example.com/theirs',
      title: "Not the caller's",
      sourceSessionId: null,
    });

    const result = await fetchBookmarks();

    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://example.com/mine');
    // userId must never leak onto the wire.
    expect((result[0] as unknown as Record<string, unknown>).userId).toBeUndefined();
  });

  it('round-trips the sessionId filter through the real Hono RPC client -> HTTP query string -> server query param, and leaves the no-sessionId branch unaffected', async () => {
    await createBookmark('https://example.com/a', 'Session A bookmark', 'session-a');
    await createBookmark('https://example.com/b', 'Session B bookmark', 'session-b');

    // Real client function -> real Hono RPC `$get({ query: { sessionId } })`
    // -> real HTTP request with a `?sessionId=` query string -> server's
    // `c.req.query('sessionId')` -> `findByUserIdAndSourceSessionId` ->
    // back through `BookmarksListResponseSchema`. Neither side's unit tests
    // exercise this connection: the client's mocks `fetch`, the server's
    // route test builds the URL by hand.
    const sessionAResult = await fetchBookmarks('session-a');
    expect(sessionAResult.map((b) => b.title)).toEqual(['Session A bookmark']);

    const sessionARequest = findRequest(bridge.capturedRequests, 'GET', '/api/bookmarks');
    expect(sessionARequest?.url).toContain('sessionId=session-a');

    // No-sessionId branch: must still return bookmarks from BOTH sessions,
    // proving the omitted-query-param path is genuinely unaffected by the
    // new branch rather than merely asserted so in a comment.
    const allResult = await fetchBookmarks();
    expect(allResult.map((b) => b.title).sort()).toEqual(['Session A bookmark', 'Session B bookmark']);
  });

  it('returns an empty array (boundary value) when the caller has no bookmarks', async () => {
    const result = await fetchBookmarks();
    expect(result).toEqual([]);
  });

  it('deletes a bookmark through the real client function, and it no longer appears in a subsequent fetch', async () => {
    const created = await createBookmark('https://example.com/bye', 'To delete', 'session-1');

    expect(await fetchBookmarks()).toHaveLength(1);

    await deleteBookmark(created.id);

    const deleteRequest = findRequest(bridge.capturedRequests, 'DELETE', `/api/bookmarks/${created.id}`);
    expect(deleteRequest).toBeDefined();

    expect(await fetchBookmarks()).toEqual([]);
  });

  it('rejects a disallowed URL scheme (S4) at the real wire -- the server 400 surfaces through handleApiError, not just the isolated route unit test', async () => {
    await expect(createBookmark('javascript:alert(1)', 'Nope', 'session-1')).rejects.toThrow(ApiError);

    // Nothing was persisted.
    expect(await fetchBookmarks()).toEqual([]);
  });
});
