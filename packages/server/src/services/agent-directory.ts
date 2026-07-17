import type { AgentKind, AgentSurface, AgentDirectoryEntry, AgentResolution } from '@agent-console/shared';

/**
 * Stateless, policy-free composite over the per-kind AgentSurface registries.
 * Owns no lifecycle, no caching, no CRUD -- it is a query adapter over the
 * managers' live in-memory maps (agent-surface migration PR-A). Suggestion policy (which
 * agent generates a branch/title suggestion) and default-agent policy
 * (repo.defaultAgentId fallback) stay at callers; see
 * docs/design/agent-surface.md.
 *
 * The constructor's mapped-type parameter is the compile-time exhaustiveness
 * gate: adding a kind to AGENT_KINDS makes every AgentDirectory construction
 * site a compile error until a matching AgentSurface is supplied.
 */
export class AgentDirectory {
  constructor(private readonly surfaces: { [K in AgentKind]: AgentSurface<K> }) {}

  /** All entries across every registry. Order: terminal first, then embedded (stable, documented). */
  listAll(): AgentDirectoryEntry[] {
    return [...this.surfaces.terminal.list(), ...this.surfaces.embedded.list()];
  }

  /** Single-registry lookup by kind + id. */
  get(kind: AgentKind, id: string): AgentDirectoryEntry | undefined {
    return this.surfaces[kind].get(id);
  }

  /**
   * Cross-registry resolution absorbing the #1165 facade verbatim:
   * - by id (ref.agentId set): terminal precedence, then embedded, else not-found.
   * - by name (ref.agentId unset, ref.agentName set): collect matches across
   *   ALL surfaces (terminal first); 0 matches => not-found, >1 => ambiguous
   *   (candidates listed, "Use agentId to specify."), exactly 1 => that entry.
   * Error message strings are preserved byte-for-byte so #1165's existing
   * `delegate_to_worktree` tests keep passing without modification.
   */
  resolve(ref: { agentId?: string; agentName?: string }): AgentResolution {
    if (ref.agentId) {
      const terminal = this.surfaces.terminal.get(ref.agentId);
      if (terminal) return { ok: true, entry: terminal };
      const embedded = this.surfaces.embedded.get(ref.agentId);
      if (embedded) return { ok: true, entry: embedded };
      return { ok: false, reason: 'not-found', message: `Agent not found: ${ref.agentId}` };
    }

    if (ref.agentName) {
      const matches = [
        ...this.surfaces.terminal.findByName(ref.agentName),
        ...this.surfaces.embedded.findByName(ref.agentName),
      ];
      if (matches.length === 0) {
        return { ok: false, reason: 'not-found', message: `No agent found with name: ${ref.agentName}` };
      }
      if (matches.length > 1) {
        const ids = matches.map((e) => `${e.agent.name} (${e.agent.id})`).join(', ');
        return {
          ok: false,
          reason: 'ambiguous',
          message: `Multiple agents match name "${ref.agentName}": ${ids}. Use agentId to specify.`,
          candidates: matches,
        };
      }
      return { ok: true, entry: matches[0] };
    }

    return {
      ok: false,
      reason: 'not-found',
      message: 'No agent reference provided (agentId or agentName required)',
    };
  }
}
