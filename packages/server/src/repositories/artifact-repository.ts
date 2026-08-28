import type { Artifact } from '@agent-console/shared';

/**
 * Parameters for creating a new HTML artifact (HTML Artifacts phase 1).
 * `content` is the raw HTML bytes -- persisted to disk by the
 * implementation (see `lib/artifact-storage.ts`), never stored in the
 * `artifacts` table itself.
 */
export interface CreateArtifactParams {
  id: string;
  /** Owning user's `users.id`, resolved from the calling session's `createdBy` -- never from MCP caller identity. */
  userId: string;
  title: string;
  content: string;
  /**
   * Provenance (nullable). Used only as a secondary list filter in
   * `findByUserIdAndSourceSessionId`; never as an authorization check.
   */
  sourceSessionId: string | null;
}

/**
 * Server-internal artifact record: the wire `Artifact` summary plus
 * `userId`, the owning user's id. `userId` MUST NEVER be forwarded into a
 * wire response (see `packages/shared/src/types/artifact.ts`'s wire-shape
 * JSDoc, which deliberately excludes it) -- it exists here only so route
 * handlers can resolve the on-disk file location (`lib/artifact-storage.ts`
 * keys files by `userId`) and enforce owner-only deletion
 * (docs/design/html-artifacts.md §5.1).
 */
export interface ArtifactRecord extends Artifact {
  userId: string;
}

/**
 * Repository interface for persisting HTML artifacts. Combines metadata
 * (the `artifacts` DB table) and file storage (`lib/artifact-storage.ts`)
 * behind one interface so callers never have to keep the two in sync by
 * hand -- `create` and `delete` each touch both in one call.
 */
export interface ArtifactRepository {
  /** Create a new artifact: writes the HTML file, then inserts the metadata row. */
  create(params: CreateArtifactParams): Promise<ArtifactRecord>;

  /** Find an artifact's metadata (including owning `userId`) by its id. */
  findById(id: string): Promise<ArtifactRecord | null>;

  /** Find all artifacts owned by a user, newest first (wire shape -- no `userId`). */
  findByUserId(userId: string): Promise<Artifact[]>;

  /**
   * Find all artifacts owned by a user AND originating from a given
   * session, newest first (wire shape -- no `userId`). Both conditions are
   * scoped in the SQL query itself, never as a post-fetch filter -- see
   * docs/design/html-artifacts.md §4.2 (single writer of the "why") for the
   * full rationale. In short: a user-scoped fetch has no other users' rows
   * to be crowded out by; a post-fetch filter would instead lose the
   * caller's own older rows in this session, pushed out by the caller's own
   * newer rows from other sessions.
   *
   * Session ownership is deliberately NOT checked here: `userId` already
   * constrains the result set to the caller's own artifacts, so
   * `sourceSessionId` is a pure secondary filter, not an authorization
   * check.
   */
  findByUserIdAndSourceSessionId(userId: string, sessionId: string): Promise<Artifact[]>;

  /**
   * Delete an artifact: removes the metadata row and the on-disk HTML file
   * together (docs/design/html-artifacts.md §5.1's lifecycle). Returns
   * `true` if an artifact was found and deleted, `false` if no artifact
   * existed with that id.
   */
  delete(id: string): Promise<boolean>;
}
