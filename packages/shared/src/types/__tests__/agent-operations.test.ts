import { describe, it, expect } from 'bun:test';
import { AGENT_OPERATIONS } from '../agent-operations.js';

describe('AGENT_OPERATIONS', () => {
  it('contains exactly the five operations named in the Issue #1160 PR-D spec, plus the restart operation added by Issue #1519, the mid-run parameter operation added by agent-surface.md Phase 3, and the MCP-server-permission operation added by epic #1636 Phase 5 PR-3a', () => {
    expect(AGENT_OPERATIONS).toEqual([
      'listAgents',
      'resolveAgent',
      'createSessionWithAgent',
      'addWorkerToSession',
      'manageDefinitions',
      'restart',
      'setWorkerParameters',
      'decideMcpServerPermissions',
    ]);
  });

  it('has no duplicate entries', () => {
    expect(new Set(AGENT_OPERATIONS).size).toBe(AGENT_OPERATIONS.length);
  });
});
