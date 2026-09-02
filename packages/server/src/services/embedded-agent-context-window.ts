import type { EmbeddedAgentDefinition } from '@agent-console/shared';
import type { InternalEmbeddedAgentWorker } from './worker-types.js';

/**
 * Resolves an embedded-agent worker's EFFECTIVE context-window denominator
 * (agent-surface.md Ruling 4). SINGLE WRITER of this rule: the activation
 * `init` composition and every wire conversion of an embedded-agent worker
 * call this -- nothing else reads `definition.contextWindowTokens` or
 * `worker.contextWindowTokens` directly for this purpose.
 *
 * #1554 (Phase 2 of #1521): the `worker` parameter is now REQUIRED, not
 * optional -- a deliberate breaking signature change (R4b). The whole point
 * is that `tsc` mechanically enumerates every call site needing an update,
 * rather than leaving closure to a grep that could miss one. Do NOT make
 * `worker` optional to dodge the resulting compile errors.
 *
 * The rule (Ruling 4, "do not inherit"): a `contextWindowTokens` override
 * is meaningful ONLY when this same worker's `model` is also overridden.
 * Once a model override is active, the effective window is EITHER the
 * worker's own override OR `undefined` -- it is NEVER the definition's
 * default, even if the worker's own override is absent. Silently falling
 * back to the definition's window for a worker running a DIFFERENT model
 * than the definition declares that window for would be wrong: the
 * definition's number was operator-declared for the definition's own
 * model, not for whatever the worker happens to be overridden to.
 *
 * Only when there is NO model override (`worker.model === null`) does the
 * definition's own `contextWindowTokens` apply -- this is the #1556/#1557
 * pre-existing behavior, unchanged by this widening.
 */
export function resolveEffectiveContextWindow(
  definition: Pick<EmbeddedAgentDefinition, 'contextWindowTokens'> | undefined,
  worker: Pick<InternalEmbeddedAgentWorker, 'model' | 'contextWindowTokens'>,
): number | undefined {
  if (worker.model !== null) {
    // Model override active -- NEVER fall back to the definition's window
    // (Ruling 4 "do not inherit"). Undeclared, not defaulted.
    return worker.contextWindowTokens ?? undefined;
  }
  return definition?.contextWindowTokens;
}
