/**
 * Bookmark routes.
 *
 * Mounted inside the `/api` mount (`routes/api.ts`), AFTER
 * `.use('*', authMiddleware)`, mirroring `routes/artifacts.ts` -- auth
 * comes ONLY from that middleware, so this route relies on it for
 * `authUser` rather than asserting its own auth.
 *
 * A bookmark is owned by its creator: only the owner may list (`GET /`,
 * scoped to the caller's own bookmarks) or delete (`DELETE /:id`) it.
 * There is no MCP tool for bookmarks and no server-side URL fetch -- the
 * client's `<title>` is never resolved server-side (SSRF surface, not
 * requested).
 */
import { Hono } from 'hono';
import type { AppBindings } from '../app-context.js';
import { NotFoundError, ForbiddenError } from '../lib/errors.js';
import { vValidator } from '../middleware/validation.js';
import { CreateBookmarkRequestSchema } from '@agent-console/shared';

const bookmarks = new Hono<AppBindings>()
  // List the authenticated user's own bookmarks, newest first.
  //
  // Optional `?sessionId=` narrows the list to bookmarks originating from
  // that session. Session ownership is NOT checked -- the `authUser.id`
  // user-scope already constrains the result set, so `sessionId` is a
  // pure secondary filter, not an authorization check.
  .get('/', async (c) => {
    const { bookmarkRepository } = c.get('appContext');
    const authUser = c.get('authUser');
    const sessionId = c.req.query('sessionId');
    const list = sessionId
      ? await bookmarkRepository.findByUserIdAndSourceSessionId(authUser.id, sessionId)
      : await bookmarkRepository.findByUserId(authUser.id);
    return c.json({ bookmarks: list });
  })
  // Register a new bookmark. `url` is scheme-allowlisted (http:/https:
  // only) by CreateBookmarkRequestSchema (S4) -- validated here, at the
  // server boundary, since the client is not a trust boundary. `title` is
  // never synthesized server-side: empty/omitted stays null, and the
  // client displays the URL when title is absent.
  .post('/', vValidator(CreateBookmarkRequestSchema), async (c) => {
    const body = c.req.valid('json');
    const { bookmarkRepository } = c.get('appContext');
    const authUser = c.get('authUser');

    const created = await bookmarkRepository.create({
      id: crypto.randomUUID(),
      userId: authUser.id,
      url: body.url,
      title: body.title && body.title.length > 0 ? body.title : null,
      sourceSessionId: body.sessionId,
      // REST is human-only by construction (a browser session cookie is
      // the only way to reach this handler) -- there is no REST path to
      // register an 'agent'-origin bookmark (see
      // docs/design/session-bookmarks.md §6.1).
      origin: 'user',
    });
    // `create` returns the server-internal BookmarkRecord (wire summary +
    // userId); strip userId before it crosses the wire (see
    // packages/shared/src/types/bookmark.ts's wire-shape JSDoc).
    const { userId: _userId, ...bookmark } = created;
    return c.json({ bookmark }, 201);
  })
  // Delete a bookmark -- owner only. A non-owner gets 403 and the bookmark
  // survives untouched; deleting a nonexistent id is 404.
  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    const { bookmarkRepository } = c.get('appContext');
    const authUser = c.get('authUser');

    const bookmark = await bookmarkRepository.findById(id);
    if (!bookmark) {
      throw new NotFoundError('Bookmark');
    }
    if (bookmark.userId !== authUser.id) {
      throw new ForbiddenError('Only the owner can delete this bookmark');
    }

    const deleted = await bookmarkRepository.delete(id);
    if (!deleted) {
      // Deleted between the existence check and delete (race); idempotent 404.
      throw new NotFoundError('Bookmark');
    }
    return c.json({ success: true });
  });

export { bookmarks };
