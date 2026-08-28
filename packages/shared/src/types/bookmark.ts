/**
 * A registered bookmark: an arbitrary URL (plus optional title) saved from
 * a session.
 *
 * This is the wire summary shape only, mirroring `types/artifact.ts`'s
 * `Artifact` shape: it deliberately excludes `userId` (owner identity never
 * crosses the wire) and `sourceSessionId` (provenance only, server-internal
 * -- see `repositories/bookmark-repository.ts`'s `BookmarkRecord`). `origin`
 * IS included on the wire -- it is provenance the client renders (an
 * "agent"-registered badge), not authorization data (see
 * `docs/design/session-bookmarks.md` §4.2).
 */
export interface Bookmark {
  id: string;
  url: string;
  title: string | null;
  createdAt: string;
  /** Who registered this bookmark: through the sidebar form, or via an MCP tool call. */
  origin: 'user' | 'agent';
}
