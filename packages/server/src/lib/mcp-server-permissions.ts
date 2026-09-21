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

export async function listAllowedProjectMcpServerPairs(
  repository: Pick<McpServerPermissionRepository, 'listByRepository'>,
  repositoryId: string,
): Promise<Array<{ name: string; hash: string }>> {
  return (await repository.listByRepository(repositoryId))
    .filter((row) => row.decision === 'allow')
    .map((row) => ({ name: row.serverName, hash: row.configHash }));
}
