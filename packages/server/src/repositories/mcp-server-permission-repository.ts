import type { McpPermissionScope } from '../lib/mcp-server-permissions.js';

/**
 * Repository interface for MCP server permission decisions (epic #1636
 * Phase 5 PR-2, docs/design/embedded-agent-sdk-engine.md §4.5's "the
 * approval record"; extended to cover quick sessions via
 * `McpPermissionScope`'s `'path'` kind). Unlike
 * `ArtifactRepository`/`BookmarkRepository`, this has no file-storage
 * component -- this repository is DB-only, and it is backed by TWO
 * physical tables (`mcp_server_permissions`, keyed by `repository_id`;
 * `mcp_server_path_permissions`, keyed by `location_path`) selected by
 * `scope.kind` -- see `SqliteMcpServerPermissionRepository` for the branch.
 *
 * `decision` here is the DB-row verb vocabulary (`'allow'` / `'deny'`) --
 * DIFFERENT from the wire event's past-participle vocabulary
 * (`'allowed'`/`'pending'`/`'rejected-reserved'`/`'invalid'`) and from
 * `EmbeddedAgentWorker.mcpServers[].decision`'s worker-state vocabulary
 * (which merges this table's `'deny'` rows into `'denied'`). Callers that
 * cross those boundaries own the mapping; this interface only speaks the
 * DB's own verb form.
 */
export interface McpServerPermissionRow {
  id: string;
  scope: McpPermissionScope;
  serverName: string;
  configHash: string;
  decision: 'allow' | 'deny';
  decidedBy: string;
  createdAt: string;
  decidedAt: string;
}

/**
 * Parameters for `McpServerPermissionRepository.upsert`. Upsert key is
 * `(scope, serverName, configHash)` -- a decision is bound to the EXACT
 * `.mcp.json` entry content it was made against.
 */
export interface UpsertMcpServerPermissionParams {
  scope: McpPermissionScope;
  serverName: string;
  configHash: string;
  decision: 'allow' | 'deny';
  /** users.id of the actor recording THIS decision (either polarity). */
  decidedBy: string;
}

export interface McpServerPermissionRepository {
  /**
   * Every permission row for a scope, both decisions -- callers need
   * `deny` rows too (to mark a worker-state entry `denied`, not merely to
   * omit `allow`ed ones).
   */
  listByScope(scope: McpPermissionScope): Promise<McpServerPermissionRow[]>;

  /**
   * Upsert on `(scope, serverName, configHash)`: `id`/`createdAt` are
   * untouched on conflict; `decision`/`decidedBy`/`decidedAt` are
   * overwritten. Returns the resulting row.
   */
  upsert(params: UpsertMcpServerPermissionParams): Promise<McpServerPermissionRow>;

  /** A single row by its natural key, or `null`. */
  get(scope: McpPermissionScope, serverName: string, configHash: string): Promise<McpServerPermissionRow | null>;
}
