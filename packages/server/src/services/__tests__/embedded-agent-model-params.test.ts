import { describe, it, expect } from 'bun:test';
import {
  resolveEffectiveModelParams,
  hasEmbeddedAgentParameterOverride,
} from '../embedded-agent-model-params.js';
import type { EmbeddedAgentDefinition } from '@agent-console/shared';
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

