/**
 * An HTML artifact uploaded by a user (HTML Artifacts phase 1).
 *
 * This is the wire summary shape only -- the shape returned by the artifact
 * history list. It deliberately excludes `content` (the raw HTML bytes) and
 * any filesystem path: content is served exclusively through the dedicated
 * serving endpoint (`GET /api/artifacts/:id`), never inlined into a list
 * response, and no client-visible representation of the server's storage
 * layout should exist. See docs/design/html-artifacts.md §5, §6.
 */
export interface Artifact {
  id: string;
  title: string;
  createdAt: string;
  sizeBytes: number;
}
