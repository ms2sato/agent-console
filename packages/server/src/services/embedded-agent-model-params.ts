import type {
  EmbeddedAgentDefinition,
  EmbeddedAgentEngineParameterCapabilities,
} from '@agent-console/shared';
import type { InternalEmbeddedAgentWorker } from './worker-types.js';
import { ValidationError } from '../lib/errors.js';

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

/**
 * Creation-time override input. `null` is deliberately NOT expressible here:
 * at worker-creation time there is no prior override to clear, so absent
 * ("no override") is the only "off" state there is.
 */
export interface EmbeddedAgentParameterOverrideCreateInput {
  model?: string;
  reasoningEffort?: string;
  contextWindowTokens?: number;
}

/**
 * Patch-time override input (agent-surface.md Ruling 3). ABSENT and `null`
 * are different instructions: absent = leave this override exactly as it is,
 * `null` = CLEAR it, so the worker goes back to live-reading the definition's
 * own default.
 */
export interface EmbeddedAgentParameterOverridePatchInput {
  model?: string | null;
  reasoningEffort?: string | null;
  contextWindowTokens?: number | null;
}

/**
 * SINGLE WRITER of embedded-agent parameter-override validation
 * (agent-surface.md Ruling 1/4), with THREE callers:
 * `WorkerLifecycleManager.createWorker` (worker creation, including the MCP
 * `delegate_to_worktree` path that reaches it), `SessionManager
 * .setEmbeddedAgentParameters` (the mid-run PATCH), and the
 * `set_agent_parameters` MCP tool. The Phase 2 inline block in `createWorker`
 * MOVED here; it was not copied.
 *
 * The capability row is a PARAMETER rather than a table lookup performed
 * inside this function, so `createWorker`'s
 * `getEmbeddedAgentParameterCapabilitiesImpl` DI seam still reaches the
 * validation it was introduced for -- including an INCAPABLE row, which the
 * production `EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES` table does not
 * contain today. Reading the table here by `definition.engine` would defeat
 * that seam silently (the tests would keep passing against the production
 * table and stop exercising the incapable branch at all).
 *
 * NORMALISATION IS PART OF THE CONTRACT, not a side effect: `model` and
 * `reasoningEffort` are trimmed here and the trimmed values are RETURNED for
 * the caller to persist. The REST/WS creation schemas already trim at the
 * wire, but MCP's `delegate_to_worktree` validates them through a looser Zod
 * schema (`z.string().optional()`, no `.min(1)` / trim), so before this
 * writer existed a padded value reached persistence with its spaces intact.
 * Callers persist what this function returns; they do not re-trim.
 *
 * Key PRESENCE is preserved in the returned object -- an absent key stays
 * absent, so a patch caller can still tell "leave alone" from "clear".
 *
 * Throws `ValidationError` (a 400 at every caller's boundary) on the first
 * failing rule; the checks run model -> reasoningEffort -> window coupling,
 * and that order is observable in the error messages.
 */
export function validateEmbeddedAgentParameterOverride(
  definition: Pick<EmbeddedAgentDefinition, 'name' | 'engine'>,
  params: EmbeddedAgentParameterOverrideCreateInput,
  capabilities: EmbeddedAgentEngineParameterCapabilities,
): EmbeddedAgentParameterOverrideCreateInput;
export function validateEmbeddedAgentParameterOverride(
  definition: Pick<EmbeddedAgentDefinition, 'name' | 'engine'>,
  params: EmbeddedAgentParameterOverridePatchInput,
  capabilities: EmbeddedAgentEngineParameterCapabilities,
): EmbeddedAgentParameterOverridePatchInput;
export function validateEmbeddedAgentParameterOverride(
  definition: Pick<EmbeddedAgentDefinition, 'name' | 'engine'>,
  params: EmbeddedAgentParameterOverridePatchInput,
  capabilities: EmbeddedAgentEngineParameterCapabilities,
): EmbeddedAgentParameterOverridePatchInput {
  const normalized: EmbeddedAgentParameterOverridePatchInput = {};

  if (params.model !== undefined) {
    if (params.model === null) {
      normalized.model = null;
    } else {
      // Mirror the valibot wire schemas' v.trim() + v.minLength(1, 'model
      // must not be empty') contract (packages/shared/src/schemas/worker.ts).
      // Unlike the REST/WS routes, MCP's delegate_to_worktree validates
      // `model` via a looser Zod schema (z.string().optional(), no
      // .min(1)/trim), so an empty/whitespace-only value would otherwise
      // reach this choke point unrejected -- and would also satisfy the
      // contextWindowTokens-requires-model check below despite being
      // semantically absent (agent-surface.md Ruling 4 / 4d).
      const model = params.model.trim();
      if (model.length === 0) {
        throw new ValidationError('model must not be empty');
      }
      if (!capabilities.model.capable) {
        throw new ValidationError(
          `Embedded agent "${definition.name}" (engine: ${definition.engine}) does not support the "model" parameter -- ${capabilities.model.reason}`,
        );
      }
      normalized.model = model;
    }
  }

  if (params.reasoningEffort !== undefined) {
    if (params.reasoningEffort === null) {
      normalized.reasoningEffort = null;
    } else {
      // Same empty/whitespace gap as `model` above, for the same reason
      // (MCP's looser Zod schema).
      const reasoningEffort = params.reasoningEffort.trim();
      if (reasoningEffort.length === 0) {
        throw new ValidationError('reasoningEffort must not be empty');
      }
      if (!capabilities.reasoningEffort.capable) {
        throw new ValidationError(
          `Embedded agent "${definition.name}" (engine: ${definition.engine}) does not support the "reasoningEffort" parameter -- ${capabilities.reasoningEffort.reason}`,
        );
      }
      if (
        capabilities.reasoningEffort.acceptedValues !== null &&
        !capabilities.reasoningEffort.acceptedValues.includes(reasoningEffort)
      ) {
        throw new ValidationError(
          `Embedded agent "${definition.name}" (engine: ${definition.engine}) does not accept "${reasoningEffort}" for "reasoningEffort" -- accepted values: ${capabilities.reasoningEffort.acceptedValues.join(', ')}`,
        );
      }
      normalized.reasoningEffort = reasoningEffort;
    }
  }

  if (params.contextWindowTokens !== undefined) {
    // agent-surface.md Ruling 4. `model === null` (clearing the override)
    // counts as "no accompanying model" for exactly the same reason an absent
    // `model` does: after this request there is no model override for the
    // window to be a property OF. The creation caller can never reach the
    // null branch -- its input type has no null -- so this stays the same
    // single rule for all three callers rather than two near-identical ones.
    if (params.model === undefined || params.model === null) {
      throw new ValidationError(
        'contextWindowTokens requires an accompanying model override -- agent-surface.md Ruling 4: a declared window without a model change would silently apply to a model it wasn\'t declared for.',
      );
    }
    normalized.contextWindowTokens = params.contextWindowTokens;
  }

  return normalized;
}
