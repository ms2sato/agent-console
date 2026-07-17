import type { EmbeddedAgentContextUsage } from './embedded-agent-store';

interface ContextUsageBarProps {
  /** `EmbeddedAgentDefinition.contextWindowTokens` -- undefined means no denominator is configured. */
  contextWindowTokens: number | undefined;
  contextUsage: EmbeddedAgentContextUsage | null;
  softRatio: number;
  hardRatio: number;
}

/**
 * Always-visible 2px context-window usage bar (Context Handoff Phase A) --
 * see docs/design/embedded-agent-worker.md "Context Handoff (Phase A)" § UI
 * "Always-visible usage bar". In-flow (NOT absolutely positioned, unlike
 * `TerminalLoadingBar`), rendered as a `shrink-0` sibling so it never eats
 * into the transcript's `flex-1` scroll region.
 *
 * `contextWindowTokens` undefined -> indeterminate: no fill, a static
 * dashed/striped track (no animation -- an animated stripe here is visual
 * noise per owner UX review), `role="progressbar"` with NO
 * aria-valuenow/min/max (nothing to measure against).
 *
 * `contextWindowTokens` defined -> determinate: solid fill sized to
 * `promptTokens / contextWindowTokens`, color banded by `softRatio`/`hardRatio`.
 */
export function ContextUsageBar({
  contextWindowTokens,
  contextUsage,
  softRatio,
  hardRatio,
}: ContextUsageBarProps) {
  if (contextWindowTokens === undefined) {
    const title =
      contextUsage !== null
        ? `~${contextUsage.promptTokens} tokens used (estimated; set contextWindowTokens for a gauge)`
        : undefined;
    return (
      <div
        className="h-0.5 shrink-0"
        role="progressbar"
        title={title}
        style={{
          backgroundImage:
            'repeating-linear-gradient(45deg, #475569 0, #475569 4px, transparent 4px, transparent 8px)',
        }}
      />
    );
  }

  const ratio = contextUsage !== null ? contextUsage.promptTokens / contextWindowTokens : 0;
  const pct = Math.min(100, Math.max(0, ratio * 100));
  const color = ratio >= hardRatio ? 'bg-red-600' : ratio >= softRatio ? 'bg-amber-500' : 'bg-gray-500';
  const title =
    contextUsage !== null
      ? `${Math.round(pct)}% (${contextUsage.promptTokens} / ${contextWindowTokens} tokens)`
      : undefined;

  return (
    <div
      className="h-0.5 shrink-0 overflow-hidden bg-slate-800"
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      title={title}
    >
      <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
