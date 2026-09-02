import type { EmbeddedAgentDefinition } from '@agent-console/shared';

/**
 * Resolves an embedded-agent worker's EFFECTIVE context-window denominator
 * (agent-surface.md Ruling 4). SINGLE WRITER of this rule: the activation
 * `init` composition and every wire conversion of an embedded-agent worker
 * call this -- nothing else reads `definition.contextWindowTokens` directly
 * for this purpose.
 *
 * #1556: takes only the definition, since no per-worker override exists yet.
 * #1554 (Phase 2 of #1521) will add a REQUIRED worker parameter carrying
 * the worker's own override fields, and `tsc` will then mechanically
 * enumerate every call site needing an update -- that is the intended
 * closure mechanism, not a placeholder parameter here.
 */
export function resolveEffectiveContextWindow(
  definition: Pick<EmbeddedAgentDefinition, 'contextWindowTokens'> | undefined,
): number | undefined {
  return definition?.contextWindowTokens;
}
