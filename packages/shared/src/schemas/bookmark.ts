import * as v from 'valibot';

/**
 * Wire schema for the `Bookmark` summary shape. Mirrors
 * `types/bookmark.ts`'s `Bookmark` interface field-for-field so a server
 * response that silently drops/adds a field fails to parse instead of
 * failing silently at the client (see `.claude/rules/pre-pr-completeness.md`
 * Q10, the #926 lesson).
 */
export const BookmarkSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  url: v.pipe(v.string(), v.minLength(1)),
  title: v.nullable(v.string()),
  createdAt: v.string(),
  origin: v.picklist(['user', 'agent']),
});

export type BookmarkSchemaOutput = v.InferOutput<typeof BookmarkSchema>;

/**
 * Wire schema for `GET /api/bookmarks`'s list response. Parsed at the
 * client fetch boundary so a server response that silently drops/adds a
 * field fails to parse instead of failing silently at the client (see
 * `.claude/rules/pre-pr-completeness.md` Q10, the #926 lesson).
 */
export const BookmarksListResponseSchema = v.strictObject({
  bookmarks: v.array(BookmarkSchema),
});

export type BookmarksListResponse = v.InferOutput<typeof BookmarksListResponseSchema>;

/**
 * Allowlisted URL schemes for `POST /api/bookmarks` (S4, navigation safety).
 * Allowlist, not blocklist: only these two schemes are ever accepted --
 * `javascript:`, `data:`, `file:`, `vbscript:`, and anything unlisted are
 * rejected. This is the single source of truth for the scheme check; the
 * request schema below and the server-side route handler both derive from
 * it.
 */
export const ALLOWED_BOOKMARK_URL_SCHEMES = ['http:', 'https:'] as const;

/**
 * Validates that a string is a well-formed URL with an allowlisted scheme
 * (`http:` / `https:`). Parses with the global `URL` constructor -- a
 * malformed URL throws, which this function treats as invalid rather than
 * letting it propagate.
 */
function isAllowedBookmarkUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (ALLOWED_BOOKMARK_URL_SCHEMES as readonly string[]).includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Request-body schema for `POST /api/bookmarks`. `url` must be a non-empty,
 * well-formed URL whose scheme is allowlisted (S4); `title` is optional
 * free text (no server-side synthesis -- an absent title displays the URL
 * client-side), capped at 200 characters (matches `MAX_TITLE_LENGTH` in
 * `mcp-server.ts`, the HTML artifact title cap -- one length policy, reused
 * rather than re-derived); `sessionId` is the source session id
 * (provenance, non-empty).
 *
 * This is the SINGLE writer of scheme and length validation for bookmark
 * registration -- both `POST /api/bookmarks` and the `create_bookmark` MCP
 * tool parse through this schema. Do not re-implement either check
 * elsewhere (see `docs/design/session-bookmarks.md` §8).
 */
export const CreateBookmarkRequestSchema = v.strictObject({
  url: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'URL is required'),
    v.check(isAllowedBookmarkUrl, 'URL must use http: or https:'),
  ),
  title: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200, 'Title must be at most 200 characters'))),
  sessionId: v.pipe(v.string(), v.trim(), v.minLength(1, 'sessionId is required')),
});

export type CreateBookmarkRequest = v.InferOutput<typeof CreateBookmarkRequestSchema>;
