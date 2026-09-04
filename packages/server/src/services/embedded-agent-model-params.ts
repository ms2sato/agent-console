import type { EmbeddedAgentDefinition } from '@agent-console/shared';
import type { InternalEmbeddedAgentWorker } from './worker-types.js';

/**
 * Resolves an embedded-agent worker's EFFECTIVE `model` / `reasoningEffort`
 * (agent-surface.md Ruling 3 -- "worker override beats definition default").
 * SINGLE WRITER of this rule for these two params: today's only consumer is
 * `EmbeddedAgentWorkerService.runActivation`'s init composition.
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
 *
 * TWO OVERLOAD SIGNATURES over ONE unchanged implementation, because the
 * consumers genuinely differ in what they can supply (Phase 3 widened the
 * consumer set from activation alone to the wire conversions as well):
 *
 * - The activation path ALWAYS has a definition -- it just resolved one to
 *   spawn against -- so it keeps the precise `model: string`.
 * - The wire conversions may have NONE (a deleted definition, or the
 *   paused-session converter whose `getEmbeddedAgent` dep is itself
 *   optional). They get `model: string | undefined`, which is what
 *   `EmbeddedAgentWorker.model`'s optionality on the wire means: UNKNOWN,
 *   never "the definition's default".
 *
 * The overload exists so both callers route through this SINGLE WRITER
 * instead of a wire conversion re-implementing `worker.model ??
 * definition.provider.model` inline with its own undefined handling --
 * which is exactly the duplication `resolveEffectiveContextWindow`'s
 * sibling doc comment warns about for the window rule.
 */
export function resolveEffectiveModelParams(
  definition: Pick<EmbeddedAgentDefinition, 'provider'>,
  worker: Pick<InternalEmbeddedAgentWorker, 'model' | 'reasoningEffort'>,
): { model: string; reasoningEffort: string | null };
export function resolveEffectiveModelParams(
  definition: Pick<EmbeddedAgentDefinition, 'provider'> | undefined,
  worker: Pick<InternalEmbeddedAgentWorker, 'model' | 'reasoningEffort'>,
): { model: string | undefined; reasoningEffort: string | null };
export function resolveEffectiveModelParams(
  definition: Pick<EmbeddedAgentDefinition, 'provider'> | undefined,
  worker: Pick<InternalEmbeddedAgentWorker, 'model' | 'reasoningEffort'>,
): { model: string | undefined; reasoningEffort: string | null } {
  return {
    model: worker.model ?? definition?.provider.model,
    reasoningEffort: worker.reasoningEffort ?? null,
  };
}

/**
 * Whether this worker carries ANY parameter override at all
 * (agent-surface.md Rulings 3/4). SINGLE WRITER of the three-way OR, so the
 * wire conversions compose `EmbeddedAgentWorker.hasParameterOverride` by
 * calling this rather than each spelling the disjunction out.
 *
 * A surface needs this because the EFFECTIVE values alone cannot answer the
 * question: an override set to the same string the definition declares
 * produces an identical effective `model`, so "override" versus "definition
 * default" is not recoverable by comparison downstream.
 */
export function hasEmbeddedAgentParameterOverride(
  worker: Pick<InternalEmbeddedAgentWorker, 'model' | 'reasoningEffort' | 'contextWindowTokens'>,
): boolean {
  return (
    worker.model !== null || worker.reasoningEffort !== null || worker.contextWindowTokens !== null
  );
}
