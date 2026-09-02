import { describe, it, expect } from 'bun:test';
import { resolveEffectiveContextWindow } from '../embedded-agent-context-window.js';
import type { InternalEmbeddedAgentWorker } from '../worker-types.js';

function buildWorker(
  overrides: Pick<InternalEmbeddedAgentWorker, 'model' | 'contextWindowTokens'>,
): Pick<InternalEmbeddedAgentWorker, 'model' | 'contextWindowTokens'> {
  return overrides;
}

describe('resolveEffectiveContextWindow', () => {
  describe('no model override (worker.model === null) -- #1556/#1557 pre-existing behavior', () => {
    it("returns the definition's contextWindowTokens when set", () => {
      expect(
        resolveEffectiveContextWindow(
          { contextWindowTokens: 128_000 },
          buildWorker({ model: null, contextWindowTokens: null }),
        ),
      ).toBe(128_000);
    });

    it('returns undefined when the definition declares no window', () => {
      expect(
        resolveEffectiveContextWindow(
          { contextWindowTokens: undefined },
          buildWorker({ model: null, contextWindowTokens: null }),
        ),
      ).toBeUndefined();
    });

    it('returns undefined without throwing when the definition itself is undefined (deleted/dangling)', () => {
      expect(resolveEffectiveContextWindow(undefined, buildWorker({ model: null, contextWindowTokens: null }))).toBeUndefined();
    });
  });

  describe('model override active (worker.model !== null) -- Ruling 4', () => {
    it("uses the worker's own contextWindowTokens override when set", () => {
      expect(
        resolveEffectiveContextWindow(
          { contextWindowTokens: 128_000 },
          buildWorker({ model: 'gpt-5', contextWindowTokens: 64_000 }),
        ),
      ).toBe(64_000);
    });

    it(
      'returns undefined -- NEVER falls back to the definition\'s contextWindowTokens -- ' +
        "when the worker's own override is null (Ruling 4 negative pin: a model override with " +
        'no window of its own means undeclared, not defaulted)',
      () => {
        expect(
          resolveEffectiveContextWindow(
            { contextWindowTokens: 128_000 },
            buildWorker({ model: 'gpt-5', contextWindowTokens: null }),
          ),
        ).toBeUndefined();
      },
    );

    it('returns undefined when both the worker override and the definition window are absent', () => {
      expect(
        resolveEffectiveContextWindow(
          { contextWindowTokens: undefined },
          buildWorker({ model: 'gpt-5', contextWindowTokens: null }),
        ),
      ).toBeUndefined();
    });

    it('never falls back to the definition window even when the definition itself is undefined', () => {
      expect(
        resolveEffectiveContextWindow(undefined, buildWorker({ model: 'gpt-5', contextWindowTokens: null })),
      ).toBeUndefined();
    });
  });
});
