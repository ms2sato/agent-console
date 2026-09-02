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
  });

  describe('discriminated union shape', () => {
    it('an incapable row (test-only fixture) carries a reason, not acceptedValues/consumptionSite', () => {
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
