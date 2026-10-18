import * as v from 'valibot';

/**
 * Wire schemas of the file viewer worker: its two read-only routes
 * (`GET .../files/tree` and `GET .../files/content`) and the server-to-client
 * messages of its worker WebSocket (docs/design/file-viewer-worker.md). The
 * schema is the single writer: the
 * entity types are derived from it, there is no hand-written twin.
 *
 * Strict, so a server response that silently drops or adds a field fails to
 * parse at the client instead of failing silently (see
 * `.claude/rules/pre-pr-completeness.md` Q10).
 */

/**
 * One entry of a directory listing. `symlink` is the entry's OWN kind: the
 * listing never follows a link, so a symlink carries no target and no
 * dir/file distinction. There is deliberately no `size` (a later query
 * parameter can add one without breaking the wire).
 */
export const FileTreeEntrySchema = v.strictObject({
  /** A single path segment (never contains a separator). */
  name: v.pipe(v.string(), v.minLength(1)),
  kind: v.picklist(['dir', 'file', 'symlink']),
});

export const FileTreeResponseSchema = v.strictObject({
  /** The directory that was listed, relative to the session location ('' = root). */
  path: v.string(),
  entries: v.array(FileTreeEntrySchema),
});

/**
 * Content of one file.
 *
 * The cross-field rules are enforced here, not only by the producing service,
 * so a producer that breaks them fails at the parse boundary:
 * - `text` carries `content` (an empty file is `content: ''`);
 * - `binary` carries no `content` and is never `truncated` (nothing was cut:
 *   there is no content to cut).
 */
export const FileContentResponseSchema = v.pipe(
  v.strictObject({
    /** Echoes the validated request path, stable across reloads. */
    path: v.string(),
    kind: v.picklist(['text', 'binary']),
    /** Present for `text` only. */
    content: v.optional(v.string()),
    /** Total bytes on disk (not the bytes returned). */
    size: v.pipe(v.number(), v.integer(), v.minValue(0)),
    /** True only when `kind` is `text` and the size cap cut the content. */
    truncated: v.boolean(),
    /** Prism language name, `'text'` when unknown. */
    language: v.string(),
  }),
  v.check(
    (r) => (r.kind === 'text' ? r.content !== undefined : r.content === undefined && !r.truncated),
    'text content must carry `content`; binary content must carry neither `content` nor `truncated`',
  ),
);

export type FileTreeEntry = v.InferOutput<typeof FileTreeEntrySchema>;
export type FileTreeResponse = v.InferOutput<typeof FileTreeResponseSchema>;
export type FileContentResponse = v.InferOutput<typeof FileContentResponseSchema>;

/**
 * A changed path as the live-updates watcher reports it: relative to the
 * session location, `/`-separated, non-empty, no leading slash, no backslash, no drive-letter prefix, and no `..`
 * segment. The
 * predicate is restated here (the server's `isValidFilePath` is not importable
 * from shared) so a producer that leaks an absolute or escaping path fails at
 * the parse boundary.
 */
const ChangedPathSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.check(
    (p) => !p.startsWith('/') && !p.includes('\\') && !/^[A-Za-z]:/.test(p) && !p.split('/').includes('..'),
    'a changed path must be `/`-separated and relative (no backslash, no drive letter) and contain no `..` segment',
  ),
);

/**
 * Directory content changed. `overflow` is true when more distinct paths
 * changed than the batch keeps (`paths` then holds the first ones and the
 * client refetches the whole worker). `paths` is never empty on the wire the
 * server sends, but an empty array is a valid shape.
 */
export const FilesChangedMessageSchema = v.strictObject({
  type: v.literal('files-changed'),
  paths: v.array(ChangedPathSchema),
  overflow: v.boolean(),
});

/** The server cannot watch the working directory; the viewer falls back to Refresh. */
export const WatchUnavailableMessageSchema = v.strictObject({
  type: v.literal('watch-unavailable'),
  reason: v.picklist(['permission-denied', 'watch-failed']),
});

/** Server-to-client messages of the file viewer's worker WebSocket (there are no client messages). */
export const FileViewerServerMessageSchema = v.variant('type', [
  FilesChangedMessageSchema,
  WatchUnavailableMessageSchema,
]);

export type FileViewerServerMessage = v.InferOutput<typeof FileViewerServerMessageSchema>;
