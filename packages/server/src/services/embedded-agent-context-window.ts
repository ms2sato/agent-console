import type { EmbeddedAgentDefinition } from '@agent-console/shared';

/**
 * Structural input for the worker side of `resolveEffectiveContextWindow`.
 * Empty for now (#1556) -- the model/reasoning-effort override phase
 * (#1554, Phase 2 of #1521) widens this to carry the worker's own
 * model/context-window override fields, at which point the resolver starts
 * preferring them over the definition. Kept as an explicit parameter now
 * (rather than added later) so that phase does not need to touch any of
 * this function's call sites -- only this function's body.
 */
export interface EmbeddedAgentContextWindowWorkerInput {
  readonly [key: string]: never;
}

/**
 * Resolves an embedded-agent worker's EFFECTIVE context-window denominator
 * (agent-surface.md Ruling 4). SINGLE WRITER of this rule: the activation
 * `init` composition and every wire conversion of an embedded-agent worker
 * call this -- nothing else reads `definition.contextWindowTokens` directly
 * for this purpose.
 *
 * #1556: returns the definition's own value unconditionally (the `worker`
 * parameter is unused -- no per-worker override exists yet). The follow-up
 * model-override phase (#1554) extends this to prefer a worker-level
 * override when present, per Ruling 4's "do not inherit" rule (an
 * overridden model without its own window becomes undeclared, never
 * falling back to the definition's).
 */
export function resolveEffectiveContextWindow(
  _worker: EmbeddedAgentContextWindowWorkerInput,
  definition: Pick<EmbeddedAgentDefinition, 'contextWindowTokens'> | undefined,
): number | undefined {
  return definition?.contextWindowTokens;
}
