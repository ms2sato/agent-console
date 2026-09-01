import { describe, it, expect } from 'bun:test';
import {
  getAgentParameterCapabilities,
  buildAgentParameterTemplateVars,
  templateSupportsModel,
  templateSupportsReasoningEffort,
} from '../agent-parameter-capabilities.js';
import type { AgentDefinition } from '../agent.js';

function buildAgent(commandTemplate: string): AgentDefinition {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    isBuiltIn: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    commandTemplate,
    capabilities: {
      supportsContinue: false,
      supportsHeadlessMode: false,
      supportsActivityDetection: false,
    },
  };
}

describe('getAgentParameterCapabilities', () => {
  describe('model detection', () => {
    it('detects {{model:+--model}} (optional-argument form)', () => {
      const capabilities = getAgentParameterCapabilities(buildAgent('claude {{model:+--model}}{{prompt}}'));
      expect(capabilities.model).toBe(true);
    });

    it('detects {{model}} (no default)', () => {
      const capabilities = getAgentParameterCapabilities(buildAgent('cli --model {{model}} {{prompt}}'));
      expect(capabilities.model).toBe(true);
    });

    it('detects {{model:default}} (default-value form)', () => {
      const capabilities = getAgentParameterCapabilities(buildAgent('cli --model {{model:claude-opus-4-6}} {{prompt}}'));
      expect(capabilities.model).toBe(true);
    });

    it('does not false-positive on {{modelFoo...}} (differently-named variable, boundary)', () => {
      const capabilities = getAgentParameterCapabilities(buildAgent('cli --foo {{modelFoo:+--foo}} {{prompt}}'));
      expect(capabilities.model).toBe(false);
    });

    it('is false when no model var is present', () => {
      const capabilities = getAgentParameterCapabilities(buildAgent('claude {{prompt}}'));
      expect(capabilities.model).toBe(false);
    });
  });

  describe('reasoningEffort detection', () => {
    it('detects {{effort:+--effort}} (optional-argument form)', () => {
      const capabilities = getAgentParameterCapabilities(buildAgent('cli {{effort:+--effort}}{{prompt}}'));
      expect(capabilities.reasoningEffort).toBe(true);
    });

    it('detects {{effort}} (no default)', () => {
      const capabilities = getAgentParameterCapabilities(buildAgent('cli --effort {{effort}} {{prompt}}'));
      expect(capabilities.reasoningEffort).toBe(true);
    });

    it('detects {{effort:default}} (default-value form)', () => {
      const capabilities = getAgentParameterCapabilities(buildAgent('cli --effort {{effort:medium}} {{prompt}}'));
      expect(capabilities.reasoningEffort).toBe(true);
    });

    it('does not false-positive on {{effortLevel...}} (differently-named variable, boundary)', () => {
      const capabilities = getAgentParameterCapabilities(buildAgent('cli {{effortLevel:+--x}} {{prompt}}'));
      expect(capabilities.reasoningEffort).toBe(false);
    });

    it('is false when no effort var is present', () => {
      const capabilities = getAgentParameterCapabilities(buildAgent('claude {{prompt}}'));
      expect(capabilities.reasoningEffort).toBe(false);
    });
  });

  describe('boundary values', () => {
    it('returns {model: false, reasoningEffort: false} for an empty commandTemplate (no throw)', () => {
      expect(() => getAgentParameterCapabilities(buildAgent(''))).not.toThrow();
      expect(getAgentParameterCapabilities(buildAgent(''))).toEqual({ model: false, reasoningEffort: false });
    });

    it('returns {model: false, reasoningEffort: false} for a whitespace-only commandTemplate (no throw)', () => {
      expect(() => getAgentParameterCapabilities(buildAgent('   '))).not.toThrow();
      expect(getAgentParameterCapabilities(buildAgent('   '))).toEqual({ model: false, reasoningEffort: false });
    });

    it('detects both when a template consumes both variables', () => {
      const capabilities = getAgentParameterCapabilities(
        buildAgent('cli {{model:+--model}}{{effort:+--effort}}{{prompt}}'),
      );
      expect(capabilities).toEqual({ model: true, reasoningEffort: true });
    });
  });
});

describe('templateSupportsModel', () => {
  it('returns true for a template containing {{model...}}', () => {
    expect(templateSupportsModel('claude {{model:+--model}}{{prompt}}')).toBe(true);
  });

  it('returns false for a template with no {{model...}} placeholder (e.g. a continueTemplate)', () => {
    expect(templateSupportsModel('claude -c')).toBe(false);
  });
});

describe('templateSupportsReasoningEffort', () => {
  it('returns true for a template containing {{effort...}}', () => {
    expect(templateSupportsReasoningEffort('cli {{effort:+--effort}}{{prompt}}')).toBe(true);
  });

  it('returns false for a template with no {{effort...}} placeholder (e.g. a continueTemplate)', () => {
    expect(templateSupportsReasoningEffort('claude -c')).toBe(false);
  });
});

describe('buildAgentParameterTemplateVars', () => {
  it('maps both model and reasoningEffort when both are set', () => {
    expect(buildAgentParameterTemplateVars({ model: 'opus', reasoningEffort: 'high' })).toEqual({
      model: 'opus',
      effort: 'high',
    });
  });

  it('maps only model when only model is set', () => {
    expect(buildAgentParameterTemplateVars({ model: 'opus' })).toEqual({ model: 'opus' });
  });

  it('maps only effort when only reasoningEffort is set', () => {
    expect(buildAgentParameterTemplateVars({ reasoningEffort: 'high' })).toEqual({ effort: 'high' });
  });

  it('returns an empty object when neither is set', () => {
    expect(buildAgentParameterTemplateVars({})).toEqual({});
  });

  it('treats an explicit empty-string model as absent (empty => absent contract)', () => {
    expect(buildAgentParameterTemplateVars({ model: '' })).toEqual({});
  });

  it('treats an explicit empty-string reasoningEffort as absent (empty => absent contract)', () => {
    expect(buildAgentParameterTemplateVars({ reasoningEffort: '' })).toEqual({});
  });

  it('treats null model/reasoningEffort as absent', () => {
    expect(buildAgentParameterTemplateVars({ model: null, reasoningEffort: null })).toEqual({});
  });
});
