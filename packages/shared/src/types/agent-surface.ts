/**
 * Cross-surface agent parity types (agent-surface migration PR-A).
 *
 * AgentDefinition (terminal agents) and EmbeddedAgentDefinition (embedded
 * agents) are deliberately separate registries with disjoint config shapes
 * and non-overlapping id namespaces (owner requirement, standing since the
 * embedded-agent v1 design). This file does NOT merge them -- it unifies
 * what each registry's consumers can query (AgentSurface / AgentDirectory),
 * not what each registry stores.
 *
 * See docs/design/agent-surface.md for the normative spec.
 */
import type { AgentDefinition } from './agent.js';
import type { EmbeddedAgentDefinition } from './embedded-agent.js';
import { getAgentParameterCapabilities } from './agent-parameter-capabilities.js';
import { EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES } from './embedded-agent-parameter-capabilities.js';
import type { EmbeddedAgentEngineParameterCapabilities } from './embedded-agent-parameter-capabilities.js';

/**
 * SINGLE WRITER of agent-kind literals. Every consumer derives from this
 * constant or the AgentKind type -- never a hardcoded 'terminal' | 'embedded'.
 */
export const AGENT_KINDS = ['terminal', 'embedded'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/**
 * Full-fidelity, kind-tagged entry. Deliberately NOT a lossy summary
 * projection -- consumers narrow by `kind` (exhaustive switch / if-else).
 */
export type AgentDirectoryEntry =
  | { kind: 'terminal'; agent: AgentDefinition }
  | { kind: 'embedded'; agent: EmbeddedAgentDefinition };

/**
 * Per-registry query surface. K-generic so a terminal surface cannot
 * type-return an embedded entry.
 */
export interface AgentSurface<K extends AgentKind = AgentKind> {
  readonly kind: K;
  list(): Extract<AgentDirectoryEntry, { kind: K }>[];
  get(id: string): Extract<AgentDirectoryEntry, { kind: K }> | undefined;
  findByName(name: string): Extract<AgentDirectoryEntry, { kind: K }>[];
}

/** Result of cross-registry resolution (mirrors the #1165 facade contract). */
export type AgentResolution =
  | { ok: true; entry: AgentDirectoryEntry }
  | { ok: false; reason: 'not-found'; message: string }
  | { ok: false; reason: 'ambiguous'; message: string; candidates: AgentDirectoryEntry[] };

/**
 * Boolean-only view of an `AgentDirectoryEntry`'s parameter capability
 * (agent-surface.md "Model & Reasoning-Effort Parameters" / Ruling 4).
 * Deliberately does NOT carry `acceptedValues` / `consumptionSite` /
 * `reason` -- those are per-row self-description that only the validation
 * choke point (`createWorker` in worker-lifecycle-manager.ts) needs; a
 * kind-dispatching UI consumer only needs to know whether to render each
 * input.
 */
export interface AgentParameterCapabilitiesByKind {
  model: boolean;
  reasoningEffort: boolean;
  /**
   * Whether the entry can meaningfully accept a context-window override.
   * This is a fact about the KIND (terminal never has one; embedded's
   * meaning depends on the SAME entry's own model capability), not a fact
   * about the embedded engine -- so it is derived here, not stored as a
   * column on EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES. Deriving it here
   * also means a kind-dispatching consumer (e.g. a creation-form component)
   * never needs to branch on `entry.kind` itself -- this single boolean
   * already encodes that branch's outcome.
   */
  contextWindowTokens: boolean;
}

/**
 * SINGLE kind-dispatch entry point for `AgentParameterCapabilitiesByKind`.
 * Every consumer that needs to know "can this entry accept model /
 * reasoningEffort / contextWindowTokens" -- regardless of whether the entry
 * is terminal or embedded -- calls this function rather than re-deriving
 * per-kind logic itself. Terminal capability is unchanged from
 * `getAgentParameterCapabilities` (this function only spreads it and adds
 * `contextWindowTokens: false`); embedded capability comes from
 * `EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES`, keyed by the definition's
 * `engine`.
 *
 * NOT used by `createWorker`'s embedded-agent validation branch in
 * worker-lifecycle-manager.ts -- that branch already knows its kind
 * statically and needs the full per-row shape (acceptedValues / reason),
 * which this boolean-only view intentionally discards. See that branch's
 * own comment for the rationale.
 */
export function getAgentParameterCapabilitiesFor(
  entry: AgentDirectoryEntry
): AgentParameterCapabilitiesByKind {
  switch (entry.kind) {
    case 'terminal':
      return { ...getAgentParameterCapabilities(entry.agent), contextWindowTokens: false };
    case 'embedded':
      return deriveEmbeddedParameterCapabilities(
        EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES[entry.agent.engine]
      );
    default: {
      // Exhaustiveness guard in the form workflow.md's "Every pin's reach is
      // measured, not predicted" requires: a `const x: never = entry;`
      // assignment, NOT `declare const x: never`. `declare` introduces no
      // assignment, so `never` has nothing to reject and a future
      // AgentDirectoryEntry variant would compile cleanly here without this
      // branch ever firing.
      //
      // Reach measured against this repo's own compiler (2026-09-02):
      // temporarily adding a third arm to AgentDirectoryEntry above (`{
      // kind: 'mutation-probe'; agent: AgentDefinition }`) and running
      // `bunx tsc --noEmit` in packages/shared produces:
      //   `error TS2322: Type '{ kind: "mutation-probe"; ... }' is not
      //   assignable to type 'never'.`
      // pointing at this exact assignment line. Reverting the mutation
      // returns `tsc --noEmit` to a clean exit with no diagnostics.
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
}

/**
 * @internal Exported for testing. Pure derivation from an embedded engine's
 * full-fidelity capability ROW (`EmbeddedAgentEngineParameterCapabilities`)
 * to the boolean-only `AgentParameterCapabilitiesByKind` shape --
 * `getAgentParameterCapabilitiesFor`'s embedded branch delegates to this
 * rather than inlining the formula, so a test can exercise the REAL
 * derivation logic against a fixture row (including a `capable: false` row,
 * which `EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES` does not contain
 * today -- see that table's own comment) without duplicating the formula.
 */
export function deriveEmbeddedParameterCapabilities(
  row: EmbeddedAgentEngineParameterCapabilities
): AgentParameterCapabilitiesByKind {
  return {
    model: row.model.capable,
    reasoningEffort: row.reasoningEffort.capable,
    contextWindowTokens: row.model.capable,
  };
}
