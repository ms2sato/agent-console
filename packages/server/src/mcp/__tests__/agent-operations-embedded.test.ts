import { describe, it, expect } from 'bun:test';
import { AGENT_OPERATIONS } from '@agent-console/shared';
import { MCP_AGENT_OPERATIONS } from '../agent-operations-mcp.js';
import { EMBEDDED_AGENT_OPERATIONS } from '../agent-operations-embedded.js';
import { getRegisteredMcpToolNames } from '../../__tests__/utils/mcp-tool-names-helper.js';

describe('EMBEDDED_AGENT_OPERATIONS', () => {
  it('covers exactly AGENT_OPERATIONS (no missing/extra keys)', () => {
    expect(Object.keys(EMBEDDED_AGENT_OPERATIONS).sort()).toEqual([...AGENT_OPERATIONS].sort());
  });

  it('every exposed `via` claim names a currently-registered MCP tool', async () => {
    const registeredNames = await getRegisteredMcpToolNames();

    for (const operation of AGENT_OPERATIONS) {
      const entry = EMBEDDED_AGENT_OPERATIONS[operation];
      if (!entry.exposed) continue;

      const tokens = entry.via.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? [];
      const matchesRegisteredTool = tokens.some((token) => registeredNames.has(token));

      if (!matchesRegisteredTool) {
        throw new Error(
          `expected via="${entry.via}" for "${operation}" to reference a registered MCP tool`,
        );
      }
      expect(matchesRegisteredTool).toBe(true);
    }
  });

  // epic #1636 Phase 5 PR-3a: operations an EMBEDDED caller must never
  // perform even though the shared MCP endpoint exposes them to TUI
  // callers; each is enforced in the tool itself (see
  // agent-operations-embedded.ts's reason). Adding an entry here is a
  // design decision that needs an Architect ruling, never a convenience.
  const PERMANENT_EMBEDDED_DIVERGENCES = ['decideMcpServerPermissions'] as const;

  it('mirrors MCP_AGENT_OPERATIONS exposed/not-exposed flags exactly, except the declared permanent divergences', () => {
    // polarity confirmed: removing 'decideMcpServerPermissions' from
    // PERMANENT_EMBEDDED_DIVERGENCES fails this test (embedded=false vs
    // MCP=true).
    for (const operation of AGENT_OPERATIONS) {
      if ((PERMANENT_EMBEDDED_DIVERGENCES as readonly string[]).includes(operation)) continue;
      expect(EMBEDDED_AGENT_OPERATIONS[operation].exposed).toBe(MCP_AGENT_OPERATIONS[operation].exposed);
    }
  });

  it('every declared permanent divergence is actually divergent (a stale entry fails here)', () => {
    // polarity confirmed: flipping EMBEDDED_AGENT_OPERATIONS.decideMcpServerPermissions.exposed
    // to true fails this test's first assertion.
    for (const operation of PERMANENT_EMBEDDED_DIVERGENCES) {
      expect(EMBEDDED_AGENT_OPERATIONS[operation].exposed).toBe(false);
      expect((EMBEDDED_AGENT_OPERATIONS[operation] as { reason: string }).reason.length).toBeGreaterThan(0);
      expect(MCP_AGENT_OPERATIONS[operation].exposed).toBe(true);
    }
  });

  it("exposes 'restart' via the same shared MCP endpoint as the MCP surface (Issue #1519)", () => {
    expect(EMBEDDED_AGENT_OPERATIONS.restart).toEqual({
      exposed: true,
      via: 'MCP endpoint (shared) — restart_all_agents',
    });
  });

  it("exposes 'setWorkerParameters' via the same shared MCP endpoint (agent-surface.md Phase 3)", () => {
    // The self-targeting guard on set_agent_parameters does not make this a
    // narrower exposure than the MCP surface's: an embedded agent reaches the
    // same tool on the same endpoint, and the guard is about WHICH worker may
    // be targeted, not about which callers may see the tool.
    expect(EMBEDDED_AGENT_OPERATIONS.setWorkerParameters).toEqual({
      exposed: true,
      via: 'MCP endpoint (shared) — set_agent_parameters',
    });
  });

  it("does not expose 'decideMcpServerPermissions' -- embedded callers are refused inside the tool (PR-3a)", () => {
    expect(EMBEDDED_AGENT_OPERATIONS.decideMcpServerPermissions).toEqual({
      exposed: false,
      reason: expect.stringContaining('embedded-agent worker'),
    });
  });
});
