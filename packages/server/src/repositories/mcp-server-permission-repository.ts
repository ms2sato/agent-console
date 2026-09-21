/**
 * Repository interface for MCP server permission decisions (epic #1636
 * Phase 5 PR-2, docs/design/embedded-agent-sdk-engine.md §4.5's "the
 * approval record"). Unlike `ArtifactRepository`/`BookmarkRepository`, this
 * has no file-storage component -- this repository is DB-only.
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
  repositoryId: string;
  serverName: string;
  configHash: string;
  decision: 'allow' | 'deny';
  decidedBy: string;
  createdAt: string;
  decidedAt: string;
}

/**
 * Parameters for `McpServerPermissionRepository.upsert`. Upsert key is
 * `(repositoryId, serverName, configHash)` -- a decision is bound to the
 * EXACT `.mcp.json` entry content it was made against.
 */
export interface UpsertMcpServerPermissionParams {
  repositoryId: string;
  serverName: string;
  configHash: string;
  decision: 'allow' | 'deny';
  /** users.id of the actor recording THIS decision (either polarity). */
  decidedBy: string;
}

export interface McpServerPermissionRepository {
  /**
   * Every permission row for a repository, both decisions -- callers need
   * `deny` rows too (to mark a worker-state entry `denied`, not merely to
   * omit `allow`ed ones).
   */
  listByRepository(repositoryId: string): Promise<McpServerPermissionRow[]>;

  /**
   * Upsert on `(repositoryId, serverName, configHash)`: `id`/`createdAt`
   * are untouched on conflict; `decision`/`decidedBy`/`decidedAt` are
   * overwritten. Returns the resulting row.
   */
  upsert(params: UpsertMcpServerPermissionParams): Promise<McpServerPermissionRow>;

  /** A single row by its natural key, or `null`. */
  get(repositoryId: string, serverName: string, configHash: string): Promise<McpServerPermissionRow | null>;
}
