import type { EmbeddedAgentWindowObservations } from '@agent-console/shared';

/**
 * One reading reported by a worker, before it is folded into the register.
 * `providerStated` is THEIR number (extracted from a provider rejection);
 * `apparentClamp` is OUR inference and carries no number -- the two kinds
 * are never merged (docs/design/embedded-agent-worker.md, "Window-declaration
 * drift on the definition").
 */
export type WindowObservation =
  | { kind: 'providerStated'; tokens: number }
  | { kind: 'apparentClamp' };

/**
 * In-memory observation register keyed by embedded-agent definition id, and
 * the single writer of it. Not persisted: the evidence is about the running
 * system and the remedy is one PATCH away.
 *
 * Holds at most ONE latest observation per kind. `record` reports whether the
 * visible state changed, so a caller broadcasts only on a change: a
 * `context-usage` reading arrives every turn, and a repeat of an already-held
 * clamp (or of the same provider-stated number) changes nothing an operator
 * can see.
 */
export class WindowObservationRegister {
  private readonly byDefinition = new Map<string, EmbeddedAgentWindowObservations>();

  /** @returns true when the register's visible state changed. */
  record(definitionId: string, observation: WindowObservation, observedAt: string): boolean {
    const current = this.byDefinition.get(definitionId) ?? {};
    if (observation.kind === 'providerStated') {
      if (current.providerStated?.tokens === observation.tokens) {
        return false;
      }
      this.byDefinition.set(definitionId, {
        ...current,
        providerStated: { tokens: observation.tokens, observedAt },
      });
      return true;
    }
    if (current.apparentClamp !== undefined) {
      return false;
    }
    this.byDefinition.set(definitionId, { ...current, apparentClamp: { observedAt } });
    return true;
  }

  get(definitionId: string): EmbeddedAgentWindowObservations | undefined {
    return this.byDefinition.get(definitionId);
  }

  /** @returns true when the definition had any observation to drop. */
  clear(definitionId: string): boolean {
    return this.byDefinition.delete(definitionId);
  }
}
