import * as v from 'valibot';

/**
 * An HTML artifact uploaded by a user (HTML Artifacts phase 1), and the wire
 * schema its `Artifact` type is derived from.
 *
 * This is the wire summary shape only -- the shape returned by the artifact
 * history list. It deliberately excludes `content` (the raw HTML bytes) and
 * any filesystem path: content is served exclusively through the dedicated
 * serving endpoint (`GET /api/artifacts/:id`), never inlined into a list
 * response, and no client-visible representation of the server's storage
 * layout should exist. See docs/design/html-artifacts.md §5, §6.
 *
 * Strict, so a server response that silently drops/adds a field fails to
 * parse instead of failing silently at the client (see
 * `.claude/rules/pre-pr-completeness.md` Q10).
 */
export const ArtifactSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  title: v.pipe(v.string(), v.minLength(1)),
  createdAt: v.string(),
  sizeBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
  // Time of the latest in-place content update (ISO 8601), or `null` when the
  // artifact has never been updated. Required-nullable (like
  // `clonedSourceRepoPath`): always present on the wire because the server
  // always sends it. See docs/design/html-artifacts.md section 5.4.
  updatedAt: v.nullable(v.string()),
});

export type Artifact = v.InferOutput<typeof ArtifactSchema>;

/**
 * Wire schema for `GET /api/artifacts`'s list response (HTML Artifacts
 * phase 2). Parsed at the client fetch boundary so a server response that
 * silently drops/adds a field fails to parse instead of failing silently
 * at the client (see `.claude/rules/pre-pr-completeness.md` Q10, the #926
 * lesson).
 */
export const ArtifactsListResponseSchema = v.strictObject({
  artifacts: v.array(ArtifactSchema),
});

export type ArtifactsListResponse = v.InferOutput<typeof ArtifactsListResponseSchema>;
