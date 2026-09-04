import { describe, it, expect } from 'bun:test';
import {
  resolveEffectiveModelParams,
  hasEmbeddedAgentParameterOverride,
  validateEmbeddedAgentParameterOverride,
} from '../embedded-agent-model-params.js';
import { ValidationError } from '../../lib/errors.js';
import type {
  EmbeddedAgentDefinition,
  EmbeddedAgentEngineParameterCapabilities,
} from '@agent-console/shared';
import type { InternalEmbeddedAgentWorker } from '../worker-types.js';

function buildDefinition(model: string): Pick<EmbeddedAgentDefinition, 'provider'> {
  return { provider: { model } };
}

function buildWorker(
  overrides: Pick<InternalEmbeddedAgentWorker, 'model' | 'reasoningEffort'>,
): Pick<InternalEmbeddedAgentWorker, 'model' | 'reasoningEffort'> {
  return overrides;
}

describe('resolveEffectiveModelParams', () => {
  it("uses the worker's own model override when set", () => {
    const result = resolveEffectiveModelParams(
      buildDefinition('gpt-5'),
      buildWorker({ model: 'gpt-5-codex', reasoningEffort: null }),
    );

    expect(result.model).toBe('gpt-5-codex');
  });

  it("falls back to the definition's provider.model when the worker has no override", () => {
    const result = resolveEffectiveModelParams(
      buildDefinition('gpt-5'),
      buildWorker({ model: null, reasoningEffort: null }),
    );

    expect(result.model).toBe('gpt-5');
  });

  it("uses the worker's own reasoningEffort override when set", () => {
    const result = resolveEffectiveModelParams(
      buildDefinition('gpt-5'),
      buildWorker({ model: null, reasoningEffort: 'high' }),
    );

    expect(result.reasoningEffort).toBe('high');
  });

  it('resolves reasoningEffort to null when the worker has no override (no definition-level default exists)', () => {
    const result = resolveEffectiveModelParams(
      buildDefinition('gpt-5'),
      buildWorker({ model: 'gpt-5-codex', reasoningEffort: null }),
    );

    expect(result.reasoningEffort).toBeNull();
  });

  it(
    "live-reads the definition's CURRENT provider.model on every call -- a later definition edit " +
      '(with no worker-level override set) changes the result, proving no copy is taken at worker-creation time',
    () => {
      const worker = buildWorker({ model: null, reasoningEffort: null });

      const before = resolveEffectiveModelParams(buildDefinition('gpt-5'), worker);
      expect(before.model).toBe('gpt-5');

      // Simulate a later definition edit (a fresh definition object with the
      // same identity but a changed provider.model, as a re-fetch from
      // storage would produce).
      const after = resolveEffectiveModelParams(buildDefinition('gpt-5.1'), worker);
      expect(after.model).toBe('gpt-5.1');
    },
  );

  it(
    "does NOT track a later definition edit once the worker has its own override -- the override is a copy " +
      'taken at set time, not a live-read',
    () => {
      const worker = buildWorker({ model: 'gpt-5-codex', reasoningEffort: null });

      const before = resolveEffectiveModelParams(buildDefinition('gpt-5'), worker);
      expect(before.model).toBe('gpt-5-codex');

      const after = resolveEffectiveModelParams(buildDefinition('gpt-5.1'), worker);
      expect(after.model).toBe('gpt-5-codex');
    },
  );

  describe('the undefined-definition overload (agent-surface.md Phase 3 wire conversions)', () => {
    // The wire conversions may have NO definition (deleted, or the
    // paused-session converter's optional lookup). That arm's `model` is
    // `string | undefined` -- the wire's UNKNOWN -- while the activation
    // arm keeps its precise `string`.

    it('returns model: undefined when there is no definition AND no worker override', () => {
      const result = resolveEffectiveModelParams(
        undefined,
        buildWorker({ model: null, reasoningEffort: null }),
      );

      expect(result.model).toBeUndefined();
      expect(result.reasoningEffort).toBeNull();
    });

    it("returns the worker's own override when there is no definition to fall back on", () => {
      const result = resolveEffectiveModelParams(
        undefined,
        buildWorker({ model: 'gpt-5-codex', reasoningEffort: 'high' }),
      );

      expect(result.model).toBe('gpt-5-codex');
      expect(result.reasoningEffort).toBe('high');
    });
  });
});

