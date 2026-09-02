import type { EmbeddedAgentDefinition } from '@agent-console/shared';
import type { InternalEmbeddedAgentWorker } from './worker-types.js';

/**
 * Resolves an embedded-agent worker's EFFECTIVE `model` / `reasoningEffort`
 * (agent-surface.md Ruling 3 -- "worker override beats definition default").
 * SINGLE WRITER of this rule for these two params: today's only consumer is
 * `EmbeddedAgentWorkerService.runActivation`'s init composition (a later
 * wave wires that call site; this wave only lands the resolver itself).
 *
 * Distinct from `resolveEffectiveContextWindow`
 * (`embedded-agent-context-window.ts`), which has a DIFFERENT rule (Ruling
 * 4: a `contextWindowTokens` override is meaningful only alongside a
 * `model` override, and is never inherited from the definition once one is
 * active) and a different consumer set (wire conversions in addition to
 * activation) -- deliberately NOT bundled into one struct-returning
 * function.
 *
 * `worker.model === null` means "live-read the definition's own default":
 * a later edit to `definition.provider.model` (with no worker-level
 * override set) changes what this function returns on the NEXT call, since
 * nothing is copied at worker-creation time. A worker-level override, once
 * set, IS a copy taken at set time and does not track later definition
 * edits -- this is what "beats" means, not "wins once but then follows".
 */
export function resolveEffectiveModelParams(
  definition: Pick<EmbeddedAgentDefinition, 'provider'>,
  worker: Pick<InternalEmbeddedAgentWorker, 'model' | 'reasoningEffort'>,
): { model: string; reasoningEffort: string | null } {
  return {
    model: worker.model ?? definition.provider.model,
    reasoningEffort: worker.reasoningEffort ?? null,
  };
}
