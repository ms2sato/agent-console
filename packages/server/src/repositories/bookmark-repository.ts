import type { Bookmark } from '@agent-console/shared';

/**
 * Parameters for creating a new bookmark.
 */
export interface CreateBookmarkParams {
  id: string;
  /** Owning user's `users.id`, resolved from the authenticated caller. */
  userId: string;
  url: string;
  title: string | null;
  /** Provenance only (nullable); never used for lookup. */
  sourceSessionId: string | null;
}

/**
 * Server-internal bookmark record: the wire `Bookmark` summary plus
 * `userId`, the owning user's id. `userId` MUST NEVER be forwarded into a
 * wire response (see `packages/shared/src/types/bookmark.ts`'s wire-shape
 * JSDoc, which deliberately excludes it) -- it exists here only so route
 * handlers can enforce owner-only deletion.
 */
export interface BookmarkRecord extends Bookmark {
  userId: string;
}

/**
 * Repository interface for persisting bookmarks. Unlike
 * `ArtifactRepository`, bookmarks have no file-storage component -- this
 * repository is DB-only.
 */
export interface BookmarkRepository {
  /** Create a new bookmark. */
  create(params: CreateBookmarkParams): Promise<BookmarkRecord>;

  /** Find a bookmark's metadata (including owning `userId`) by its id. */
  findById(id: string): Promise<BookmarkRecord | null>;

  /** Find all bookmarks owned by a user, newest first (wire shape -- no `userId`). */
  findByUserId(userId: string): Promise<Bookmark[]>;

  /**
   * Find all bookmarks owned by a user AND originating from a given
   * session, newest first (wire shape -- no `userId`). Both conditions are
   * scoped in the SQL query itself, never as a post-fetch filter.
   *
   * A user-scoped fetch never contains other users' rows, so "another
   * user's newer rows crowd the caller out" is NOT the mechanism here. What
   * a post-fetch session filter would actually lose is the same user's
   * older bookmarks in the target session, pushed out of a row-cap window
   * by that same user's newer bookmarks from other sessions.
   *
   * Session ownership is deliberately NOT checked here: `userId` already
   * constrains the result set to the caller's own bookmarks, so
   * `sourceSessionId` is a pure secondary filter, not an authorization
   * check.
   */
  findByUserIdAndSourceSessionId(userId: string, sessionId: string): Promise<Bookmark[]>;

  /**
   * Delete a bookmark. Returns `true` if a bookmark was found and deleted,
   * `false` if no bookmark existed with that id.
   */
  delete(id: string): Promise<boolean>;
}
