import { describe, it, expect } from 'bun:test';
import type { AgentDefinition } from '../agent.js';
import type { EmbeddedAgentDefinition } from '../embedded-agent.js';
import type { AgentDirectoryEntry } from '../agent-surface.js';
import { AGENT_KINDS, getAgentParameterCapabilitiesFor, deriveEmbeddedParameterCapabilities } from '../agent-surface.js';
import { EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES } from '../embedded-agent-parameter-capabilities.js';

// Fully-typed fixtures, no `as unknown as` casts (Issue #1554 CodeRabbit
// Finding 3 / see .claude/rules "ask if the cast is even needed before
// asking which idiom"). Mirrors the sibling `buildAgent` helper in
// agent-parameter-capabilities.test.ts (same directory) rather than
// bypassing the type system via a cast -- both AgentDefinition and
// EmbeddedAgentDefinition have few enough required fields that a plausible
// dummy value for each is straightforward.
function buildAgent(id: string, name: string, commandTemplate: string): AgentDefinition {
  return {
    id,
    name,
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

function buildEmbeddedAgent(
  id: string,
  name: string,
  engine: 'openai-api' | 'claude-sdk'
): EmbeddedAgentDefinition {
  const base = {
    id,
    name,
    isBuiltIn: false,
    createdBy: 'test-user',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
  return engine === 'openai-api'
    ? { ...base, engine: 'openai-api', provider: { baseUrl: 'http://localhost:11434/v1', model: 'test-model' } }
    : { ...base, engine: 'claude-sdk', provider: { model: 'test-model' } };
}

const modelCapableAgent = buildAgent('model-agent', 'Model Capable Agent', 'mytool {{model:+--model}} {{prompt}}');

const bothCapableAgent = buildAgent(
  'both-agent',
  'Both Capable Agent',
  'mytool {{model:+--model}} {{effort:+--effort}} {{prompt}}'
);

const incapableAgent = buildAgent('plain-agent', 'Plain Agent', 'mytool {{prompt}}');

const openaiApiDefinition = buildEmbeddedAgent('embedded-openai', 'Local GPT', 'openai-api');

const claudeSdkDefinition = buildEmbeddedAgent('embedded-claude-sdk', 'Claude SDK builtin', 'claude-sdk');

describe('getAgentParameterCapabilitiesFor', () => {
  describe('terminal entries', () => {
    it('spreads getAgentParameterCapabilities and always sets contextWindowTokens: false', () => {
      const result = getAgentParameterCapabilitiesFor({ kind: 'terminal', agent: bothCapableAgent });
      expect(result).toEqual({ model: true, reasoningEffort: true, contextWindowTokens: false });
    });

    // Pin (ii): terminal entries are ALWAYS contextWindowTokens: false,
    // regardless of the agent's own model/reasoningEffort capability --
    // contextWindowTokens has no terminal-agent meaning at all
    // (agent-surface.md Ruling 4).
    it('(ii) fixes contextWindowTokens to false for a terminal entry even when model is capable', () => {
      const result = getAgentParameterCapabilitiesFor({ kind: 'terminal', agent: modelCapableAgent });
      expect(result.contextWindowTokens).toBe(false);
    });

    it('(ii) fixes contextWindowTokens to false for a terminal entry with no capability at all', () => {
      const result = getAgentParameterCapabilitiesFor({ kind: 'terminal', agent: incapableAgent });
      expect(result).toEqual({ model: false, reasoningEffort: false, contextWindowTokens: false });
    });
  });

  describe('embedded entries', () => {
    it('reads model/reasoningEffort capability from EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES, keyed by engine', () => {
      const openaiResult = getAgentParameterCapabilitiesFor({ kind: 'embedded', agent: openaiApiDefinition });
      const claudeResult = getAgentParameterCapabilitiesFor({ kind: 'embedded', agent: claudeSdkDefinition });

      const openaiRow = EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES['openai-api'];
      const claudeRow = EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES['claude-sdk'];

      expect(openaiResult.model).toBe(openaiRow.model.capable);
      expect(openaiResult.reasoningEffort).toBe(openaiRow.reasoningEffort.capable);
      expect(claudeResult.model).toBe(claudeRow.model.capable);
      expect(claudeResult.reasoningEffort).toBe(claudeRow.reasoningEffort.capable);
    });

    it("derives contextWindowTokens from the SAME entry's model capability, not a separate table column", () => {
      const result = getAgentParameterCapabilitiesFor({ kind: 'embedded', agent: openaiApiDefinition });
      const row = EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES['openai-api'];
      expect(result.contextWindowTokens).toBe(row.model.capable);
    });
  });

  // Pin (i): a DI fixture row (including a `capable: false` row, which the
  // real production table does not contain today -- see
  // embedded-agent-parameter-capabilities.ts's own comment) is fed directly
  // through `deriveEmbeddedParameterCapabilities` -- the REAL, PRODUCTION
  // derivation formula `getAgentParameterCapabilitiesFor`'s embedded branch
  // delegates to, not a duplicate reimplementation in this test file (see
  // testing.md Anti-Pattern #1). `getAgentParameterCapabilitiesFor` itself
  // has no injectable table-lookup seam (per the confirmed design, it reads
  // EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES directly) -- so
  // `deriveEmbeddedParameterCapabilities` is the extraction point that makes
  // this pin possible without either duplicating logic or adding a seam the
  // design doesn't call for.
  //
  // Checked worker-lifecycle-manager.test.ts for a reusable exported
  // fixture first (per the "reuse before recreate" instruction): its
  // `capable: false` rows are inline object literals local to each test
  // case, not exported, so an equivalent fixture is constructed here
  // instead of imported.
  describe('(i) DI fixture row (capable:false, absent from the real table today)', () => {
    it('reports contextWindowTokens: false when the fixture row has model.capable: false', () => {
      const incapableModelRow = {
        model: { capable: false as const, reason: 'test fixture: model overrides disabled for this engine' },
        reasoningEffort: { capable: true as const, acceptedValues: null, consumptionSite: 'test fixture' },
      };
      const result = deriveEmbeddedParameterCapabilities(incapableModelRow);
      expect(result).toEqual({ model: false, reasoningEffort: true, contextWindowTokens: false });
    });

    it('reports reasoningEffort: false independently of model/contextWindowTokens when only reasoningEffort is incapable', () => {
      const incapableEffortRow = {
        model: { capable: true as const, acceptedValues: null, consumptionSite: 'test fixture' },
        reasoningEffort: { capable: false as const, reason: 'test fixture: reasoningEffort disabled for this engine' },
      };
      const result = deriveEmbeddedParameterCapabilities(incapableEffortRow);
      expect(result).toEqual({ model: true, reasoningEffort: false, contextWindowTokens: true });
    });

    it('reports all-false when the fixture row is incapable of both', () => {
      const allIncapableRow = {
        model: { capable: false as const, reason: 'test fixture: model disabled' },
        reasoningEffort: { capable: false as const, reason: 'test fixture: reasoningEffort disabled' },
      };
      const result = deriveEmbeddedParameterCapabilities(allIncapableRow);
      expect(result).toEqual({ model: false, reasoningEffort: false, contextWindowTokens: false });
    });
  });

  describe('AgentDirectoryEntry kind dispatch (exhaustiveness)', () => {
    it('handles both known kinds without throwing', () => {
      const entries: AgentDirectoryEntry[] = [
        { kind: 'terminal', agent: modelCapableAgent },
        { kind: 'embedded', agent: openaiApiDefinition },
      ];
      for (const entry of entries) {
        expect(() => getAgentParameterCapabilitiesFor(entry)).not.toThrow();
      }
    });

    // Pin (iii)'s runtime half: the exhaustiveness measurement itself (a
    // temporary third AgentDirectoryEntry variant causing `tsc --noEmit` to
    // fail with TS2322 at the `const _exhaustive: never = entry;` line) is a
    // compile-time-only fact and cannot be expressed as a `bun:test`
    // assertion without permanently adding a bogus variant to the exported
    // union type. The measurement was performed manually (mutate, run `bunx
    // tsc --noEmit` in packages/shared, observe TS2322, revert, confirm
    // clean) and is recorded next to the guard itself, in
    // agent-surface.ts's `default` branch comment, per workflow.md's "Every
    // pin's reach is measured, not predicted". This test instead pins the
    // structural property that measurement depends on staying true:
    // AGENT_KINDS's arm count matches the number of AgentDirectoryEntry
    // variants exercised in this file's fixtures (2 today), so a future
    // AgentDirectoryEntry variant necessarily changes AGENT_KINDS's length
    // too.
    it('AGENT_KINDS has exactly one entry per AgentDirectoryEntry variant exercised above (2 today)', () => {
      expect(AGENT_KINDS.length).toBe(2);
      expect(AGENT_KINDS).toEqual(['terminal', 'embedded']);
    });
  });
});
