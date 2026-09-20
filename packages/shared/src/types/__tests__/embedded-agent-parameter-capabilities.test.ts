import { describe, it, expect } from 'bun:test';
import {
  EFFORT_LEVELS,
  EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES,
  type EmbeddedAgentEngineParameterCapability,
} from '../embedded-agent-parameter-capabilities.js';

describe('EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES', () => {
  it('declares both engines', () => {
    expect(Object.keys(EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES).sort()).toEqual(['claude-sdk', 'openai-api']);
  });

  describe('openai-api', () => {
    const caps = EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES['openai-api'];

    it('is capable of model, pass-through (no local value validation)', () => {
      expect(caps.model.capable).toBe(true);
      if (caps.model.capable) {
        expect(caps.model.acceptedValues).toBeNull();
        expect(caps.model.consumptionSite.length).toBeGreaterThan(0);
      }
    });

    it('is capable of reasoningEffort, pass-through', () => {
      expect(caps.reasoningEffort.capable).toBe(true);
      if (caps.reasoningEffort.capable) {
        expect(caps.reasoningEffort.acceptedValues).toBeNull();
        expect(caps.reasoningEffort.consumptionSite.length).toBeGreaterThan(0);
      }
    });

    it('is incapable of mcpServers (no declared-server mechanism, only the console dial-back)', () => {
      expect(caps.mcpServers.capable).toBe(false);
      if (!caps.mcpServers.capable) {
        expect(caps.mcpServers.reason.length).toBeGreaterThan(0);
      }
    });

    it('is incapable of task (no subagent runtime)', () => {
      expect(caps.task.capable).toBe(false);
      if (!caps.task.capable) {
        expect(caps.task.reason.length).toBeGreaterThan(0);
      }
    });
  });

  describe('claude-sdk', () => {
    const caps = EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES['claude-sdk'];

    it('is capable of model, pass-through (no local value validation)', () => {
      expect(caps.model.capable).toBe(true);
      if (caps.model.capable) {
        expect(caps.model.acceptedValues).toBeNull();
        expect(caps.model.consumptionSite.length).toBeGreaterThan(0);
      }
    });

    it('is capable of reasoningEffort with a closed value domain equal to EFFORT_LEVELS', () => {
      expect(caps.reasoningEffort.capable).toBe(true);
      if (caps.reasoningEffort.capable) {
        expect(caps.reasoningEffort.acceptedValues).toEqual(EFFORT_LEVELS);
        expect(caps.reasoningEffort.consumptionSite.length).toBeGreaterThan(0);
      }
    });

    it('is capable of mcpServers, pass-through (epic #1636 Phase 5 decision 3)', () => {
      expect(caps.mcpServers.capable).toBe(true);
      if (caps.mcpServers.capable) {
        expect(caps.mcpServers.acceptedValues).toBeNull();
        expect(caps.mcpServers.consumptionSite.length).toBeGreaterThan(0);
      }
    });

    it('is capable of task, pass-through (epic #1636 Phase 5 decision 3)', () => {
      expect(caps.task.capable).toBe(true);
      if (caps.task.capable) {
        expect(caps.task.acceptedValues).toBeNull();
        expect(caps.task.consumptionSite.length).toBeGreaterThan(0);
      }
    });
  });

  describe('discriminated union shape', () => {
    // Note: prior to epic #1636 Phase 5 (Issue #1779), the `capable: false`
    // branch was exercised only by this hand-built fixture -- the table had
    // no production incapable row. `mcpServers`/`task` on `openai-api`
    // (asserted above) are now the first production rows exercising it; this
    // fixture stays as a direct shape check of the discriminated union
    // itself, independent of any particular table entry.
    it('an incapable row carries a reason, not acceptedValues/consumptionSite', () => {
      const incapable: EmbeddedAgentEngineParameterCapability = {
        capable: false,
        reason: 'this engine does not support this parameter',
      };
      expect(incapable.capable).toBe(false);
      if (!incapable.capable) {
        expect(incapable.reason).toBe('this engine does not support this parameter');
      }
    });
  });
});

describe('EFFORT_LEVELS', () => {
  it('has exactly the 5 SDK-declared values, in the documented order', () => {
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});
