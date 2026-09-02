import type { EmbeddedAgentContextUsage } from './embedded-agent-store';

interface ContextUsageBarProps {
  /** The worker's effective context-window denominator (agent-surface.md Ruling 4) -- undefined means no denominator is configured. */
  contextWindowTokens: number | undefined;
  contextUsage: EmbeddedAgentContextUsage | null;
  /** The ratio at which compaction fires -- the red band's lower edge. */
  threshold: number;
}

/**
 * How far below the compaction threshold the amber band starts. The bar's
 * job is to let the user see compaction coming; this margin is what makes
 * "coming" visible without introducing a second configurable ratio (the
 * retired soft/hard pair existed only to drive two threshold banners, which
 * #1401 removed).
 */
const AMBER_BAND_MARGIN = 0.15;

/**
 * Always-visible 2px context-window usage bar (Compaction) -- see
 * docs/design/embedded-agent-worker.md "Compaction" § UI
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
 * `promptTokens / contextWindowTokens`, banded gray -> amber -> red against
 * the compaction threshold.
 */
export function ContextUsageBar({
  contextWindowTokens,
  contextUsage,
  threshold,
}: ContextUsageBarProps) {
  if (contextWindowTokens === undefined) {
    const title =
      contextUsage !== null
        ? `${contextUsage.estimated ? '~' : ''}${contextUsage.promptTokens} tokens used${
            contextUsage.estimated ? ' (estimated)' : ''
          }; set contextWindowTokens for a gauge`
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
  const color =
    ratio >= threshold
      ? 'bg-red-600'
      : ratio >= threshold - AMBER_BAND_MARGIN
        ? 'bg-amber-500'
        : 'bg-gray-500';
  // A clamped reading makes the gauge itself untrustworthy, because the
  // denominator is a window the provider does not honour. The warning is
  // placed here, on the widget that performs that division, rather than in
  // the transcript: a reader who wonders what the bar is telling them meets
  // the reason it may be telling them the wrong thing.
  const clamped = contextUsage?.appearsClamped === true;
  const baseTitle =
    contextUsage !== null
      ? `${contextUsage.estimated ? '~' : ''}${Math.round(pct)}% (${contextUsage.promptTokens} / ${contextWindowTokens} tokens${
          contextUsage.estimated ? '; estimated' : ''
        })`
      : undefined;
  // The clause deliberately repeats neither number: the base title above
  // already shows both operands, and restating them here produced a tooltip
  // that said "196608" twice in two different formats.
  const title =
    contextUsage !== null && contextUsage.appearsClamped === true
      ? `${baseTitle} — this reading looks capped at the provider's own input limit, ` +
        `so the provider may be silently dropping input and this percentage is measured ` +
        `against a window larger than the model accepts. Check the agent's context window setting.`
      : baseTitle;

  return (
    <div
      className={`h-0.5 shrink-0 overflow-hidden bg-slate-800${clamped ? ' ring-1 ring-amber-400/70' : ''}`}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-invalid={clamped || undefined}
      title={title}
    >
      <div
        className={`h-full ${color}`}
        style={{
          width: `${pct}%`,
          // Hatching the fill says "do not read this length literally" without
          // a second colour scale or any motion, keeping the bar's register.
          //
          // Hex rather than `rgba()` for the stripe: happy-dom drops a
          // gradient containing `rgba(...)` from the inline style entirely,
          // so the value never reaches a test assertion. Valid CSS either
          // way and a real browser renders both; the opaque stripe simply
          // masks the fill colour instead of darkening it.
          ...(clamped
            ? {
                backgroundImage:
                  'repeating-linear-gradient(45deg, #0f172a 0, #0f172a 3px, transparent 3px, transparent 6px)',
              }
            : {}),
        }}
      />
    </div>
  );
}