describe('hasEmbeddedAgentParameterOverride', () => {
  const worker = (
    model: string | null,
    reasoningEffort: string | null,
    contextWindowTokens: number | null,
  ): Pick<InternalEmbeddedAgentWorker, 'model' | 'reasoningEffort' | 'contextWindowTokens'> => ({
    model,
    reasoningEffort,
    contextWindowTokens,
  });

  it('is false when none of the three overrides is set', () => {
    expect(hasEmbeddedAgentParameterOverride(worker(null, null, null))).toBe(false);
  });

  it('is true when only the model override is set', () => {
    expect(hasEmbeddedAgentParameterOverride(worker('gpt-5-codex', null, null))).toBe(true);
  });

  it('is true when only the reasoningEffort override is set', () => {
    expect(hasEmbeddedAgentParameterOverride(worker(null, 'high', null))).toBe(true);
  });

  it('is true when only the contextWindowTokens override is set', () => {
    // Reachable independently of `model` at THIS layer even though Ruling 4
    // couples the two at the write boundary -- the flag reports what the
    // persisted row actually carries, it does not re-litigate the coupling.
    expect(hasEmbeddedAgentParameterOverride(worker(null, null, 200_000))).toBe(true);
  });
});


describe('validateEmbeddedAgentParameterOverride', () => {
  const DEFINITION = { name: 'Local Qwen', engine: 'openai-api' as const };

  const CAPABLE: EmbeddedAgentEngineParameterCapabilities = {
    model: { capable: true, acceptedValues: null, consumptionSite: 'test fixture' },
    reasoningEffort: { capable: true, acceptedValues: null, consumptionSite: 'test fixture' },
  };
  const CLOSED_EFFORT: EmbeddedAgentEngineParameterCapabilities = {
    model: { capable: true, acceptedValues: null, consumptionSite: 'test fixture' },
    reasoningEffort: {
      capable: true,
      acceptedValues: ['low', 'medium', 'high'],
      consumptionSite: 'test fixture',
    },
  };

  describe('normalisation (the N2 half of the contract)', () => {
    // Reach measured 2026-09-04, by deleting each `.trim()` in turn and
    // re-running this file plus worker-lifecycle-manager.test.ts:
    //   model trim removed        -> 4 failures (2 here, 2 there)
    //   reasoningEffort trim removed -> 5 failures (2 here, 3 there)
    // The two branches are independent; neither mutation touches the other's
    // tests.
    it('trims model and returns the trimmed value for the caller to persist', () => {
      const result = validateEmbeddedAgentParameterOverride(
        DEFINITION,
        { model: '  gpt-5-codex  ', contextWindowTokens: 200_000 },
        CAPABLE,
      );

      expect(result.model).toBe('gpt-5-codex');
    });

    it('trims reasoningEffort BEFORE the accepted-values check, so a padded accepted value is accepted', () => {
      // Order matters: checking the raw value against the closed list would
      // reject ' high ' outright rather than accepting it as 'high'.
      const result = validateEmbeddedAgentParameterOverride(
        DEFINITION,
        { reasoningEffort: ' high ' },
        CLOSED_EFFORT,
      );

      expect(result.reasoningEffort).toBe('high');
    });

    it('leaves an absent key absent, so a patch caller can still tell "leave alone" from "clear"', () => {
      const result = validateEmbeddedAgentParameterOverride(
        DEFINITION,
        { reasoningEffort: 'high' },
        CAPABLE,
      );

      expect('model' in result).toBe(false);
      expect('contextWindowTokens' in result).toBe(false);
    });

    it('passes null through as null (clear the override), not as absent', () => {
      const result = validateEmbeddedAgentParameterOverride(
        DEFINITION,
        { model: null, reasoningEffort: null },
        CAPABLE,
      );

      expect('model' in result).toBe(true);
      expect(result.model).toBeNull();
      expect(result.reasoningEffort).toBeNull();
    });
  });

  describe('value rules (moved verbatim from createWorker, same messages)', () => {
    it('rejects an empty or whitespace-only model', () => {
      expect(() =>
        validateEmbeddedAgentParameterOverride(DEFINITION, { model: '   ' }, CAPABLE),
      ).toThrow(/model must not be empty/);
    });

    it('rejects an empty or whitespace-only reasoningEffort', () => {
      expect(() =>
        validateEmbeddedAgentParameterOverride(DEFINITION, { reasoningEffort: '  ' }, CAPABLE),
      ).toThrow(/reasoningEffort must not be empty/);
    });

    it('rejects a model when the capability row says incapable, naming the row\'s reason', () => {
      const incapable: EmbeddedAgentEngineParameterCapabilities = {
        model: { capable: false, reason: 'test fixture: model overrides disabled' },
        reasoningEffort: { capable: true, acceptedValues: null, consumptionSite: 'test fixture' },
      };

      expect(() =>
        validateEmbeddedAgentParameterOverride(
          DEFINITION,
          { model: 'gpt-5', contextWindowTokens: null },
          incapable,
        ),
      ).toThrow(/does not support the "model" parameter -- test fixture: model overrides disabled/);
    });

    it('rejects a reasoningEffort outside a closed accepted-values list, naming the list', () => {
      expect(() =>
        validateEmbeddedAgentParameterOverride(
          DEFINITION,
          { reasoningEffort: 'ultra' },
          CLOSED_EFFORT,
        ),
      ).toThrow(/does not accept "ultra" for "reasoningEffort" -- accepted values: low, medium, high/);
    });

    it('accepts any value when acceptedValues is null (pass-through, the provider is the authority)', () => {
      const result = validateEmbeddedAgentParameterOverride(
        DEFINITION,
        { reasoningEffort: 'whatever-the-provider-takes' },
        CAPABLE,
      );

      expect(result.reasoningEffort).toBe('whatever-the-provider-takes');
    });

    it('checks model BEFORE reasoningEffort, so an empty model wins over a bad effort', () => {
      // The message identifies which check fired, which is the only way to
      // observe the order from outside.
      expect(() =>
        validateEmbeddedAgentParameterOverride(
          DEFINITION,
          { model: '', reasoningEffort: 'ultra' },
          CLOSED_EFFORT,
        ),
      ).toThrow(/model must not be empty/);
    });
  });

  describe('Ruling 4 coupling', () => {
    it('rejects contextWindowTokens with no model key at all', () => {
      expect(() =>
        validateEmbeddedAgentParameterOverride(DEFINITION, { contextWindowTokens: 32_000 }, CAPABLE),
      ).toThrow(/contextWindowTokens requires an accompanying model override/);
    });

    it('rejects contextWindowTokens alongside a model CLEAR (null)', () => {
      // After this request there is no model override for the window to be a
      // property of, which is the same condition as an absent model.
      expect(() =>
        validateEmbeddedAgentParameterOverride(
          DEFINITION,
          { model: null, contextWindowTokens: 32_000 },
          CAPABLE,
        ),
      ).toThrow(/contextWindowTokens requires an accompanying model override/);
    });

    it('accepts contextWindowTokens: null alongside a model (declared: no window, compaction inert)', () => {
      const result = validateEmbeddedAgentParameterOverride(
        DEFINITION,
        { model: 'gpt-5', contextWindowTokens: null },
        CAPABLE,
      );

      expect(result.model).toBe('gpt-5');
      expect(result.contextWindowTokens).toBeNull();
    });

    it('accepts a model with no contextWindowTokens key (the creation shape -- the full-state IFF is a wire rule, not a validator rule)', () => {
      // createWorker has always allowed this, and the extraction must not
      // have quietly tightened it: the "a model requires a window" direction
      // lives in UpdateEmbeddedAgentWorkerRequestSchema, which only the PATCH
      // and the MCP tool go through.
      const result = validateEmbeddedAgentParameterOverride(DEFINITION, { model: 'gpt-5' }, CAPABLE);

      expect(result.model).toBe('gpt-5');
    });
  });

  it('throws ValidationError (a 400 at every caller boundary), not a bare Error', () => {
    expect(() =>
      validateEmbeddedAgentParameterOverride(DEFINITION, { model: '' }, CAPABLE),
    ).toThrow(ValidationError);
  });
});
