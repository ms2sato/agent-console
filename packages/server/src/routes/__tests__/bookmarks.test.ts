/**
 * Sibling test for the bookmark routes.
 *
 * Unlike `artifacts.test.ts`, bookmarks have no file-storage component --
 * this test uses a real in-memory sqlite DB only, no real filesystem
 * needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { AuthUser } from '@agent-console/shared';
import { BookmarkSchema } from '@agent-console/shared';
import * as v from 'valibot';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteBookmarkRepository } from '../../repositories/sqlite-bookmark-repository.js';
import { bookmarks } from '../bookmarks.js';
import { authMiddleware } from '../../middleware/auth.js';
import { onApiError } from '../../lib/error-handler.js';
import type { AppBindings, AppContext } from '../../app-context.js';
import type { UserMode, PtySpawnRequest } from '../../services/user-mode.js';
import type { PtyInstance } from '../../lib/pty-provider.js';

// ---------------------------------------------------------------------------
// Test users
// ---------------------------------------------------------------------------

const OWNER: AuthUser = { id: 'owner-1', username: 'owner', homeDir: '/home/owner' };
const OTHER: AuthUser = { id: 'other-1', username: 'other', homeDir: '/home/other' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockUserMode(authenticateResult: AuthUser | null): UserMode {
  return {
    authenticate: () => authenticateResult,
    login: async () => null,
    spawnPty: (_request: PtySpawnRequest): PtyInstance => {
      throw new Error('spawnPty not implemented in mock');
    },
  };
}

/**
 * Builds a Hono app that mirrors production layering for `/api/bookmarks`:
 * appContext -> authMiddleware -> route. `authenticateResult` controls
 * whether the simulated request is authenticated.
 */
