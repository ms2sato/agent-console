import { describe, it, expect } from 'bun:test';
import { AGENT_OPERATIONS } from '../agent-operations.js';

describe('AGENT_OPERATIONS', () => {
  it('contains exactly the five operations named in the Issue #1160 PR-D spec', () => {
    expect(AGENT_OPERATIONS).toEqual([
      'listAgents',
      'resolveAgent',
      'createSessionWithAgent',
      'addWorkerToSession',
      'manageDefinitions',
    ]);
  });

  it('has no duplicate entries', () => {
    expect(new Set(AGENT_OPERATIONS).size).toBe(AGENT_OPERATIONS.length);
  });
});
