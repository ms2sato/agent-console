import type { EmbeddedAgentWindowObservations } from '@agent-console/shared';

/** UTC calendar date of an ISO timestamp; deterministic across locales and time zones. */
function formatObservedDate(observedAt: string): string {
  return observedAt.slice(0, 10);
}

/**
 * The human-readable sentences for a definition's window observations, one
 * per kind present. The two kinds stay two sentences: a provider-stated
 * limit is the provider's number, an apparent clamp is the console's own
 * inference and carries no number -- they are never merged into one "real
 * window" (docs/design/embedded-agent-worker.md, "Window-declaration drift
 * on the definition").
 */
export function describeWindowObservations(observations: EmbeddedAgentWindowObservations | undefined): string[] {
  if (!observations) return [];
  const sentences: string[] = [];
  if (observations.providerStated) {
    sentences.push(
      `A worker on this definition observed the provider's limit as ${observations.providerStated.tokens.toLocaleString('en-US')} on ${formatObservedDate(observations.providerStated.observedAt)}.`,
    );
  }
  if (observations.apparentClamp) {
    sentences.push(
      `Readings appear clamped since ${formatObservedDate(observations.apparentClamp.observedAt)}.`,
    );
  }
  return sentences;
}

export interface WindowObservationsNoticeProps {
  observations: EmbeddedAgentWindowObservations | undefined;
  /** When set, appended as a plain statement for a viewer who cannot edit the declaration. */
  readOnlyNote?: string;
  className?: string;
}

/**
 * A fact, never a control: renders nothing when there is no observation, so
 * the default (no drift observed) state is unchanged.
 */
export function WindowObservationsNotice({ observations, readOnlyNote, className }: WindowObservationsNoticeProps) {
  const sentences = describeWindowObservations(observations);
  if (sentences.length === 0) return null;
  return (
    <div
      role="note"
      data-testid="window-observations-notice"
      className={className ?? 'text-xs text-amber-400 mt-1'}
    >
      {sentences.map((sentence) => (
        <p key={sentence}>{sentence}</p>
      ))}
      {readOnlyNote && <p className="text-gray-500">{readOnlyNote}</p>}
    </div>
  );
}
