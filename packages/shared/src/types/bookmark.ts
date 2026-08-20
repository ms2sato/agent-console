/**
 * A user-registered bookmark: an arbitrary URL (plus optional title) saved
 * from a session.
 *
 * This is the wire summary shape only, mirroring `types/artifact.ts`'s
 * `Artifact` shape: it deliberately excludes `userId` (owner identity never
 * crosses the wire) and `sourceSessionId` (provenance only, server-internal
 * -- see `repositories/bookmark-repository.ts`'s `BookmarkRecord`).
 */
export interface Bookmark {
  id: string;
  url: string;
  title: string | null;
  createdAt: string;
}
