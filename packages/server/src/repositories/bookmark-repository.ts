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
  /**
   * Provenance (nullable). Used only as a secondary list filter in
   * `findByUserIdAndSourceSessionId`; never as an authorization check.
   */
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
   * scoped in the SQL query itself, never as a post-fetch filter -- see
   * docs/design/html-artifacts.md §4.2 (single writer of the "why", shared
   * with `ArtifactRepository`'s identical pattern) for the full rationale.
   * In short: a user-scoped fetch has no other users' rows to be crowded
   * out by; a post-fetch filter would instead lose the caller's own older
   * rows in this session, pushed out by the caller's own newer rows from
   * other sessions.
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
