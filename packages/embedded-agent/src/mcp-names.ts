/**
 * MCP server name classification shared by the epic #1636 Phase 5 discovery
 * loaders (`mcp-discovery.ts`, `agents-discovery.ts`) and the Task 0 premise
 * probe that first measured these rules (`scripts/smoke/probe-sdk-declared-
 * mcp-and-task.ts`). MOVED here (not copied) so the probe and
 * the production discovery loaders share exactly one definition of "is this
 * an account connector" / "which server does this tool name belong to" --
 * see docs/design/embedded-agent-sdk-engine.md §4.5 D-E's "wall" paragraph,
 * which names this file as the single writer of `isAccountConnector`.
 */

/**
 * Server-name prefix of the executing account's claude.ai connectors
 * (docs/design/embedded-agent-sdk-engine.md §4.1's accepted class, measured
 * present under `settingSources: []` on three SDK versions). A NAMING
 * HYPOTHESIS inferred from this host's own interactive tool catalog
 * (`mcp__claude_ai_Google_Drive__*`, `mcp__claude_ai_Claude_Docs__*`), NOT
 * from `sdk.d.ts`, which names no such prefix (Architect ruling).
 * Every caller therefore prints BOTH partitions raw where it matters --
 * connector names and non-connector names -- so a reader can re-partition,
 * and every leak / exactness verdict rests on the NON-connector partition
 * alone; whether strict mode drops the connector class is recorded as a
 * measurement, never folded into a verdict.
 */
export const ACCOUNT_CONNECTOR_PREFIX = 'claude_ai_';

/**
 * `system:init`'s `mcp_servers[].name` reports the SAME four connectors as a
 * human-readable label ("claude.ai Google Drive"), not the underscore-joined
 * slug the tool-name prefix uses ("claude_ai_Google_Drive") -- measured on
 * a live host's own P0 run (2026-09-20): `mcp_servers` carried "claude.ai
 * Claude Docs" / "claude.ai Google Drive" / "claude.ai Google Calendar" /
 * "claude.ai Gmail", none of which `ACCOUNT_CONNECTOR_PREFIX.startsWith`
 * could ever match, while the SAME servers' tools (where they had any) were
 * correctly bucketed via the tool-name prefix. Rather than maintain a SECOND
 * string heuristic for the label form (itself unobserved in `sdk.d.ts`, same
 * caveat as the prefix above), this normalizes any server name to the
 * tool-name slug shape before testing the prefix -- one hypothesis, applied
 * once, to both name spaces. The replacement rule (any run of non
 * alphanumeric characters becomes a single `_`) is itself inferred from the
 * four observed label/slug pairs, not documented anywhere in `sdk.d.ts`.
 */
export function slugifyMcpServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, '_');
}

export function isAccountConnector(serverName: string): boolean {
  return slugifyMcpServerName(serverName).startsWith(ACCOUNT_CONNECTOR_PREFIX);
}

/** `mcp__<server>__<tool>` -> `<server>`, or `null` for a non-MCP name. */
export function mcpServerOf(toolName: string): string | null {
  const m = /^mcp__(.+?)__/.exec(toolName);
  return m ? m[1] : null;
}
