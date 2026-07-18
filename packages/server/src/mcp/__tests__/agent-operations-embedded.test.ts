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

  it('mirrors MCP_AGENT_OPERATIONS exposed/not-exposed flags exactly (structural identity)', () => {
    for (const operation of AGENT_OPERATIONS) {
      expect(EMBEDDED_AGENT_OPERATIONS[operation].exposed).toBe(
        MCP_AGENT_OPERATIONS[operation].exposed,
      );
    }
  });
});
