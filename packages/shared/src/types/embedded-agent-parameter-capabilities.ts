import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';

/**
 * Per-engine, per-parameter capability declaration (agent-surface.md Ruling
 * 1, embedded-agent side). Mirrors `agent-parameter-capabilities.ts`'s
 * terminal-agent-side capability shape and location -- this file lives in
 * `packages/shared` because both client (creation-form gating) and server
 * (`createWorker`'s creation-time validation) consume it.
 *
 * A DISCRIMINATED UNION, not optional fields on a single shape. Optional
 * fields would let "capable but no consumptionSite" or "incapable but no
 * reason" type-check, which defeats the point of requiring these fields --
 * every capable row must name where the value is actually consumed, and
 * every incapable row must name why.
 */
export type EmbeddedAgentEngineParameterCapability =
  | { capable: true; acceptedValues: readonly string[] | null; consumptionSite: string }
  | { capable: false; reason: string };

/**
 * `acceptedValues: null` means pass-through -- this file does no local
 * value validation; the provider/SDK is the authority. `acceptedValues:
 * [...]` means a closed value domain -- a value outside the list is a LOUD
 * reject upstream (at the creation-time validation choke point), not this
 * file's job to reject; this file only declares the domain.
 */
export interface EmbeddedAgentEngineParameterCapabilities {
  model: EmbeddedAgentEngineParameterCapability;
  reasoningEffort: EmbeddedAgentEngineParameterCapability;
}

/**
 * The Claude Agent SDK's own `effort` values (`Options.effort?: EffortLevel`,
 * `sdk.d.ts` line 576), hand-written here rather than derived, because a
 * literal array of allowed values needs to exist at runtime for the
 * capability table below -- `EffortLevel` itself is erased at compile time.
 * Anchored to the SDK's own type via a mutual, both-directions type-level
 * pin (see `_EffortLevelsMatchSdk` / `_SdkMatchesEffortLevels` below) so
 * drift in either direction (SDK adds/removes a level, or this array drifts
 * from it) fails `tsc`, not silently.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Mutual, both-directions type-level pin between `EFFORT_LEVELS` and the
 * SDK's own `EffortLevel` type.
 *
 * The constraint (`Assert<T extends true>`) is what makes the pin fire. A
 * form that instead declares `type _X = ... ? true : never;` followed by
 * `declare const _x: _X` is inert: `declare` introduces no assignment, so
 * `never` has nothing to reject and drift compiles cleanly. Both halves are
 * required here -- `never` becomes `false`, AND `false` must violate an
 * `extends true` constraint; either alone leaves the pin inert. See
 * `.claude/rules/workflow.md` "Every pin's reach is measured, not
 * predicted" for the full rationale.
 *
 * Reach measured against this repo's own compiler (2026-09-02): mutating
 * `'xhigh'` to `'xhighx'` in `EFFORT_LEVELS` produces, on both pin
 * declarations (both directions fire independently):
 *   `error TS2344: Type 'false' does not satisfy the constraint 'true'.`
 * (`_EffortLevelsMatchSdk` at its declaration line, and
 * `_SdkMatchesEffortLevels` at its declaration line -- the mutated array no
 * longer contains `'xhigh'`, so the SDK's own `EffortLevel` union is no
 * longer a subset of it either). Restoring the correct value returns
 * `tsc --noEmit` to a clean exit with no diagnostics.
 *
 * This pin is only as fresh as `packages/shared`'s own devDependency pin on
 * `@anthropic-ai/claude-agent-sdk` (currently 0.3.238) -- it does NOT read
 * the version `packages/embedded-agent` actually runs at runtime. When
 * bumping the SDK version in `packages/embedded-agent` (the runtime
 * consumer), bump `packages/shared`'s devDependency to match in the same
 * PR, or this pin keeps compiling green against a stale `EffortLevel`
 * definition that no longer reflects what the running subprocess actually
 * sends.
 */
type Assert<T extends true> = T;
type _EffortLevelsMatchSdk = Assert<(typeof EFFORT_LEVELS)[number] extends EffortLevel ? true : false>;
type _SdkMatchesEffortLevels = Assert<EffortLevel extends (typeof EFFORT_LEVELS)[number] ? true : false>;
export type { _EffortLevelsMatchSdk, _SdkMatchesEffortLevels };

/**
 * The per-engine capability table. SINGLE WRITER for embedded-agent
 * parameter capability -- `createWorker`'s creation-time validation and any
 * kind-dispatching consumer (`agent-surface.ts`) read this table rather
 * than re-deriving per-engine capability.
 *
 * All 4 (engine, param) combinations are `capable: true` today -- verified
 * fact, not a placeholder: the SDK really does expose `Options.effort`
 * (`sdk.d.ts` line 1711), and both engines' request/options composition
 * really does have a `model` field. This does not violate Ruling 1's
 * "capable/incapable" wording -- that names the representable set, not a
 * requirement that an incapable row currently exist. The `capable: false`
 * branch is exercised only by test-only DI-injected fixture tables.
 */
export const EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES: Record<
  'openai-api' | 'claude-sdk',
  EmbeddedAgentEngineParameterCapabilities
> = {
  'openai-api': {
    model: {
      capable: true,
      acceptedValues: null,
      consumptionSite: 'chat.completions request body `model` field (agent-loop.ts)',
    },
    reasoningEffort: {
      capable: true,
      acceptedValues: null,
      consumptionSite:
        'chat.completions request body `reasoning_effort` field (openai-chat-adapter.ts) -- ' +
        'pass-through; not every OpenAI-compatible provider honors it, the provider is the authority',
    },
  },
  'claude-sdk': {
    model: {
      capable: true,
      acceptedValues: null,
      consumptionSite: 'query() Options.model (sdk-engine.ts buildOptions)',
    },
    reasoningEffort: {
      capable: true,
      acceptedValues: EFFORT_LEVELS,
      consumptionSite: 'query() Options.effort (sdk-engine.ts buildOptions)',
    },
  },
} as const;
