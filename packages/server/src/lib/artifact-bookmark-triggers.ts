/**
 * Realtime-refresh trigger emitters for HTML artifacts and bookmarks
 * (`artifact-created` / `artifact-deleted` / `bookmark-created` /
 * `bookmark-deleted`), shared by the MCP tools (`create_html_artifact`,
 * `delete_html_artifact`, `create_bookmark`, `delete_bookmark` in
 * `mcp/mcp-server.ts`) and the REST routes (`routes/bookmarks.ts`,
 * `routes/artifacts.ts`). Both callers broadcast the
 * SAME wire message shape for the SAME domain event; this module is the
 * single writer of that shape, and of the owning-session resolution rule
 * for delete triggers described below.
 *
 * ---- Owning-session rule for delete triggers ----
 *
 * A delete trigger's `sessionId` names the OWNING session (whose panel
 * query the deleted item was listed under) -- resolved from the record's
 * `sourceSessionId`, NEVER from the deleting call's own session (the MCP
 * tools' `sessionId` param; REST has no equivalent concept at all). The two
 * coincide for the common case (a session deletes its own artifact/bookmark)
 * but diverge whenever a caller deletes an item that was created from a
 * DIFFERENT session (e.g. an orchestrator session cleaning up a delegate
 * session's artifacts) -- using the deleting session there would tell the
 * WRONG panel to refetch and leave the item's actual owning panel stale.
 *
 * `emitBookmarkDeleted` / `emitArtifactDeleted` accept an optional
 * `fallbackSessionId`, used ONLY when `sourceSessionId` is null. MCP callers
 * pass their own `sessionId` param as the fallback (mirroring the prior
 * MCP-only inline behavior); REST callers pass no fallback at all, since
 * REST has no "calling session" concept to fall back to.
 *
 * When BOTH `sourceSessionId` and the fallback are unavailable, the
 * broadcast is skipped entirely -- it does NOT throw. A trigger whose
 * `sessionId` would be null or synthesized is worse than no trigger at all:
 * the client scopes cache invalidation by that id, so a fabricated id would
 * invalidate the wrong panel, and a null one is rejected outright by the
 * strict wire schema (`v.string()` on `sessionId` in
 * `packages/shared/src/schemas/app-server-message.ts`, which uses
 * `v.strictObject` -- see `.claude/rules/pre-pr-completeness.md` Question
 * 10). This branch is unreachable in production today: every artifact and
 * bookmark creation path (REST and MCP alike) always sets `sourceSessionId`
 * non-null. It exists only so the type's nullability has a defined
 * behavior, rather than leaving an inert, never-exercised parameter.
 */
import type { AppServerMessage } from '@agent-console/shared';
import { createLogger } from './logger.js';

const logger = createLogger('artifact-bookmark-triggers');

export function emitBookmarkCreated(
  broadcast: (msg: AppServerMessage) => void,
  params: { sessionId: string; bookmarkId: string },
): void {
  broadcast({ type: 'bookmark-created', sessionId: params.sessionId, bookmarkId: params.bookmarkId });
}

export function emitArtifactCreated(
  broadcast: (msg: AppServerMessage) => void,
  params: { sessionId: string; artifactId: string },
): void {
  broadcast({ type: 'artifact-created', sessionId: params.sessionId, artifactId: params.artifactId });
}

export function emitBookmarkDeleted(
  broadcast: (msg: AppServerMessage) => void,
  record: { sourceSessionId: string | null },
  bookmarkId: string,
  fallbackSessionId?: string,
): void {
  const sessionId = record.sourceSessionId ?? fallbackSessionId;
  if (!sessionId) {
    logger.debug({ bookmarkId }, 'Skipping bookmark-deleted broadcast: no owning session and no fallback caller session');
    return;
  }
  broadcast({ type: 'bookmark-deleted', sessionId, bookmarkId });
}

export function emitArtifactDeleted(
  broadcast: (msg: AppServerMessage) => void,
  record: { sourceSessionId: string | null },
  artifactId: string,
  fallbackSessionId?: string,
): void {
  const sessionId = record.sourceSessionId ?? fallbackSessionId;
  if (!sessionId) {
    logger.debug({ artifactId }, 'Skipping artifact-deleted broadcast: no owning session and no fallback caller session');
    return;
  }
  broadcast({ type: 'artifact-deleted', sessionId, artifactId });
}
