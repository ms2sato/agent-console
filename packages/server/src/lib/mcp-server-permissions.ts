/**
 * epic #1636 Phase 5 PR-2 (docs/design/embedded-agent-sdk-engine.md §4.5's
 * "the approval record"), Architect ruling (B), 2026-09-21.
 *
 * Single writer of "the FULL currently-allowed (name, hash) pair set for a
 * repository" -- the exact composition BOTH
 * `EmbeddedAgentWorkerService.activate`'s `init.allowedProjectMcpServers`
 * and `SessionManager.setMcpServerPermissions`'s live-apply `set-mcp-servers`
 * command use. Extracted once a second call site needed the identical
 * `.filter(decision === 'allow').map(...)` composition (`workflow.md`'s
 * "Duplication check" / `design-principles.md`'s sibling-grep discipline):
 * without one writer, the two call sites could silently drift on what
 * "currently allowed" means for a repository.
 */
import type { McpServerPermissionRepository } from '../repositories/mcp-server-permission-repository.js';
import type { EmbeddedAgentWorker, SetMcpServerPermissionsRequest } from '@agent-console/shared';

export async function listAllowedProjectMcpServerPairs(
  repository: Pick<McpServerPermissionRepository, 'listByRepository'>,
  repositoryId: string,
): Promise<Array<{ name: string; hash: string }>> {
  return (await repository.listByRepository(repositoryId))
    .filter((row) => row.decision === 'allow')
    .map((row) => ({ name: row.serverName, hash: row.configHash }));
}

/**
 * Result of resolving a `SetMcpServerPermissionsRequest` against a worker's
 * currently-discovered MCP servers. `ok: false`'s `kind` names the failure
 * class so each caller (the REST route, the `set_mcp_server_permission` MCP
 * tool) can map it to its own surface's error shape (404 / 409 for the
 * route, a plain `errorResult` for the tool) without re-implementing the
 * classification.
 */
export type ResolvePermissionDecisionsResult =
  | { ok: true; decisions: Array<{ name: string; hash: string; decision: 'allow' | 'deny' }> }
  | { ok: false; kind: 'not-discovered' | 'undecidable' | 'nothing-pending'; message: string };

/**
 * Single writer of the epic #1636 Phase 5 PR-2 "I-6" decision-resolution
 * rules (epic #1636 Phase 5 PR-3a, docs/design/embedded-agent-sdk-engine.md
 * §4.5): given a worker's currently-discovered MCP servers and a caller's
 * requested decision, resolve it to the durable-row shape
 * `SessionManager.setMcpServerPermissions` accepts.
 *
 * Extracted from `routes/workers.ts`'s `POST .../mcp-permissions` handler
 * once `set_mcp_server_permission` (the MCP tool) needed the identical
 * resolution rules -- `design-principles.md`'s sibling-grep discipline: a
 * second call site sharing the exact same `if ('all' in body)` branching
 * would otherwise drift silently between the route and the tool.
 *
 * - `{ name, hash, decision }`: the pair must have been discovered
 *   (`not-discovered` otherwise); a discovered `'rejected-reserved'` /
 *   `'invalid'` pair cannot be decided (`undecidable`).
 * - `{ all: true }`: every currently-`'pending'` pair (with a computed
 *   `hash`) is resolved to `allow`. Zero pending pairs is NOT a failure --
 *   it resolves `ok: true` with an empty `decisions` array (a legitimate
 *   200 no-op at the route; the caller decided nothing changed rather than
 *   that something went wrong). The `'nothing-pending'` member of `kind`
 *   stays part of the type's contract for a future caller that wants to
 *   distinguish the two `ok: true` shapes without inspecting array length,
 *   but no current caller needs it, and none is constructed here.
 */
export function resolvePermissionDecisions(
  discovered: EmbeddedAgentWorker['mcpServers'],
  body: SetMcpServerPermissionsRequest,
): ResolvePermissionDecisionsResult {
  const rows = discovered ?? [];

  if ('all' in body) {
    // Every currently-pending pair. An entry with no `hash` (an
    // `'invalid'` discovery with nothing computable) can never be
    // `'pending'` in the first place, so this filter never needs a
    // separate hash-presence check.
    const decisions = rows
      .filter((entry): entry is typeof entry & { hash: string } => entry.decision === 'pending' && entry.hash !== undefined)
      .map((entry) => ({ name: entry.name, hash: entry.hash, decision: 'allow' as const }));
    return { ok: true, decisions };
  }

  const match = rows.find((entry) => entry.name === body.name && entry.hash === body.hash);
  if (!match) {
    return {
      ok: false,
      kind: 'not-discovered',
      message: `MCP server '${body.name}' with hash '${body.hash}'`,
    };
  }
  if (match.decision === 'rejected-reserved' || match.decision === 'invalid') {
    return {
      ok: false,
      kind: 'undecidable',
      message: `A permission decision cannot be recorded for '${body.name}': its discovered decision is '${match.decision}'`,
    };
  }
  return { ok: true, decisions: [{ name: body.name, hash: body.hash, decision: body.decision }] };
}