function buildApp(
  bookmarkRepository: SqliteBookmarkRepository,
  authenticateResult: AuthUser | null,
): Hono<AppBindings> {
  const partialContext: Partial<AppContext> = {
    bookmarkRepository,
    userMode: mockUserMode(authenticateResult),
  };
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('appContext', partialContext as AppContext);
    await next();
  });
  app.use('*', authMiddleware);
  app.onError(onApiError);
  app.route('/api/bookmarks', bookmarks);
  return app;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Bookmark routes', () => {
  let db: Kysely<Database>;
  let repository: SqliteBookmarkRepository;

  beforeEach(async () => {
    db = await createDatabaseForTest();
    repository = new SqliteBookmarkRepository(db);

    // `bookmarks.user_id` carries a real FK to `users.id` -- seed the two
    // test users this file's tests attribute bookmarks to.
    const now = new Date().toISOString();
    for (const user of [OWNER, OTHER]) {
      await db
        .insertInto('users')
        .values({ id: user.id, os_uid: null, username: user.username, home_dir: user.homeDir, created_at: now, updated_at: now })
        .execute();
    }
  });

  afterEach(async () => {
    await db.destroy();
  });

  // =========================================================================
  // GET /api/bookmarks
  // =========================================================================

  describe('GET /api/bookmarks', () => {
    it("returns only the caller's own bookmarks, newest first, matching the BookmarkSchema wire shape", async () => {
      await repository.create({
        id: 'bookmark-old',
        userId: OWNER.id,
        url: 'https://example.com/old',
        title: 'Old',
        sourceSessionId: null,
        origin: 'user',
      });
      await new Promise((r) => setTimeout(r, 2));
      await repository.create({
        id: 'bookmark-new',
        userId: OWNER.id,
        url: 'https://example.com/new',
        title: 'New',
        sourceSessionId: null,
        origin: 'user',
      });
      await repository.create({
        id: 'bookmark-other-user',
        userId: OTHER.id,
        url: 'https://example.com/other',
        title: "Other user's bookmark",
        sourceSessionId: null,
        origin: 'user',
      });

      const app = buildApp(repository, OWNER);
      const res = await app.request('/api/bookmarks');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { bookmarks: unknown[] };
      expect(body.bookmarks).toHaveLength(2);
      expect((body.bookmarks as { title: string }[]).map((b) => b.title)).toEqual(['New', 'Old']);

      // Parse each entry through the real wire schema (closes the Q10 gap:
      // a server-side field addition/removal that valibot would silently
      // strip must fail this parse, not just a hand-checked object shape).
      for (const entry of body.bookmarks) {
        const parsed = v.parse(BookmarkSchema, entry);
        expect(parsed.url).toBeDefined();
        expect(parsed.origin).toBe('user');
        // userId must never leak onto the wire.
        expect((entry as Record<string, unknown>).userId).toBeUndefined();
      }
    });

    it('returns an empty array when the caller has no bookmarks (boundary value)', async () => {
      const app = buildApp(repository, OWNER);
      const res = await app.request('/api/bookmarks');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { bookmarks: unknown[] };
      expect(body.bookmarks).toEqual([]);
    });

    it('rejects an unauthenticated request with 401', async () => {
      const app = buildApp(repository, null);
      const res = await app.request('/api/bookmarks');
      expect(res.status).toBe(401);
    });

    it("with ?sessionId= present, returns only the caller's bookmarks in that session", async () => {
      await repository.create({
        id: 'bookmark-session-1',
        userId: OWNER.id,
        url: 'https://example.com/in-session',
        title: 'In session',
        sourceSessionId: 'session-1',
        origin: 'user',
      });
      await repository.create({
        id: 'bookmark-session-2',
        userId: OWNER.id,
        url: 'https://example.com/other-session',
        title: 'In another session',
        sourceSessionId: 'session-2',
        origin: 'user',
      });
      await repository.create({
        id: 'bookmark-other-user-session-1',
        userId: OTHER.id,
        url: 'https://example.com/other-user',
        title: "Other user's, same session",
        sourceSessionId: 'session-1',
        origin: 'user',
      });

      const app = buildApp(repository, OWNER);
      const res = await app.request('/api/bookmarks?sessionId=session-1');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { bookmarks: { title: string }[] };
      expect(body.bookmarks.map((b) => b.title)).toEqual(['In session']);
    });

    it('with ?sessionId= present but the caller has no bookmarks in that session, returns an empty array', async () => {
      await repository.create({
        id: 'bookmark-different-session',
        userId: OWNER.id,
        url: 'https://example.com/different',
        title: 'Different session',
        sourceSessionId: 'session-2',
        origin: 'user',
      });

      const app = buildApp(repository, OWNER);
      const res = await app.request('/api/bookmarks?sessionId=session-1');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { bookmarks: unknown[] };
      expect(body.bookmarks).toEqual([]);
    });
  });

  // =========================================================================
  // POST /api/bookmarks
  // =========================================================================

  describe('POST /api/bookmarks', () => {
    it('creates a bookmark with a title and returns the wire shape (no userId/sourceSessionId leak)', async () => {
      const app = buildApp(repository, OWNER);
      const res = await app.request('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', title: 'My bookmark', sessionId: 'session-1' }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { bookmark: Record<string, unknown> };
      expect(body.bookmark.url).toBe('https://example.com');
      expect(body.bookmark.title).toBe('My bookmark');
      expect(body.bookmark.userId).toBeUndefined();
      // sourceSessionId is a server-internal BookmarkRecord field (Issue #1520's
      // owning-session resolution for the realtime-refresh delete trigger) --
      // it must never cross the wire, same as userId.
      expect(body.bookmark.sourceSessionId).toBeUndefined();
      expect(body.bookmark.origin).toBe('user');

      v.parse(BookmarkSchema, body.bookmark);

      const stored = await repository.findById(body.bookmark.id as string);
      expect(stored?.userId).toBe(OWNER.id);
      expect(stored?.origin).toBe('user');
      expect(stored?.sourceSessionId).toBe('session-1');
    });

    it('creates a bookmark with title omitted, stored as null title', async () => {
      const app = buildApp(repository, OWNER);
      const res = await app.request('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', sessionId: 'session-1' }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { bookmark: Record<string, unknown> };
      expect(body.bookmark.title).toBeNull();
    });

    it('rejects an unauthenticated request with 401', async () => {
      const app = buildApp(repository, null);
      const res = await app.request('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', sessionId: 'session-1' }),
      });
      expect(res.status).toBe(401);
    });

    // -----------------------------------------------------------------------
    // S4: scheme allowlist -- one test per rejected scheme, plus positive
    // controls for the two allowed schemes.
    // -----------------------------------------------------------------------

    it('rejects a javascript: URL scheme with 400', async () => {
      const app = buildApp(repository, OWNER);
      const res = await app.request('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'javascript:alert(1)', sessionId: 'session-1' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a data: URL scheme with 400', async () => {
      const app = buildApp(repository, OWNER);
      const res = await app.request('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'data:text/html,<script>alert(1)</script>', sessionId: 'session-1' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a file: URL scheme with 400', async () => {
      const app = buildApp(repository, OWNER);
      const res = await app.request('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'file:///etc/passwd', sessionId: 'session-1' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a vbscript: URL scheme with 400', async () => {
      const app = buildApp(repository, OWNER);
      const res = await app.request('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'vbscript:msgbox("hi")', sessionId: 'session-1' }),
      });
      expect(res.status).toBe(400);
    });

    it('accepts an http: URL', async () => {
      const app = buildApp(repository, OWNER);
      const res = await app.request('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://example.com', sessionId: 'session-1' }),
      });
      expect(res.status).toBe(201);
    });

    it('accepts an https: URL', async () => {
      const app = buildApp(repository, OWNER);
      const res = await app.request('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', sessionId: 'session-1' }),
      });
      expect(res.status).toBe(201);
    });
  });

  // =========================================================================
  // DELETE /api/bookmarks/:id
  // =========================================================================

  describe('DELETE /api/bookmarks/:id', () => {
    it('lets the owner delete their own bookmark, removing the row', async () => {
      const created = await repository.create({
        id: 'bookmark-to-delete',
        userId: OWNER.id,
        url: 'https://example.com/bye',
        title: 'To delete',
        sourceSessionId: null,
        origin: 'user',
      });

      const app = buildApp(repository, OWNER);
      const res = await app.request(`/api/bookmarks/${created.id}`, { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);

      expect(await repository.findById(created.id)).toBeNull();
    });

    it('rejects a non-owner delete with 403, leaving the row untouched', async () => {
      const created = await repository.create({
        id: 'bookmark-not-yours',
        userId: OWNER.id,
        url: 'https://example.com/mine',
        title: 'Not yours',
        sourceSessionId: null,
        origin: 'user',
      });

      const app = buildApp(repository, OTHER);
      const res = await app.request(`/api/bookmarks/${created.id}`, { method: 'DELETE' });

      expect(res.status).toBe(403);

      const stillThere = await repository.findById(created.id);
      expect(stillThere).not.toBeNull();
      expect(stillThere?.userId).toBe(OWNER.id);
    });

    it('returns 404 for a nonexistent bookmark id', async () => {
      const app = buildApp(repository, OWNER);
      const res = await app.request('/api/bookmarks/does-not-exist', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });

    it('rejects an unauthenticated request with 401', async () => {
      const created = await repository.create({
        id: 'bookmark-unauth-delete',
        userId: OWNER.id,
        url: 'https://example.com',
        title: 'T',
        sourceSessionId: null,
        origin: 'user',
      });

      const app = buildApp(repository, null);
      const res = await app.request(`/api/bookmarks/${created.id}`, { method: 'DELETE' });
      expect(res.status).toBe(401);
    });
  });
});
